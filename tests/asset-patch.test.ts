import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Manuscript, RunInfo, WorkProgress } from '../shared/contracts.js';
import { diagnosticScope } from '../shared/diagnostics.js';
import type { AssetPatch } from '../electron/agent/asset-patch.js';
import type { ModelProvider } from '../electron/agent/model.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import type { RunContext } from '../electron/agent/runs.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { BookTaskScope } from '../electron/agent/task-scope.js';
import { projectReadResult, type DocumentPage } from '../electron/agent/tool-context.js';
import { discoverTools } from '../electron/agent/tool-discovery.js';
import { WorkspaceService } from '../electron/workspace.js';
import { collectDiagnostics } from './diagnostic-fixture.js';

const actor = { type: 'subject', id: 'keeper' } as const;
const clue = { type: 'clue', id: 'seal-return' } as const;
const chapter = { type: 'chapter', id: 'turn' } as const;
const outline = { type: 'outline', id: 'outline' } as const;
const planned = 'ASSET_OLD_MARKER：守灯人计划在夜间归还铜印。';
const happened = 'ASSET_NEW_MARKER：守灯人已在夜间归还铜印。';
const otherSentence = '铜印的边角有独特的裂纹。';
const link = '[铜印归还](../chapters/turn.md#arrival)';
const defaultBody = `## 稳定设定\n\n守灯人常在渡口巡查。${'潮'.repeat(900)}\n\n${planned}\n\n${otherSentence}\n\n关联：${link}\n`;
const update = (kind: 'subject' | 'clue', id: string) => ({ kind, action: 'update', targets: [{ id }] });

async function fixture(t: TestContext, body = defaultBody, allowScope = true, direction?: string) {
  const root = await mkdtemp(join(tmpdir(), 'fw-asset-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notify: string[][] = [];
  const ws = new WorkspaceService({
    libraryRoot: root,
    onChange: (_, refs) => notify.push(refs.map(({ type, id }) => `${type}/${id}`)),
  });
  await ws.init();
  const book = await ws.createBook({ title: '归还铜印', summary: '渡口纪事。' });
  const seeded = await ws.writeChanges(book.id, [
    { ...actor, expect: null, fields: { name: '守灯人', kind: 'character' }, body },
    { ...chapter, expect: null, fields: { title: '归还', order: 1 }, body: '守灯人在夜间归还了铜印。' },
    {
      ...clue,
      expect: null,
      fields: { title: '铜印', subjectIds: [actor.id], setupChapterId: chapter.id },
      body: `## 可见线索\n\n${otherSentence}\n\n## 回收真相\n\n${planned}\n\n关联：${link}\n`,
    },
  ]);
  assert.equal(seeded.error, undefined);
  notify.length = 0;
  const trace = collectDiagnostics();
  const controller = new AbortController();
  const runId = randomUUID();
  let outcome: RunInfo['taskOutcome'];
  let progress: WorkProgress | undefined;
  const ctx: RunContext = {
    id: runId,
    authorLine: 1,
    session: {
      id: randomUUID(),
      bookId: book.id,
      label: 'fixture',
      cwd: ws.bookRoot(book.id),
      updated: '',
    },
    signal: controller.signal,
    diagnostic: diagnosticScope(trace.report, { runId }),
    text() {},
    async line() {},
    preview() {},
    progress(value) {
      progress = value;
    },
    taskOutcome(value) {
      outcome = value;
    },
    async saveNovelTask() {},
  };
  const checked: string[] = [];
  const model: ModelProvider = {
    effort: 'default',
    async turn({ tools, history }) {
      assert.deepEqual(
        tools.map(({ name }) => name),
        ['check_book_scope'],
        'only the existing scope review',
      );
      checked.push((history[0] as { text: string }).text);
      return {
        role: 'assistant',
        text: '',
        calls: [
          {
            id: 'scope-verdict',
            name: 'check_book_scope',
            args: JSON.stringify({ allowed: allowScope }),
          },
        ],
      };
    },
  };
  const author = allowScope ? '只把资料里铜印归还处的计划表述改成已发生。' : '只看资料，不改稿。';
  const scope = new BookTaskScope(ctx, direction ?? author, model);
  const novel = new NovelTools(ws, book.id, model, new SkillCatalog('skills'), { scope });
  const documents = async () => (await ws.readAll(book.id)).documents;
  const exposed = novel.tools();
  const execute = (name: string, args: object, run = ctx) =>
    exposed.find((tool) => tool.name === name)!.execute(args, run);
  const register = (
    doc: Manuscript,
    mode: {
      assetPatch?: AssetPatch;
      assetPending?: true;
      currentEvidence?: { revision: string; quote: string };
    } = {},
  ) =>
    scope
      .tool(documents)
      .execute(
        { items: [{ operation: `${doc.type}.update`, id: doc.id, purpose: '处理资料计划态', ...mode }] },
        ctx,
      );
  const read = async (doc: Manuscript, offset = 0, length = doc.body.length, limit?: number) => {
    let delivery: Parameters<NonNullable<RunContext['onToolResultDispatch']>>[0] | undefined;
    const value = (await execute(
      'book_get_context',
      { type: doc.type, documentId: doc.id, offset, length },
      {
        ...ctx,
        onToolResultDispatch(fn) {
          delivery = fn;
        },
      },
    )) as DocumentPage;
    assert.ok(delivery);
    const sent =
      limit === undefined
        ? value
        : (projectReadResult('book_get_context', { ok: true, value }, limit)!.value as DocumentPage);
    delivery(() => {}, { ok: true, value: sent });
    return sent;
  };
  const replace = (doc: Manuscript, patch: AssetPatch, run?: RunContext) =>
    execute('book_patch_asset', { kind: doc.type, id: doc.id, ...patch }, run);
  const load = (ref = actor as typeof actor | typeof clue) => ws.readDocument(book.id, ref);
  const save = (doc: Manuscript, body: string) =>
    ws.writeChanges(book.id, [{ ...doc, expect: doc.revision, body }]);
  return {
    ws,
    ctx,
    book,
    scope,
    novel,
    model,
    checked,
    trace,
    notify,
    execute,
    register,
    read,
    replace,
    load,
    save,
    documents,
    abort: () => controller.abort(),
    result: () => ({ outcome, progress }),
  };
}

const patch = ({ revision }: Manuscript, quote = planned, replacement = happened) => ({
  revision,
  quote,
  replacement,
});
const failure = (diagnosticReason: string) => ({ diagnosticReason });

test('a new-note sync cannot be registered without a current creation and scene receipt', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.scope
      .tool(f.documents)
      .execute(
        { items: [{ operation: 'subject.sync', id: actor.id, purpose: '同步本轮新建主体的场景状态' }] },
        f.ctx,
      ),
    failure('context_required'),
  );
  assert.equal(f.checked.length, 0);
  assert.deepEqual(f.scope.items, []);
  assert.deepEqual(f.notify, []);
});

test('a missing chapter draft returns the catalog-before-prose dependency without partial registration', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.scope.tool(f.documents).execute(
      {
        items: [
          { operation: 'chapter.catalog', id: 'new-chapter', purpose: '新章目录' },
          { operation: 'chapter.draft', id: 'new-chapter', purpose: '新章正文' },
        ],
      },
      f.ctx,
    ),
    {
      diagnosticReason: 'missing',
      message: /new-chapter.*chapter\.catalog.*book_apply_changes.*chapter\.draft/u,
    },
  );
  assert.equal(f.checked.length, 0);
  assert.deepEqual(f.scope.items, []);
  await assert.rejects(f.ws.readDocument(f.book.id, { type: 'chapter', id: 'new-chapter' }));
});

test('other missing documents and denied scope decisions do not instruct the Agent to create a chapter', async (t) => {
  const f = await fixture(t, defaultBody, false);
  const register = (operation: string, id: string) =>
    f.scope.tool(f.documents).execute({ items: [{ operation, id, purpose: '核对目标' }] }, f.ctx);
  for (const [operation, id] of [
    ['chapter.patch', 'missing-chapter'],
    ['subject.update', 'missing-note'],
  ])
    await assert.rejects(register(operation, id), {
      diagnosticReason: 'missing',
      message: /^(?!.*chapter\.catalog)/u,
    });
  await assert.rejects(register('chapter.draft', chapter.id), {
    diagnosticReason: 'invalid_options',
    message: /^(?!.*chapter\.catalog)/u,
  });
  assert.equal(f.checked.length, 1);
  assert.deepEqual(f.scope.items, []);
  assert.deepEqual(f.notify, []);
});

for (const variant of [
  'changed-scene',
  'changed-asset',
  'author-restricted',
  'independent-pending',
] as const) {
  test(`a recorded scene sync never becomes a whole-note update: ${variant}`, async (t) => {
    const note = { type: 'subject', id: 'new-seal' } as const;
    const addedScene = '鸦羽人擦过铜印，石墙上亮起三道金纹。';
    const savedPlan = '后期登场：铜印本应落在没有灯光的仓库。';
    const stable = '铜印上有一枚无法磨去的鸟形刻痕。';
    const noteBody = `## 稳定设定\n${stable}\n\n## 计划\n- ${savedPlan}\n\n## 档案\n保留旧编号。`;
    const restricted = variant === 'author-restricted';
    const f = await fixture(
      t,
      defaultBody,
      true,
      '新增铜印并在归还章写下金纹。' +
        (restricted ? '正文落盘后不要再改资料。' : '以实际片段同步新资料。'),
    );
    const review = f.model.turn.bind(f.model);
    let syncRequests = 0;
    const response = (text: string, name?: string, args?: object) => ({
      role: 'assistant' as const,
      text,
      calls: name ? [{ id: 'fixture-' + name, name, args: JSON.stringify(args) }] : [],
    });
    f.model.turn = async (request) => {
      const { tools, history } = request;
      const tool = tools[0]?.name;
      if (!tool) return response(addedScene);
      if (tool === 'book_read_chapter') return response('现有定位足够。');
      if (tool === 'submit_story_descriptions')
        return response('', tool, { items: [{ id: note.id, body: noteBody }] });
      if (tool === 'check_book_scope') {
        const checked = await review(request);
        if (
          restricted &&
          JSON.parse((history[0] as { text: string }).text).candidates[0].operation === 'subject.sync'
        )
          return response('', tool, { allowed: false });
        return checked;
      }
      if (tool === 'submit_story_sync') {
        syncRequests++;
        assert.equal(
          variant,
          'independent-pending',
          'denials/conflicts must stop before a sync request',
        );
        return response('', tool, {
          evidence: [{ source: 1, status: 'appearance', excerpt: 1 }],
          edits: [],
        });
      }
      assert.fail(`Unexpected request: ${tool}`);
    };
    const register = (...items: object[]) =>
      f.scope.tool(f.documents, f.novel.scopeSyncTargets).execute({ items }, f.ctx);
    const sync = { operation: 'subject.sync', id: note.id, purpose: '只核对已提交金纹和被取代的计划' };
    await register(
      { operation: 'subject.create', id: note.id, purpose: '创建铜印' },
      { operation: 'chapter.insert', id: chapter.id, purpose: '补写金纹现身', stage: 'reveal' },
    );
    await f.execute('book_generate_assets', {
      kind: note.type,
      action: 'create',
      targets: [{ id: note.id, fields: { name: '铜印', kind: 'item' } }],
    });
    const originalNote = await f.ws.readDocument(f.book.id, note);
    await assert.rejects(register(sync), failure('context_required'));
    const originalChapter = await f.ws.readDocument(f.book.id, chapter);
    await f.read(originalChapter);
    await f.execute('book_generate_chapter', {
      chapterId: chapter.id,
      mode: 'insert',
      subjectIds: [note.id],
      insertion: {
        revision: originalChapter.revision,
        quote: originalChapter.body.trim(),
        place: 'after',
      },
    });
    const currentChapter = await f.ws.readDocument(f.book.id, chapter);
    assert.match(currentChapter.body, /三道金纹/u);
    const call = () => f.execute('book_generate_assets', update(note.type, note.id));
    f.notify.length = 0;
    if (restricted) {
      await assert.rejects(register(sync), failure('invalid_options'));
      assert.match(f.checked.at(-1)!, /不要再改资料/);
      await assert.rejects(call(), failure('asset_update_route'));
      assert.equal(f.scope.item('subject.sync', note.id), undefined);
    } else {
      await assert.rejects(
        register({ ...sync, operation: 'subject.update' }),
        failure('asset_update_route'),
      );
      if (variant === 'independent-pending') {
        await f.register(originalNote, { assetPending: true });
        await assert.rejects(call(), failure('asset_update_route'));
      }
      await register(sync);
      assert.deepEqual(JSON.parse(f.checked.at(-1)!).candidates[0].syncEvidence, {
        createdRevision: originalNote.revision,
        currentAssetRevision: originalNote.revision,
        sceneCount: 1,
        passages: [expectScene()],
      });
      function expectScene() {
        const [target] = f.novel.scopeSyncTargets([originalNote, currentChapter])[0].passages;
        return {
          target,
          chapterId: chapter.id,
          stage: 'reveal',
          committedRevision: currentChapter.revision,
          currentRevision: currentChapter.revision,
          excerpt: addedScene,
        };
      }
      if (variant === 'independent-pending') {
        const recovery = await f.novel.narrowedWritingStep(f.ctx);
        assert.ok(recovery?.accepts('book_generate_assets', update(note.type, note.id)));
        assert.ok(
          !recovery?.accepts('book_generate_assets', {
            ...update(note.type, note.id),
            targets: [{ id: note.id, fields: { name: '越界的名称' } }],
          }),
        );
        await f.register(await f.load());
        await assert.rejects(
          f.execute('book_generate_assets', {
            kind: note.type,
            action: 'update',
            targets: [{ id: note.id }, { id: actor.id }],
          }),
          failure('asset_update_route'),
        );
        assert.deepEqual(f.notify, []);
        const result = (await call()) as { assets: { revision: string }[]; pendingSync: unknown[] };
        const actual = await f.ws.readDocument(f.book.id, note);
        assert.equal(result.assets[0].revision, actual.revision);
        assert.deepEqual(result.pendingSync, []);
        assert.deepEqual(actual.fields, originalNote.fields);
        assert.ok(actual.body.includes(stable) && actual.body.includes('保留旧编号。'));
        assert.ok(actual.body.includes(addedScene) && !actual.body.includes(savedPlan));
        await f.novel.assertFinished(f.ctx);
        assert.equal(f.result().outcome, 'partial');
        assert.deepEqual(f.notify, [[`subject/${note.id}`]]);
        assert.equal(syncRequests, 1);
        return;
      }
      const changed = variant === 'changed-asset' ? originalNote : currentChapter;
      assert.equal((await f.save(changed, changed.body + '\n\n作者手动修改。')).error, undefined);
      if (variant === 'changed-asset') {
        const revised = await f.ws.readDocument(f.book.id, note);
        await f.read(revised);
        const exact = patch(revised, '保留旧编号。', '核对编号后归档。');
        await f.register(revised, { assetPatch: exact });
        await f.replace(revised, exact);
      }
      f.notify.length = 0;
      await assert.rejects(call(), failure('conflict'));
      await assert.rejects(register(sync), failure('conflict'));
      assert.match((await f.ws.readDocument(f.book.id, changed)).body, /作者手动修改/u);
    }
    assert.equal(syncRequests, 0);
    assert.deepEqual(f.notify, []);
    await f.novel.assertFinished(f.ctx);
    assert.equal(f.result().outcome, 'partial');
    assert.deepEqual(
      f.result().progress?.local?.remaining.filter(({ operation }) => operation.endsWith('.sync')),
      [{ operation: 'subject.sync', id: note.id }],
    );
  });
}

for (const ref of [actor, clue]) {
  test(`a ${ref.type} exact patch uses only its current dispatched slice and an actual commit`, async (t) => {
    const f = await fixture(t);
    const doc = await f.load(ref);
    const before = await f.documents();
    const catalog = discoverTools(f.novel.tools());
    assert.ok(!catalog.visible().some(({ name }) => name === 'book_patch_asset'));
    const hits = (await catalog.registry[0].execute({ query: 'book_patch_asset' }, f.ctx)) as {
      candidates: { id: string; access: string }[];
    };
    assert.deepEqual(
      hits.candidates.slice(0, 1).map(({ id, access }) => ({ id, access })),
      [{ id: 'book_patch_asset', access: 'write' }],
    );
    assert.ok(
      !new NovelTools(f.ws, f.book.id, f.model, new SkillCatalog('skills'))
        .tools()
        .some(({ name }) => name === 'book_patch_asset'),
    );
    const range = doc.body.indexOf(planned);
    const endOfFirst = planned.indexOf('守灯人');
    await f.read(doc, range, endOfFirst);
    await f.read(doc, range + endOfFirst, planned.length - endOfFirst);
    const input = patch(doc);
    await f.register(doc, { assetPatch: input });
    assert.deepEqual(JSON.parse(f.checked[0]).candidates[0].assetPatch, input);
    const receipt = await f.replace(doc, input);
    const saved = await f.load(ref);
    assert.deepEqual(receipt, { kind: ref.type, id: ref.id, revision: saved.revision, patched: 1 });
    assert.deepEqual(saved.fields, doc.fields);
    assert.equal(saved.body, doc.body.replace(planned, happened));
    assert.deepEqual(
      (await f.documents()).filter(({ id }) => id !== ref.id),
      before.filter(({ id }) => id !== ref.id),
    );
    assert.deepEqual(f.notify, [[`${ref.type}/${ref.id}`]]);
    const commit = f.trace.rows.filter(({ event }) => event === 'workspace.document.committed');
    assert.equal(commit.length, 1);
    const finished = f.trace.rows.find(({ event }) => event === 'asset.patch.finished');
    assert.match(String(commit[0].fields.revision), /^[0-9a-f]{16}$/u);
    assert.equal(commit[0].fields.revision, finished?.fields.revision);
    assert.notEqual(commit[0].fields.expectedRevision, commit[0].fields.revision);
    await f.novel.assertFinished(f.ctx);
    assert.equal(f.result().outcome, 'fulfilled');
    assert.deepEqual(f.trace.rejected, []);
    assert.doesNotMatch(JSON.stringify(f.trace.rows), /ASSET_(OLD|NEW)_MARKER/);
    assert.equal(f.checked.length, 1);
    await assert.rejects(f.replace(doc, input), failure('conflict'));
  });
}

test('a precise binding cannot authorize other anchors, replacements, owners, generic routes or recovery writes', async (t) => {
  const f = await fixture(t);
  const doc = await f.load();
  const originalOutline = await f.ws.readDocument(f.book.id, outline);
  await f.read(doc);
  const input = patch(doc);
  await f.register(doc, { assetPatch: input });
  for (const wrong of [
    patch(doc, otherSentence),
    patch(doc, planned, otherSentence),
    { ...input, revision: '0'.repeat(64) },
  ])
    await assert.rejects(f.replace(doc, wrong), failure('patch_not_authorized'));
  for (const different of [
    { id: randomUUID() },
    { authorLine: 2 },
    { session: { ...f.ctx.session, id: randomUUID() } },
    { session: { ...f.ctx.session, bookId: randomUUID() } },
    { narrowedWriting: true },
  ])
    await assert.rejects(
      f.replace(doc, input, { ...f.ctx, ...different }),
      failure('patch_not_authorized'),
    );
  await assert.rejects(
    f.execute('book_generate_assets', update('subject', doc.id)),
    failure('asset_update_route'),
  );
  await f.scope
    .tool(f.documents)
    .execute(
      { items: [{ operation: 'outline.write', id: outline.id, purpose: '对照范围内的大纲操作' }] },
      f.ctx,
    );
  await assert.rejects(
    f.execute('book_apply_changes', {
      operations: [
        { ...outline, action: 'update', body: '# 与资料更新同批的大纲' },
        { ...actor, action: 'update', body: happened },
      ],
    }),
    failure('asset_update_route'),
  );
  const recovery = await f.novel.narrowedWritingStep(f.ctx);
  assert.ok(!recovery?.accepts('book_generate_assets', update('subject', doc.id)));
  assert.ok(!recovery?.accepts('book_patch_asset', { kind: doc.type, id: doc.id, ...input }));
  assert.deepEqual(await f.load(), doc);
  assert.deepEqual(await f.ws.readDocument(f.book.id, outline), originalOutline);
  assert.equal(f.scope.summarize(await f.documents()).done, 0);
  assert.equal(f.checked.length, 2);
  assert.equal(f.notify.length, 0);
});

for (const mode of ['document', 'pending', 'satisfied', 'read-only'] as const) {
  test(`a ${mode} scope is not a precise patch binding`, async (t) => {
    const f = await fixture(t, defaultBody, mode !== 'read-only');
    const doc = await f.load();
    await f.read(doc);
    const input = patch(doc);
    if (mode === 'read-only')
      await assert.rejects(f.register(doc, { assetPatch: input }), failure('invalid_options'));
    else
      await f.register(
        doc,
        mode === 'pending'
          ? { assetPending: true }
          : mode === 'satisfied'
            ? { currentEvidence: { revision: doc.revision, quote: planned } }
            : {},
      );
    await assert.rejects(f.replace(doc, input), failure('patch_not_authorized'));
    if (mode === 'pending') {
      await assert.rejects(
        f.execute('book_generate_assets', update('subject', doc.id)),
        failure('asset_update_route'),
      );
      assert.equal(f.scope.summarize(await f.documents()).remaining[0].assetPending, true);
      await f.novel.assertFinished(f.ctx);
      assert.equal(f.result().outcome, 'incomplete');
    } else if (mode === 'satisfied') {
      await f.novel.assertFinished(f.ctx);
      assert.equal(f.result().outcome, 'no_write_needed');
    }
    assert.deepEqual(await f.load(), doc);
    assert.equal(f.notify.length, 0);
  });
}

test('search hits and projected or gapped pages do not cover an exact patch', async (t) => {
  const f = await fixture(t);
  const doc = await f.load();
  const input = patch(doc);
  await f.register(doc, { assetPatch: input });
  const hits = await f.execute('book_search_text', { query: planned });
  assert.match(JSON.stringify(hits), /ASSET_OLD_MARKER/);
  await assert.rejects(f.replace(doc, input), failure('context_required'));
  const start = doc.body.indexOf(planned);
  const page = await f.read(doc, start, planned.length, 0);
  assert.equal(page.pageState, 'deferred');
  await assert.rejects(f.replace(doc, input), failure('context_required'));
  await f.read(doc, start, 3);
  await f.read(doc, start + 4, planned.length - 4);
  await assert.rejects(f.replace(doc, input), failure('context_required'));
  assert.deepEqual(await f.load(), doc);
  assert.equal(f.notify.length, 0);
});

for (const variant of ['absent', 'ambiguous', 'no-op', 'entire-description', 'changed-link'] as const) {
  test(`invalid exact asset patch does not write: ${variant}`, async (t) => {
    const f = await fixture(
      t,
      variant === 'ambiguous'
        ? defaultBody + planned
        : variant === 'entire-description'
          ? planned + '\n'
          : defaultBody,
    );
    const doc = await f.load();
    await f.read(doc);
    const bad =
      variant === 'absent'
        ? patch(doc, '不在说明中的短文。')
        : variant === 'no-op'
          ? patch(doc, planned, planned)
          : variant === 'changed-link'
            ? patch(doc, link, '删掉原引用')
            : patch(doc);
    await f.register(doc, { assetPatch: bad });
    await assert.rejects(
      f.replace(doc, bad),
      failure(variant === 'absent' || variant === 'ambiguous' ? 'patch_anchor' : 'patch_scope'),
    );
    assert.deepEqual(await f.load(), doc);
    assert.equal(f.notify.length, 0);
  });
}

test('manual revision changes need both current readback and a fresh exact registration', async (t) => {
  const f = await fixture(t);
  const doc = await f.load();
  const old = patch(doc);
  await f.read(doc, doc.body.indexOf(planned), planned.length);
  await f.register(doc, { assetPatch: old });
  assert.equal((await f.save(doc, '作者补写。\n\n' + doc.body)).error, undefined);
  const modified = await f.load();
  await assert.rejects(f.replace(doc, old), failure('conflict'));
  await assert.rejects(f.register(doc, { assetPatch: old }), failure('conflict'));
  const fresh = patch(modified);
  await f.register(modified, { assetPatch: fresh });
  await assert.rejects(f.replace(modified, fresh), failure('context_required'));
  await f.read(modified, modified.body.indexOf(planned), planned.length);
  await f.replace(modified, fresh);
  const saved = await f.load();
  assert.equal(saved.body, modified.body.replace(planned, happened));
  assert.equal(f.scope.summarize(await f.documents()).done, 1);
  const second = patch(saved, otherSentence, '裂纹只有亲眼看过才认得。');
  await f.register(saved, { assetPatch: second });
  assert.equal(
    f.scope.summarize(await f.documents()).done,
    0,
    'the first commit cannot fulfill a different binding',
  );
  assert.equal(f.notify.length, 2);
});

for (const race of ['manual write', 'cancellation'] as const) {
  test(`the shared commit precondition wins over an already checked asset patch: ${race}`, async (t) => {
    const f = await fixture(t);
    const doc = await f.load();
    const input = patch(doc);
    await f.read(doc, doc.body.indexOf(planned), planned.length);
    await f.register(doc, { assetPatch: input });
    const write = f.ws.writeChanges.bind(f.ws);
    const authored = '作者在提交前保存了这一行。\n\n' + doc.body;
    f.ws.writeChanges = async (...args) => {
      if (race === 'manual write')
        assert.equal(
          (await write(f.book.id, [{ ...doc, body: authored, expect: doc.revision }])).error,
          undefined,
        );
      else f.abort();
      return write(...args);
    };
    await assert.rejects(
      f.replace(doc, input),
      failure(race === 'manual write' ? 'conflict' : 'cancelled'),
    );
    assert.equal((await f.load()).body, race === 'manual write' ? authored : doc.body);
    assert.equal(f.scope.summarize(await f.documents()).done, 0);
    assert.ok(!f.trace.rows.some(({ event }) => event === 'workspace.document.committed'));
  });
}
