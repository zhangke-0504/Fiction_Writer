import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WorkspaceService } from '../electron/workspace.js';
import { Journal } from '../electron/journal.js';
import { RunManager } from '../electron/agent/runs.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import { runAgent } from '../electron/agent/loop.js';
import { Gate } from '../electron/agent/scripted.js';
import type { Script } from '../electron/agent/scripted.js';
import type { AssistantTurn } from '../electron/agent/model.js';
import { captureWritingRequests, isolatedRequest } from './writing-request-fixture.js';
import { ProviderError } from '../electron/agent/provider.js';

const send = (name: string, args: unknown): AssistantTurn => ({
  role: 'assistant',
  text: '',
  calls: [{ id: name + '-1', name, args: JSON.stringify(args) }],
});
const finish = (): AssistantTurn => ({ role: 'assistant', text: '完成。', calls: [] });
const generated = '## 稳定设定\n曾在渡口保管归还的铜铃。NEW_ASSET_BODY';
const clue = '## 可见线索\n让读者看到裂开的铜铃。\n\n## 回收真相\n裂缝标记了归还人。';
const propose = (id: string, body: string) =>
  send('submit_story_descriptions', { items: [{ id, body }] });
const tools = {
  fill: { kind: 'subject', action: 'fill', targets: [{ id: 'keeper' }] },
  create: {
    kind: 'clue',
    action: 'create',
    targets: [
      {
        id: 'bell-riddle',
        fields: {
          title: '铜铃的裂缝',
          subjectIds: ['bell'],
          setupChapterId: 'early',
          payoffChapterId: 'late',
        },
      },
    ],
  },
};

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'fw-story-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceService({ libraryRoot: join(root, 'library') });
  await workspace.init();
  const { id } = await workspace.createBook({ title: '渡口纪事', summary: '寻找一只铜铃。' });
  assert.equal(
    (
      await workspace.writeChanges(id, [
        {
          type: 'chapter',
          id: 'early',
          fields: { title: '渡口', order: 1 },
          body: '罗蓝在这里保管铜铃。BEFORE_GUARD',
          expect: null,
        },
        {
          type: 'chapter',
          id: 'late',
          fields: { title: '海面', order: 2 },
          body: '铜铃回到主人手里。',
          expect: null,
        },
        {
          type: 'subject',
          id: 'keeper',
          fields: { name: '罗蓝', kind: 'character' },
          body: '待补',
          expect: null,
        },
        {
          type: 'subject',
          id: 'bell',
          fields: { name: '铜铃', kind: 'item' },
          body: '铃柄只能由渡口保管。SOURCE_ITEM_SETTING',
          expect: null,
        },
      ])
    ).error,
    undefined,
  );
  const runs = new RunManager(join(root, 'state'), new Journal(() => {}));
  await runs.init();
  const session = await runs.create({ cwd: workspace.bookRoot(id), bookId: id }, '测试');
  const catalog = new SkillCatalog(fileURLToPath(new URL('../skills', import.meta.url)));
  const start = (prompt: string, script: Script[]) => {
    const { provider, requests } = captureWritingRequests(script);
    const novel = new NovelTools(workspace, id, provider, catalog, { authorPrompt: prompt });
    runs.start(session.id, prompt, (ctx) =>
      runAgent(ctx, provider, 'OUTER_CHAT_ONLY', [], prompt, novel.tools()),
    );
    return {
      requests,
      wait: async () => {
        await runs.wait(session.id);
        return runs.get(session.id);
      },
    };
  };
  return { workspace, id, runs, session, start };
}

test('a single subject is filled using manuscript evidence without feeding its prompt or output back to the Agent', async (t) => {
  const f = await fixture(t);
  const original = await f.workspace.readDocument(f.id, { type: 'chapter', id: 'early' });
  const op = f.start('只给罗蓝补说明', [
    () => send('book_generate_assets', { ...tools.fill, direction: '参照渡口原文' }),
    (request) => {
      isolatedRequest(request, 'OUTER_CHAT_ONLY');
      assert.match(request.system, /生成主体说明/);
      assert.doesNotMatch(request.system, /生成伏笔说明|只给罗蓝补说明/);
      assert.match(JSON.stringify(request.history), /只给罗蓝补说明.*参照渡口原文.*BEFORE_GUARD/s);
      return propose('keeper', generated);
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":true.*keeper.*revision/s);
      assert.doesNotMatch(JSON.stringify(history), /NEW_ASSET_BODY|BEFORE_GUARD/);
      return finish();
    },
  ]);
  const outcome = await op.wait();
  assert.equal(
    outcome.run?.status,
    'completed',
    JSON.stringify({
      error: outcome.run?.error,
      recent: op.requests.at(-1),
      lanes: op.requests.map((r) => r.lane),
    }),
  );
  assert.deepEqual(
    op.requests.map((r) => r.lane),
    ['agent', 'asset', 'agent'],
  );
  assert.match(
    (await f.workspace.readDocument(f.id, { type: 'subject', id: 'keeper' })).body,
    /NEW_ASSET_BODY/,
  );
  assert.equal(
    (await f.workspace.readDocument(f.id, { type: 'chapter', id: 'early' })).revision,
    original.revision,
  );
});

test('a standalone clue uses subject notes and both current chapter anchors', async (t) => {
  const f = await fixture(t);
  const op = f.start('新增一条铜铃的伏笔', [
    () => send('book_generate_assets', tools.create),
    (request) => {
      isolatedRequest(request, 'OUTER_CHAT_ONLY');
      assert.match(request.system, /生成伏笔说明/);
      assert.match(JSON.stringify(request.history), /SOURCE_ITEM_SETTING.*early.*late/s);
      return propose('bell-riddle', clue);
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":true/);
      assert.doesNotMatch(JSON.stringify(history.at(-1)), /回收真相|裂缝标记了归还人/);
      return finish();
    },
  ]);
  const outcome = await op.wait();
  assert.equal(
    outcome.run?.status,
    'completed',
    JSON.stringify({
      error: outcome.run?.error,
      recent: op.requests.at(-1),
      lanes: op.requests.map((r) => r.lane),
    }),
  );
  const result = await f.workspace.readDocument(f.id, { type: 'clue', id: 'bell-riddle' });
  assert.equal(result.fields.payoffChapterId, 'late');
  assert.equal(result.body.trim(), clue);
});

test('empty generated output and unauthorized replacement leave existing notes unchanged', async (t) => {
  const f = await fixture(t);
  const op = f.start('补写罗蓝的说明', [
    () =>
      send('book_generate_assets', {
        ...tools.fill,
        action: 'update',
        targets: [{ id: 'bell' }],
        direction: '覆盖铜铃说明',
      }),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":false.*授权/s);
      return send('book_generate_assets', tools.fill);
    },
    () => propose('keeper', '## 稳定设定\n待补。'),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":false.*context_required/s);
      return finish();
    },
  ]);
  const outcome = await op.wait();
  assert.equal(
    outcome.run?.status,
    'completed',
    JSON.stringify({ error: outcome.run?.error, recent: op.requests.at(-1) }),
  );
  assert.equal(op.requests.filter((r) => r.lane === 'asset').length, 1);
  assert.equal((await f.workspace.readDocument(f.id, { type: 'subject', id: 'keeper' })).body, '待补');
  assert.match(
    (await f.workspace.readDocument(f.id, { type: 'subject', id: 'bell' })).body,
    /SOURCE_ITEM_SETTING/,
  );
});

test('an invalid anchor is rejected before the asset model is called', async (t) => {
  const f = await fixture(t);
  const bad = structuredClone(tools.create);
  bad.targets[0].fields.payoffChapterId = 'no-such-chapter';
  const op = f.start('新增一条铜铃的伏笔', [
    () => send('book_generate_assets', bad),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /invalid_references.*no-such-chapter/s);
      return finish();
    },
  ]);
  await op.wait();
  assert.ok(op.requests.every((r) => r.lane === 'agent'));
  await assert.rejects(f.workspace.readDocument(f.id, { type: 'clue', id: 'bell-riddle' }));
});

for (const cancel of [true, false])
  test(
    cancel
      ? 'stopping an asset request does not save candidates'
      : 'changed source evidence blocks the asset commit',
    { timeout: 4000 },
    async (t) => {
      const f = await fixture(t);
      const gate = new Gate();
      let seen!: () => void;
      const started = new Promise<void>((resolve) => {
        seen = resolve;
      });
      const op = f.start('补写罗蓝的说明', [
        () => send('book_generate_assets', tools.fill),
        async ({ signal }) => {
          seen();
          await gate.wait(signal);
          return propose('keeper', generated);
        },
        ({ history }) => {
          assert.match(JSON.stringify(history.at(-1)), /"ok":false.*conflict/s);
          return finish();
        },
      ]);
      await started;
      if (cancel) f.runs.stop(f.session.id);
      else {
        const doc = await f.workspace.readDocument(f.id, { type: 'chapter', id: 'early' });
        assert.equal(
          (
            await f.workspace.writeChanges(f.id, [
              { ...doc, expect: doc.revision, body: '修订的正文。' },
            ])
          ).error,
          undefined,
        );
        gate.release();
      }
      const result = await op.wait();
      assert.equal(result.run?.status, cancel ? 'cancelled' : 'completed');
      assert.equal(
        (await f.workspace.readDocument(f.id, { type: 'subject', id: 'keeper' })).body,
        '待补',
      );
    },
  );

test('normalizes an unambiguous generated heading but rejects a setup that only contains the protected payoff', async (t) => {
  const f = await fixture(t);
  const fill = f.start('只给罗蓝补说明', [
    () => send('book_generate_assets', tools.fill),
    () => propose('keeper', '## 长期设定\n罗蓝能辨认海面上的浮标。'),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":true/);
      return finish();
    },
  ]);
  assert.equal((await fill.wait()).run?.status, 'completed');
  assert.match(
    (await f.workspace.readDocument(f.id, { type: 'subject', id: 'keeper' })).body,
    /^## 稳定设定/m,
  );
  const truth = '归还铜铃的陌生人就是逃亡的主人';
  const blocked = f.start('新增一条铜铃的伏笔', [
    () => send('book_generate_assets', tools.create),
    () => propose('bell-riddle', `## 可见线索\n${truth}。\n\n## 回收真相\n揭示事实：${truth}。`),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /no_visible_evidence/);
      return finish();
    },
  ]);
  assert.equal((await blocked.wait()).run?.status, 'completed');
  await assert.rejects(f.workspace.readDocument(f.id, { type: 'clue', id: 'bell-riddle' }));
});

test('a length-limited asset batch suggests a smaller batch rather than repeating or saving', async (t) => {
  const f = await fixture(t);
  const op = f.start('新增人物阿树和阿石', [
    () =>
      send('book_generate_assets', {
        kind: 'subject',
        action: 'create',
        targets: [
          { id: 'tree', fields: { name: '阿树', kind: 'character' } },
          { id: 'stone', fields: { name: '阿石', kind: 'character' } },
        ],
      }),
    () => {
      throw new ProviderError('中断', 'protocol', 'output_limit');
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"suggestedBatchSize":1/);
      return finish();
    },
  ]);
  const outcome = await op.wait();
  assert.equal(outcome.run?.status, 'completed', outcome.run?.error);
  assert.equal(op.requests.filter(({ lane }) => lane === 'asset').length, 1);
  await assert.rejects(f.workspace.readDocument(f.id, { type: 'subject', id: 'tree' }));
});

test('a new mid-story actor must connect to the requested number of distinct existing subjects', async (t) => {
  const f = await fixture(t);
  const prompt = '增加一个跟2个以上已有主体有关联的反派及他的伏笔，在故事中期登场';
  const actor = { id: 'rust', fields: { name: '赤锈', kind: 'character' } };
  const input = {
    kind: 'subject',
    action: 'create',
    targets: [{ ...actor, relatedSubjectIds: ['bell'] }],
  };
  // Fill our fixture's existing actor via the author path first; only existing, usable notes can be linked.
  const old = await f.workspace.readDocument(f.id, { type: 'subject', id: 'keeper' });
  assert.equal(
    (await f.workspace.writeChanges(f.id, [{ ...old, expect: old.revision, body: generated }])).error,
    undefined,
  );
  const op = f.start(prompt, [
    () => send('book_generate_assets', input),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /至少 2 个不同的既有主体/);
      return send('book_generate_assets', {
        ...input,
        targets: [{ ...actor, relatedSubjectIds: ['bell', 'keeper'] }],
      });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history), /SOURCE_ITEM_SETTING/);
      assert.match(JSON.stringify(history), /NEW_ASSET_BODY/);
      return propose('rust', '## 稳定设定\n赤锈曾替罗蓝保管铜铃，如今借铃声误导他。');
    },
    () => finish(),
  ]);
  const result = await op.wait();
  assert.equal(result.run?.status, 'completed', result.run?.error);
  assert.equal(op.requests.filter(({ lane }) => lane === 'asset').length, 1);
  const doc = await f.workspace.readDocument(f.id, { type: 'subject', id: 'rust' });
  assert.match(doc.body, /subjects\/bell.md/);
  assert.match(doc.body, /subjects\/keeper.md/);
});
