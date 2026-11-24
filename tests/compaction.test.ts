import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunManager } from '../electron/agent/runs.js';
import { Journal } from '../electron/journal.js';
import { ScriptedProvider } from '../electron/agent/scripted.js';
import { object, runAgent, ToolFailure } from '../electron/agent/loop.js';
import { inputEstimate, tokens } from '../electron/agent/context-budget.js';
import { WorkspaceService } from '../electron/workspace.js';
import { collectDiagnostics } from './diagnostic-fixture.js';
import type { AssistantTurn } from '../electron/agent/model.js';

const answer = (text: string): AssistantTurn => ({ role: 'assistant', text, calls: [] });
const action = (id: string, name: string, args = '{}') => ({
  ...answer(''),
  calls: [{ id, name, args }],
});
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'fw-session-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = collectDiagnostics();
  const restart = async () => {
    const runs = new RunManager(join(root, 'state'), new Journal(() => {}), trace.report);
    await runs.init();
    return runs;
  };
  const disk = async (id: string) =>
    await readFile(join(root, 'state', 'sessions', `${id}.jsonl`), 'utf8');
  const entries = async (id: string) =>
    (await disk(id))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { root, trace, restart, disk, entries };
}

for (const source of ['model', 'excerpt'] as const) {
  test(`append a private ${source} checkpoint and restore it after restart without changing old messages`, async (t) => {
    const { root, trace, restart, disk, entries } = await fixture(t);
    let runs = await restart();
    const bookId = randomUUID();
    const session = await runs.create({ cwd: root, bookId }, '旧书名');
    const unrelated = await runs.create({ cwd: root, bookId }, '同书的新会话');
    const original = '海上章节始终使用第一人称；不得让无名水手提前知道钥匙的来历。';
    const amendment = '作者修订：叙述者不能在结局以前承认错误。';
    const recent = '下一步先核对已经保存的章。';
    assert.ok(tokens('中文上下文') > tokens('english'));
    runs.start(session.id, original, async (ctx) => {
      await ctx.saveNovelTask({
        chapterIds: ['chapter-a'],
        originalLine: ctx.authorLine!,
        knownCatalog: [],
        pendingReferences: [],
      });
      await ctx.line({ role: 'assistant', text: '长篇旧讨论'.repeat(700) });
      await ctx.line({ role: 'status', text: 'status clipped from provider but kept in journal' });
    });
    await runs.wait(session.id);
    runs.start(session.id, amendment, async (ctx) => {
      assert.equal(ctx.continuation?.originalDirection, original);
      await ctx.saveNovelTask({ ...ctx.continuation!.task, amendmentLine: ctx.authorLine });
      await ctx.line({ role: 'assistant', text: '另一次旧讨论'.repeat(700) });
    });
    await runs.wait(session.id);
    runs.start(session.id, recent, async (ctx) => {
      await ctx.line({ role: 'assistant', text: '知道了。' });
    });
    await runs.wait(session.id);
    const originalTranscript = runs.get(session.id).messages;
    const prefix = await disk(session.id);
    const prompt = '请接着写完本书，不复述上轮。';
    const summary = '作者决定：narrator-constraint-durable；整书还需要核对已有稿。';
    const provider = Object.assign(
      new ScriptedProvider([
        (req) => {
          assert.match(req.system, /压缩同一会话/);
          assert.equal(req.tools.length, 0);
          assert.ok(inputEstimate(req.system, req.history, req.tools) <= 3200);
          assert.match(JSON.stringify(req.history), /叙述者不能在结局以前承认错误/);
          if (source === 'excerpt') throw new Error('summary endpoint unavailable');
          return answer(summary);
        },
        (req) => {
          assert.ok(inputEstimate(req.system, req.history, req.tools) <= 3200);
          assert.match(req.system, /不得让无名水手提前知道钥匙的来历/);
          assert.match(req.system, /叙述者不能在结局以前承认错误/);
          assert.match(JSON.stringify(req.history), /下一步先核对已经保存的章/);
          assert.deepEqual(req.history.at(-1), { role: 'user', text: prompt });
          assert.doesNotMatch(JSON.stringify(req.history), /长篇旧讨论|另一次旧讨论/);
          assert.match(req.system, source === 'model' ? /narrator-constraint-durable/ : /会话摘录/);
          return answer('不会自动重放历史动作。');
        },
      ]),
      { inputTokenBudget: 3200 },
    );
    runs.start(session.id, prompt, async (ctx) => {
      await runAgent(ctx, provider, 'test harness', [], prompt, []);
    });
    await runs.wait(session.id);
    assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
    assert.ok((await disk(session.id)).startsWith(prefix));
    const checkpoints = (await entries(session.id))
      .filter((row) => row.compaction)
      .map((row) => row.compaction);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].through, 5); // user, assistant, status, user, assistant
    assert.equal(checkpoints[0].source, source);
    assert.ok(
      trace.rows.some((row) => row.event === 'context.checkpoint' && row.fields.source === source),
    );
    assert.deepEqual(trace.rejected, []);

    runs = await restart();
    assert.deepEqual(
      runs.get(session.id).messages.slice(0, originalTranscript.length),
      originalTranscript,
    );
    assert.equal(runs.get(session.id).run?.status, 'completed');
    const same = Object.assign(
      new ScriptedProvider([
        (req) => {
          assert.doesNotMatch(req.system, /你只负责压缩/);
          assert.match(req.system, /不得让无名水手提前知道钥匙的来历/);
          assert.match(JSON.stringify(req.history), /不会自动重放历史动作/);
          assert.ok(req.history.every((row) => row.role !== 'tool'));
          return answer('继续。');
        },
      ]),
      { inputTokenBudget: 3200 },
    );
    runs.start(session.id, '继续', async (ctx) => {
      assert.equal(ctx.continuation?.amendedDirection, amendment);
      await runAgent(ctx, same, 'test harness', [], '继续', []);
    });
    await runs.wait(session.id);
    assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
    assert.equal((await entries(session.id)).filter((row) => row.compaction).length, 1);

    const fresh = new ScriptedProvider([
      (req) => {
        assert.doesNotMatch(req.system + JSON.stringify(req.history), /无名水手|narrator-constraint/);
        return answer('新会话。');
      },
    ]);
    runs.start(unrelated.id, '你好', async (ctx) => {
      await runAgent(ctx, fresh, 'test harness', [], '你好', []);
    });
    await runs.wait(unrelated.id);
    assert.equal(runs.get(unrelated.id).run?.status, 'completed', runs.get(unrelated.id).run?.error);
  });
}

test('persist only observed tool execution and actual commit revisions, including a partial write', async (t) => {
  const { root, restart, disk, entries } = await fixture(t);
  const workspace = new WorkspaceService({
    libraryRoot: join(root, 'library'),
    beforeReplace: async (path) => {
      if (path.endsWith('not-written.md')) throw new Error('synthetic disk problem');
    },
  });
  await workspace.init();
  const { id: bookId } = await workspace.createBook({ title: '回执夹具', summary: '主体' });
  let runs = await restart();
  const session = await runs.create({ bookId, cwd: workspace.bookRoot(bookId) }, '新会话');
  const changes = ['written', 'not-written'].map((id) => ({
    id,
    type: 'subject' as const,
    expect: null,
    fields: { name: id, kind: 'item' as const },
    body: 'SECRET_RAW_MANUSCRIPT',
  }));
  const provider = new ScriptedProvider([
    () => action('HIDDEN_TOOL_ID', 'read_file', '{bad json'),
    () => action('read-exec', 'read_file'),
    () => ({
      ...action('write-exec', 'book_apply_changes', '{"raw":"SECRET_TOOL_ARGS"}'),
      native: 'SECRET_NATIVE_THINKING',
    }),
    () => action('failing-exec', 'delete_file'),
    () => answer('完成夹具。'),
  ]);
  runs.start(session.id, '写入回执测试', async (ctx) => {
    await runAgent(ctx, provider, '', [], '写入回执测试：SECRET_CURRENT_ATTACHMENT', [
      {
        name: 'read_file',
        description: 'test read',
        schema: object({}, []),
        execute: async () => 'SECRET_TOOL_OUTPUT',
      },
      {
        name: 'book_apply_changes',
        description: 'test write',
        schema: object({ raw: { type: 'string' } }),
        execute: async (_, task) => {
          const result = await workspace.writeChanges(bookId, changes, task.signal, [], task.diagnostic);
          if (result.error) throw new ToolFailure(result.reason ?? 'io_failure', result.error, result);
          return result;
        },
      },
      {
        name: 'delete_file',
        description: 'test failure',
        schema: object({}, []),
        execute: async () => {
          throw new Error('SECRET_ERROR_DETAIL');
        },
      },
    ]);
  });
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  const stored = (await entries(session.id))
    .filter((row) => row.toolReceipt)
    .map((row) => row.toolReceipt);
  assert.deepEqual(
    stored.map((row) => [row.round, row.tool, row.outcome, row.commitCount]),
    [
      [2, 'read_file', 'ok', 0],
      [3, 'book_apply_changes', 'partial', 1],
      [4, 'delete_file', 'failed', 0],
    ],
  );
  const observed = await workspace.readDocument(bookId, { type: 'subject', id: 'written' });
  assert.deepEqual(stored[1].commits, [
    { operation: 'write', revision: observed.revision, type: 'subject', id: 'written' },
  ]);
  await assert.rejects(workspace.readDocument(bookId, { type: 'subject', id: 'not-written' }));
  assert.doesNotMatch(await disk(session.id), /SECRET_|HIDDEN_TOOL_ID|not-written/);
  runs = await restart();
  assert.equal(runs.get(session.id).run?.status, 'completed');
  assert.equal((await entries(session.id)).filter((row) => row.toolReceipt).length, 3);
  const follow = new ScriptedProvider([
    (req) => {
      assert.match(req.system, /write:subject\/written/);
      assert.doesNotMatch(req.system, /SECRET_|not-written/);
      assert.equal(
        req.history.some((row) => row.role === 'tool'),
        false,
      );
      return answer('看到了已经执行的回执。');
    },
  ]);
  runs.start(session.id, '检查上次进度', async (ctx) => {
    await runAgent(ctx, follow, '', [], '检查上次进度', []);
  });
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.equal((await entries(session.id)).filter((row) => row.toolReceipt).length, 3);
});
