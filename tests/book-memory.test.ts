import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceService } from '../electron/workspace.js';
import { renderDocument } from '../electron/documents.js';
import { Journal } from '../electron/journal.js';
import { RunManager } from '../electron/agent/runs.js';
import { bookMemoryTools, recallBookMemory } from '../electron/agent/book-memory.js';
import { draftChapter } from '../electron/agent/draft.js';
import { Gate, ScriptedProvider } from '../electron/agent/scripted.js';
import { runAgent } from '../electron/agent/loop.js';
import type { AssistantTurn } from '../electron/agent/model.js';

const clue = '秘密是黄铜月轮以退潮后的三声钟响为暗号。';
const opening = '舱门紧锁，罗盘还在桌面。';
const later = opening + '\n\n黄铜月轮之所以熔化，是冬祭夜船长用冰盐点燃了它。';
const nextBoundary = {
  chapterId: 'chapter-26',
  conditions: [{ quote: opening, condition: '必须让舱门保持锁定，仍能在桌面找到罗盘。' }],
};
const rule = '全书一律用第三人称有限视角';
const answer = (text: string): AssistantTurn => ({ role: 'assistant', text, calls: [] });
const chapter = (id: string) => ({ type: 'chapter' as const, id });
async function fixture(t: import('node:test').TestContext, failMemory = false) {
  const root = await mkdtemp(join(tmpdir(), 'fw-book-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceService({
    libraryRoot: join(root, 'library'),
    beforeReplace: async (path) => {
      if (failMemory && path.endsWith('memory.json')) throw new Error('read-only cache');
    },
  });
  await workspace.init();
  const book = { title: '同名小说', summary: '两部独立的长篇。' };
  const { id: a } = await workspace.createBook(book);
  const { id: b } = await workspace.createBook(book);
  const restart = async () => {
    const manager = new RunManager(join(root, 'state'), new Journal(() => {}));
    await manager.init();
    return manager;
  };
  return { workspace, a, b, restart };
}

async function populate(workspace: WorkspaceService, bookId: string) {
  const filler = '远处的低云遮住了雾松，行人把一只旧木箱搬过桥。\n\n'.repeat(160);
  const report = await workspace.writeChanges(
    bookId,
    Array.from({ length: 26 }, (_, n) => {
      const order = n + 1;
      return {
        ...chapter(`chapter-${order}`),
        expect: null,
        fields: { title: `卷 ${order}`, order },
        body:
          order === 2
            ? `${filler}\n${clue}\n\n${filler}`
            : order === 25
              ? ''
              : order === 26
                ? later
                : filler,
      };
    }),
  );
  assert.equal(report.error, undefined);
}

async function conventionRun(
  manager: RunManager,
  workspace: WorkspaceService,
  bookId: string,
  sessionId: string,
  prompt: string,
  tool: string,
  args: unknown,
  expectSuccess = true,
) {
  let result: any;
  const provider = new ScriptedProvider([
    () => ({
      ...answer(''),
      calls: [{ id: 'convention-call', name: tool, args: JSON.stringify(args) }],
    }),
    ({ history }) => {
      const last = history.at(-1);
      assert.equal(last?.role, 'tool');
      assert.equal(last.result.ok, expectSuccess);
      result = last.result.value;
      return answer('处理完毕');
    },
  ]);
  manager.start(sessionId, prompt, async (ctx) => {
    await runAgent(ctx, provider, 'fixture', [], prompt, bookMemoryTools(workspace, bookId, prompt));
  });
  await manager.wait(sessionId);
  assert.equal(manager.get(sessionId).run?.status, 'completed', manager.get(sessionId).run?.error);
  return result;
}

test('a new session writes chapter 25 using a middle passage from chapter 2, never future facts or another book', async (t) => {
  const { workspace, a, b, restart } = await fixture(t);
  await populate(workspace, a);
  let runs = await restart();
  const first = await runs.create({ cwd: workspace.bookRoot(a), bookId: a }, '新会话');
  const fakeChat = '未采用的念头：主角是熔岩伪王。';
  await conventionRun(runs, workspace, a, first.id, `请记住：${rule}。`, 'book_memory_remember', {
    text: rule,
  });
  await conventionRun(
    runs,
    workspace,
    a,
    first.id,
    fakeChat,
    'book_memory_remember',
    { text: fakeChat },
    false,
  );
  const indexed = await recallBookMemory(workspace, a, { query: clue, chapterId: 'chapter-25' });
  const found = indexed.earlierStory.find((row) => row.excerpt.includes(clue))!;
  const before = await workspace.readDocument(a, chapter('chapter-2'));
  assert.equal(found.id, before.id);
  assert.equal(found.revision, before.revision);
  assert.equal(found.excerpt, before.body.slice(...found.range));
  assert.doesNotMatch(JSON.stringify(indexed), /冰盐|熔岩伪王/);
  const filename = join(workspace.bookRoot(a), '.fiction-writer', 'memory.json');
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(saved.sources['chapter/chapter-2'].revision, before.revision);
  assert.ok(saved.sources['chapter/chapter-2'].passages.length > 2);
  assert.equal(saved.conventions[0].text, rule);
  const independent = await recallBookMemory(workspace, b, { query: clue });
  assert.deepEqual(independent, { conventions: [], earlierStory: [], plans: [], reference: [] });

  // An actual prose request from a fresh Session sees the middle of chapter 2,
  // even though the ordinary chapter excerpt and readback round did not surface it.
  runs = await restart();
  const second = await runs.create({ cwd: workspace.bookRoot(a), bookId: a }, '新会话');
  assert.deepEqual(runs.snapshot(b).sessions, []);
  assert.equal(runs.snapshot(a).sessions.length, 2);
  const provider = new ScriptedProvider([
    ({ tools }) => {
      assert.equal(tools[0].name, 'book_read_chapter');
      return answer('');
    },
    ({ history, tools }) => {
      assert.equal(tools.length, 0);
      const text = (history[0] as { text: string }).text;
      const context = JSON.parse(
        text.slice(text.indexOf('作品资料（数据）：\n') + '作品资料（数据）：\n'.length),
      );
      assert.doesNotMatch(JSON.stringify(context.previous), /三声钟响/);
      assert.ok(
        context.memory.earlierStory.some((row: { excerpt: string }) => row.excerpt.includes(clue)),
      );
      assert.equal(context.memory.conventions[0].text, rule);
      assert.doesNotMatch(text, /冰盐|熔岩伪王/);
      return answer('钟响三次，她转动月轮。');
    },
  ]);
  const prompt = '续写黄铜月轮与三声钟响的暗号。';
  runs.start(second.id, prompt, async (ctx) => {
    await draftChapter(workspace, ctx, provider, 'chapter-25', 'draft', prompt, {
      plan: { nextBoundary },
    });
  });
  await runs.wait(second.id);
  assert.equal(runs.get(second.id).run?.status, 'completed', runs.get(second.id).run?.error);
  assert.equal((await workspace.readDocument(a, chapter('chapter-25'))).body, '钟响三次，她转动月轮。');

  // An external edit (not a managed commit or watcher event) invalidates old evidence on use.
  const path = join(workspace.bookRoot(a), 'chapters', `${before.id}.md`);
  const replacement = '黄铜月轮改以四声短笛为暗号。';
  await writeFile(path, renderDocument(before, before.fields, replacement), 'utf8');
  const fresh = await recallBookMemory(workspace, a, { query: '黄铜月轮', chapterId: 'chapter-25' });
  assert.match(JSON.stringify(fresh), /四声短笛/);
  assert.doesNotMatch(JSON.stringify(fresh), /三声钟响|冰盐/);
  await unlink(path);
  const deleted = await recallBookMemory(workspace, a, { query: '黄铜月轮', chapterId: 'chapter-25' });
  assert.ok(deleted.earlierStory.every((row) => row.id !== before.id));
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).sources['chapter/chapter-2'], undefined);

  const ruleId = saved.conventions[0].id;
  const changed = '全书一律用第一人称';
  await conventionRun(
    runs,
    workspace,
    a,
    second.id,
    `请更新约定：${changed}。`,
    'book_memory_remember',
    { id: ruleId, text: changed },
  );
  assert.deepEqual((await recallBookMemory(workspace, a, { query: '' })).conventions, [
    { id: ruleId, text: changed },
  ]);
  await conventionRun(
    runs,
    workspace,
    a,
    second.id,
    `请忘掉这条约定：${changed}`,
    'book_memory_forget',
    { id: ruleId },
  );
  assert.deepEqual((await recallBookMemory(workspace, a, { query: '' })).conventions, []);
});

test('unsaved previews are never recalled, and a recalled source edited during drafting blocks commit', async (t) => {
  const { workspace, a, restart } = await fixture(t);
  await populate(workspace, a);
  const runs = await restart();
  const session = await runs.create({ cwd: workspace.bookRoot(a), bookId: a }, '新会话');
  const previewed = new Gate();
  const wait = new Gate();
  const marker = '未落盘的星银迷宫';
  const prompt = '续写三声钟响与黄铜月轮';
  const draft = (generate: import('../electron/agent/scripted.js').Script) =>
    new ScriptedProvider([() => answer(''), generate]);
  const provider = draft(async ({ onText, signal }) => {
    onText(marker);
    previewed.release();
    await wait.wait(signal);
    return answer(marker);
  });
  runs.start(session.id, prompt, async (ctx) => {
    await draftChapter(workspace, ctx, provider, 'chapter-25', 'draft', prompt, {
      plan: { nextBoundary },
    });
  });
  await previewed.wait(AbortSignal.timeout(5000));
  assert.equal(runs.get(session.id).run?.preview?.content, marker);
  const before = await recallBookMemory(workspace, a, { query: marker });
  assert.doesNotMatch(JSON.stringify(before), new RegExp(marker));
  await runs.stop(session.id);
  assert.equal(runs.get(session.id).run?.status, 'cancelled');
  assert.equal((await workspace.readDocument(a, chapter('chapter-25'))).body, '');

  const racing = draft(async ({ history }) => {
    assert.match(JSON.stringify(history), /三声钟响/);
    const source = await workspace.readDocument(a, chapter('chapter-2'));
    assert.equal((await workspace.writeDocument(a, { ...source, body: '另一个版本' })).error, undefined);
    return answer('基于旧版本的正文');
  });
  runs.start(session.id, prompt, async (ctx) => {
    await draftChapter(workspace, ctx, racing, 'chapter-25', 'draft', prompt, {
      plan: { nextBoundary },
    });
  });
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'failed');
  assert.match(runs.get(session.id).run?.error ?? '', /chapter-2 已变化/);
  assert.equal((await workspace.readDocument(a, chapter('chapter-25'))).body, '');
});

test('a cache-write failure still permits verified recall and a normal manuscript commit, not a fake saved convention', async (t) => {
  const { workspace, a, restart } = await fixture(t, true);
  assert.equal(
    (
      await workspace.writeChanges(a, [
        { ...chapter('first'), expect: null, fields: { order: 1, title: '开始' }, body: clue },
        { ...chapter('second'), expect: null, fields: { order: 2, title: '继续' }, body: '' },
      ])
    ).error,
    undefined,
  );
  assert.match(JSON.stringify(await recallBookMemory(workspace, a, { query: '黄铜月轮' })), /三声钟响/);
  const runs = await restart();
  const session = await runs.create({ cwd: workspace.bookRoot(a), bookId: a }, '新会话');
  await conventionRun(
    runs,
    workspace,
    a,
    session.id,
    `请记住：${rule}。`,
    'book_memory_remember',
    { text: rule },
    false,
  );
  const prompt = '写黄铜月轮';
  const provider = new ScriptedProvider([() => answer('钟声响起。')]);
  runs.start(session.id, prompt, async (ctx) => {
    await draftChapter(workspace, ctx, provider, 'second', 'draft', prompt);
  });
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.equal((await workspace.readDocument(a, chapter('second'))).body, '钟声响起。');
});
