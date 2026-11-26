import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { ActiveContext } from '../electron/agent/active-context.js';
import { runAgent, runTaskAgent } from '../electron/agent/loop.js';
import type { LocalTool, ReadToolContext } from '../electron/agent/local-tool.js';
import type { ModelProvider, ModelRequest, Turn } from '../electron/agent/model.js';
import { MalformedMessagesArguments, MessagesOutputLimit } from '../electron/agent/provider.js';
import { RunTasks } from '../electron/agent/run-tasks.js';
import type { RunContext } from '../electron/agent/runs.js';
import { createTaskTools } from '../electron/agent/task-tools.js';
import { taskReportBudget, type TaskWaitResult } from '../electron/agent/task-result.js';
import type { ToolReceipt } from '../electron/agent/tool-receipts.js';
import type { DiagnosticFields } from '../shared/diagnostics.js';

const call = (id: string, name: string, args: object) => ({ id, name, args: JSON.stringify(args) });
const reply = (...calls: ReturnType<typeof call>[]) => ({ role: 'assistant' as const, text: '', calls });
const brief = (label: string) => ({ brief: label, deliverable: 'find one excerpt' });
const evidence = (summary: string) => ({
  summary,
  references: [{ path: 'chapter.txt', line: 3 }],
  unresolved: [],
});
const noLog = () => {};
const session = { id: randomUUID(), cwd: '.', label: 'test', updated: '' };
const fail = () => {
  throw new Error('parent state reached');
};
const readContext = (signal: AbortSignal) => ({ session, signal });
const parentContext = (signal: AbortSignal): RunContext => ({
  ...readContext(signal),
  id: randomUUID(),
  diagnostic: noLog,
  text: fail,
  line: fail,
  progress: fail,
  preview: fail,
  saveNovelTask: fail,
  recordTool: fail,
  history: { lines: [{ role: 'user', text: 'PRIVATE_PARENT_HISTORY' }], receipts: [], save: fail },
});

test('task lanes keep separate requests, tool state, and parent callbacks', async () => {
  const controller = new AbortController();
  const all = new Map<string, number>();
  const parent = parentContext(controller.signal);
  const provider: ModelProvider = {
    effort: 'high',
    async turn(req) {
      const a = req.system === 'child-A';
      const label = a ? 'A' : 'B';
      const wire = JSON.stringify(req.history);
      assert.doesNotMatch(wire, /PRIVATE_PARENT_HISTORY/);
      assert.ok(!wire.includes(`${a ? 'B' : 'A'}_PRIVATE_DATA`));
      req.onText('unpublished');
      const count = all.get(label) ?? 0;
      all.set(label, count + 1);
      if (!count) return reply(call('lookup', 'tool_search', { query: 'read_file' }));
      if (count === 1) return reply(call('same-tool-id', 'read_file', { label }));
      assert.match(wire, new RegExp(`${label}_PRIVATE_DATA`));
      return reply();
    },
  };
  const tool: LocalTool<ReadToolContext> = {
    name: 'read_file',
    description: 'read files',
    schema: { type: 'object' },
    async execute({ label }, ctx) {
      assert.deepEqual(Object.keys(ctx).sort(), ['diagnostic', 'session', 'signal']);
      assert.deepEqual(Object.keys(ctx.session).sort(), ['bookId', 'cwd']);
      return { text: `${label}_PRIVATE_DATA` };
    },
  };
  const task = { beforeRequest: () => {}, finished: () => false };
  await Promise.all(
    ['A', 'B'].map((lane) =>
      runTaskAgent(parent, parent.id, provider, `child-${lane}`, 'delegated brief', [tool], task),
    ),
  );
  assert.deepEqual([...all.values()], [3, 3]);
});

test('two task reservations share limits, wait can time out, and an earlier report survives another failure', async () => {
  const gate = Promise.withResolvers<void>();
  const controller = new AbortController();
  const tasks = new RunTasks(
    controller.signal,
    async ({ brief: label }, task) => {
      task.request();
      await gate.promise;
      task.read();
      task.report(evidence(label), 'completed');
    },
    noLog,
    { totalReads: 1 },
  );
  try {
    const a = tasks.start(brief('a')).taskId;
    const b = tasks.start(brief('b')).taskId;
    const missing = randomUUID();
    assert.throws(() => tasks.start(brief('c')), { diagnosticReason: 'task_capacity' });
    const first = await tasks.wait([a, b, missing], 5);
    assert.equal(first.waitTimedOut, true);
    assert.deepEqual(first.runningIds, [a, b]);
    assert.equal(first.tasks[2].status, 'unknown');
    gate.resolve();
    await tasks.wait([a, b], 1000);
    const result = await tasks.wait([a, b], 0);
    assert.deepEqual(
      result.tasks.map(({ status }) => status),
      ['completed', 'failed'],
    );
    assert.equal(result.tasks[0].report?.summary, 'a');
    assert.equal(result.tasks[1].reason, 'task_budget');
    assert.throws(() => tasks.start(brief('c')), { diagnosticReason: 'task_budget' });
    const anotherRun = new RunTasks(controller.signal, async () => {});
    assert.equal((await anotherRun.wait([a], 0)).tasks[0].status, 'unknown');
  } finally {
    gate.resolve();
    await tasks.close();
  }
});

test('deadline is a task terminal, and close waits for abortion to settle', async () => {
  const ended = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const tasks = new RunTasks(controller.signal, async (_brief, task) => {
    entered.resolve();
    await once(task.signal, 'abort');
    await ended.promise;
  });
  const a = tasks.start(brief('a')).taskId;
  await entered.promise;
  const waiting = tasks.wait([a], 1000);
  const cancelled = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort();
  const closing = tasks.close();
  let done = false;
  void closing.then(() => {
    done = true;
  });
  await cancelled;
  assert.equal(done, false);
  ended.resolve();
  await closing;
  assert.equal(done, true);

  const deadlines = new RunTasks(
    new AbortController().signal,
    async (_brief, task) => {
      task.report(evidence('partial'), 'progress');
      await once(task.signal, 'abort');
    },
    noLog,
    { taskMs: 15, windowMs: 10 },
  );
  try {
    const b = deadlines.start(brief('b')).taskId;
    const state = (await deadlines.wait([b], 1000)).tasks[0];
    assert.equal(state.status, 'timed_out');
    assert.equal(state.reason, 'task_deadline');
    assert.equal(state.report?.summary, 'partial');
    assert.throws(() => deadlines.start(brief('c')), { diagnosticReason: 'task_budget' });
  } finally {
    await deadlines.close();
  }
});

for (const mode of ['completed', 'partial', 'failed', 'timed_out'] as const) {
  test(`delegation returns ${mode} from complete tool turns only`, async () => {
    const controller = new AbortController();
    const ctx = parentContext(controller.signal);
    let requests = 0;
    const provider: ModelProvider = {
      effort: 'high',
      async turn(req: ModelRequest) {
        requests++;
        req.onText('UNPUBLISHED_CHILD_FRAGMENT');
        req.onDispatch?.(req.spanId!);
        if (mode === 'timed_out') throw new DOMException('test timeout', 'TimeoutError');
        if (mode === 'failed' || (mode === 'partial' && requests === 2)) throw new MessagesOutputLimit();
        return reply(
          call('report', 'task_report', {
            status: mode === 'partial' ? 'progress' : 'completed',
            ...evidence('complete phase'),
          }),
        );
      },
    };
    const delegation = createTaskTools(ctx, provider, []);
    try {
      const [start, wait] = delegation.tools;
      const { taskId } = (await start.execute(brief('isolated'), ctx)) as { taskId: string };
      const result = (await wait.execute({ taskIds: [taskId], waitMs: 1000 }, ctx)) as TaskWaitResult;
      assert.equal(result.tasks[0].status, mode);
      assert.equal(
        result.tasks[0].report?.summary,
        mode === 'completed' || mode === 'partial' ? 'complete phase' : undefined,
      );
      assert.equal(requests, mode === 'partial' ? 2 : 1);
    } finally {
      await delegation.close();
    }
  });
}

const toolResult = (history: Turn[], id: string) =>
  history.find((turn): turn is Extract<Turn, { role: 'tool' }> => turn.role === 'tool' && turn.id === id)
    ?.result;

test('a main agent discovers, starts, polls and merges a multi-round task without inheriting its work', async () => {
  const events: { event: string; fields?: DiagnosticFields }[] = [];
  const lines: unknown[] = [];
  const receipts: ToolReceipt[] = [];
  const parent = {
    ...parentContext(new AbortController().signal),
    history: undefined,
    text() {},
    async line(line: unknown) {
      lines.push(line);
    },
    async recordTool(receipt: ToolReceipt) {
      receipts.push(receipt);
    },
    diagnostic: (event: string, fields?: DiagnosticFields) => events.push({ event, fields }),
  };
  const release = Promise.withResolvers<void>();
  let parentRound = 0;
  let childRound = 0;
  let taskId = '';
  const waitArgs = () => ({ taskIds: [taskId], waitMs: 1000 });
  const reportMarker = 'PRIVATE_REPORT_MARKER';
  const provider: ModelProvider = {
    effort: 'high',
    async turn(req) {
      req.onDispatch?.(req.spanId!);
      if (req.system.includes('只读子任务')) {
        assert.doesNotMatch(JSON.stringify(req.history), /PRIVATE_PARENT_INPUT/);
        switch (++childRound) {
          case 1:
            await release.promise;
            return reply(call('search-child', 'tool_search', { query: 'search_text read_file' }));
          case 2:
            return reply(call('find', 'search_text', {}));
          case 3:
            assert.equal(toolResult(req.history, 'find')?.value, 'PRIVATE_CHILD_SEARCH');
            return reply(call('read', 'read_file', {}));
          case 4:
            assert.equal(toolResult(req.history, 'read')?.value, 'PRIVATE_CHILD_TEXT');
            return reply(
              call('report-child', 'task_report', { status: 'completed', ...evidence(reportMarker) }),
            );
          default:
            throw new Error('unexpected child request');
        }
      }
      assert.doesNotMatch(JSON.stringify(req.history), /PRIVATE_CHILD_(SEARCH|TEXT)/);
      switch (++parentRound) {
        case 1:
          assert.deepEqual(
            req.tools.map(({ name }) => name),
            ['tool_search'],
          );
          return reply(call('discover', 'tool_search', { query: 'start_task wait_tasks' }));
        case 2:
          assert.deepEqual(
            (
              toolResult(req.history, 'discover')?.value as { candidates: { access: string }[] }
            ).candidates.map(({ access }) => access),
            ['control', 'control'],
          );
          return reply(call('start', 'start_task', brief('specific task')));
        case 3:
          taskId = (toolResult(req.history, 'start')?.value as { taskId: string }).taskId;
          return reply(call('poll', 'wait_tasks', { ...waitArgs(), waitMs: 5 }));
        case 4:
          assert.equal((toolResult(req.history, 'poll')?.value as TaskWaitResult).waitTimedOut, true);
          release.resolve();
          return reply(
            call('first', 'wait_tasks', waitArgs()),
            call('duplicate', 'wait_tasks', waitArgs()),
          );
        case 5:
        case 6: {
          const first = toolResult(req.history, 'first')?.value as TaskWaitResult;
          const second = toolResult(req.history, 'duplicate')?.value as TaskWaitResult;
          assert.equal(first.tasks[0].report?.summary, reportMarker);
          assert.equal(second.tasks[0].report, undefined);
          if (parentRound === 5) throw new MalformedMessagesArguments();
          return reply(call('again', 'wait_tasks', waitArgs()));
        }
        case 7:
          assert.equal(
            (toolResult(req.history, 'again')?.value as TaskWaitResult).tasks[0].delivery,
            'sent',
          );
          return { ...reply(), text: 'Query complete.' };
        default:
          throw new Error('unexpected parent request');
      }
    },
  };
  const readTool = (name: string, value: string): LocalTool<ReadToolContext> => ({
    name,
    description: name,
    schema: { type: 'object' },
    async execute() {
      return value;
    },
  });
  const delegation = createTaskTools(parent, provider, [
    readTool('search_text', 'PRIVATE_CHILD_SEARCH'),
    readTool('read_file', 'PRIVATE_CHILD_TEXT'),
  ]);
  try {
    await runAgent(parent, provider, 'parent', [], 'PRIVATE_PARENT_INPUT', delegation.tools, 20, {});
  } finally {
    release.resolve();
    await delegation.close();
  }
  assert.equal(childRound, 4);
  assert.equal(
    events.filter(({ event, fields }) => event === 'task.report_dispatch' && fields?.delivery === 'full')
      .length,
    1,
  );
  assert.equal(events.filter(({ event }) => event === 'model.arguments_retry').length, 1);
  assert.ok(receipts.length > 2 && receipts.every(({ commitCount }) => commitCount === 0));
  assert.ok(receipts.every(({ tool }) => ['start_task', 'wait_tasks', 'tool_search'].includes(tool)));
  assert.doesNotMatch(JSON.stringify({ receipts, lines }), /PRIVATE_|task_report|specific task/u);
});

test('cancelling after assembling but before dispatching a report does not mark it sent', async () => {
  const parentAbort = new AbortController();
  const events: string[] = [];
  const parent: RunContext = {
    ...parentContext(parentAbort.signal),
    history: undefined,
    text() {},
    async line() {},
    recordTool: undefined,
    diagnostic: (event) => {
      events.push(event);
    },
  };
  let round = 0;
  const provider: ModelProvider = {
    effort: 'high',
    async turn(req) {
      if (req.system.includes('只读子任务'))
        return reply(
          call('report', 'task_report', { status: 'completed', ...evidence('abort marker') }),
        );
      if (++round === 1) {
        req.onDispatch?.(req.spanId!);
        return reply(call('start', 'start_task', brief('a')));
      }
      if (round === 2) {
        req.onDispatch?.(req.spanId!);
        const { taskId } = toolResult(req.history, 'start')!.value as { taskId: string };
        return reply(call('wait', 'wait_tasks', { taskIds: [taskId] }));
      }
      const report = toolResult(req.history, 'wait')!.value as TaskWaitResult;
      assert.equal(report.tasks[0].report?.summary, 'abort marker');
      parentAbort.abort();
      req.signal.throwIfAborted();
      throw new Error('expected abort');
    },
  };
  const delegation = createTaskTools(parent, provider, []);
  try {
    await assert.rejects(runAgent(parent, provider, 'parent', [], 'prompt', delegation.tools), {
      name: 'AbortError',
    });
  } finally {
    await delegation.close();
  }
  assert.ok(!events.includes('task.report_dispatch'));
  assert.ok(events.includes('tool.result_omitted'));
});

test('unshipped or status-only reports stay retrievable, including after request replanning', async () => {
  const tasks = new RunTasks(new AbortController().signal, async (_brief, task) => {
    task.report(evidence('R'.repeat(1700)), 'completed');
  });
  try {
    const { taskId } = tasks.start(brief('retain across projection'));
    const first = await tasks.wait([taskId], 1000);
    const context = new ActiveContext('parent', '', [], 'prompt', []);
    const append = (id: string, value: TaskWaitResult) =>
      context.append(
        reply(call(id, 'wait_tasks', {})),
        [{ role: 'tool', id, result: { ok: true, value } }],
        [],
      );
    append('first', first);
    const planOnly = context.fit(4000);
    assert.ok((planOnly.latest.get('first')!.value as TaskWaitResult).tasks[0].report);
    const retryPlan = context.fit(550);
    const deferred = retryPlan.latest.get('first')!.value as TaskWaitResult;
    assert.equal(deferred.tasks[0].delivery, 'deferred');
    assert.equal(deferred.tasks[0].report, undefined);
    tasks.observeDispatch(deferred, noLog);
    const second = await tasks.wait([taskId], 0);
    assert.equal(second.tasks[0].report?.summary.length, 1700);
    append('second', second);
    const wire = context.fit(4000);
    const trace: string[] = [];
    const included = wire.latest.get('second')!.value as TaskWaitResult;
    tasks.observeDispatch(included, (event) => trace.push(event));
    tasks.observeDispatch(included, (event) => trace.push(event));
    assert.deepEqual(trace, ['task.report_dispatch']);
    assert.equal((await tasks.wait([taskId], 0)).tasks[0].delivery, 'sent');
  } finally {
    await tasks.close();
  }
});

test('delegated report budget preserves whole reports and shares separate history and batch caps', () => {
  const context = new ActiveContext('parent', '', [], 'brief', []);
  const append = (id: string) => {
    const value: TaskWaitResult = {
      tasks: Array.from({ length: 3 }, () => ({
        taskId: randomUUID(),
        status: 'completed',
        report: { ...evidence('R'.repeat(1700)), candidate: 'C'.repeat(1700) },
      })),
      runningIds: [],
      waitTimedOut: false,
    };
    context.append(
      reply(call(id, 'wait_tasks', {})),
      [{ role: 'tool', id, result: { ok: true, value } }],
      [],
    );
  };
  append('history');
  context.fit(40_000);
  append('latest');
  const { history, projection } = context.fit(40_000);
  for (const id of ['history', 'latest']) {
    const value = toolResult(history, id)?.value as TaskWaitResult;
    const carried = value.tasks.flatMap(({ report }) => report ?? []);
    assert.equal(carried.length, 2);
    assert.ok(carried.every(({ candidate }) => candidate?.length === 1700));
    assert.equal(value.tasks[2].delivery, 'deferred');
  }
  assert.ok(projection.newTaskEstimate! <= taskReportBudget.batch);
  assert.ok(projection.historicalTaskEstimate! <= taskReportBudget.history);
});
