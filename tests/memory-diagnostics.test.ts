import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Manuscript } from '../shared/contracts.js';
import { diagnosticScope } from '../shared/diagnostics.js';
import { recallBookMemory, type ReportMemoryDispatch } from '../electron/agent/book-memory.js';
import { validateDiagnostic } from '../electron/diagnostics/contract.js';
import { renderDocument } from '../electron/documents.js';
import { WorkspaceService } from '../electron/workspace.js';
import { collectDiagnostics } from './diagnostic-fixture.js';

const uniqueClue = 'PRIVATE_PROSE_OBSIDIAN';
const secretQuery = 'PRIVATE_QUERY_IDENTIFIER';
const rawId = 'private-chapter-id';
const chapter = { type: 'chapter', id: rawId } as const;

async function fixture(
  t: import('node:test').TestContext,
  beforeReplace?: (path: string) => Promise<void>,
) {
  const base = await realpath(tmpdir()),
    root = await mkdtemp(join(base, 'fw-memory-diag-'));
  t.after(async () => {
    const actual = await realpath(root);
    if (actual === root && dirname(actual) === base) await rm(actual, { recursive: true, force: true });
  });
  const workspace = new WorkspaceService({ libraryRoot: join(root, 'library'), beforeReplace });
  await workspace.init();
  const { id: bookId } = await workspace.createBook({ title: 'PRIVATE_WORK_TITLE', summary: 'harbor' });
  const target = { type: 'chapter' as const, id: 'recall-boundary' };
  const written = await workspace.writeChanges(bookId, [
    {
      ...chapter,
      expect: null,
      fields: { order: 2, title: 'PRIVATE_CHAPTER_TITLE' },
      body: uniqueClue,
    },
    { ...target, expect: null, fields: { order: 3, title: 'Target chapter' }, body: '' },
  ]);
  assert.equal(written.error, undefined);
  const directory = join(workspace.bookRoot(bookId), '.fiction-writer');
  const filename = join(directory, 'memory.json');
  const diag = collectDiagnostics();
  const report = diagnosticScope(diag.report, { runId: randomUUID() });
  const latest = (event: string) => diag.rows.findLast((row) => row.event === event)?.fields;
  const recall = (options: Partial<Parameters<typeof recallBookMemory>[2]> = {}) =>
    recallBookMemory(workspace, bookId, {
      query: `${uniqueClue} ${secretQuery}`,
      chapterId: target.id,
      diagnostic: { trigger: 'tool', report },
      ...options,
    });
  return { workspace, bookId, directory, filename, diag, report, recall, latest };
}

test('memory diagnostics are worker-only, field-limited, and use the normal commit fingerprints', () => {
  const salt = Buffer.from('synthetic-memory-salt');
  const fields = {
    runId: randomUUID(),
    recallId: randomUUID(),
    spanId: randomUUID(),
    trigger: 'draft',
    workspaceRef: 'private-book',
    documentRef: `chapter/${rawId}`,
    docType: 'chapter',
    revision: 'f'.repeat(64),
    sourceType: 'story',
    sourceChapterOrder: 2,
  };
  const input = { event: 'memory.context.source', fields };
  assert.equal(validateDiagnostic('renderer', input, salt, true), undefined);
  assert.equal(validateDiagnostic('main', input, salt), undefined);
  for (const improper of [
    { trigger: 'agent' },
    { recallId: 'fake-id' },
    { spanId: undefined },
    { sourceChapterOrder: -1 },
    { query: secretQuery },
    { excerpt: uniqueClue },
    { cacheIssue: 'path content' },
  ])
    assert.equal(
      validateDiagnostic('worker', { ...input, fields: { ...fields, ...improper } }, salt),
      undefined,
    );
  const source = validateDiagnostic('worker', input, salt);
  const { workspaceRef, documentRef, docType, revision } = fields;
  const commit = validateDiagnostic(
    'worker',
    {
      event: 'workspace.document.committed',
      fields: { workspaceRef, documentRef, docType, revision, operation: 'write' },
    },
    salt,
  );
  assert.ok(source && commit);
  for (const ref of ['workspaceRef', 'documentRef', 'revision'] as const) {
    assert.equal(source.fields[ref], commit.fields[ref]);
    assert.notEqual(source.fields[ref], fields[ref]);
    assert.match(String(source.fields[ref]), /^[a-f0-9]{16}$/u);
  }
});

test('recall diagnostics separate hits, empty results, errors and lazy index updates', async (t) => {
  const { workspace, bookId, filename, diag, latest, recall } = await fixture(t);
  assert.equal((await recall()).earlierStory[0]?.excerpt, uniqueClue);
  const created = { ...latest('memory.index.finished') };
  assert.equal(created.cacheAction, 'created');
  assert.equal(created.staleCount, 0);
  assert.ok(Number(created.rebuiltCount) >= 1);
  const first = latest('memory.recall.finished')!;
  assert.equal(first.trigger, 'tool');
  assert.equal(first.outcome, 'ok');
  assert.equal(first.storyCount, 1);
  assert.equal(first.recallId, created.recallId);
  assert.ok(await readFile(filename, 'utf8'));

  await recall({ query: 'word_with_no_matching_text' });
  const reuse = latest('memory.index.finished')!;
  const empty = latest('memory.recall.finished')!;
  assert.notEqual(empty.recallId, first.recallId);
  assert.equal(reuse.cacheAction, 'unchanged');
  assert.equal(reuse.rebuiltCount, 0);
  assert.equal(reuse.reusedCount, created.rebuiltCount);
  assert.equal(empty.outcome, 'ok');
  for (const count of ['storyCount', 'planCount', 'referenceCount', 'conventionCount'])
    assert.equal(empty[count], 0);

  const original = await workspace.readDocument(bookId, chapter);
  const path = join(workspace.bookRoot(bookId), 'chapters', `${rawId}.md`);
  await writeFile(path, renderDocument(chapter, original.fields, 'REVISED_SOURCE_TEXT'), 'utf8');
  const fresh = (await recall()).earlierStory[0];
  assert.equal(fresh?.excerpt, 'REVISED_SOURCE_TEXT');
  assert.notEqual(fresh.revision, original.revision);
  const edited = latest('memory.index.finished')!;
  assert.equal(edited.cacheAction, 'updated');
  assert.equal(edited.staleCount, 1);
  assert.equal(edited.rebuiltCount, 1);

  await unlink(path);
  await recall();
  const removed = latest('memory.index.finished')!;
  assert.equal(removed.cacheAction, 'updated');
  assert.equal(removed.staleCount, 1);
  assert.equal(removed.rebuiltCount, 0);
  assert.doesNotMatch(await readFile(filename, 'utf8'), new RegExp(rawId));

  const count = diag.rows.filter((row) => row.event === 'memory.index.finished').length;
  await assert.rejects(recall({ chapterId: 'invalid\nPRIVATE_TOOL_TARGET' }), /目标章节不存在/);
  const failed = latest('memory.recall.finished')!;
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.reason, 'missing');
  assert.equal(failed.storyCount, undefined);
  assert.equal(diag.rows.filter((row) => row.event === 'memory.index.finished').length, count);
  assert.deepEqual(diag.rejected, []);
  assert.doesNotMatch(JSON.stringify(diag.rows), /PRIVATE_|private-chapter-id/);
});

test('cache read, format and write failures degrade without changing recall or clearing the sidecar', async (t) => {
  let denyWrite = false;
  const { directory, filename, recall, latest, diag } = await fixture(t, async (path) => {
    if (denyWrite && path.endsWith('memory.json')) throw new Error('PRIVATE_FILESYSTEM_ERROR');
  });
  await mkdir(directory);
  // A directory at the sidecar path is not a readable cache (including on Windows).
  await mkdir(filename);
  assert.equal((await recall()).earlierStory[0]?.excerpt, uniqueClue);
  assert.equal(latest('memory.index.finished')?.cacheIssue, 'read_failed');
  await rmdir(filename);
  const corrupt = '{ PRIVATE_RAW_INVALID_JSON';
  await writeFile(filename, corrupt, 'utf8');
  assert.equal((await recall()).earlierStory[0]?.excerpt, uniqueClue);
  assert.equal(latest('memory.index.finished')?.cacheIssue, 'invalid_format');
  assert.equal(await readFile(filename, 'utf8'), corrupt);
  await unlink(filename);
  denyWrite = true;
  const result = await recall();
  assert.equal(result.earlierStory[0]?.excerpt, uniqueClue);
  assert.equal(latest('memory.index.finished')?.cacheIssue, 'write_failed');
  assert.equal(latest('memory.recall.finished')?.outcome, 'ok');
  await assert.rejects(readFile(filename), { code: 'ENOENT' });
  assert.deepEqual(
    diag.rows
      .filter((row) => row.event === 'memory.index.finished')
      .map((row) => row.fields.cacheAction),
    ['degraded', 'degraded', 'degraded'],
  );

  const stillWorks = await recall({
    diagnostic: {
      trigger: 'draft',
      report() {
        throw new Error('logger unavailable');
      },
      captureDispatch() {
        throw new Error('observer unavailable');
      },
    },
  });
  assert.deepEqual(stillWorks, result);
  assert.deepEqual(diag.rejected, []);
  assert.doesNotMatch(JSON.stringify(diag.rows), /PRIVATE_/);
});

test('cancelling before the atomic replace reports a cancelled index and recall, not an empty hit', async (t) => {
  const stop = new AbortController();
  const { filename, recall, latest, report, diag } = await fixture(t, async (path) => {
    if (path.endsWith('memory.json')) stop.abort();
  });
  let attached = false;
  await assert.rejects(
    recall({
      signal: stop.signal,
      diagnostic: {
        trigger: 'draft',
        report,
        captureDispatch() {
          attached = true;
        },
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(attached, false);
  assert.equal(latest('memory.index.finished')?.cacheAction, 'cancelled');
  const cancelled = latest('memory.recall.finished')!;
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(cancelled.storyCount, undefined);
  await assert.rejects(readFile(filename), { code: 'ENOENT' });
  assert.deepEqual(diag.rejected, []);
});

test('index capacity is not evidence of staleness and dispatch details are deduplicated and bounded', async (t) => {
  const { bookId, directory, filename, diag, recall, report, latest } = await fixture(t);
  const documents: Manuscript[] = Array.from({ length: 1201 }, (_, n) => ({
    type: 'chapter',
    id: `source-${n}`,
    revision: n.toString(16).padStart(64, '0'),
    fields: { order: n + 1, title: 'PRIVATE_CAP_TITLE' },
    body: n < 10 ? `${uniqueClue} `.repeat(40) : 'fixture only',
  }));
  await mkdir(directory);
  const last = documents.at(-1)!;
  await writeFile(
    filename,
    JSON.stringify({
      version: 1,
      bookId,
      conventions: [],
      sources: {
        [`chapter/${last.id}`]: { revision: last.revision, passages: [[0, last.body.length]] },
      },
    }),
    'utf8',
  );
  let dispatch: ReportMemoryDispatch | undefined;
  const result = await recall({
    chapterId: last.id,
    documents,
    limit: 20,
    diagnostic: {
      trigger: 'draft',
      report,
      captureDispatch(value) {
        dispatch = value;
      },
    },
  });
  assert.equal(latest('memory.index.finished')?.staleCount, 0);
  assert.equal(latest('memory.index.finished')?.reusedCount, 1);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).sources[`chapter/${last.id}`], undefined);
  assert.equal(result.earlierStory.length, 20);
  assert.equal(
    diag.rows.some((row) => row.event === 'memory.context.dispatched'),
    false,
  );
  const spanId = randomUUID();
  assert.ok(dispatch);
  dispatch(diagnosticScope(report, { spanId }));
  const context = latest('memory.context.dispatched')!;
  assert.equal(context.spanId, spanId);
  assert.equal(context.storyCount, 20);
  assert.equal(context.sourceCount, 10);
  assert.equal(context.omittedSources, 2);
  const sources = diag.rows.filter((row) => row.event === 'memory.context.source');
  assert.equal(sources.length, 8);
  assert.equal(new Set(sources.map((row) => row.fields.documentRef)).size, 8);
  assert.ok(
    sources.every((row) => row.fields.spanId === spanId && row.fields.recallId === context.recallId),
  );
  assert.deepEqual(diag.rejected, []);
  assert.doesNotMatch(JSON.stringify(diag.rows), /PRIVATE_|source-\d+/);
});
