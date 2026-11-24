import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NovelTools } from '../electron/agent/novel-tools.js';
import { defaultRoundLimit, runAgent } from '../electron/agent/loop.js';
import { RunManager } from '../electron/agent/runs.js';
import { ScriptedProvider, type Script } from '../electron/agent/scripted.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { Journal } from '../electron/journal.js';
import { WorkspaceService } from '../electron/workspace.js';

const chapterIds = ['one', 'two', 'three'];
const text = (text: string) => ({ role: 'assistant' as const, text, calls: [] });
const tool = (id: string, name: string, args: object) => ({
  ...text(''),
  calls: [{ id, name, args: JSON.stringify(args) }],
});
const goal = (action: 'register' | 'check', ids?: string[]) =>
  tool(`${action}-${ids?.length ?? 0}`, 'book_get_context', { novelGoal: { action, chapterIds: ids } });
const activate = () => tool('skill', 'skill_load', { name: 'generate-novel' });
async function fixture(t: TestContext, authored: number) {
  const root = await mkdtemp(join(tmpdir(), 'fw-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceService({ libraryRoot: join(root, 'library') });
  await workspace.init();
  const book = await workspace.createBook({ title: '旅程', summary: '船员寻家' });
  const state = join(root, 'state');
  const runs = new RunManager(state, new Journal(() => {}));
  await runs.init();
  const session = await runs.create({ cwd: workspace.bookRoot(book.id), bookId: book.id }, 'test');
  const catalog = new SkillCatalog(fileURLToPath(new URL('../skills', import.meta.url)));
  const id = book.id;
  const outline = await workspace.readDocument(id, { type: 'outline', id: 'outline' });
  const result = await workspace.writeChanges(id, [
    { ...outline, expect: outline.revision, body: '神秘来信引导船回家。' },
    {
      type: 'subject',
      id: 'letter',
      fields: { name: '来信', kind: 'item' },
      expect: null,
      body: '藏有归途。',
    },
    ...chapterIds.map((id, i) => ({
      type: 'chapter' as const,
      id,
      fields: { title: `章节 ${i + 1}`, order: i + 1 },
      expect: null,
      body: i < authored ? `作者原稿 ${i + 1}` : '',
    })),
    {
      type: 'clue',
      id: 'return',
      fields: {
        title: '回程暗号',
        subjectIds: ['letter'],
        setupChapterId: 'one',
        payoffChapterId: 'three',
      },
      expect: null,
      body: '早收到的信后来指出回家的路。',
    },
  ]);
  assert.equal(result.error, undefined);
  return { workspace, runs, session, id, catalog, state };
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  prompt: string,
  script: Script[],
  modelPrompt = prompt,
) {
  const model = new ScriptedProvider(script);
  const { runs, catalog, session, workspace, id } = f;
  const novel = new NovelTools(workspace, id, model, catalog, { authorPrompt: prompt });
  runs.start(session.id, prompt, async (ctx) => {
    await runAgent(
      ctx,
      model,
      '',
      [],
      modelPrompt,
      [...catalog.tools((name) => novel.skillApplied(name)), ...novel.tools()],
      novel,
    );
    await novel.assertFinished(ctx);
  });
  await runs.wait(session.id);
  return runs.get(session.id).run!;
}

for (const authored of [0, 2]) {
  test(`backend verifies the entire frozen goal instead of a model's done claim (${authored} of 3 saved)`, async (t) => {
    const f = await fixture(t, authored);
    const result = await run(f, '写3章完整小说', [
      activate,
      () => goal('register', chapterIds),
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), new RegExp(`"done":${authored},"total":3`));
        assert.match(JSON.stringify(history.at(-1)), /"complete":false/);
        return goal('register', ['one']);
      },
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), /novel_goal_conflict/);
        return text('已经全部生成');
      },
    ]);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /整书未完成/);
    assert.deepEqual(
      result.progress && [result.progress.done, result.progress.total, result.progress.complete],
      [authored, 3, false],
    );
  });
}

test('a saved catalog and the model claim are not success without a registered goal', async (t) => {
  const result = await run(await fixture(t, 0), '写完小说', [activate, () => text('已经全部生成')]);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /未登记/);
});

test('a supplied count cannot be silently reduced at initial registration', async (t) => {
  const result = await run(await fixture(t, 3), '希望大概写10章左右', [
    activate,
    () => goal('register', chapterIds),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /作者指定了 10 章/);
      return text('无法完成');
    },
  ]);
  assert.equal(result.status, 'failed');
});

test('already saved chapters are reused and only the next empty chapter is drafted', async (t) => {
  const f = await fixture(t, 2);
  const generate = (id: string) =>
    tool(`draft-${id}`, 'book_generate_chapter', { mode: 'draft', chapterId: id });
  const result = await run(f, '写3章完整小说', [
    activate,
    () => goal('register', chapterIds),
    () => generate('one'),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"reused":true/);
      return generate('three');
    },
    () => text('她从信里读懂暗号。船转向家乡，平安进港。'),
    () => goal('check'),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"complete":true/);
      return text('全书已保存');
    },
  ]);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.progress?.done, 3);
  assert.equal(result.progress?.complete, true);
  assert.equal(
    (await f.workspace.readDocument(f.id, { type: 'chapter', id: 'one' })).body,
    '作者原稿 1',
  );
  assert.match(
    (await f.workspace.readDocument(f.id, { type: 'chapter', id: 'three' })).body,
    /平安进港/,
  );
});

const resume = (updateDirection = false) =>
  tool('resume', 'book_get_context', { novelGoal: { action: 'resume', updateDirection } });
const draftThird = () =>
  tool('draft-third', 'book_generate_chapter', { chapterId: 'three', mode: 'draft' });
async function reboot(f: Awaited<ReturnType<typeof fixture>>) {
  const runs = new RunManager(f.state, new Journal(() => {}));
  await runs.init();
  return { ...f, runs };
}

test('resuming takes direction from the saved author message, not an attachment or a recent transcript', async (t) => {
  let f = await fixture(t, 2);
  const original = '写完这本小说。坚持第一人称航海日志。';
  const amendment = '接着写完，改用第三人称叙述。';
  const attachment = 'fixture-attachment-content-not-for-resume';
  await run(
    f,
    original,
    [activate, () => goal('register', chapterIds), () => text('已暂停')],
    `${original}\n${attachment}`,
  );
  f = await reboot(f);
  await run(f, amendment, [
    activate,
    () => resume(true),
    ({ history }) => {
      const result = JSON.stringify(history.at(-1));
      assert.match(result, /第一人称航海日志/);
      assert.doesNotMatch(result, new RegExp(attachment));
      return text('再次暂停，尚未生成第三章');
    },
  ]);
  f = await reboot(f);
  const before = await f.workspace.readDocument(f.id, { type: 'chapter', id: 'one' });
  const result = await run(f, '接着写完', [
    activate,
    () => resume(),
    ({ history }) => {
      const entry = JSON.stringify(history.at(-1));
      assert.match(entry, /第一人称航海日志/);
      assert.match(entry, /第三人称叙述/);
      assert.doesNotMatch(entry, new RegExp(attachment));
      return draftThird();
    },
    ({ history }) => {
      const context = JSON.stringify(history);
      assert.match(context, /第一人称航海日志.+第三人称叙述.+接着写完/);
      assert.doesNotMatch(context, new RegExp(attachment));
      return text('她折好罗盘下的来信，迎着岸灯回家了。');
    },
    () => text('已保存第三章'),
  ]);
  assert.equal(result.status, 'completed', result.error);
  assert.equal((await f.workspace.readDocument(f.id, before)).revision, before.revision);
  const journal = await readFile(join(f.state, 'sessions', `${f.session.id}.jsonl`), 'utf8');
  assert.doesNotMatch(journal, new RegExp(attachment));
  const rows = journal
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const tasks = rows.filter((row) => 'novelTask' in row);
  assert.ok(tasks.some((row) => Number.isSafeInteger(row.novelTask?.originalLine)));
  assert.doesNotMatch(JSON.stringify(tasks.map((row) => row.novelTask)), /第一人称|第三人称/);
  assert.equal(tasks.at(-1).novelTask, null);
});

test('resuming cannot silently recreate a chapter that disappeared from the saved catalog', async (t) => {
  let f = await fixture(t, 2);
  await run(f, '生成整本小说', [activate, () => goal('register', chapterIds), () => text('先停止')]);
  await f.workspace.deleteDocument(f.id, { type: 'chapter', id: 'three' });
  f = await reboot(f);
  const result = await run(f, '接着写完', [
    activate,
    () => resume(),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /原目录中的章节已缺失/);
      return tool('recreate', 'book_apply_changes', {
        operations: [
          {
            type: 'chapter',
            id: 'three',
            action: 'create',
            fields: { title: '第三章', order: 3 },
          },
        ],
      });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /novel_goal_conflict/);
      return text('目录被改动，未写入');
    },
  ]);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /已缺失/);
  await assert.rejects(f.workspace.readDocument(f.id, { type: 'chapter', id: 'three' }));
});

test('a registered chapter goal uses the same model round limit', async (t) => {
  const f = await fixture(t, 2);
  let repeatedRounds = 0;
  const repeat = (i: number) => () => {
    repeatedRounds++;
    return tool(`repeat-${i}`, 'book_get_context', { index: 'chapters' });
  };
  const result = await run(f, '写3章完整小说', [
    activate,
    () => goal('register', chapterIds),
    ...Array.from({ length: defaultRoundLimit - 2 }, (_, i) => repeat(i)),
    () => {
      throw new Error('must not exceed the shared round limit');
    },
  ]);
  assert.equal(repeatedRounds + 2, defaultRoundLimit);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /往返上限/);
});

test('the same whole-book Run can fill a required note and retry the blocked chapter without a stage machine', async (t) => {
  const f = await fixture(t, 2);
  const subject = { type: 'subject' as const, id: 'navigator' };
  assert.equal(
    (
      await f.workspace.writeChanges(f.id, [
        { ...subject, expect: null, fields: { name: '领航员', kind: 'character' }, body: '待补' },
      ])
    ).error,
    undefined,
  );
  const draft = (id: string) =>
    tool(id, 'book_generate_chapter', { mode: 'draft', chapterId: 'three', subjectIds: [subject.id] });
  const result = await run(f, '写3章完整小说，保留旧稿并补领航员的说明', [
    activate,
    () => goal('register', chapterIds),
    () => draft('missing-note'),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /context_required.*navigator/s);
      return tool('fill-note', 'book_generate_assets', {
        kind: 'subject',
        action: 'fill',
        targets: [{ id: subject.id }],
      });
    },
    () =>
      tool('candidate', 'submit_story_descriptions', {
        items: [{ id: subject.id, body: '## 稳定设定\n潮差超过两尺时不离港。CONTINUITY_FIXTURE' }],
      }),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":true/);
      assert.doesNotMatch(JSON.stringify(history.at(-1)), /CONTINUITY_FIXTURE/);
      return draft('after-fill');
    },
    ({ history, tools }) => {
      assert.deepEqual(tools, []);
      assert.match(JSON.stringify(history), /CONTINUITY_FIXTURE/);
      return text('等潮水平缓下来，他们才驶出海湾。');
    },
    () => goal('check'),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"complete":true/);
      return text('完成。');
    },
  ]);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(
    (await f.workspace.readDocument(f.id, { type: 'chapter', id: 'one' })).body,
    '作者原稿 1',
  );
});

test('an interrupted goal resumes from the saved opening cards without rewriting them', async (t) => {
  let f = await fixture(t, 0);
  const letter = await f.workspace.readDocument(f.id, { type: 'subject', id: 'letter' });
  const clue = await f.workspace.readDocument(f.id, { type: 'clue', id: 'return' });
  const premise = '只有掌灯者能辨认旧信上的刻痕';
  const secret = '真正的信使是藏在船舱里的王子';
  const changes = await f.workspace.writeChanges(f.id, [
    { ...letter, expect: letter.revision, body: `## 稳定设定\n掌灯者需要人证。${premise}。` },
    {
      ...clue,
      expect: clue.revision,
      body: `## 可见线索\n来信由人证交给掌灯者。\n\n## 回收真相\n回收时再问「人证」。${premise}。\n揭示事实：${secret}。`,
    },
  ]);
  assert.equal(changes.error, undefined);
  const initial = (await f.workspace.readAll(f.id)).documents.filter(
    (d) => d.type === 'clue' || d.type === 'subject',
  );
  const previous = await run(f, '写3章完整小说', [
    activate,
    () => goal('register', chapterIds),
    () => text('首章准备不通过，已停止。'),
  ]);
  assert.equal(previous.status, 'failed');
  assert.equal(previous.progress?.done, 0);
  f = await reboot(f);
  const gen = (chapterId: string) =>
    tool('draft-' + chapterId, 'book_generate_chapter', { mode: 'draft', chapterId });
  const actual = await run(f, '继续', [
    activate,
    () => resume(),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"done":0/);
      return gen('one');
    },
    ({ history, tools }) => {
      assert.deepEqual(tools, []);
      assert.match(JSON.stringify(history), new RegExp(premise));
      assert.doesNotMatch(JSON.stringify(history), new RegExp(secret));
      return text('掌灯者接过来信。');
    },
    () => gen('two'),
    () => text('船绕过雨幕。'),
    () => gen('three'),
    ({ history }) => {
      assert.match(JSON.stringify(history), new RegExp(secret));
      return text('王子以真名接过来信。');
    },
    () => goal('check'),
    () => text('已写完三章。'),
  ]);
  assert.equal(actual.status, 'completed', actual.error);
  assert.deepEqual(
    (await f.workspace.readAll(f.id)).documents.filter((d) => d.type === 'clue' || d.type === 'subject'),
    initial,
  );
});
