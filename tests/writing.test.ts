import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceService } from '../electron/workspace.js';
import { RunManager } from '../electron/agent/runs.js';
import { Journal } from '../electron/journal.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import { runAgent } from '../electron/agent/loop.js';
import { ScriptedProvider } from '../electron/agent/scripted.js';
import { loadSkills } from '../electron/agent/skills.js';
import { fileURLToPath } from 'node:url';
import { chapterContext } from '../electron/agent/chapter-context.js';
import { draftChapter } from '../electron/agent/draft.js';
import type { Manuscript } from '../shared/contracts.js';
const text = (value: string) => ({ role: 'assistant' as const, text: value, calls: [] });
const call = (id: string, name: string, args: unknown) => ({
  ...text(''),
  calls: [{ id, name, args: JSON.stringify(args) }],
});
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'fw-writing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceService({ libraryRoot: join(root, 'library') });
  await workspace.init();
  const { id } = await workspace.createBook({ title: '雾中归航', summary: '寻找灯塔', style: '克制' });
  const journal = new Journal(() => {}),
    runs = new RunManager(join(root, 'state'), journal);
  await runs.init();
  const session = await runs.create({ cwd: workspace.bookRoot(id), bookId: id }, '测试');
  const skills = await loadSkills(fileURLToPath(new URL('../skills', import.meta.url)));
  const outline = await workspace.readDocument(id, { type: 'outline', id: 'outline' });
  const report = await workspace.writeChanges(id, [
    { ...outline, expect: outline.revision, body: '父亲留下 [钥匙](subjects/key.md)。' },
    {
      type: 'subject',
      id: 'key',
      expect: null,
      fields: { name: '钥匙', kind: 'item' },
      body: '父亲留下。',
    },
    {
      type: 'subject',
      id: 'town',
      expect: null,
      fields: { name: '海岬', kind: 'scene' },
      body: '一处无关的岸。',
    },
    {
      type: 'chapter',
      id: 'one',
      expect: null,
      fields: { title: '潮起', order: 1 },
      body: '月升后，远处有蓝光。',
    },
    {
      type: 'chapter',
      id: 'two',
      expect: null,
      fields: { title: '归航', order: 2 },
      body: '她推开小门。',
    },
    {
      type: 'clue',
      id: 'promise',
      expect: null,
      fields: {
        title: '钥匙的来历',
        subjectIds: ['key'],
        setupChapterId: 'one',
        payoffChapterId: 'two',
      },
      body: '父亲留下钥匙，约定重逢。',
    },
  ]);
  assert.equal(report.error, undefined);
  return { workspace, root, id, runs, session, skills };
}

test('story consistency requires the current read set and applies only affected documents', async (t) => {
  const { workspace, id, runs, session, skills } = await fixture(t);
  const town = await workspace.readDocument(id, { type: 'subject', id: 'town' });
  const provider = new ScriptedProvider([
    () =>
      call('apply-too-soon', 'book_apply_changes', {
        operations: [{ type: 'subject', id: 'key', action: 'update', body: '母亲留下。' }],
      }),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /先用 book_get_context/);
      return call('context1', 'book_get_context', {});
    },
    ({ history, system }) => {
      const read = JSON.stringify(history.at(-1));
      assert.match(read, /父亲留下/);
      assert.match(read, /钥匙的来历/);
      assert.match(system, /反向检查/);
      return call('apply1', 'book_apply_changes', {
        operations: [
          { type: 'subject', id: 'key', action: 'update', body: '母亲留下。' },
          {
            type: 'outline',
            id: 'outline',
            action: 'update',
            body: '母亲留下 [钥匙](subjects/key.md)。',
          },
          { type: 'clue', id: 'promise', action: 'update', body: '母亲留下钥匙，约定重逢。' },
        ],
      });
    },
    ({ history }) => {
      assert.ok(JSON.stringify(history.at(-1)).includes('committed'));
      return text('已调整三处');
    },
  ]);
  runs.start(session.id, '调整钥匙来历', (ctx) =>
    runAgent(
      ctx,
      provider,
      skills.consistency,
      [],
      '调整钥匙来历',
      new NovelTools(workspace, id, provider, skills).tools(),
    ).then(() => {}),
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  const after = await workspace.readAll(id);
  assert.match(after.documents.find((d) => d.id === 'key')!.body, /母亲/);
  assert.match(after.documents.find((d) => d.id === 'promise')!.body, /母亲/);
  assert.deepEqual(after.diagnostics, []);
  assert.equal(after.documents.find((d) => d.id === 'town')!.revision, town.revision);
  assert.equal(after.documents.find((d) => d.id === 'two')!.body, '她推开小门。');

  const reverse = new ScriptedProvider([
    () => call('context2', 'book_get_context', {}),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /母亲留下/);
      return call('apply2', 'book_apply_changes', {
        operations: [
          { type: 'outline', id: 'outline', action: 'update', body: '移走钥匙的回收安排。' },
          {
            type: 'clue',
            id: 'promise',
            action: 'update',
            fields: { payoffChapterId: null },
            body: '母亲留下钥匙，暂不回收。',
          },
        ],
      });
    },
    () => text('大纲和伏笔回收已更新，主体保留。'),
  ]);
  runs.start(session.id, '改大纲', (ctx) =>
    runAgent(
      ctx,
      reverse,
      skills.consistency,
      [],
      '改大纲',
      new NovelTools(workspace, id, reverse, skills).tools(),
    ).then(() => {}),
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.equal(
    (await workspace.readDocument(id, { type: 'clue', id: 'promise' })).fields.payoffChapterId,
    undefined,
  );
  assert.match((await workspace.readDocument(id, { type: 'subject', id: 'key' })).body, /母亲/);
});

test('chapter drafting uses prior prose, relevant clues, subject facts, and keeps continuation as an append', async (t) => {
  const { workspace, id, runs, session, skills } = await fixture(t);
  const provider = new ScriptedProvider([
    ({ history, system, onText }) => {
      const input = JSON.stringify(history);
      assert.match(input, /远处有蓝光/);
      assert.match(input, /钥匙的来历/);
      assert.match(input, /父亲留下/);
      assert.match(input, /小门/);
      assert.match(system, /不复述/);
      onText('看到了潮光。');
      return text('看到了潮光。');
    },
  ]);
  runs.start(session.id, '续写', (ctx) =>
    draftChapter(workspace, ctx, provider, 'two', 'append', '承接上一幕', {
      skill: skills.chapter,
    }).then(() => {}),
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.equal(
    (await workspace.readDocument(id, { type: 'chapter', id: 'two' })).body,
    '她推开小门。\n\n看到了潮光。',
  );
});

test('long chapter context uses real excerpts with source IDs and prioritizes recent prose', () => {
  const make = (id: string, order: number, body: string): Manuscript => ({
    type: 'chapter',
    id,
    body,
    fields: { title: id, order },
    revision: 'r',
  });
  const early = make('early', 1, `较早的真相。\n\n${'中'.repeat(28000)}\n\n较早的结尾。`),
    last = make('latest', 2, '最新发生的具体事情。'),
    target = make('target', 3, '');
  const context = chapterContext([early, last, target], target, 3000);
  assert.equal(context.previous.at(-1)?.text, last.body);
  assert.match(context.previous[0].header, /chapters\/early\.md/);
  assert.match(context.previous[0].text, /开头与结尾摘录/);
  assert.match(context.previous[0].text, /较早的结尾/);
  assert.ok(context.previous[0].text.length < early.body.length);
});

test('long chapter generation can retrieve a missed passage before showing prose', async (t) => {
  const { workspace, id, runs, session, skills } = await fixture(t);
  const earlier = await workspace.readDocument(id, { type: 'chapter', id: 'one' });
  const fact = '潮汐誓言从不允许携火过桥。';
  const body = `开篇。\n\n${'甲'.repeat(32_000)}\n\n${fact}\n\n${'乙'.repeat(32_000)}\n\n结尾。`;
  assert.equal((await workspace.writeDocument(id, { ...earlier, body })).error, undefined);
  const provider = new ScriptedProvider([
    ({ history, tools, onText }) => {
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['book_read_chapter'],
      );
      assert.match(history[0].role === 'user' ? history[0].text : '', /"chapterId":"one"/);
      assert.ok(!JSON.stringify(history).includes(fact));
      onText('这段取材说明不是正文。');
      return call('lookup', 'book_read_chapter', { chapterId: 'one', query: '潮汐誓言' });
    },
    ({ history, tools, onText }) => {
      assert.deepEqual(tools, []);
      assert.equal(runs.get(session.id).run?.preview, undefined);
      assert.match(JSON.stringify(history), new RegExp(fact));
      assert.ok(!JSON.stringify(history).includes('这段取材说明不是正文'));
      onText('她放下火把才继续过桥。');
      assert.match(runs.get(session.id).run?.preview?.content ?? '', /放下火把/);
      return text('她放下火把才继续过桥。');
    },
  ]);
  runs.start(session.id, '续写', (ctx) =>
    draftChapter(workspace, ctx, provider, 'two', 'append', '核对前文的潮汐誓言', {
      skill: skills.chapter,
    }).then(() => {}),
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  const saved = await workspace.readDocument(id, { type: 'chapter', id: 'two' });
  assert.equal(saved.body, '她推开小门。\n\n她放下火把才继续过桥。');
  assert.equal((await workspace.readDocument(id, earlier)).body, body);
});

test('writing based on a reread passage rejects a later change to that source', async (t) => {
  const { workspace, id, runs, session, skills } = await fixture(t);
  const original = await workspace.readDocument(id, { type: 'chapter', id: 'one' });
  assert.equal(
    (await workspace.writeDocument(id, { ...original, body: `${'甲'.repeat(60_000)}取材出处` })).error,
    undefined,
  );
  const before = await workspace.readDocument(id, { type: 'chapter', id: 'two' });
  const provider = new ScriptedProvider([
    () => call('lookup', 'book_read_chapter', { chapterId: 'one', offset: 100, length: 100 }),
    async () => {
      const current = await workspace.readDocument(id, original);
      assert.equal(
        (await workspace.writeDocument(id, { ...current, body: '作者修订了前章。' })).error,
        undefined,
      );
      return text('不应提交这一稿。');
    },
  ]);
  runs.start(session.id, '续写', (ctx) =>
    draftChapter(workspace, ctx, provider, 'two', 'append', '核对前章', { skill: skills.chapter }).then(
      () => {},
    ),
  );
  await runs.wait(session.id);
  const run = runs.get(session.id).run;
  assert.equal(run?.status, 'failed');
  assert.match(run?.error ?? '', /chapter\/one 已变化/);
  assert.equal(run?.preview, undefined);
  assert.equal((await workspace.readDocument(id, before)).revision, before.revision);
});
