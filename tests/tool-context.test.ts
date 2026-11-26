import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ActiveContext } from '../electron/agent/active-context.js';
import {
  recallBookMemory,
  type BookRecall,
  type ReportMemoryDispatch,
} from '../electron/agent/book-memory.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import type { RunContext } from '../electron/agent/runs.js';
import { ScriptedProvider } from '../electron/agent/scripted.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { projectReadResult, type DocumentPage } from '../electron/agent/tool-context.js';
import { discoverTools } from '../electron/agent/tool-discovery.js';
import { WorkspaceService } from '../electron/workspace.js';
import type { ToolResult } from '../shared/contracts.js';
import { diagnosticScope } from '../shared/diagnostics.js';
import { collectDiagnostics } from './diagnostic-fixture.js';

const first = { type: 'chapter', id: 'first' } as const;
const second = { type: 'chapter', id: 'second' } as const;
const asset = { type: 'subject', id: 'actor' } as const;
const quote = '一枚铜印静静躺在旧门外。';
const replacement = '一枚旧钥匙静静躺在门外。';
const author = `请把第一章的「${quote}」改成「${replacement}」。`;
const body = '🌊' + '潮'.repeat(1_650) + '\n' + quote + '\n' + '门'.repeat(2_500);
const diagnostic = () => {};
const stringCall = (name: string, args: object) => ({
  id: name,
  name,
  args: JSON.stringify(args),
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'fw-tool-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = new WorkspaceService({ libraryRoot: root });
  await ws.init();
  const book = await ws.createBook({ title: '旧港', summary: '只读夹具。' });
  const other = await ws.createBook({ title: '他书', summary: '只读夹具。' });
  const seed = await ws.writeChanges(book.id, [
    { ...first, expect: null, fields: { title: '第一章', order: 1 }, body },
    { ...second, expect: null, fields: { title: '第二章', order: 2 }, body: '灯塔仍在。' },
    {
      ...asset,
      expect: null,
      fields: { name: '港口船夫', kind: 'character' },
      body: '旧港角色。'.repeat(800),
    },
  ]);
  assert.equal(seed.error, undefined);
  assert.equal(
    (
      await ws.writeChanges(other.id, [
        {
          type: 'chapter',
          id: 'off-book',
          expect: null,
          fields: { title: '另一本书', order: 1 },
          body: quote,
        },
      ])
    ).error,
    undefined,
  );
  const model = new ScriptedProvider([
    () => ({
      role: 'assistant',
      text: '',
      calls: [stringCall('submit_chapter_patch_review', { allowed: true })],
    }),
  ]);
  const novel = new NovelTools(ws, book.id, model, new SkillCatalog('skills'), { authorPrompt: author });
  const tools = novel.tools();
  const ctx: RunContext = {
    id: randomUUID(),
    session: {
      id: randomUUID(),
      bookId: book.id,
      label: 'fixture',
      cwd: ws.bookRoot(book.id),
      updated: '',
    },
    signal: new AbortController().signal,
    text() {},
    async line() {},
    preview() {},
    progress() {},
    async saveNovelTask() {},
  };
  const execute = async <T>(name: string, args: object) => {
    let sent: Parameters<NonNullable<RunContext['onToolResultDispatch']>>[0] | undefined;
    const value = await tools
      .find((tool) => tool.name === name)!
      .execute(args, {
        ...ctx,
        onToolResultDispatch: (f) => {
          sent = f;
        },
      });
    return {
      value: value as T,
      dispatch: (included: unknown = value) => sent?.(diagnostic, { ok: true, value: included }),
    };
  };
  return { ws, bookId: book.id, ctx, tools, execute };
}

test('bound search uses current-book references, bounded previews and distinct incomplete coverage', async (t) => {
  const { ws, bookId, tools, ctx, execute } = await fixture(t);
  const catalog = discoverTools(tools);
  assert.ok(!catalog.visible().some(({ name }) => name === 'book_search_text'));
  assert.deepEqual(
    (
      (await catalog.registry
        .find(({ name }) => name === 'tool_search')!
        .execute({ query: 'book_search_text' }, ctx)) as { candidates: { id: string; access: string }[] }
    ).candidates
      .slice(0, 1)
      .map(({ id, access }) => ({ id, access })),
    [{ id: 'book_search_text', access: 'read' }],
  );
  const page = await execute<{ matches: { id: string; revision: string; range: [number, number] }[] }>(
    'book_search_text',
    { query: quote },
  );
  assert.deepEqual(
    page.value.matches.map(({ id }) => id),
    [first.id],
  );
  const source = await ws.readDocument(bookId, first);
  assert.equal(page.value.matches[0].revision, source.revision);
  assert.equal(source.body.slice(...page.value.matches[0].range), quote);
  const common = await execute<{ matches: unknown[]; nextOffset: number; pageState: string }>(
    'book_search_text',
    { query: '潮' },
  );
  assert.ok(common.value.matches.length > 0 && common.value.matches.length <= 20);
  assert.equal(common.value.nextOffset, common.value.matches.length);
  assert.equal(common.value.pageState, 'partial');
  const none = await execute('book_search_text', { query: '从未出现' });
  assert.deepEqual(none.value, {
    offset: 0,
    matches: [],
    nextOffset: null,
    pageState: 'complete',
    hint: '命中仅用于定位；需精确依据时在同一修订按范围回读。',
  });
});

test('catalogue defaults to metadata; long originals page without skips or broken characters', async (t) => {
  const { ws, bookId, execute } = await fixture(t);
  const get = <T>(args: object) => execute<T>('book_get_context', args);
  const index = (await get<{ documents: { id: string; body?: string }[] }>({})).value;
  assert.ok(index.documents.every(({ body }) => body === undefined));
  const allowed = (await get<typeof index>({ includeBodies: true })).value;
  assert.equal(allowed.documents.find(({ id }) => id === asset.id)!.body, undefined);
  assert.ok(allowed.documents.some(({ body }) => body?.includes('只读夹具')));
  const emoji = (await get<DocumentPage>({ type: first.type, documentId: first.id, length: 1 })).value;
  assert.equal(emoji.document.body, '🌊');
  assert.deepEqual(emoji.range, [0, 2]);
  for (const ref of [first, asset]) {
    const source = await ws.readDocument(bookId, ref);
    let offset: number | null = 0,
      read = '';
    for (let i = 0; offset !== null; i++) {
      assert.ok(i < 12);
      const page = (
        await get<DocumentPage>({
          type: ref.type,
          documentId: ref.id,
          revision: source.revision,
          offset,
        })
      ).value;
      assert.equal(page.range[0], offset);
      assert.equal(page.document.body, source.body.slice(...page.range));
      assert.doesNotMatch(page.document.body!, /[\uD800-\uDFFF]/u);
      read += page.document.body;
      offset = page.nextOffset;
    }
    assert.equal(read, source.body);
    assert.equal(
      (
        await get<DocumentPage>({
          type: ref.type,
          documentId: ref.id,
          revision: 'a'.repeat(64),
          offset: 1,
        })
      ).value.pageState,
      'changed',
    );
  }
});

test('undispatched, previewed and clipped originals do not satisfy the existing patch read precondition', async (t) => {
  const { ws, bookId, execute } = await fixture(t);
  const original = await ws.readDocument(bookId, first);
  const params = { chapterId: first.id, revision: original.revision, edits: [{ quote, replacement }] };
  const tryPatch = () => execute('book_patch_chapter', params);
  const search = await execute('book_search_text', { query: quote });
  search.dispatch();
  const offset = original.body.indexOf(quote);
  const page = await execute<DocumentPage>('book_get_context', {
    type: first.type,
    documentId: first.id,
    offset,
  });
  assert.ok(page.value.document.body?.includes(quote));
  await assert.rejects(tryPatch, { diagnosticReason: 'context_required' });
  const projected = projectReadResult('book_get_context', { ok: true, value: page.value }, 0)!
    .value as DocumentPage;
  assert.equal(projected.pageState, 'deferred');
  assert.equal(projected.nextOffset, offset);
  page.dispatch(projected);
  await assert.rejects(tryPatch, { diagnosticReason: 'context_required' });
  const clipped = projectReadResult('book_get_context', { ok: true, value: page.value }, 10)!
    .value as DocumentPage;
  assert.equal(clipped.pageState, 'partial');
  assert.ok(clipped.document.body!.length > 0 && clipped.document.body!.length < quote.length);
  assert.equal(clipped.nextOffset, offset + clipped.document.body!.length);
  page.dispatch(clipped);
  await assert.rejects(tryPatch, { diagnosticReason: 'context_required' });
  const short = await execute<DocumentPage>('book_get_context', {
    type: first.type,
    documentId: first.id,
    offset,
    length: quote.length,
  });
  short.dispatch();
  const active = new ActiveContext('test', '', [], author, []);
  const append = (id: string) => {
    const result: ToolResult = { ok: true, value: short.value };
    active.append(
      { role: 'assistant', text: '', calls: [{ id, name: 'book_get_context', args: '{}' }] },
      [{ role: 'tool', id, result }],
      [],
    );
  };
  append('old');
  active.fit(40_000);
  append('latest');
  const history = active.fit(40_000).history;
  assert.equal(
    (
      history.find((row) => row.role === 'tool' && row.id === 'old') as {
        result: { value: DocumentPage };
      }
    ).result.value.pageState,
    'reference',
  );
  await tryPatch();
  const updated = await ws.readDocument(bookId, first);
  assert.equal(updated.body, original.body.replace(quote, replacement));
  await assert.rejects(tryPatch, { diagnosticReason: 'conflict' });
});

test('projected memory counts and sources report only included evidence', async (t) => {
  const { ws, bookId } = await fixture(t);
  const trace = collectDiagnostics();
  const report = diagnosticScope(trace.report, { runId: randomUUID(), spanId: randomUUID() });
  let observe: ReportMemoryDispatch | undefined;
  const recall = await recallBookMemory(ws, bookId, {
    query: '铜印',
    chapterId: second.id,
    diagnostic: {
      trigger: 'tool',
      report,
      captureDispatch: (call) => {
        observe = call;
      },
    },
  });
  assert.ok(recall.earlierStory.length > 0);
  const projected = projectReadResult('book_memory_recall', { ok: true, value: recall }, 0)!
    .value as BookRecall;
  assert.equal(projected.earlierStory.length, 0);
  observe!(report, projected);
  assert.ok(!trace.rows.some(({ event }) => event === 'memory.context.dispatched'));
  observe!(report, { ...recall, earlierStory: recall.earlierStory.slice(0, 1) });
  assert.equal(
    trace.rows.find(({ event }) => event === 'memory.context.dispatched')?.fields.storyCount,
    1,
  );
  assert.doesNotMatch(JSON.stringify(trace.rows), /铜印|潮潮潮/);
  assert.deepEqual(trace.rejected, []);
});
