import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DocRef, Manuscript } from '../shared/contracts.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import { BookTaskScope } from '../electron/agent/task-scope.js';
import { prosePatchIntent } from '../electron/agent/chapter-intent.js';
import type { ParagraphGapEdit, ProseEdit } from '../electron/agent/chapter-patch.js';
import { runAgent } from '../electron/agent/loop.js';
import { RunManager } from '../electron/agent/runs.js';
import { Gate, ScriptedProvider, type Script } from '../electron/agent/scripted.js';
import { MalformedMessagesArguments } from '../electron/agent/provider.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { DiagnosticFailure } from '../electron/diagnostics/trace.js';
import { Journal } from '../electron/journal.js';
import { WorkspaceService } from '../electron/workspace.js';
import { collectDiagnostics } from './diagnostic-fixture.js';

const ch = (n: number): DocRef => ({ type: 'chapter', id: 'ch' + n });
const chapterIds = Array.from({ length: 10 }, (_, i) => ch(i + 1).id);
const injury = '旧句标记_OLD_ONLY：检察官的脸被碎玻璃划伤。';
const correction = '新句标记_NEW_ONLY：检察官的脸被泼出的液体烧伤。';
const source = '证据标记_SOURCE_ONLY：来人把刺鼻的液体泼在检察官脸上。';
const missing = '警督没有出现在站台上，机房仍上着锁。';
const invented = '医护车把警督和机房里的证人带走了。';
const prefix = '空站台映着昏黄的灯光，夜里的雨声盖住了脚步，档案员悄悄走过无人的长廊。';
const suffix = '列车穿过隧道，最后一盏工作灯照在门上，无人回答。市民只听见沉默的鸣钟。';
const lastDraft = [prefix, injury, missing, suffix, prefix + suffix].join('\r\n\r\n');
const evidenceBody = prefix + '\n\n' + source + '\n\n' + suffix;
const direct = '请把第十章的“' + injury + '”改成“' + correction + '”。';
const semantic = '请把第十章的伤因修正为与第八章的描写一致。';
const text = (value: string) => ({ role: 'assistant' as const, text: value, calls: [] });
const use = (name: string, args: object) => ({
  ...text(''),
  calls: [{ id: name, name, args: JSON.stringify(args) }],
});
const decision = (allowed: boolean) => use('submit_chapter_patch_review', { allowed });
const reviewNote = 'REVIEW_VISIBLE_TEXT_MUST_NOT_ESCAPE';
const read = (n: number, offset = 0, length = 6000) =>
  use('book_get_context', { type: 'chapter', documentId: ch(n).id, offset, length });
const latest = (history: readonly unknown[]) => JSON.stringify(history.at(-1));

async function fixture(t: TestContext, authored = 10) {
  const root = await mkdtemp(join(tmpdir(), 'fw-chapter-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notifications: DocRef[][] = [];
  const ws = new WorkspaceService({
    libraryRoot: join(root, 'library'),
    onChange: (_, docs) => {
      notifications.push(docs);
    },
  });
  await ws.init();
  const { id } = await ws.createBook({ title: '钟与长廊', summary: '夜里只剩长廊里的钟。' });
  const outline = await ws.readDocument(id, { type: 'outline', id: 'outline' });
  const seeded = await ws.writeChanges(id, [
    { ...outline, expect: outline.revision, body: '# 概要\n\n检察官和档案员寻找失散的证人。' },
    {
      type: 'subject',
      id: 'examiner',
      expect: null,
      fields: { name: '检察官', kind: 'character' },
      body: '检察官负责保护证人。',
    },
    {
      type: 'clue',
      id: 'chime',
      expect: null,
      fields: { title: '钟声', setupChapterId: ch(1).id, payoffChapterId: ch(10).id },
      body: '## 可见线索\n\n钟声提醒众人附近有站台。\n\n## 回收真相\n\n钟声曾引导失散的证人返回站台。',
    },
    ...chapterIds.map((chapterId, at) => ({
      ...ch(at + 1),
      id: chapterId,
      expect: null,
      fields: { title: '夜航 ' + (at + 1), order: at + 1 },
      body:
        at < authored
          ? at === 9
            ? lastDraft
            : at === 7
              ? evidenceBody
              : prefix + '第' + (at + 1) + '段旅程。'
          : '',
    })),
  ]);
  assert.equal(seeded.error, undefined);
  const state = join(root, 'state');
  const runs = new RunManager(state, new Journal(() => {}));
  await runs.init();
  const session = await runs.create({ cwd: ws.bookRoot(id), bookId: id }, 'patch');
  const catalog = new SkillCatalog(fileURLToPath(new URL('../skills', import.meta.url)));
  const load = (n: number) => ws.readDocument(id, ch(n));
  const save = (doc: Manuscript, body: string) =>
    ws.writeChanges(id, [{ ...doc, expect: doc.revision, body }]);
  const history = async () =>
    (await readFile(join(state, 'sessions', session.id + '.jsonl'), 'utf8'))
      .split(/\r?\n/gu)
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  const patch = (
    doc: Manuscript,
    edits: (ProseEdit | ParagraphGapEdit)[] = [{ quote: injury, replacement: correction }],
    evidence?: object[],
  ) => use('book_patch_chapter', { chapterId: doc.id, revision: doc.revision, edits, evidence });
  const start = (prompt: string, script: Script[], selectedChapterId?: string, scoped = false) => {
    const trace = collectDiagnostics();
    const model = new ScriptedProvider(script);
    const asked: string[] = [];
    const step = model.turn.bind(model);
    model.turn = (req) => {
      const named = req.tools.length === 1 ? req.tools[0].name : '';
      asked.push(named || (req.tools.length ? 'main' : 'draft'));
      return named === 'book_read_chapter' ? Promise.resolve(text('无需回读')) : step(req);
    };
    runs.start(
      session.id,
      prompt,
      async (ctx) => {
        const scope = scoped ? new BookTaskScope(ctx, prompt, model) : undefined;
        const novel = new NovelTools(ws, id, model, catalog, {
          authorPrompt: prompt,
          selectedChapterId,
          scope,
        });
        const system = novel.prepareEdit(ctx, (await ws.readAll(id)).documents);
        await runAgent(
          ctx,
          model,
          system,
          [],
          prompt,
          [
            ...catalog.tools((name) => novel.skillApplied(name)),
            ...novel.tools(),
            ...(scope ? [scope.tool(async () => (await ws.readAll(id)).documents)] : []),
          ],
          novel,
          scoped ? {} : undefined,
        );
        await novel.assertFinished(ctx);
      },
      'default',
      trace.report,
    );
    return {
      trace,
      asked,
      stop: () => runs.stop(session.id),
      wait: async () => {
        await runs.wait(session.id);
        return runs.get(session.id).run!;
      },
    };
  };
  return { ws, id, load, save, history, patch, start, notifications };
}

test('current directive resolves one editable chapter, not the chapter cited as evidence', () => {
  const docs = [8, 10].map((n) => ({ ...ch(n), fields: { order: n }, body: '', revision: '' }));
  assert.equal(prosePatchIntent(semantic, docs)?.chapterId, ch(10).id);
  assert.deepEqual(prosePatchIntent(direct, docs)?.exact, { quote: injury, replacement: correction });
  assert.equal(
    prosePatchIntent('把本章的伤因改成已确定的事实。', docs, ch(10).id)?.chapterId,
    ch(10).id,
  );
  assert.equal(prosePatchIntent('请修改第十章全文。', docs), undefined);
});

test('explicit exact patch saves only the specified text, emits a real receipt, and rejects replay', async (t) => {
  const f = await fixture(t);
  const before = await f.ws.readAll(f.id);
  const doc = await f.load(10);
  const op = f.start(direct, [
    () => read(10, doc.body.indexOf(injury), injury.length),
    () => f.patch(doc),
    async ({ history }) => {
      assert.match(latest(history), /"patched":1/);
      return f.patch(doc);
    },
    ({ history }) => {
      assert.match(latest(history), /conflict/);
      return read(10);
    },
    async () => f.patch(await f.load(10)),
    ({ history }) => {
      assert.match(latest(history), /patch_anchor/);
      return text('第十章伤因已定点修订。');
    },
  ]);
  const run = await op.wait();
  assert.equal(run.status, 'completed', run.error);
  const after = await f.ws.readAll(f.id);
  assert.deepEqual(
    after.documents.filter((d) => d.id !== doc.id),
    before.documents.filter((d) => d.id !== doc.id),
  );
  const saved = await f.load(10);
  assert.equal(saved.body, lastDraft.replace(injury, correction));
  assert.deepEqual(saved.fields, doc.fields);
  assert.deepEqual(f.notifications.at(-1), [ch(10)]);
  const receipts = (await f.history()).flatMap((row) =>
    row.toolReceipt?.tool === 'book_patch_chapter' ? [row.toolReceipt] : [],
  );
  assert.deepEqual(
    receipts.map((r) => [r.outcome, r.commitCount, r.commits[0]?.revision]),
    [
      ['ok', 1, saved.revision],
      ['failed', 0, undefined],
      ['failed', 0, undefined],
    ],
  );
  assert.deepEqual(op.trace.rejected, []);
  assert.doesNotMatch(JSON.stringify(op.trace.rows), /_OLD_ONLY|_NEW_ONLY|_SOURCE_ONLY/);
});

const seventh = 7;
const moving = '周澜低声把那晚听到的对话重新说了一遍。';
const destination = '两人回到车尾，终于能慢慢把话说完。';
const movePrompt = '把第七章走廊里周澜的这段对话挪到车尾。';
const beforeMove = [prefix, moving, suffix, destination, prefix].join('\n\n');
const afterMove = [prefix, suffix, destination, moving, prefix].join('\n\n');
const removeDialogue = { quote: `${moving}\n\n`, replacement: '', part: 'remove-old' };
const addDialogue = { quote: destination, replacement: `${destination}\n\n${moving}`, part: 'add-new' };
const moveScope = () =>
  use('book_task_scope', {
    items: [
      {
        operation: 'chapter.patch',
        id: ch(seventh).id,
        part: 'remove-old',
        purpose: '移除走廊对话',
      },
      { operation: 'chapter.patch', id: ch(seventh).id, part: 'add-new', purpose: '补入车尾对话' },
    ],
  });

for (const variant of [
  'stepwise',
  'author-restored-source',
  'batch',
  'invalid-batch',
  'denied-batch',
  'unknown-part',
  'delete-only',
  'rename-only',
] as const) {
  test(`seventh chapter relocation: ${variant}`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.save(await f.load(seventh), beforeMove)).error, undefined);
    const initial = await f.load(seventh);
    const restored = variant === 'author-restored-source';
    const stepwise = variant === 'stepwise' || restored;
    const invalid = variant === 'invalid-batch';
    const denied = variant === 'denied-batch';
    const unknownPart = variant === 'unknown-part';
    const rejected = invalid || denied || unknownPart;
    const deletionOnly = variant === 'delete-only';
    const renameOnly = variant === 'rename-only';
    const run = f.start(
      movePrompt,
      [
        () => use('tool_search', { query: 'book_patch_chapter book_get_context book_apply_changes' }),
        () => {
          const request = moveScope();
          if (renameOnly) {
            const input = JSON.parse(request.calls[0].args);
            input.items.push({ operation: 'chapter.catalog', id: initial.id, purpose: '改章名' });
            request.calls[0].args = JSON.stringify(input);
          }
          return request;
        },
        () => use('check_book_scope', { allowed: true }),
        () => read(seventh),
        () =>
          renameOnly
            ? use('book_apply_changes', {
                operations: [
                  { type: 'chapter', id: initial.id, action: 'update', fields: { title: '车尾' } },
                ],
              })
            : f.patch(initial, [
                removeDialogue,
                ...(stepwise || deletionOnly
                  ? []
                  : [
                      invalid
                        ? { ...addDialogue, quote: '没有这个锚点' }
                        : unknownPart
                          ? { ...addDialogue, part: 'outside' }
                          : addDialogue,
                    ]),
              ]),
        ...(invalid || unknownPart || renameOnly ? [] : [() => decision(!denied)]),
        ...(!stepwise
          ? []
          : [
              async ({ history }: Parameters<Script>[0]) => {
                assert.match(latest(history), /patched.*1/);
                if (restored)
                  assert.equal((await f.save(await f.load(seventh), beforeMove)).error, undefined);
                return read(seventh);
              },
              async () => f.patch(await f.load(seventh), [addDialogue]),
              () => decision(true),
            ]),
        ({ history }) => {
          assert.match(
            latest(history),
            invalid
              ? /patch_anchor/
              : denied || unknownPart
                ? /patch_scope/
                : renameOnly
                  ? /committed/
                  : /patched/,
          );
          if (denied) assert.match(latest(history), /不拆分须一并提交的改动/);
          return text('核对结果。');
        },
      ],
      undefined,
      true,
    );
    const finished = await run.wait();
    assert.equal(finished.status, 'completed', finished.error);
    assert.equal(
      finished.taskOutcome,
      rejected || renameOnly ? 'incomplete' : deletionOnly || restored ? 'partial' : 'fulfilled',
    );
    assert.equal(finished.progress?.done, rejected || renameOnly ? 0 : deletionOnly || restored ? 1 : 2);
    assert.equal(finished.progress?.total, 2);
    if (deletionOnly) {
      assert.match(finished.progress?.message ?? '', /补入车尾对话/);
      assert.doesNotMatch(finished.progress?.message ?? '', /移除走廊对话/);
    }
    if (restored) assert.match(finished.progress?.message ?? '', /移除走廊对话/);
    assert.equal(
      (await f.load(seventh)).body,
      rejected || renameOnly
        ? beforeMove
        : deletionOnly
          ? beforeMove.replace(removeDialogue.quote, '')
          : restored
            ? beforeMove.replace(destination, addDialogue.replacement)
            : afterMove,
    );
    const patches = (await f.history())
      .map((row) => row.toolReceipt)
      .filter((r) => r?.tool === 'book_patch_chapter');
    assert.deepEqual(
      patches.map((r) => r.commitCount),
      stepwise ? [1, 1] : rejected ? [0] : renameOnly ? [] : [1],
    );
    if (stepwise) assert.notEqual(patches[0].commits[0].revision, patches[1].commits[0].revision);
    const observed = run.trace.rows.filter((row) => row.event === 'chapter.patch.part');
    assert.equal(observed.length, renameOnly ? 0 : deletionOnly ? 1 : 2);
    assert.equal(new Set(observed.map((row) => row.fields.partRef)).size, observed.length);
    assert.deepEqual(run.trace.rejected, []);
    assert.doesNotMatch(JSON.stringify(observed), /remove-old|add-new|周澜|车尾/);
  });
}

for (const prompt of [
  '只检查第十章的伤因。',
  '请修正第十章的伤因。不要改第十章。',
  '接着写完。',
  '只在第十章插入一段。',
  '按上一份方案执行。',
  '请修改第十章和第八章的伤因。',
]) {
  test('rejects unscoped local patch: ' + prompt, async (t) => {
    const f = await fixture(t);
    const doc = await f.load(10);
    const op = f.start(prompt, [
      () => read(10),
      () => f.patch(doc),
      ({ history }) => {
        assert.match(latest(history), /patch_not_authorized/);
        return text('没有写入。');
      },
    ]);
    assert.equal((await op.wait()).status, 'completed');
    assert.deepEqual(await f.load(10), doc);
  });
}

for (const conflict of ['target', 'source', 'cancel', 'bad-second-edit', 'unread-quote'] as const) {
  test('refuses an entire patch on ' + conflict, async (t) => {
    const f = await fixture(t);
    const doc = await f.load(10),
      proof = await f.load(8);
    const ready = new Gate(),
      next = new Gate();
    const invalid = conflict === 'bad-second-edit';
    const op = f.start(semantic, [
      () => (conflict === 'unread-quote' ? read(10, 0, 4) : read(10)),
      () => read(8),
      () =>
        f.patch(
          doc,
          invalid
            ? [
                { quote: injury, replacement: correction },
                { quote: '找不到的句子', replacement: '不写' },
              ]
            : undefined,
          [{ chapterId: proof.id, revision: proof.revision, quote: source }],
        ),
      ...(invalid || conflict === 'unread-quote'
        ? []
        : [
            async ({ tools, signal }: Parameters<Script>[0]) => {
              assert.equal(tools[0]?.name, 'submit_chapter_patch_review');
              ready.release();
              await next.wait(signal);
              return decision(true);
            },
          ]),
      ({ history }) => {
        assert.match(
          latest(history),
          invalid ? /patch_anchor/ : conflict === 'unread-quote' ? /context_required/ : /conflict/,
        );
        return text('没有执行。');
      },
    ]);
    if (!invalid && conflict !== 'unread-quote') {
      await ready.wait(AbortSignal.timeout(5000));
      if (conflict === 'cancel') await op.stop();
      else {
        const item = conflict === 'source' ? proof : doc;
        assert.equal((await f.save(item, item.body + '\n手工保存。')).error, undefined);
      }
      next.release();
    }
    assert.equal((await op.wait()).status, conflict === 'cancel' ? 'cancelled' : 'completed');
    const saved = await f.load(10);
    assert.equal(saved.body, lastDraft + (conflict === 'target' ? '\n手工保存。' : ''));
    assert.doesNotMatch(JSON.stringify(op.trace.rows), /_OLD_ONLY|_NEW_ONLY|_SOURCE_ONLY/);
    assert.deepEqual(op.trace.rejected, []);
  });
}

const whole = '基于设定编写10章内容';
const enrollWhole = (id: string, resume = false): Script[] => [
  () => use('tool_search', { query: 'book_get_context book_generate_chapter book_patch_chapter' }),
  () =>
    use('book_task_scope', {
      items: [
        {
          operation: resume ? 'novel.resume' : 'novel.register',
          id,
          ...(resume ? {} : { count: 10 }),
          purpose: '交付整书',
        },
      ],
    }),
  () => use('check_book_scope', { allowed: true }),
  () => use('skill_load', { name: 'generate-novel' }),
];
const goal = (action: 'register' | 'resume' | 'check' = 'register') =>
  use('book_get_context', {
    novelGoal: {
      action,
      ...(action === 'register' && { chapterIds }),
    },
  });
const generate = (n: number) => use('book_generate_chapter', { chapterId: ch(n).id, mode: 'draft' });
const authoredBody = (n: number) =>
  n === 10
    ? lastDraft
    : n === 8
      ? evidenceBody
      : prefix + '这一段旅程的编号是' + n + '，众人循着钟声寻找另外一扇门。';
const draftSteps = (from: number, to: number): Script[] =>
  Array.from({ length: to - from + 1 }, (_, i) => i + from).flatMap((n) => [
    () => generate(n),
    () => text(authoredBody(n)),
  ]);
const proofFor = (doc: Manuscript) => [{ chapterId: doc.id, revision: doc.revision, quote: source }];

test('ten freshly written chapters permit only a verified factual correction of chapter ten', async (t) => {
  const f = await fixture(t, 0);
  let completedDrafts: Manuscript[] | undefined;
  const op = f.start(
    whole,
    [
      ...enrollWhole(f.id),
      () => goal(),
      ...draftSteps(1, 10),
      async () => {
        completedDrafts = (await f.ws.readAll(f.id)).documents;
        assert.equal(completedDrafts.filter((d) => d.type === 'chapter' && d.body.trim()).length, 10);
        return read(10);
      },
      () => read(8),
      async () =>
        f.patch(
          await f.load(10),
          [{ quote: missing, replacement: invented }],
          proofFor(await f.load(8)),
        ),
      ({ history, tools, system }) => {
        assert.equal(tools[0]?.name, 'submit_chapter_patch_review');
        assert.match(system, /未证实事实/);
        assert.match(latest(history), /证据标记_SOURCE_ONLY/);
        return decision(false);
      },
      async ({ history }) => {
        assert.match(latest(history), /patch_evidence/);
        assert.equal((await f.load(10)).body, lastDraft);
        return f.patch(await f.load(10), undefined, proofFor(await f.load(8)));
      },
      ({ history, tools }) => {
        assert.equal(tools[0]?.name, 'submit_chapter_patch_review');
        assert.match(latest(history), /旧句标记_OLD_ONLY.*新句标记_NEW_ONLY/);
        return decision(true);
      },
      ({ history }) => {
        assert.match(latest(history), /"patched":1,"factCorrection":true/);
        return goal('check');
      },
      ({ history }) => {
        assert.match(latest(history), /"done":10,"total":10.*"complete":true/);
        return text('10 章已保存；第十章伤因已修正；脱身经过无依据，仍待定。');
      },
    ],
    undefined,
    true,
  );
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.progress && [result.progress.done, result.progress.total], [10, 10]);
  assert.equal(op.asked.filter((s) => s === 'draft').length, 10);
  assert.equal(op.asked.filter((s) => s === 'submit_chapter_patch_review').length, 2);
  const final = await f.ws.readAll(f.id);
  assert.ok(completedDrafts);
  assert.deepEqual(
    final.documents.filter((d) => d.id !== ch(10).id),
    completedDrafts.filter((d) => d.id !== ch(10).id),
  );
  assert.equal((await f.load(10)).body, lastDraft.replace(injury, correction));
  assert.ok(
    (await f.history()).some(
      (row) => row.line?.role === 'assistant' && /已修正.*仍待定/u.test(row.line.text),
    ),
  );
  assert.deepEqual(op.trace.rejected, []);
  assert.doesNotMatch(JSON.stringify(op.trace.rows), /_OLD_ONLY|_NEW_ONLY|_SOURCE_ONLY/);
});

for (const kind of ['reused', 'author-edited', 'resumed'] as const) {
  test('does not grant implicit patch rights to a ' + kind + ' chapter', async (t) => {
    const f = await fixture(t, kind === 'reused' ? 10 : 9);
    if (kind === 'resumed') {
      const initial = await f
        .start(
          whole,
          [...enrollWhole(f.id), () => goal(), () => text('第十章尚未写入。')],
          undefined,
          true,
        )
        .wait();
      assert.equal(initial.status, 'failed');
    }
    const op = f.start(
      kind === 'resumed' ? '接着写完。' : whole,
      [
        ...enrollWhole(f.id, kind === 'resumed'),
        () => goal(kind === 'resumed' ? 'resume' : 'register'),
        ...(kind === 'reused' ? [] : draftSteps(10, 10)),
        async () => {
          if (kind === 'author-edited') {
            const draft = await f.load(10);
            assert.equal((await f.save(draft, draft.body + '\n作者另加一句。')).error, undefined);
          }
          return read(10);
        },
        () => read(8),
        async () => f.patch(await f.load(10), undefined, proofFor(await f.load(8))),
        ({ history }) => {
          assert.match(latest(history), kind === 'author-edited' ? /conflict/ : /patch_not_authorized/);
          return text('该处没有写入，列为待核对。');
        },
      ],
      undefined,
      true,
    );
    const result = await op.wait();
    assert.equal(result.status, 'completed', result.error);
    assert.equal(op.asked.filter((s) => s === 'submit_chapter_patch_review').length, 0);
    assert.equal(
      (await f.load(10)).body,
      lastDraft + (kind === 'author-edited' ? '\n作者另加一句。' : ''),
    );
  });
}

for (const variant of ['invalid-evidence', 'invalid-verdict', 'companion-text', 'not-read'] as const) {
  test('an attempted new-draft correction fails closed: ' + variant, async (t) => {
    const f = await fixture(t, 9);
    const op = f.start(
      whole,
      [
        ...enrollWhole(f.id),
        () => goal(),
        ...draftSteps(10, 10),
        () => read(10),
        ...(variant === 'not-read' ? [] : [() => read(8)]),
        async () => {
          const evidence = proofFor(await f.load(8));
          if (variant === 'invalid-evidence') evidence[0].quote = '明知并不存在的来源短句';
          return f.patch(await f.load(10), undefined, evidence);
        },
        ...(variant === 'invalid-verdict'
          ? [() => use('submit_chapter_patch_review', { allowed: 'yes' })]
          : variant === 'companion-text'
            ? [() => ({ ...decision(true), text: reviewNote })]
            : []),
        ({ history }) => {
          assert.match(latest(history), /patch_evidence/);
          return text('勘误证据不足，没有写入。');
        },
      ],
      undefined,
      true,
    );
    const result = await op.wait();
    assert.equal(result.status, 'completed', result.error);
    assert.equal((await f.load(10)).body, lastDraft);
  });
}

test('a body sent to the catalog tool is rejected without payload in diagnostics or prose commits', async (t) => {
  const f = await fixture(t);
  const doc = await f.load(10);
  const op = f.start(direct, [
    () => read(10),
    () => use('book_apply_changes', { operations: [{ ...ch(10), action: 'update', body: correction }] }),
    ({ history }) => {
      assert.match(latest(history), /chapter_body_not_supported/);
      return use('book_generate_chapter', { chapterId: doc.id, mode: 'replace' });
    },
    ({ history }) => {
      assert.match(latest(history), /rewrite_not_authorized/);
      return text('没有覆盖正文。');
    },
  ]);
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(await f.load(10), doc);
  const receipts = (await f.history()).flatMap((row) => (row.toolReceipt ? [row.toolReceipt] : []));
  assert.ok(
    receipts.some(
      (r) =>
        r.tool === 'book_apply_changes' &&
        r.reason === 'chapter_body_not_supported' &&
        r.commitCount === 0,
    ),
  );
  assert.doesNotMatch(JSON.stringify(op.trace.rows), /_NEW_ONLY/);
  assert.deepEqual(op.trace.rejected, []);
});

test('an explicit literal instruction cannot be repurposed to change different text in the same chapter', async (t) => {
  const f = await fixture(t);
  const doc = await f.load(10);
  const op = f.start(direct, [
    () => read(10),
    () => f.patch(doc, [{ quote: missing, replacement: invented }]),
    ({ history }) => {
      assert.match(latest(history), /patch_scope/);
      return text('不得改另一句。');
    },
  ]);
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(await f.load(10), doc);
});

for (const prompt of ['解决未清理的问题', '把上面那几项处理掉']) {
  test(`same-session follow-up can actually patch from a visible unresolved item: ${prompt}`, async (t) => {
    const f = await fixture(t);
    const original = await f.load(10);
    const prior = '尚有一项待处理：第十章的检察官伤因与第八章不一致，应该将碎玻璃划伤改为被液体烧伤。';
    assert.equal(
      (await f.start('检查伤因，先不要改稿', [() => text(prior)], undefined, true).wait()).status,
      'completed',
    );
    const applied = f.start(
      prompt,
      [
        ({ tools }) => {
          assert.ok(tools.some(({ name }) => name === 'tool_search'));
          assert.ok(!tools.some(({ name }) => name === 'book_patch_chapter'));
          return use('tool_search', { query: 'book_get_context book_patch_chapter' });
        },
        () =>
          use('book_task_scope', {
            sourceQuote: '第十章的检察官伤因与第八章不一致',
            items: [
              { operation: 'chapter.patch', id: ch(10).id, purpose: '按第八章将伤因改为液体烧伤' },
            ],
          }),
        ({ tools, history }) => {
          assert.equal(tools[0].name, 'check_book_scope');
          const request = (history[0] as { text: string }).text;
          assert.match(request, /第十章的检察官伤因与第八章不一致/);
          assert.ok(request.includes(prompt));
          return use('check_book_scope', { allowed: true });
        },
        () => read(8),
        () => read(10),
        () => f.patch(original),
        ({ tools }) => {
          assert.equal(tools[0].name, 'submit_chapter_patch_review');
          return { ...decision(true), text: reviewNote };
        },
        ({ history }) => {
          assert.match(latest(history), /"patched":1/);
          assert.doesNotMatch(JSON.stringify(history), new RegExp(reviewNote));
          return text('已核对并改正');
        },
      ],
      undefined,
      true,
    );
    const run = await applied.wait();
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.progress?.complete, true);
    assert.equal(run.progress?.done, 1);
    const saved = await f.load(10);
    assert.equal(saved.body, original.body.replace(injury, correction));
    const receipt = (await f.history()).find(
      ({ toolReceipt }) => toolReceipt?.tool === 'book_patch_chapter',
    )?.toolReceipt;
    assert.equal(receipt?.commits[0]?.revision, saved.revision);
    const review = applied.trace.rows.find(({ event }) => event === 'chapter.patch.review');
    const commit = applied.trace.rows.find(({ event }) => event === 'workspace.document.committed');
    assert.equal(review?.fields.verdict, 'approved');
    assert.equal(review?.fields.hasVisibleText, true);
    assert.ok(review?.fields.spanId && commit?.fields.callId);
    assert.equal(review.fields.callId, commit.fields.callId);
    assert.equal(review.fields.runId, commit.fields.runId);
    assert.doesNotMatch(JSON.stringify(applied.trace.rows), new RegExp(reviewNote));
    assert.deepEqual(applied.trace.rejected, []);
  });
}

const scopedReviewFailures: [string, Script, string, boolean | undefined][] = [
  ['explicit denial with text', () => ({ ...decision(false), text: reviewNote }), 'denied', true],
  ['explicit denial without text', () => decision(false), 'denied', false],
  ['text only', () => text(reviewNote), 'invalid_verdict', true],
  [
    'two calls',
    () => ({ ...text(''), calls: [...decision(true).calls, ...use('other', {}).calls] }),
    'invalid_verdict',
    false,
  ],
  ['wrong tool', () => use('other', { allowed: true }), 'invalid_verdict', false],
  [
    'invalid JSON',
    () => ({ ...text(''), calls: [{ ...decision(true).calls[0], args: '{' }] }),
    'invalid_verdict',
    false,
  ],
  [
    'closed Messages reply with malformed arguments',
    ({ onText }) => {
      onText(reviewNote);
      throw new MalformedMessagesArguments();
    },
    'invalid_verdict',
    true,
  ],
  [
    'non-boolean',
    () => use('submit_chapter_patch_review', { allowed: 'true' }),
    'invalid_verdict',
    false,
  ],
  [
    'extra property',
    () => use('submit_chapter_patch_review', { allowed: true, commentary: reviewNote }),
    'invalid_verdict',
    false,
  ],
  [
    'interrupted stream',
    () => {
      throw new DiagnosticFailure('incomplete_stream', reviewNote);
    },
    'incomplete',
    undefined,
  ],
  [
    'timeout',
    () => {
      throw new DOMException(reviewNote, 'TimeoutError');
    },
    'incomplete',
    undefined,
  ],
];

for (const [variant, review, verdict, hasVisibleText] of scopedReviewFailures) {
  test(
    'a scoped chapter patch does not treat an unusable response as approval: ' + variant,
    async (t) => {
      const f = await fixture(t);
      const original = await f.load(10);
      const op = f.start(
        semantic,
        [
          () => use('tool_search', { query: 'book_get_context book_patch_chapter' }),
          () =>
            use('book_task_scope', {
              items: [{ operation: 'chapter.patch', id: original.id, purpose: '核对伤因' }],
            }),
          () => use('check_book_scope', { allowed: true }),
          () => read(10),
          () => f.patch(original),
          review,
          ({ history }) => {
            assert.match(latest(history), /patch_scope/);
            assert.doesNotMatch(latest(history), new RegExp(reviewNote));
            return text('未修改。');
          },
        ],
        undefined,
        true,
      );
      const result = await op.wait();
      assert.equal(result.status, 'completed', result.error);
      assert.equal(result.taskOutcome, 'incomplete');
      assert.deepEqual(await f.load(10), original);
      assert.equal(op.asked.filter((name) => name === 'submit_chapter_patch_review').length, 1);
      assert.ok(!op.trace.rows.some(({ event }) => event === 'workspace.document.committed'));
      const logged = op.trace.rows.filter(({ event }) => event === 'chapter.patch.review');
      assert.deepEqual(
        logged.map(({ fields }) => [fields.verdict, fields.hasVisibleText]),
        [[verdict, hasVisibleText]],
      );
      assert.doesNotMatch(JSON.stringify(op.trace.rows), new RegExp(reviewNote));
      assert.deepEqual(op.trace.rejected, []);
    },
  );
}

test('a read-only current instruction with a real previous quote does not unlock patch', async (t) => {
  const f = await fixture(t);
  const original = await f.load(10);
  const prior = '第十章伤因待核对，可能需要修订。';
  await f.start('列出待办', [() => text(prior)], undefined, true).wait();
  const result = f.start(
    '检查前面的伤因，先别改稿。',
    [
      () => use('tool_search', { query: 'book_get_context book_patch_chapter' }),
      () =>
        use('book_task_scope', {
          sourceQuote: prior,
          items: [{ operation: 'chapter.patch', id: ch(10).id, purpose: '改写伤因' }],
        }),
      () => use('check_book_scope', { allowed: false }),
      () => read(10),
      () => f.patch(original),
      ({ history }) => {
        assert.match(latest(history), /patch_not_authorized/);
        return text('未改稿');
      },
    ],
    undefined,
    true,
  );
  assert.equal((await result.wait()).status, 'completed');
  assert.equal((await f.load(10)).revision, original.revision);
});

test('a verified readback may finish without issuing a write', async (t) => {
  const f = await fixture(t);
  const original = await f.load(10);
  await f.save(original, original.body.replace(injury, correction));
  const updated = await f.load(10);
  const prior = '还要确认第十章的伤因是否已统一为液体烧伤。';
  await f.start('先告诉我还需核对什么', [() => text(prior)], undefined, true).wait();
  const operation = f.start(
    '把前面剩下的事处理完',
    [
      () => use('tool_search', { query: 'book_get_context' }),
      () => read(10),
      () =>
        use('book_task_scope', {
          sourceQuote: prior,
          items: [
            {
              operation: 'chapter.patch',
              id: ch(10).id,
              purpose: '确保伤因为液体烧伤',
              currentEvidence: { revision: updated.revision, quote: correction },
            },
          ],
        }),
      () => use('check_book_scope', { allowed: true }),
      () => text('现稿已满足，无需改动。'),
    ],
    undefined,
    true,
  );
  const run = await operation.wait();
  assert.equal(run.taskOutcome, 'no_write_needed');
  assert.equal(run.progress?.done, 1);
  assert.equal((await f.load(10)).revision, updated.revision);
  assert.equal(
    operation.trace.rows.some(({ event }) => event === 'workspace.document.committed'),
    false,
  );
});

test('a scope cannot borrow a quote that is not in the same conversation', async (t) => {
  const approvedElsewhere = '另一个会话中的任务：第十章把伤因改为液体烧伤。';
  const other = await fixture(t);
  await other.start('列出需要更正的事实', [() => text(approvedElsewhere)], undefined, true).wait();
  const f = await fixture(t);
  const existing = await f.load(10);
  const op = f.start(
    '把参考内容里的问题修完',
    [
      () => use('tool_search', { query: 'book_get_context book_patch_chapter' }),
      () =>
        use('book_task_scope', {
          sourceQuote: approvedElsewhere,
          items: [{ operation: 'chapter.patch', id: ch(10).id, purpose: '使用未核实的外部方案' }],
        }),
      ({ history }) => {
        assert.match(latest(history), /invalid_options/);
        return read(10);
      },
      () => f.patch(existing),
      ({ history }) => {
        assert.match(latest(history), /patch_not_authorized/);
        return text('未写入');
      },
    ],
    undefined,
    true,
  );
  await op.wait();
  assert.equal(op.asked.includes('check_book_scope'), false);
  assert.equal((await f.load(10)).revision, existing.revision);
});

test('accepted scope does not override a later chapter change or mask partial completion', async (t) => {
  const f = await fixture(t);
  const first = await f.load(9);
  const second = await f.load(10);
  const quote = '第9段旅程。';
  const newQuote = '第9段走向渡口。';
  const prior = '先列出两项勘误，不修改章节。';
  const source = '请分别核对第九章的旅程描述和第十章的检察官伤因，这两处仍需要更正。';
  await f.start(prior, [() => text(source)], undefined, true).wait();
  const op = f.start(
    '按刚才的两项处理',
    [
      () => use('tool_search', { query: 'book_get_context book_patch_chapter' }),
      () =>
        use('book_task_scope', {
          sourceQuote: source,
          items: [
            { operation: 'chapter.patch', id: first.id, purpose: '核对第九章的旅程描述' },
            { operation: 'chapter.patch', id: second.id, purpose: '根据第八章核对伤因' },
          ],
        }),
      () => use('check_book_scope', { allowed: true }),
      () => read(9),
      () => f.patch(first, [{ quote, replacement: newQuote }]),
      () => decision(true),
      ({ history }) => {
        assert.match(latest(history), /"patched":1/);
        return read(10);
      },
      async () => {
        const changed = await f.save(second, second.body + '\n\n作者新加的检查标记。');
        assert.equal(changed.error, undefined);
        return f.patch(second);
      },
      ({ history }) => {
        assert.match(latest(history), /conflict/);
        return text('第一处已修，第二处改版未覆盖。');
      },
    ],
    undefined,
    true,
  );
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.taskOutcome, 'partial');
  assert.equal(result.progress?.done, 1);
  assert.match((await f.load(9)).body, new RegExp(newQuote));
  assert.ok((await f.load(10)).body.trimEnd().endsWith('作者新加的检查标记。'));
  assert.equal(op.trace.rows.filter(({ event }) => event === 'chapter.patch.finished').length, 2);
});

test('cancelling a scoped continuation does not commit or replay the candidate', async (t) => {
  const f = await fixture(t);
  const baseline = await f.load(10);
  const prior = '第十章伤因还没按第八章核对。';
  await f.start('只报告遗留', [() => text(prior)], undefined, true).wait();
  const gate = new Gate();
  let reviewing!: () => void;
  const ready = new Promise<void>((resolve) => {
    reviewing = resolve;
  });
  const op = f.start(
    '解决未清理的问题',
    [
      () => use('tool_search', { query: 'book_get_context book_patch_chapter' }),
      () =>
        use('book_task_scope', {
          sourceQuote: prior,
          items: [{ operation: 'chapter.patch', id: ch(10).id, purpose: '更正伤因' }],
        }),
      () => use('check_book_scope', { allowed: true }),
      () => read(10),
      () => f.patch(baseline),
      async ({ signal }) => {
        reviewing();
        await gate.wait(signal);
        return decision(true);
      },
    ],
    undefined,
    true,
  );
  await ready;
  await op.stop();
  assert.equal((await op.wait()).status, 'cancelled');
  assert.equal((await f.load(10)).revision, baseline.revision);
  const next = f.start(
    '只读检查',
    [
      () => use('tool_search', { query: 'book_patch_chapter' }),
      () => f.patch(baseline),
      ({ history }) => {
        assert.match(latest(history), /patch_not_authorized/);
        return text('无需写入');
      },
    ],
    undefined,
    true,
  );
  assert.equal((await next.wait()).status, 'completed');
  assert.equal((await f.load(10)).revision, baseline.revision);
});

const gapLeft = '段尾_GAP_LEFT：他合上了日记。';
const gapRight = '段首_GAP_RIGHT：钟声响起。';
const sixLf = '\n'.repeat(6);
const gapPart = 'spacing';
const gapEdit: ParagraphGapEdit = {
  paragraphGap: { leftQuote: gapLeft, rightQuote: gapRight, blankLines: 1 },
  part: gapPart,
};
const gapPrompt = '请把第十章日记结尾和钟声开头之间的空白缩为一个空行，只改这处。';
const findGapTools = () =>
  use('tool_search', { query: 'book_get_context book_search_text book_patch_chapter' });
const registerGap = (id: string) =>
  use('book_task_scope', {
    items: [{ operation: 'chapter.patch', id, part: gapPart, purpose: gapPrompt }],
  });
const approveScope = () => use('check_book_scope', { allowed: true });

async function gapFixture(f: Awaited<ReturnType<typeof fixture>>, separator = sixLf) {
  const current = await f.load(10);
  const body = `${prefix}\n\n${gapLeft}${separator}${gapRight}\n\n${suffix}${sixLf}${missing}`;
  assert.equal((await f.save(current, body)).error, undefined);
  return f.load(10);
}

test('a paragraph gap needs the whole delivered range, not a preview or just its two anchors', async (t) => {
  const f = await fixture(t);
  const doc = await gapFixture(f);
  const leftAt = doc.body.indexOf(gapLeft);
  const gapAt = leftAt + gapLeft.length;
  const rightAt = gapAt + sixLf.length;
  const attempt = () => f.patch(doc, [gapEdit]);
  const op = f.start(
    gapPrompt,
    [
      findGapTools,
      () => registerGap(doc.id),
      approveScope,
      () => use('book_search_text', { type: 'chapter', documentId: doc.id, query: gapLeft }),
      ({ history }) => {
        assert.ok(latest(history).includes(gapRight));
        return attempt();
      },
      ({ history }) => {
        assert.match(latest(history), /context_required/);
        return read(10, leftAt, gapLeft.length);
      },
      () => read(10, rightAt, gapRight.length),
      attempt,
      ({ history }) => {
        assert.match(latest(history), /context_required/);
        return read(10, gapAt, sixLf.length);
      },
      attempt,
      ({ tools, history }) => {
        assert.deepEqual(
          tools.map(({ name }) => name),
          ['submit_chapter_patch_review'],
        );
        const request = history.at(-1);
        assert.ok(request?.role === 'user');
        const candidate = JSON.parse(request.text);
        assert.deepEqual(candidate.paragraphGap, { beforeLf: 6, afterLf: 2 });
        assert.deepEqual(candidate.edits, [
          { quote: gapLeft + sixLf + gapRight, replacement: `${gapLeft}\n\n${gapRight}`, part: gapPart },
        ]);
        return decision(true);
      },
      ({ history }) => {
        assert.match(latest(history), /"patched":1/);
        return text('只缩短了指定空白。');
      },
    ],
    undefined,
    true,
  );
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.taskOutcome, 'fulfilled');
  const saved = await f.load(10);
  assert.equal(saved.body, doc.body.slice(0, gapAt) + '\n\n' + doc.body.slice(rightAt));
  assert.deepEqual(saved.fields, doc.fields);
  assert.equal(op.asked.filter((name) => name === 'submit_chapter_patch_review').length, 1);
  const receipts = (await f.history()).flatMap(({ toolReceipt }) =>
    toolReceipt?.tool === 'book_patch_chapter' ? [toolReceipt] : [],
  );
  assert.deepEqual(
    receipts.map(({ commitCount, reason }) => [commitCount, reason]),
    [
      [0, 'context_required'],
      [0, 'context_required'],
      [1, undefined],
    ],
  );
  assert.equal(receipts.at(-1)?.commits[0]?.revision, saved.revision);
  assert.doesNotMatch(JSON.stringify(op.trace.rows), /_GAP_LEFT|_GAP_RIGHT/);
});

for (const [name, reason] of [
  ['unregistered', 'patch_not_authorized'],
  ['wrong part', 'patch_scope'],
  ['mixed batch', 'invalid_arguments'],
  ['mixed fields', 'invalid_arguments'],
  ['source evidence', 'invalid_arguments'],
  ['not one blank line', 'invalid_arguments'],
  ['blank anchor', 'invalid_arguments'],
  ['multiline anchor', 'invalid_arguments'],
] as const) {
  test(`a paragraph gap does not write before the existing patch review: ${name}`, async (t) => {
    const f = await fixture(t);
    const doc = await gapFixture(f);
    const regular = { quote: gapLeft, replacement: invented, part: gapPart };
    const editsByCase: Partial<Record<typeof name, object[]>> = {
      unregistered: [{ paragraphGap: gapEdit.paragraphGap }],
      'wrong part': [{ ...gapEdit, part: 'another' }],
      'mixed batch': [gapEdit, regular],
      'mixed fields': [{ ...gapEdit, ...regular }],
      'not one blank line': [{ ...gapEdit, paragraphGap: { ...gapEdit.paragraphGap, blankLines: 0 } }],
      'blank anchor': [{ ...gapEdit, paragraphGap: { ...gapEdit.paragraphGap, leftQuote: ' \t' } }],
      'multiline anchor': [
        { ...gapEdit, paragraphGap: { ...gapEdit.paragraphGap, leftQuote: gapLeft + '\n' } },
      ],
    };
    const edits = editsByCase[name] ?? [gapEdit];
    const evidence =
      name === 'source evidence'
        ? [{ chapterId: ch(8).id, revision: (await f.load(8)).revision, quote: source }]
        : undefined;
    const op = f.start(
      gapPrompt,
      [
        findGapTools,
        ...(name === 'unregistered' ? [] : [() => registerGap(doc.id), approveScope]),
        () => read(10),
        () => use('book_patch_chapter', { chapterId: doc.id, revision: doc.revision, edits, evidence }),
        () => text('没有写入。'),
      ],
      undefined,
      true,
    );
    const result = await op.wait();
    assert.equal(result.status, 'completed', result.error);
    assert.notEqual(result.taskOutcome, 'fulfilled');
    assert.deepEqual(await f.load(10), doc);
    assert.ok(!op.asked.includes('submit_chapter_patch_review'));
    assert.ok(!op.trace.rows.some(({ event }) => event === 'workspace.document.committed'));
    assert.ok(
      op.trace.rows.some(
        ({ event, fields }) =>
          (event === 'tool.rejected' || event === 'chapter.patch.finished') && fields.reason === reason,
      ),
    );
  });
}

test('an already-correct paragraph gap is not a commit or fulfillment', async (t) => {
  const f = await fixture(t);
  const doc = await gapFixture(f, '\n\n');
  const op = f.start(
    gapPrompt,
    [
      findGapTools,
      () => registerGap(doc.id),
      approveScope,
      () => f.patch(doc, [gapEdit]),
      ({ history }) => {
        assert.match(latest(history), /context_required/);
        return read(10);
      },
      () => f.patch(doc, [gapEdit]),
      ({ history }) => {
        assert.match(latest(history), /已有 1 个空行，无需改动/);
        assert.doesNotMatch(latest(history), /"patched"/);
        return text('现有空行无需改动。');
      },
    ],
    undefined,
    true,
  );
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.taskOutcome, 'incomplete');
  assert.deepEqual(await f.load(10), doc);
  assert.ok(!op.asked.includes('submit_chapter_patch_review'));
  assert.ok(!op.trace.rows.some(({ event }) => event === 'workspace.document.committed'));
  const receipts = (await f.history()).flatMap(({ toolReceipt }) =>
    toolReceipt?.tool === 'book_patch_chapter' ? [toolReceipt.commitCount] : [],
  );
  assert.deepEqual(receipts, [0, 0]);
});

for (const outcome of ['denied', 'invalid_verdict', 'conflict', 'cancelled'] as const) {
  test(`a reviewed paragraph gap keeps zero commits on ${outcome}`, async (t) => {
    const f = await fixture(t);
    const doc = await gapFixture(f);
    const ready = new Gate(),
      next = new Gate();
    const manual = doc.body + '\n\n作者并发保存的内容。';
    const op = f.start(
      gapPrompt,
      [
        findGapTools,
        () => registerGap(doc.id),
        approveScope,
        () => read(10),
        () => f.patch(doc, [gapEdit]),
        async ({ signal }) => {
          if (outcome === 'denied') return decision(false);
          if (outcome === 'invalid_verdict') return text(reviewNote);
          ready.release();
          await next.wait(signal);
          return decision(true);
        },
        ({ history }) => {
          assert.match(latest(history), outcome === 'conflict' ? /conflict/ : /patch_scope/);
          return text('没写入。');
        },
      ],
      undefined,
      true,
    );
    if (outcome === 'conflict' || outcome === 'cancelled') {
      await ready.wait(AbortSignal.timeout(5000));
      if (outcome === 'cancelled') await op.stop();
      else assert.equal((await f.save(doc, manual)).error, undefined);
      next.release();
    }
    const result = await op.wait();
    assert.equal(result.status, outcome === 'cancelled' ? 'cancelled' : 'completed', result.error);
    assert.notEqual(result.taskOutcome, 'fulfilled');
    const saved = await f.load(10);
    if (outcome === 'conflict') assert.equal(saved.body, manual);
    else assert.deepEqual(saved, doc);
    assert.equal(op.asked.filter((name) => name === 'submit_chapter_patch_review').length, 1);
    assert.ok(!op.trace.rows.some(({ event }) => event === 'workspace.document.committed'));
    const review = op.trace.rows.find(({ event }) => event === 'chapter.patch.review');
    assert.equal(
      review?.fields.verdict,
      outcome === 'conflict' ? 'approved' : outcome === 'cancelled' ? 'incomplete' : outcome,
    );
    const receipts = (await f.history()).flatMap(({ toolReceipt }) =>
      toolReceipt?.tool === 'book_patch_chapter' ? [toolReceipt.commitCount] : [],
    );
    assert.deepEqual(receipts, [0]);
  });
}
