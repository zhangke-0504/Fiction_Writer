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
import { BookTaskScope } from '../electron/agent/task-scope.js';
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
  const start = (prompt: string, script: Script[], scoped = false) => {
    const { provider, requests } = captureWritingRequests(script);
    runs.start(session.id, prompt, async (ctx) => {
      const scope = scoped ? new BookTaskScope(ctx, prompt, provider) : undefined;
      const novel = new NovelTools(workspace, id, provider, catalog, { authorPrompt: prompt, scope });
      await runAgent(
        ctx,
        provider,
        'OUTER_CHAT_ONLY',
        [],
        prompt,
        [
          ...novel.tools(),
          ...(scope ? [scope.tool(async () => (await workspace.readAll(id)).documents)] : []),
        ],
        20,
        scoped ? {} : undefined,
      );
      if (scope) await novel.assertFinished(ctx);
    });
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

for (const kind of ['subject', 'clue'] as const) {
  test(`a single new ${kind} reuses related notes, outline and saved prose`, async (t) => {
    const f = await fixture(t);
    const outline = await f.workspace.readDocument(f.id, { type: 'outline', id: 'outline' });
    const saved = await f.workspace.writeChanges(f.id, [
      { ...outline, expect: outline.revision, body: '[铜铃](subjects/bell.md)需要保管。OUTLINE_SOURCE' },
      {
        type: 'clue',
        id: 'old-clue',
        expect: null,
        fields: { title: '旧线索', subjectIds: ['bell'] },
        body: '## 可见线索\n铜铃出现在归航船上。CLUE_SOURCE\n\n## 回收真相\n归航者报了平安。',
      },
      {
        type: 'subject',
        id: 'stranger',
        expect: null,
        fields: { name: '陌路人', kind: 'character' },
        body: 'UNRELATED_SETTING',
      },
    ]);
    assert.equal(saved.error, undefined);
    const ref = { type: kind, id: 'new-target' };
    const documents = (await f.workspace.readAll(f.id)).documents;
    const linked =
      kind === 'subject'
        ? { fields: { name: '铜铃保管者', kind: 'character' } }
        : { fields: { title: '铜铃的裂缝', subjectIds: ['bell'] } };
    const prompt =
      kind === 'subject' ? '只新增一个与铜铃相关的主体。' : '只新增一条铜铃伏笔，先不排期。';
    const op = f.start(prompt, [
      () =>
        send('book_generate_assets', { kind, action: 'create', targets: [{ id: ref.id, ...linked }] }),
      (request) => {
        const wire = JSON.stringify(request.history);
        for (const marker of ['OUTLINE_SOURCE', 'CLUE_SOURCE', 'BEFORE_GUARD', 'SOURCE_ITEM_SETTING'])
          assert.ok(wire.includes(marker), marker);
        for (const source of documents.filter(({ id }) =>
          ['outline', 'old-clue', 'early', 'bell'].includes(id),
        ))
          assert.ok(wire.includes(source.revision), source.id);
        assert.doesNotMatch(wire, /UNRELATED_SETTING/);
        return propose(ref.id, kind === 'subject' ? generated : clue);
      },
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), /"ok":true/);
        return finish();
      },
    ]);
    const outcome = await op.wait();
    assert.equal(outcome.run?.status, 'completed', outcome.run?.error);
    const target = await f.workspace.readDocument(f.id, ref);
    assert.equal(target.body.trim(), kind === 'subject' ? generated : clue);
    assert.equal(target.fields.setupChapterId, undefined);
    assert.equal(target.fields.payoffChapterId, undefined);
    assert.deepEqual(
      (await f.workspace.readAll(f.id)).documents.filter(({ id }) => id !== ref.id),
      documents,
    );
  });
}

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
  const op = f.start(
    prompt,
    [
      () => send('tool_search', { query: 'book_generate_assets' }),
      () =>
        send('book_task_scope', {
          items: [
            {
              operation: 'subject.create',
              id: 'rust',
              purpose: '新增与两名主体有关联的反派',
              relatedMinimum: 2,
            },
          ],
        }),
      () => send('check_book_scope', { allowed: true }),
      () => send('book_generate_assets', input),
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), /关联的不同既有主体数不足/);
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
    ],
    true,
  );
  const result = await op.wait();
  assert.equal(result.run?.status, 'completed', result.run?.error);
  assert.equal(op.requests.filter(({ lane }) => lane === 'asset').length, 1);
  const doc = await f.workspace.readDocument(f.id, { type: 'subject', id: 'rust' });
  assert.match(doc.body, /subjects\/bell.md/);
  assert.match(doc.body, /subjects\/keeper.md/);
});

for (const allowed of [true, false]) {
  test(`continuation asset update preserves status and actual commit evidence (allowed=${allowed})`, async (t) => {
    const f = await fixture(t);
    const ref = { type: 'subject' as const, id: 'bell' };
    const original = await f.workspace.readDocument(f.id, ref);
    const waiting = '还有一点：铜铃已经回到主人手里，资料缺少这个已发生的状态。保留铜铃的稳定设定。';
    await f.start('说明还缺哪些资料状态，别改', [() => ({ ...finish(), text: waiting })], true).wait();
    const revised = `## 稳定设定\n${original.body}\n\n## 已发生变化\n铜铃回到主人手里。`;
    const out = await f
      .start(
        '解决未清理的问题',
        [
          () => send('tool_search', { query: 'book_get_context book_generate_assets' }),
          () =>
            send('book_task_scope', {
              sourceQuote: waiting,
              items: [
                {
                  operation: 'subject.update',
                  id: ref.id,
                  purpose: '仅同步已发生变化，保留铜铃的稳定设定。',
                },
              ],
            }),
          () => send('check_book_scope', { allowed: true }),
          () => send('book_get_context', { type: ref.type, documentId: ref.id }),
          () =>
            send('book_generate_assets', {
              kind: ref.type,
              action: 'update',
              targets: [{ id: ref.id }],
            }),
          () => propose(ref.id, revised),
          ({ tools, history }) => {
            assert.equal(tools[0].name, 'check_asset_update_scope');
            assert.match(JSON.stringify(history), /SOURCE_ITEM_SETTING/);
            return send('check_asset_update_scope', { allowed });
          },
          () => finish(),
        ],
        true,
      )
      .wait();
    assert.equal(out.run?.status, 'completed', out.run?.error);
    assert.equal(out.run?.taskOutcome, allowed ? 'fulfilled' : 'incomplete');
    const actual = await f.workspace.readDocument(f.id, ref);
    assert.deepEqual(actual.fields, original.fields);
    assert.equal(actual.body, allowed ? revised + '\n' : original.body);
  });
}

for (const kind of ['subject', 'clue'] as const) {
  test(`${kind} batch keeps each target's evidence separate and tolerates a blank optional association`, async (t) => {
    const f = await fixture(t);
    const outline = await f.workspace.readDocument(f.id, { type: 'outline', id: 'outline' });
    const outlineBody = [
      '新船员接替罗蓝。[罗蓝](subjects/keeper.md) BATCH_KEEPER_ONLY',
      '新匠人接管铜铃。[铜铃](subjects/bell.md) BATCH_BELL_ONLY',
    ].join('\n\n');
    assert.equal(
      (
        await f.workspace.writeChanges(f.id, [
          { ...outline, expect: outline.revision, body: outlineBody },
        ])
      ).error,
      undefined,
    );
    const targets =
      kind === 'subject'
        ? [
            {
              id: 'new-keeper',
              fields: { name: '新船员', kind: 'character' },
              relatedSubjectIds: ['keeper'],
            },
            {
              id: 'new-bell',
              fields: { name: '新匠人', kind: 'character' },
              relatedSubjectIds: ['bell'],
            },
          ]
        : [
            {
              id: 'clue-keeper',
              fields: { title: '罗蓝来信', subjectIds: ['keeper'] },
            },
            {
              id: 'clue-bell',
              fields: { title: '铜铃的回声', subjectIds: ['bell'] },
            },
          ];
    const results =
      kind === 'subject'
        ? [
            {
              id: 'new-keeper',
              body: '## 稳定设定\n罗蓝的接替者。',
            },
            {
              id: 'new-bell',
              body: '## 稳定设定\n铜铃的新保管者。',
            },
          ]
        : [
            {
              id: 'clue-keeper',
              body: '## 可见线索\n罗蓝留下了一封信。\n\n## 回收真相\n信中写着离开的日期。',
            },
            {
              id: 'clue-bell',
              body: '## 可见线索\n铜铃发出一声轻响。\n\n## 回收真相\n裂痕记录着上次归还。',
            },
          ];
    const prompt =
      kind === 'subject'
        ? '新增两个主体：新船员与罗蓝有关，新匠人与铜铃有关。'
        : '新增两条伏笔：一条关联罗蓝，一条关联铜铃。';
    const op = f.start(prompt, [
      () => send('book_generate_assets', { kind, action: 'create', targets }),
      (request) => {
        isolatedRequest(request, 'OUTER_CHAT_ONLY');
        const history = request.history as { text: string }[];
        const payload = history[0].text.slice(history[0].text.indexOf('{'));
        const context = JSON.parse(payload) as { outline: { targetId: string; text: string }[] };
        const byTarget = new Map(context.outline.map(({ targetId, text }) => [targetId, text]));
        const firstId = kind === 'subject' ? 'new-keeper' : 'clue-keeper';
        const secondId = kind === 'subject' ? 'new-bell' : 'clue-bell';
        assert.match(byTarget.get(firstId) ?? '', /BATCH_KEEPER_ONLY/);
        assert.doesNotMatch(byTarget.get(firstId) ?? '', /BATCH_BELL_ONLY/);
        assert.match(byTarget.get(secondId) ?? '', /BATCH_BELL_ONLY/);
        assert.doesNotMatch(byTarget.get(secondId) ?? '', /BATCH_KEEPER_ONLY/);
        return send('submit_story_descriptions', { items: results });
      },
      () => finish(),
    ]);
    const outcome = await op.wait();
    assert.equal(outcome.run?.status, 'completed', outcome.run?.error);
    for (const result of results) {
      const doc = await f.workspace.readDocument(f.id, { type: kind, id: result.id });
      assert.ok(doc.body.includes(result.body.split('\n')[0]));
      if (kind === 'subject' && result.id === 'new-keeper')
        assert.match(doc.body, /subjects\/keeper\.md/);
    }
    assert.deepEqual(
      op.requests.map(({ lane }) => lane),
      ['agent', 'asset', 'agent'],
    );
  });
}

test('a blank optional related subject does not block, but an explicitly required note does', async (t) => {
  const f = await fixture(t);
  const args = {
    kind: 'subject',
    action: 'create',
    targets: [
      {
        id: 'new-keeper',
        fields: { name: '新船员', kind: 'character' },
        relatedSubjectIds: ['keeper'],
      },
    ],
  };
  const op = f.start('新增一个与罗蓝相关的主体。', [
    () => send('book_generate_assets', args),
    (request) => {
      assert.match(JSON.stringify(request.history), /keeper/);
      assert.doesNotMatch(JSON.stringify(request.history), /SOURCE_ITEM_SETTING/);
      return propose('new-keeper', '## 稳定设定\n新船员会保管铜铃。');
    },
    () => finish(),
  ]);
  const optional = await op.wait();
  assert.equal(
    optional.run?.status,
    'completed',
    JSON.stringify({
      error: optional.run?.error,
      lanes: op.requests.map(({ lane }) => lane),
      last: op.requests.at(-1)?.wire.history,
    }),
  );
  assert.deepEqual(
    op.requests.map(({ lane }) => lane),
    ['agent', 'asset', 'agent'],
  );
  assert.ok((await f.workspace.readDocument(f.id, { type: 'subject', id: 'new-keeper' })).body);

  const requiredFixture = await fixture(t);
  const required = requiredFixture.start('新增一个主体，必须依据罗蓝已保存的设定。', [
    () => send('book_generate_assets', args),
    () => finish(),
  ]);
  const blocked = await required.wait();
  assert.equal(blocked.run?.status, 'completed', blocked.run?.error);
  assert.match(
    JSON.stringify(required.requests.at(-1)?.wire.history),
    /subject\/keeper|context_required|罗蓝/,
  );
  assert.deepEqual(
    required.requests.map(({ lane }) => lane),
    ['agent', 'agent'],
  );
  await assert.rejects(
    requiredFixture.workspace.readDocument(requiredFixture.id, {
      type: 'subject',
      id: 'new-keeper',
    }),
  );
});
