import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelProfile, Protocol, RuntimeView, Session } from '../../shared/contracts.js';
import type { TaskWaitResult } from '../../electron/agent/task-result.js';
import { diagnosticText, readDiagnostics } from './diagnostic-files.js';

const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([key, input]) => window.fw.request<T>(key, input), [method, args] as const);
const call = (id: string, name: string, args: object) => ({ id, name, args });
type Call = ReturnType<typeof call>;
const sse = (res: ServerResponse, events: object[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
};

function reply(res: ServerResponse, protocol: Protocol, calls: Call[], text = '', limit = false) {
  if (protocol === 'messages') {
    const blocks = calls.map(({ id, name, args }) => ({ type: 'tool_use', id, name, input: args }));
    sse(res, [
      ...[...blocks, ...(text ? [{ type: 'text', text }] : [])].flatMap((content_block, index) => [
        { type: 'content_block_start', index, content_block },
        { type: 'content_block_stop', index },
      ]),
      {
        type: 'message_delta',
        delta: { stop_reason: limit ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn' },
      },
      { type: 'message_stop' },
    ]);
  } else if (protocol === 'chat') {
    sse(res, [
      {
        choices: [
          {
            index: 0,
            delta: {
              content: text,
              tool_calls: calls.map(({ id, name, args }, index) => ({
                index,
                id,
                function: { name, arguments: JSON.stringify(args) },
              })),
            },
            finish_reason: calls.length ? 'tool_calls' : 'stop',
          },
        ],
      },
    ]);
  } else
    sse(res, [
      {
        type: 'response.completed',
        response: {
          output: [
            ...calls.map(({ id, name, args }) => ({
              type: 'function_call',
              call_id: id,
              name,
              arguments: JSON.stringify(args),
            })),
            ...(text
              ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
              : []),
          ],
        },
      },
    ]);
}

function decode(protocol: Protocol, raw: string) {
  const body = JSON.parse(raw);
  const messages = body.messages ?? [];
  const blocks: any[] =
    protocol === 'responses'
      ? body.input
      : protocol === 'messages'
        ? messages.flatMap(({ content }: { content: unknown[] }) => content)
        : messages;
  const names: string[] = (body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);
  const pending = new Set<string>();
  const results = new Map<string, any>();
  for (const row of blocks) {
    if (row.type === 'function_call' || row.type === 'tool_use') pending.add(row.call_id ?? row.id);
    for (const item of row.tool_calls ?? []) pending.add(item.id);
    if (row.type === 'tool_result' || row.type === 'function_call_output' || row.role === 'tool') {
      const id = row.call_id ?? row.tool_call_id ?? row.tool_use_id;
      expect(pending.delete(id), `paired ${protocol} result ${id}`).toBe(true);
      results.set(id, JSON.parse(row.output ?? row.content));
    }
  }
  expect(pending.size).toBe(0);
  const system = body.system ?? body.instructions ?? messages[0].content;
  const initial =
    protocol === 'responses'
      ? (blocks[0].text ?? blocks[0].content)
      : protocol === 'messages'
        ? blocks[0].text
        : messages[1].content;
  return {
    names,
    results,
    step: [...results.keys()].at(-1),
    child: system.includes('只读子任务'),
    initial,
  };
}

const cases = [
  ['messages', 'parallel'],
  ['chat', 'parallel'],
  ['responses', 'parallel'],
  ['messages', 'deadline'],
  ['messages', 'stop'],
  ['messages', 'delete-session'],
  ['messages', 'delete-book'],
  ['messages', 'exit'],
  ['messages', 'truncated-parent'],
  ['messages', 'normal-end'],
  ['messages', 'parent-error'],
] as const;

for (const [protocol, mode] of cases) {
  test(`${protocol}: Run-local delegation (${mode})`, async ({}, info) => {
    const root = info.outputPath('app');
    const errors: string[] = [];
    const started = new Set<string>();
    const active = new Set<string>();
    const cancelled = new Set<string>();
    let peak = 0;
    let independent = false;
    let waiting = false;
    let runId = '';
    const publish = new Map<string, () => void>();
    const server = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const wire = decode(protocol, raw);
        const send = (...calls: Call[]) => {
          for (const { name } of calls) expect(wire.names).toContain(name);
          reply(res, protocol, calls);
        };
        const text = (value: string) => reply(res, protocol, [], value);
        const report = (label: string) =>
          call('child-report', 'task_report', {
            summary: `PRIVATE_REPORT_${label}`,
            unresolved: [],
            status: 'completed',
            references: [{ path: 'notes.txt', line: 1 }],
          });
        if (wire.child) {
          expect(raw).not.toContain('PRIVATE_PARENT');
          expect(wire.names).not.toContain('start_task');
          expect(wire.names).not.toContain('write_file');
          const label = JSON.parse(wire.initial).brief;
          expect(raw).not.toContain(label === 'PRIVATE_TASK_A' ? 'PRIVATE_TASK_B' : 'PRIVATE_TASK_A');
          if (!wire.step) {
            started.add(label);
            if (mode !== 'parallel') {
              active.add(label);
              res.on('close', () => {
                active.delete(label);
                if (!res.writableEnded) cancelled.add(label);
              });
              return;
            }
            return send(call('child-discover', 'tool_search', { query: 'read_file' }));
          }
          if (wire.step === 'child-discover')
            return send(call('child-read', 'read_file', { path: 'notes.txt' }));
          expect(raw).toContain('PRIVATE_CHILD_SOURCE');
          active.add(label);
          peak = Math.max(peak, active.size);
          res.on('close', () => {
            active.delete(label);
            if (!res.writableEnded) cancelled.add(label);
          });
          publish.set(label, () => send(report(label)));
          return;
        }
        expect(raw).not.toContain('PRIVATE_CHILD_SOURCE');
        const start = (id: string, brief: string) =>
          call(id, 'start_task', { brief, deliverable: 'a finding' });
        if (!wire.step) {
          expect(wire.names).not.toContain('start_task');
          return send(call('discover', 'tool_search', { query: 'start_task wait_tasks list_files' }));
        }
        if (wire.step === 'discover') {
          if (mode === 'truncated-parent')
            return reply(res, protocol, [start('launch-a', 'PRIVATE_TASK_A')], '', true);
          return send(
            start('launch-a', 'PRIVATE_TASK_A'),
            ...(mode === 'parallel' ? [start('launch-b', 'PRIVATE_TASK_B')] : []),
          );
        }
        const taskIds = ['launch-a', 'launch-b'].flatMap(
          (id) => wire.results.get(id)?.value.taskId ?? [],
        );
        const wait = (id: string, waitMs = 10_000) => call(id, 'wait_tasks', { taskIds, waitMs });
        if (wire.step === 'launch-b')
          return send(start('too-many', 'third'), call('independent', 'list_files', {}));
        if (wire.step === 'independent') {
          expect(wire.results.get('too-many').reason).toBe('task_capacity');
          expect(wire.results.get('independent').value.files).toContain('notes.txt');
          await expect.poll(() => publish.size).toBe(2);
          expect(active.size).toBe(2);
          independent = true;
          return send(wait('poll', 10));
        }
        if (wire.step === 'launch-a') {
          if (mode === 'normal-end' || mode === 'parent-error') {
            await expect.poll(() => active.size).toBe(1);
            if (mode === 'parent-error') return reply(res, protocol, [], '', true);
            return text('本任务不用等待子结果。');
          }
          waiting = true;
          return send(wait('wait'));
        }
        if (wire.step === 'poll') {
          expect(wire.results.get('poll').value.waitTimedOut).toBe(true);
          publish.get('PRIVATE_TASK_A')!();
          return send(wait('a'));
        }
        if (wire.step === 'a') {
          const value: TaskWaitResult = wire.results.get('a').value;
          expect(value.runningIds).toEqual([taskIds[1]]);
          expect(value.tasks[0].report?.summary).toBe('PRIVATE_REPORT_PRIVATE_TASK_A');
          publish.get('PRIVATE_TASK_B')!();
          return send(wait('b'));
        }
        if (wire.step === 'b') {
          const value: TaskWaitResult = wire.results.get('b').value;
          expect(value.tasks[0].delivery).toBe('sent');
          expect(value.tasks[0].report).toBeUndefined();
          expect(value.tasks[1].report?.summary).toBe('PRIVATE_REPORT_PRIVATE_TASK_B');
          return text('两项已核对。');
        }
        if (wire.step === 'wait' && mode === 'deadline') {
          const value: TaskWaitResult = wire.results.get('wait').value;
          expect(value.waitTimedOut).toBe(false);
          expect(value.tasks[0].status).toBe('timed_out');
          return text('子任务超时。');
        }
        throw new Error(`Unexpected fixture step: ${wire.step}`);
      } catch (error) {
        errors.push(String(error));
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const cwd = join(root, 'ordinary');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'notes.txt'), 'PRIVATE_CHILD_SOURCE', 'utf8');
    const app = await electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        FW_E2E: '1',
        FW_TEST_ROOT: root,
        FW_E2E_SHOW_WINDOW: '0',
        FW_TEST_DISABLE_DELEGATION: '',
        FW_TEST_TASK_TIMEOUT_MS: mode === 'deadline' ? '1500' : '',
      },
    });
    let exited = false;
    try {
      const page = await app.firstWindow();
      const profile = await rpc<ModelProfile>(page, 'profiles.save', {
        name: 'delegation fixture',
        model: 'fixture',
        apiKey: 'fixture-key',
        protocol,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
      const bookId =
        mode === 'delete-book' || mode === 'truncated-parent'
          ? (
              await rpc<{ id: string }>(page, 'book.create', {
                title: '委派夹具',
                summary: '仅供测试。',
              })
            ).id
          : undefined;
      const session = await rpc<Session>(page, 'session.create', bookId ? { bookId } : { cwd });
      ({ runId } = await rpc<{ runId: string }>(page, 'session.start', {
        id: session.id,
        profileId: profile.id,
        prompt: 'PRIVATE_PARENT',
      }));
      if (['stop', 'delete-session', 'delete-book', 'exit'].includes(mode)) {
        await expect.poll(() => waiting && active.size === 1).toBe(true);
        if (mode === 'exit') {
          await app.close();
          exited = true;
        } else if (mode === 'delete-book') await rpc(page, 'book.delete', { bookId });
        else await rpc(page, mode === 'stop' ? 'session.stop' : 'session.delete', { id: session.id });
      }
      const trace = async () =>
        (await readDiagnostics(root, 'backend')).filter(({ fields }) => fields.runId === runId);
      await expect
        .poll(async () => (await trace()).some(({ event }) => event === 'run.finished'))
        .toBe(true);
      const rows = await trace();
      expect(errors).toEqual([]);
      const finished = rows.find(({ event }) => event === 'run.finished')!;
      const attempts = rows.filter(({ event }) => event === 'task.accepted');
      const ends = rows.filter(({ event }) => event === 'task.finished');
      if (mode === 'parallel') {
        expect(independent).toBe(true);
        expect(peak).toBe(2);
        expect(attempts).toHaveLength(2);
        expect(ends.map(({ fields }) => fields.taskStatus)).toEqual(['completed', 'completed']);
        expect(
          rows.filter(
            ({ event, fields }) => event === 'model.budget_dispatched' && fields.lane === 'task',
          ),
        ).toHaveLength(6);
        const dispatch = rows.filter(
          ({ event, fields }) => event === 'task.report_dispatch' && fields.delivery === 'full',
        );
        expect(new Set(dispatch.map(({ fields }) => fields.taskId)).size).toBe(2);
        for (const { fields } of dispatch)
          expect(
            rows.some(
              (row) =>
                row.event === 'model.budget_dispatched' &&
                row.fields.lane === 'agent' &&
                row.fields.spanId === fields.spanId,
            ),
          ).toBe(true);
        const snapshot = await rpc<RuntimeView>(page, 'runtime.snapshot');
        expect(snapshot.sessions).toHaveLength(1);
        const saved = await readFile(join(root, 'state', 'sessions', `${session.id}.jsonl`), 'utf8');
        expect(saved).not.toMatch(/PRIVATE_(?:TASK|CHILD|REPORT)|task_report/u);
        expect(saved).toContain('start_task');
        expect(saved).toContain('wait_tasks');
      } else if (mode === 'truncated-parent') {
        expect(attempts).toHaveLength(0);
        expect(started.size).toBe(0);
        expect(finished.fields.outcome).toBe('failed');
      } else {
        await expect.poll(() => cancelled.size).toBe(1);
        expect(attempts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        expect(ends[0].fields.taskStatus).toBe(mode === 'deadline' ? 'timed_out' : 'cancelled');
        expect(ends[0].logSeq).toBeLessThan(finished.logSeq);
        if (mode === 'normal-end' || mode === 'parent-error')
          expect(finished.fields.outcome).toBe(mode === 'normal-end' ? 'ok' : 'failed');
      }
      const log = await diagnosticText(root, 'backend');
      expect(log).not.toMatch(/PRIVATE_(?:TASK|CHILD|REPORT)|notes\.txt/u);
    } finally {
      if (!exited) await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
