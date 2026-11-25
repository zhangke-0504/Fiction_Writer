import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DocRef, Manuscript } from '../shared/contracts.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import { prosePatchIntent } from '../electron/agent/chapter-intent.js';
import { runAgent } from '../electron/agent/loop.js';
import { RunManager } from '../electron/agent/runs.js';
import { Gate, ScriptedProvider, type Script } from '../electron/agent/scripted.js';
import { SkillCatalog } from '../electron/agent/skills.js';
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
    edits = [{ quote: injury, replacement: correction }],
    evidence?: object[],
  ) => use('book_patch_chapter', { chapterId: doc.id, revision: doc.revision, edits, evidence });
  const start = (prompt: string, script: Script[], selectedChapterId?: string) => {
    const trace = collectDiagnostics();
    const model = new ScriptedProvider(script);
    const asked: string[] = [];
    const step = model.turn.bind(model);
    model.turn = (req) => {
      const named = req.tools.length === 1 ? req.tools[0].name : '';
      asked.push(named || (req.tools.length ? 'main' : 'draft'));
      return named === 'book_read_chapter' ? Promise.resolve(text('无需回读')) : step(req);
    };
    const novel = new NovelTools(ws, id, model, catalog, { authorPrompt: prompt, selectedChapterId });
    runs.start(
      session.id,
      prompt,
      async (ctx) => {
        const system = novel.prepareEdit(ctx, (await ws.readAll(id)).documents);
        await runAgent(
          ctx,
          model,
          system,
          [],
          prompt,
          [...catalog.tools((name) => novel.skillApplied(name)), ...novel.tools()],
          novel,
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
      return f.patch(await f.load(10));
    },
    ({ history }) => {
      assert.match(latest(history), /patch_scope/);
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
    ],
  );
  assert.deepEqual(op.trace.rejected, []);
  assert.doesNotMatch(JSON.stringify(op.trace.rows), /_OLD_ONLY|_NEW_ONLY|_SOURCE_ONLY/);
});

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
const activate = () => use('skill_load', { name: 'generate-novel' });
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
  const op = f.start(whole, [
    activate,
    () => goal(),
    ...draftSteps(1, 10),
    async () => {
      completedDrafts = (await f.ws.readAll(f.id)).documents;
      assert.equal(completedDrafts.filter((d) => d.type === 'chapter' && d.body.trim()).length, 10);
      return read(10);
    },
    () => read(8),
    async () =>
      f.patch(await f.load(10), [{ quote: missing, replacement: invented }], proofFor(await f.load(8))),
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
  ]);
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
        .start(whole, [activate, () => goal(), () => text('第十章尚未写入。')])
        .wait();
      assert.equal(initial.status, 'failed');
    }
    const op = f.start(kind === 'resumed' ? '接着写完。' : whole, [
      activate,
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
    ]);
    const result = await op.wait();
    assert.equal(result.status, 'completed', result.error);
    assert.equal(op.asked.filter((s) => s === 'submit_chapter_patch_review').length, 0);
    assert.equal(
      (await f.load(10)).body,
      lastDraft + (kind === 'author-edited' ? '\n作者另加一句。' : ''),
    );
  });
}

for (const variant of ['invalid-evidence', 'invalid-verdict', 'not-read'] as const) {
  test('an attempted new-draft correction fails closed: ' + variant, async (t) => {
    const f = await fixture(t, 9);
    const op = f.start(whole, [
      activate,
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
        : []),
      ({ history }) => {
        assert.match(latest(history), /patch_evidence/);
        return text('勘误证据不足，没有写入。');
      },
    ]);
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
