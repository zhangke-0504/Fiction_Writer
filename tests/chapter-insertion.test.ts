import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WorkspaceService } from '../electron/workspace.js';
import { RunManager } from '../electron/agent/runs.js';
import { Journal } from '../electron/journal.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import { runAgent } from '../electron/agent/loop.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { captureWritingRequests } from './writing-request-fixture.js';
import { Gate, type Script } from '../electron/agent/scripted.js';
import { collectDiagnostics } from './diagnostic-fixture.js';

const author = '在故事中期插入一段陌生人登场的正文';
const entry = '增加一个跟2个以上已有主体有关联的反派及他的伏笔，在故事中期登场';
const before = '酒馆掌柜把油灯留在门边。';
const after = '众船仍在港里，守夜人没有离开。';
const original = before + '\r\n\r\n' + after;
const fragment = '一个戴灰帽的陌生人进来，把刻着三道线的指环递给掌柜。';
const outlineText =
  '<!-- chapter:chapter-5 -->\n\n接近酒馆。\n\n<!-- chapter:chapter-6 -->\n\n船出发。\n';
const doc = (n: number) => ({ type: 'chapter' as const, id: `chapter-${n}` });
const text = (value: string) => ({ role: 'assistant' as const, text: value, calls: [] });
const use = (name: string, args: unknown) => ({
  ...text(''),
  calls: [{ id: 'step-' + name, name, args: JSON.stringify(args) }],
});

async function fixture(t: import('node:test').TestContext, body = original) {
  const root = await mkdtemp(join(tmpdir(), 'fw-passage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceService({ libraryRoot: join(root, 'library') });
  await workspace.init();
  const { id } = await workspace.createBook({ title: '归家', summary: '风暴后的小城。' });
  const outline = await workspace.readDocument(id, { type: 'outline', id: 'outline' });
  const result = await workspace.writeChanges(id, [
    { ...outline, expect: outline.revision, body: outlineText },
    ...Array.from({ length: 10 }, (_, i) => ({
      ...doc(i + 1),
      fields: { title: `航程 ${i + 1}`, order: i + 1 },
      expect: null,
      body: i === 4 ? body : `第 ${i + 1} 章已写定。`,
    })),
  ]);
  assert.equal(result.error, undefined);
  const catalog = new SkillCatalog(fileURLToPath(new URL('../skills', import.meta.url)));
  const runs = new RunManager(join(root, 'state'), new Journal(() => {}));
  await runs.init();
  const session = await runs.create({ cwd: workspace.bookRoot(id), bookId: id }, '写这本');
  const target = await workspace.readDocument(id, doc(5));
  const currentOutline = await workspace.readDocument(id, outline);
  const start = (prompt: string, script: Script[]) => {
    const { provider, requests } = captureWritingRequests(script);
    const trace = collectDiagnostics();
    const novel = new NovelTools(workspace, id, provider, catalog, { authorPrompt: prompt });
    runs.start(
      session.id,
      prompt,
      async (ctx) => {
        await runAgent(ctx, provider, '只操作作者要求的作品。', [], prompt, novel.tools());
      },
      'high',
      trace.report,
    );
    return {
      requests,
      trace,
      stop: () => runs.stop(session.id),
      wait: async () => {
        await runs.wait(session.id);
        return runs.get(session.id).run!;
      },
    };
  };
  const operation = {
    chapterId: target.id,
    mode: 'insert',
    insertion: {
      revision: target.revision,
      quote: before,
      place: 'after',
      outline: { revision: currentOutline.revision, addition: '灰帽陌生人在酒馆登场。' },
    },
  };
  return { workspace, id, target, currentOutline, start, operation };
}

test('an authorized middle-scene insertion preserves existing body bytes, chapter order, and unrelated outline', async (t) => {
  const f = await fixture(t);
  const initial = await f.workspace.readAll(f.id);
  const op = f.start(author, [
    () => use('book_generate_chapter', f.operation),
    ({ history, system }) => {
      const payload = JSON.stringify(history);
      assert.match(system, /只输出要放入指定锚点/);
      assert.match(payload, new RegExp(before));
      assert.match(payload, new RegExp(after));
      assert.doesNotMatch(payload, /第 6 章已写定/);
      return text(fragment);
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"inserted":true.*"outlineUpdated":true/);
      return text('已增补。');
    },
  ]);
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  const current = await f.workspace.readAll(f.id);
  assert.equal(
    current.documents.find((d) => d.id === f.target.id)!.body,
    before + '\r\n\r\n' + fragment + '\r\n\r\n' + after,
  );
  assert.deepEqual(
    current.documents.filter((d) => d.type === 'chapter' && d.id !== f.target.id),
    initial.documents.filter((d) => d.type === 'chapter' && d.id !== f.target.id),
  );
  const updatedOutline = await f.workspace.readDocument(f.id, f.currentOutline);
  assert.equal(updatedOutline.body.replace('灰帽陌生人在酒馆登场。\n\n', ''), outlineText);
  assert.deepEqual(op.trace.rejected, []);
});

test('an insertion drops exact echoes of both neighboring paragraphs, not new prose with overlapping words', async (t) => {
  const f = await fixture(t);
  const added = fragment + '\n\n' + '掌柜回头望向港里的众船。';
  const op = f.start(author, [
    () => use('book_generate_chapter', f.operation),
    () => text([before, added, after].join('\n\n')),
    () => text('已增补。'),
  ]);
  assert.equal((await op.wait()).status, 'completed');
  assert.equal(
    (await f.workspace.readDocument(f.id, f.target)).body,
    before + '\r\n\r\n' + added + '\r\n\r\n' + after,
  );
});

test('an insertion with no new prose does not commit the chapter or outline', async (t) => {
  const f = await fixture(t);
  const op = f.start(author, [
    () => use('book_generate_chapter', f.operation),
    () => text(after),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /没有可提交的新增段落/);
      return text('没有写入。');
    },
  ]);
  assert.equal((await op.wait()).status, 'completed');
  assert.equal((await f.workspace.readDocument(f.id, f.target)).body, original);
  assert.equal((await f.workspace.readDocument(f.id, f.currentOutline)).body, outlineText);
});

for (const problem of [
  'notes-only',
  'wrong-region',
  'stale-anchor',
  'ambiguous-anchor',
  'next-conflict',
] as const) {
  test(`passage insertion rejects ${problem} without falling back to chapter replacement`, async (t) => {
    const f = await fixture(t, problem === 'ambiguous-anchor' ? original + '\n\n' + before : original);
    const operation = structuredClone(f.operation);
    let expected = 'insert_not_authorized';
    if (problem === 'wrong-region') operation.chapterId = doc(10).id;
    if (problem === 'stale-anchor') {
      operation.insertion.revision = 'f'.repeat(64);
      expected = 'conflict';
    }
    if (problem === 'ambiguous-anchor') expected = 'invalid_anchor';
    const opt =
      problem === 'next-conflict'
        ? {
            ...operation,
            nextBoundary: {
              chapterId: doc(6).id,
              conditions: [
                { quote: '第 6 章已写定。', condition: '这里的物件仍未出现。', conflict: true },
              ],
            },
          }
        : operation;
    if (problem === 'next-conflict') expected = 'continuity_conflict';
    const op = f.start(problem === 'notes-only' ? '只生成反派说明，不修改任何章节。' : author, [
      () => use('book_generate_chapter', opt),
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), new RegExp(expected));
        return text('没有写入。');
      },
    ]);
    const end = await op.wait();
    assert.equal(end.status, 'completed', end.error);
    assert.equal(op.requests.filter(({ lane }) => lane === 'draft').length, 0);
    assert.equal((await f.workspace.readDocument(f.id, f.target)).body, f.target.body);
    assert.equal((await f.workspace.readDocument(f.id, f.currentOutline)).body, outlineText);
  });
}

for (const change of ['cancel', 'external-edit'] as const) {
  test(`a streamed insertion with ${change} does not save its new prose or outline`, async (t) => {
    const f = await fixture(t);
    const ready = new Gate(),
      proceed = new Gate();
    const op = f.start(author, [
      () => use('book_generate_chapter', f.operation),
      async ({ onText, signal }) => {
        onText(fragment);
        ready.release();
        await proceed.wait(signal);
        return text(fragment);
      },
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), /conflict/);
        return text('原稿已变化。');
      },
    ]);
    await ready.wait(AbortSignal.timeout(5000));
    if (change === 'cancel') await op.stop();
    else {
      const edit = await f.workspace.writeChanges(f.id, [
        { ...f.target, expect: f.target.revision, body: original + '\n\n作者同时编辑。' },
      ]);
      assert.equal(edit.error, undefined);
      proceed.release();
    }
    const end = await op.wait();
    assert.equal(end.status, change === 'cancel' ? 'cancelled' : 'completed', end.error);
    const chapter = await f.workspace.readDocument(f.id, f.target);
    assert.equal(chapter.body, change === 'cancel' ? original : original + '\n\n作者同时编辑。');
    assert.equal((await f.workspace.readDocument(f.id, f.currentOutline)).body, outlineText);
  });
}

test('the connected entry cannot be inserted before its actual actor and clue have been saved', async (t) => {
  const f = await fixture(t);
  const op = f.start(entry, [
    () => use('book_generate_chapter', f.operation),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /同一埋设章/);
      return text('未提交。');
    },
  ]);
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.equal(op.requests.filter(({ lane }) => lane === 'draft').length, 0);
  assert.equal((await f.workspace.readDocument(f.id, f.target)).body, original);
});

test('the tool does not draft a second insertion after a successful local addition', async (t) => {
  const f = await fixture(t);
  const op = f.start(author, [
    () => use('book_generate_chapter', f.operation),
    () => text(fragment),
    () => use('book_generate_chapter', f.operation),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /局部增补已经提交/);
      return text('保留第一次的写入。');
    },
  ]);
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.equal(op.requests.filter(({ lane }) => lane === 'draft').length, 1);
});
