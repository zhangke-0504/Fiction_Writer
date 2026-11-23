import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceService } from '../electron/workspace.js';
import { WorkflowStore } from '../electron/agent/workflow.js';
import { RunManager } from '../electron/agent/runs.js';
import { ScriptedProvider, type Script } from '../electron/agent/scripted.js';
import { Journal } from '../electron/journal.js';
import { loadSkills } from '../electron/agent/skills.js';
import type { DocRef } from '../shared/contracts.js';
import type { ModelProvider } from '../electron/agent/model.js';

const reply = (text: string) => ({ role: 'assistant' as const, text, calls: [] });
const outline =
  '<!-- beat:notice -->\n\n第一幕：守塔人交出钥匙。\n\n<!-- beat:return -->\n\n第二幕：灯塔引导她归来。';
const staged: Script[] = [
  ({ history }) => {
    assert.match(JSON.stringify(history), /确定全书大纲/);
    return reply(outline);
  },
  ({ history }) => {
    assert.match(JSON.stringify(history), /生成主体/);
    return reply(
      JSON.stringify({
        subjects: [{ id: 'key', name: '钥匙', kind: 'item', body: '母亲留给守塔人。' }],
      }),
    );
  },
  ({ history }) => {
    assert.match(JSON.stringify(history), /生成伏笔/);
    return reply(
      JSON.stringify({
        clues: [
          {
            id: 'promise',
            title: '重逢',
            subjectIds: ['key'],
            setupBeatId: 'notice',
            payoffBeatId: 'return',
            body: '钥匙打开望台门。',
          },
        ],
      }),
    );
  },
  ({ history }) => {
    assert.match(JSON.stringify(history), /生成章节目录/);
    return reply(
      JSON.stringify({
        chapters: [
          { id: 'a', title: '出航', beatIds: ['notice'] },
          { id: 'b', title: '归航', beatIds: ['return'] },
        ],
      }),
    );
  },
];
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'fw-workflow-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const state = join(root, 'state'),
    workspace = new WorkspaceService({ libraryRoot: join(root, 'library') });
  await workspace.init();
  const { id } = await workspace.createBook({ title: '灯塔', summary: '在大雾中展开冒险' });
  const skills = await loadSkills(fileURLToPath(new URL('../skills', import.meta.url)));
  async function load() {
    const diary = new Journal(() => {}),
      workflow = new WorkflowStore(state);
    await workflow.init();
    const runs = new RunManager(state, diary, (bookId) => workflow.progress(bookId));
    await runs.init();
    return { runs, workflow };
  }
  const first = await load(),
    session = await first.runs.create({ cwd: workspace.bookRoot(id), bookId: id }, '灯塔');
  async function run(
    controller: typeof first,
    model: ModelProvider,
    restart = false,
    direction = '两章短篇',
    references = '',
  ) {
    controller.runs.start(session.id, direction, (ctx) =>
      controller.workflow.run(workspace, ctx, model, skills, direction, restart, references),
    );
    await controller.runs.wait(session.id);
    return controller.runs.get(session.id).run;
  }
  const read = (type: DocRef['type'], docId: string) => workspace.readDocument(id, { type, id: docId });
  return { id, read, workspace, state, session, load, run, first };
}

test('fresh whole-novel plan binds clues before prose and resumes after a failed second chapter', async (t) => {
  const f = await fixture(t);
  let firstPreview = false;
  const result = await f.run(
    f.first,
    new ScriptedProvider([
      ...staged,
      async ({ onText }) => {
        const clue = await f.read('clue', 'promise');
        assert.equal(clue.fields.setupChapterId, 'a');
        assert.equal(clue.fields.payoffChapterId, 'b');
        assert.equal(clue.fields.setupBeatId, undefined);
        onText('她乘船');
        const snap = f.first.runs.get(f.session.id).run?.preview;
        firstPreview = snap?.chapterId === 'a' && snap.content === '她乘船';
        assert.equal((await f.read('chapter', 'a')).body, '');
        onText('离岸。');
        return reply('她乘船离岸。');
      },
      () => {
        throw new Error('夹具：第二章服务断开');
      },
    ]),
  );
  assert.equal(firstPreview, true);
  assert.equal(result?.status, 'failed');
  assert.match(result?.error ?? '', /第二章/);
  const saved = await f.read('chapter', 'a');
  assert.equal(saved.body, '她乘船离岸。');
  assert.equal((await f.read('chapter', 'b')).body, '');
  assert.match(f.first.workflow.progress(f.id)?.step ?? '', /归航/);
  const statePath = join(f.state, 'workflows', `${f.id}.json`);
  assert.ok(!(await readFile(statePath, 'utf8')).includes('她乘船'));
  const restarted = await f.load();
  assert.equal(restarted.runs.snapshot().sessions[0].workflow?.done, 5);
  const pass = await f.run(
    restarted,
    new ScriptedProvider([
      ({ history, onText }) => {
        assert.match(JSON.stringify(history), /她乘船离岸/);
        onText('灯亮了。');
        return reply('灯亮了。');
      },
    ]),
  );
  assert.equal(pass?.status, 'completed', pass?.error);
  assert.equal((await f.read('chapter', 'a')).revision, saved.revision);
  assert.equal((await f.read('chapter', 'b')).body, '灯亮了。');
  assert.equal(restarted.workflow.progress(f.id)?.complete, true);
});

test('retains authored chapters and blocks stale checkpoint prerequisites until explicit replanning', async (t) => {
  const f = await fixture(t);
  const failed = await f.run(
    f.first,
    new ScriptedProvider([
      ...staged,
      () => {
        throw new Error('无法写第一章');
      },
    ]),
  );
  assert.equal(failed?.status, 'failed');
  const first = await f.read('chapter', 'a');
  assert.equal(
    (await f.workspace.writeDocument(f.id, { ...first, body: '手写内容。' })).error,
    undefined,
  );
  const restarted = await f.load();
  const result = await f.run(restarted, new ScriptedProvider([]));
  assert.equal(result?.status, 'failed');
  assert.match(result?.error ?? '', /前提已变化/);
  assert.equal(restarted.workflow.progress(f.id)?.blocked, true);
  const newPlan = await f.run(
    restarted,
    new ScriptedProvider([
      ({ history }) => {
        assert.match(JSON.stringify(history), /手写内容/);
        return reply('新书第二章。');
      },
    ]),
    true,
  );
  assert.equal(newPlan?.status, 'completed', newPlan?.error);
  assert.equal((await f.read('chapter', 'a')).body, '手写内容。');
  assert.equal((await f.read('chapter', 'b')).body, '新书第二章。');
});

test('recover a committed chapter whose completion acknowledgement was interrupted', async (t) => {
  const f = await fixture(t);
  const failed = await f.run(
    f.first,
    new ScriptedProvider([
      ...staged,
      () => {
        throw new Error('before commit');
      },
    ]),
  );
  assert.equal(failed?.status, 'failed');
  const before = await f.read('chapter', 'a');
  await f.workspace.writeDocument(f.id, { ...before, body: '已经提交，未确认。' });
  const after = await f.read('chapter', 'a');
  const path = join(f.state, 'workflows', `${f.id}.json`),
    checkpoint = JSON.parse(await readFile(path, 'utf8'));
  checkpoint.plan = {
    chapter: 'a',
    rows: [{ type: 'chapter', id: 'a', before: before.revision, after: after.revision }],
  };
  await writeFile(path, JSON.stringify(checkpoint), 'utf8');
  const restarted = await f.load();
  const result = await f.run(restarted, new ScriptedProvider([() => reply('续到第二章。')]));
  assert.equal(result?.status, 'completed', result?.error);
  assert.equal((await f.read('chapter', 'a')).revision, after.revision);
});

test('resuming can explicitly replace the stored direction without persisting reference text', async (t) => {
  const f = await fixture(t);
  const attachment = 'EPHEMERAL_REFERENCE_TEXT';
  const first = await f.run(
    f.first,
    new ScriptedProvider([
      ({ history }) => {
        assert.match(JSON.stringify(history), new RegExp(attachment));
        throw new Error('pause before saving the outline');
      },
    ]),
    false,
    'original direction',
    attachment,
  );
  assert.equal(first?.status, 'failed');
  const statePath = join(f.state, 'workflows', `${f.id}.json`);
  const checkpoint = await readFile(statePath, 'utf8');
  assert.ok(checkpoint.includes('original direction'));
  assert.ok(!checkpoint.includes(attachment));
  const reopened = await f.load();
  const override = await f.run(
    reopened,
    new ScriptedProvider([
      ({ history }) => {
        const request = JSON.stringify(history);
        assert.ok(request.includes('new direction'));
        assert.ok(!request.includes('original direction') && !request.includes(attachment));
        throw new Error('fixture command received the replacement');
      },
    ]),
    false,
    'new direction',
  );
  assert.equal(override?.error, 'fixture command received the replacement');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).direction, 'new direction');
});
