import { diagnosticScope, noDiagnostic, type ReportDiagnostic } from '../shared/diagnostics.js';
import { classified, elapsed, safeReporter } from './diagnostics/trace.js';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  BookSummary,
  BookView,
  Change,
  DocRef,
  DocSummary,
  DocType,
  InvalidReference,
  LibraryView,
  Manuscript,
  WriteReport,
} from '../shared/contracts.js';
import {
  digest,
  docKey,
  isId,
  itemFolders,
  maxDocBytes,
  parseDocument,
  referenceErrors,
  referenceIssues,
  referenceKey,
  renderDocument,
  storyBeats,
  unlinkRemoved,
  WorkspaceError,
} from './documents.js';
export { WorkspaceError } from './documents.js';
export type Guard = DocRef & { revision: string };
interface WorkspaceOptions {
  libraryRoot: string;
  onChange?: (bookId: string, docs: DocRef[], changeId: string) => number | void;
  beforeReplace?: (path: string) => void | Promise<void>;
}
const itemTypes = Object.keys(itemFolders) as (keyof typeof itemFolders)[];
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const refOf = ({ type, id }: DocRef): DocRef => ({ type, id });
const compare = (a: DocSummary, b: DocSummary) =>
  a.type === 'chapter' && b.type === 'chapter'
    ? a.fields.order! - b.fields.order! || a.id.localeCompare(b.id)
    : docKey(a).localeCompare(docKey(b));
function beneath(root: string, path: string) {
  const rel = relative(root, path);
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function docPath(root: string, bookId: string, ref: DocRef) {
  if (!ref || !isId(ref.id)) throw new WorkspaceError('无效文档 ID');
  if (ref.type === 'book' && ref.id === bookId) return join(root, 'book.md');
  if (ref.type === 'outline' && ref.id === 'outline') return join(root, 'outline.md');
  if (itemTypes.includes(ref.type as keyof typeof itemFolders))
    return join(root, itemFolders[ref.type as keyof typeof itemFolders], `${ref.id}.md`);
  throw new WorkspaceError('未知文档类型或身份');
}

const traceDocument = (ref: DocRef) => ({ documentRef: docKey(ref), docType: ref.type });
function beginCommit(
  bookId: string,
  report: ReportDiagnostic,
  operation: 'create' | 'write' | 'delete',
  count: number,
  changeId = randomUUID(),
) {
  const trace = diagnosticScope(safeReporter(report), { workspaceRef: bookId, changeId });
  const started = performance.now();
  trace('workspace.commit.started', { operation, count });
  return {
    changeId,
    trace,
    finish(outcome: string, committed: number, pending: number, reason?: string) {
      trace('workspace.commit.finished', {
        operation,
        outcome,
        committed,
        pending,
        reason,
        elapsedMs: elapsed(started),
      });
    },
  };
}

export class WorkspaceService {
  readonly libraryRoot: string;
  private canonicalRoot: string;
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(private readonly options: WorkspaceOptions) {
    this.canonicalRoot = this.libraryRoot = resolve(options.libraryRoot);
  }
  async init() {
    await fs.mkdir(this.libraryRoot, { recursive: true });
    this.canonicalRoot = await fs.realpath(this.libraryRoot);
  }
  bookRoot(bookId: string) {
    if (!isId(bookId)) throw new WorkspaceError('无效作品 ID', 'invalid_id');
    const path = join(this.canonicalRoot, bookId);
    if (!beneath(this.canonicalRoot, path)) throw new WorkspaceError('路径不在作品库内');
    return path;
  }
  private async checkedRoot(bookId: string) {
    const path = this.bookRoot(bookId);
    const info = await fs.lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceError('作品目录不可用');
    const canonical = await fs.realpath(path);
    if (!beneath(this.canonicalRoot, canonical) || relative(path, canonical))
      throw new WorkspaceError('作品目录不在作品库内');
    return canonical;
  }
  private async checkFileParent(root: string, path: string, create = false) {
    const dir = dirname(path);
    if (dir === root) return;
    try {
      const info = await fs.lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceError('资产目录不是普通目录');
    } catch (e) {
      if (create && absent(e)) await fs.mkdir(dir);
      else throw e;
    }
    if (!beneath(root, await fs.realpath(dir))) throw new WorkspaceError('资产目录不在作品内');
  }
  private async readBytes(root: string, path: string) {
    await this.checkFileParent(root, path);
    const info = await fs.lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new WorkspaceError('不是普通 Markdown 文件');
    if (info.size > maxDocBytes + 24_000) throw new WorkspaceError('文档超过大小限制');
    return fs.readFile(path);
  }
  private async readAt(root: string, bookId: string, ref: DocRef): Promise<Manuscript> {
    return parseDocument(refOf(ref), await this.readBytes(root, docPath(root, bookId, ref)));
  }
  async readDocument(bookId: string, ref: DocRef) {
    await this.writes.get(bookId);
    return this.readAt(await this.checkedRoot(bookId), bookId, ref);
  }
  private async load(root: string, bookId: string) {
    const documents: Manuscript[] = [],
      diagnostics: string[] = [];
    const refs: DocRef[] = [
      { type: 'book', id: bookId },
      { type: 'outline', id: 'outline' },
    ];
    for (const type of itemTypes) {
      const dir = join(root, itemFolders[type]);
      try {
        await this.checkFileParent(root, join(dir, '_'));
        const files = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of files)
          if (entry.isFile() && entry.name.endsWith('.md'))
            refs.push({ type, id: entry.name.slice(0, -3) });
      } catch (e) {
        if (!absent(e)) diagnostics.push(`${itemFolders[type]}: 无法读取目录`);
      }
    }
    for (const ref of refs) {
      try {
        documents.push(await this.readAt(root, bookId, ref));
      } catch (e) {
        diagnostics.push(
          `${docKey(ref)}: ${e instanceof WorkspaceError ? e.message : '无法读取 Markdown 文件'}`,
        );
      }
    }
    documents.sort(compare);
    return { documents, diagnostics };
  }
  async readAll(bookId: string) {
    await this.writes.get(bookId);
    const { documents, diagnostics } = await this.load(await this.checkedRoot(bookId), bookId);
    const keys = new Set(documents.map(docKey)),
      beats = storyBeats(documents.find((d) => d.type === 'outline')?.body ?? '');
    const beatIds = new Set(beats);
    if (beatIds.size !== beats.length) diagnostics.push('outline/outline: 大纲情节点 ID 重复');
    for (const doc of documents) {
      const broken = referenceErrors(doc, keys, beatIds);
      if (broken.length) diagnostics.push(`${docKey(doc)}: 断开的引用 ${broken.join('、')}`);
    }
    return { documents, diagnostics };
  }
  async readBook(bookId: string): Promise<BookView> {
    const { documents, diagnostics } = await this.readAll(bookId);
    return { documents: documents.map(({ body: _, ...summary }) => summary), diagnostics };
  }
  async listBooks(): Promise<LibraryView> {
    const books: BookSummary[] = [],
      diagnostics: string[] = [];
    for (const dir of await fs.readdir(this.canonicalRoot, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.isSymbolicLink() || !isId(dir.name)) continue;
      try {
        const doc = await this.readDocument(dir.name, { type: 'book', id: dir.name });
        const { title, author, genre } = doc.fields;
        books.push({
          id: doc.id,
          title: title!,
          author,
          genre,
          summary: doc.body.trim().split(/\r?\n\s*\r?\n/)[0] ?? '',
        });
      } catch (e) {
        diagnostics.push(`${dir.name}: ${e instanceof WorkspaceError ? e.message : '无法读取作品'}`);
      }
    }
    books.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    return { books, diagnostics };
  }
  async createBook(
    input: { title: string; summary: string; genre?: string; style?: string },
    diagnostic = noDiagnostic,
  ) {
    const id = randomUUID();
    const operation = beginCommit(id, diagnostic, 'create', 2);
    try {
      const root = this.bookRoot(id);
      const title = input.title?.trim(),
        body = input.summary?.trim();
      const text = renderDocument(
        { type: 'book', id },
        { title, genre: input.genre?.trim() || undefined, style: input.style?.trim() || undefined },
        body,
      );
      const staging = join(this.canonicalRoot, `.pending-${id}`);
      await fs.mkdir(staging);
      try {
        for (const folder of Object.values(itemFolders)) await fs.mkdir(join(staging, folder));
        await fs.writeFile(join(staging, 'book.md'), text, 'utf8');
        await fs.writeFile(join(staging, 'outline.md'), '', 'utf8');
        await fs.rename(staging, root);
      } catch (error) {
        const actual = await fs.realpath(staging).catch(() => undefined);
        if (actual && beneath(this.canonicalRoot, actual) && !relative(actual, staging))
          await fs.rm(actual, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const ref = { type: 'book', id } as const;
      operation.trace('workspace.document.committed', {
        ...traceDocument(ref),
        operation: 'write',
        revision: digest(text),
      });
      operation.trace('workspace.document.committed', {
        ...traceDocument({ type: 'outline', id: 'outline' }),
        operation: 'write',
        revision: digest(''),
      });
      operation.finish('ok', 2, 0);
      this.changed(id, [ref], operation);
      return { id, title };
    } catch (error) {
      operation.finish('failed', 0, 2, classified(error));
      throw error;
    }
  }
  private enqueue<T>(bookId: string, issue: () => Promise<T>) {
    const turn = (this.writes.get(bookId) ?? Promise.resolve()).then(issue);
    const tail = turn.catch(() => undefined);
    this.writes.set(bookId, tail);
    void tail.then(() => {
      if (this.writes.get(bookId) === tail) this.writes.delete(bookId);
    });
    return turn;
  }
  private changed(bookId: string, docs: DocRef[], operation: ReturnType<typeof beginCommit>) {
    const journalSeq = this.options.onChange?.(bookId, docs, operation.changeId);
    if (typeof journalSeq === 'number')
      operation.trace('workspace.notified', { journalSeq, count: docs.length, reason: 'managed' });
  }
  deleteBook(bookId: string, diagnostic = noDiagnostic) {
    return this.enqueue(bookId, async () => {
      const operation = beginCommit(bookId, diagnostic, 'delete', 1);
      const ref = { type: 'book', id: bookId } as const;
      try {
        const dir = await this.checkedRoot(bookId);
        operation.trace('workspace.preconditions', { outcome: 'ok', count: 1 });
        await fs.rm(dir, { recursive: true, force: false });
        operation.trace('workspace.document.committed', { ...traceDocument(ref), operation: 'delete' });
        operation.finish('ok', 1, 0);
      } catch (error) {
        operation.finish('failed', 0, 1, classified(error));
        throw error;
      }
      this.changed(bookId, [ref], operation);
    });
  }
  /** The one book-local memory sidecar shares the book's write/delete queue. */
  updateBookMemory<T>(
    bookId: string,
    edit: (source?: string) => { value: T; replacement?: string },
    options: { signal?: AbortSignal; bestEffort?: boolean } = {},
  ): Promise<{ value: T; storage: 'unchanged' | 'created' | 'updated' | 'write_failed' }> {
    return this.enqueue(bookId, async () => {
      options.signal?.throwIfAborted();
      const root = await this.checkedRoot(bookId);
      const path = join(root, '.fiction-writer', 'memory.json');
      const limit = 2_000_000;
      let source: string | undefined;
      try {
        await this.checkFileParent(root, path);
        const file = await fs.lstat(path);
        if (!file.isFile() || file.isSymbolicLink() || file.size > limit)
          throw new WorkspaceError('作品记忆文件不可用');
        source = await fs.readFile(path, { encoding: 'utf8', signal: options.signal });
        if (Buffer.byteLength(source) > limit) throw new WorkspaceError('作品记忆超过限制');
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const { value, replacement } = edit(source);
      if (replacement !== undefined && replacement !== source) {
        try {
          if (Buffer.byteLength(replacement) > limit) throw new WorkspaceError('作品记忆超过限制');
          await this.checkFileParent(root, path, true);
          await this.replace(path, replacement, options.signal);
          return { value, storage: source === undefined ? 'created' : 'updated' };
        } catch (error) {
          options.signal?.throwIfAborted();
          if (!options.bestEffort) throw error;
          return { value, storage: 'write_failed' };
        }
      }
      return { value, storage: 'unchanged' };
    });
  }
  private async revision(root: string, bookId: string, ref: DocRef) {
    try {
      return digest(await this.readBytes(root, docPath(root, bookId, ref)));
    } catch (e) {
      if (absent(e)) return null;
      throw e;
    }
  }
  private async replace(path: string, text: string, signal?: AbortSignal) {
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, text, { encoding: 'utf8', flag: 'wx', signal });
      signal?.throwIfAborted();
      await this.options.beforeReplace?.(path);
      signal?.throwIfAborted();
      await fs.rename(temp, path);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  }
  writeChanges(
    bookId: string,
    changes: Change[],
    signal?: AbortSignal,
    guards: Guard[] = [],
    diagnostic = noDiagnostic,
    bindNewClues = false,
  ): Promise<WriteReport> {
    return this.enqueue(bookId, () =>
      this.commit(bookId, changes, signal, guards, diagnostic, bindNewClues),
    );
  }
  private async commit(
    bookId: string,
    changes: Change[],
    signal: AbortSignal | undefined,
    guards: Guard[],
    diagnostic: ReportDiagnostic,
    bindNewClues: boolean,
  ): Promise<WriteReport> {
    let pending = changes.map(refOf);
    let invalidReferences: InvalidReference[] | undefined;
    const committed: DocRef[] = [];
    if (!changes.length) return { committed, pending };
    const operation = beginCommit(
      bookId,
      diagnostic,
      changes.every((change) => 'delete' in change) ? 'delete' : 'write',
      changes.length,
    );
    let preconditionsPassed = false;
    let failure: string | undefined;
    const matchesRevision = async (
      root: string,
      ref: DocRef,
      expected: string | null,
      step: 'guard' | 'plan' | 'replace',
    ) => {
      const actual = await this.revision(root, bookId, ref);
      if (actual === expected) return true;
      operation.trace('workspace.conflict', {
        ...traceDocument(ref),
        step,
        reason: 'conflict',
        expectedRevision: expected ?? undefined,
        actualRevision: actual ?? undefined,
      });
      return false;
    };
    try {
      signal?.throwIfAborted();
      const root = await this.checkedRoot(bookId);
      await fs.access(join(root, 'book.md'));
      const paths = changes.map((change) => docPath(root, bookId, change));
      if (
        new Set(paths.map((path) => (process.platform === 'win32' ? path.toLowerCase() : path))).size !==
        changes.length
      )
        throw new WorkspaceError('同一次批量操作不能重复修改同一文档');
      for (const guard of guards)
        if (!(await matchesRevision(root, guard, guard.revision, 'guard')))
          throw new WorkspaceError(`${docKey(guard)} 已变化，请重新读取`, 'conflict');
      const { documents } = await this.load(root, bookId);
      const original = new Map(documents.map((doc) => [docKey(doc), doc])),
        projected = new Map(original);
      const planned = new Map<string, { ref: DocRef; expect: string | null; text?: string }>();
      const removed = new Set<string>();
      for (const change of changes) {
        const ref = refOf(change),
          path = docPath(root, bookId, ref),
          key = docKey(ref);
        if (!(await matchesRevision(root, ref, change.expect, 'plan')))
          throw new WorkspaceError(`${key} 的文件已变化，请重新读取`, 'conflict');
        if ('delete' in change) {
          if (ref.type === 'book' || ref.type === 'outline')
            throw new WorkspaceError('不能通过资产删除操作删除基本信息或大纲');
          projected.delete(key);
          removed.add(key);
          planned.set(key, { ref, expect: change.expect });
        } else {
          if (ref.type === 'book' && change.expect === null)
            throw new WorkspaceError('请通过书库新建小说');
          const text = renderDocument(ref, change.fields, change.body);
          projected.set(key, parseDocument(ref, Buffer.from(text)));
          planned.set(key, { ref, expect: change.expect, text });
          if (!beneath(root, path)) throw new WorkspaceError('无效文件路径');
        }
      }
      const priorBeats = storyBeats(original.get('outline/outline')?.body ?? '');
      const nextBeats = storyBeats(projected.get('outline/outline')?.body ?? '');
      if (planned.has('outline/outline') && new Set(nextBeats).size !== nextBeats.length)
        throw new WorkspaceError('大纲里存在重复的情节点 ID');
      const removedBeats = new Set(priorBeats.filter((id) => !nextBeats.includes(id)));
      if (removed.size || removedBeats.size)
        for (const [key, doc] of projected) {
          const cleanup = unlinkRemoved(doc, removed, removedBeats);
          if (cleanup.changed) {
            const ref = refOf(doc),
              text = renderDocument(ref, cleanup.fields, cleanup.body);
            projected.set(key, parseDocument(ref, Buffer.from(text)));
            planned.set(key, {
              ref,
              expect: planned.get(key)?.expect ?? original.get(key)?.revision ?? null,
              text,
            });
          }
        }
      const ordered = [...planned.values()].sort(
        (a, b) => Number(a.text === undefined) - Number(b.text === undefined),
      );
      pending = ordered.map((item) => item.ref);
      const keys = new Set(projected.keys()),
        previous = new Set(original.keys()),
        beforeBeats = new Set(priorBeats),
        afterBeats = new Set(nextBeats);
      for (const [key, item] of planned)
        if (item.text !== undefined) {
          const old = original.get(key);
          const broken = old && referenceIssues(old, previous, beforeBeats);
          const invalid = [...referenceIssues(projected.get(key)!, keys, afterBeats)]
            .filter(([identity]) => !broken?.has(identity))
            .map(([, issue]) => ({ document: item.ref, ...issue }));
          if (invalid.length) {
            // Send a bounded set of concrete repairs; the next attempt is validated again.
            invalidReferences = invalid.slice(0, 64);
            const targets = new Set(invalidReferences.map((issue) => referenceKey(issue.target)));
            throw new WorkspaceError(
              `${key}：无效引用 ${[...targets].slice(0, 6).join('、')}`,
              'invalid_references',
            );
          }
        }
      if (bindNewClues)
        for (const item of ordered) {
          if (item.ref.type !== 'clue' || item.expect !== null || item.text === undefined) continue;
          const { setupChapterId, payoffChapterId } = projected.get(docKey(item.ref))!.fields;
          const missing = [setupChapterId, payoffChapterId].some(
            (id) => !id || !previous.has(`chapter/${id}`),
          );
          if (missing)
            throw new WorkspaceError(
              `${docKey(item.ref)}：新增伏笔须用现有章节设置埋设和回收点（setupChapterId、payoffChapterId）`,
              'unbound_foreshadowing',
            );
        }
      preconditionsPassed = true;
      operation.trace('workspace.preconditions', {
        outcome: 'ok',
        count: pending.length,
        guardCount: guards.length,
      });
      for (const item of ordered) {
        signal?.throwIfAborted();
        const path = docPath(root, bookId, item.ref);
        if (!(await matchesRevision(root, item.ref, item.expect, 'replace')))
          throw new WorkspaceError(`${docKey(item.ref)} 的文件已变化，请重新读取`, 'conflict');
        if (item.text === undefined) await fs.unlink(path);
        else {
          await this.checkFileParent(root, path, true);
          await this.replace(path, item.text, signal);
        }
        committed.push(item.ref);
        pending.shift();
        operation.trace('workspace.document.committed', {
          ...traceDocument(item.ref),
          operation: item.text === undefined ? 'delete' : 'write',
          revision: item.text === undefined ? undefined : projected.get(docKey(item.ref))?.revision,
          expectedRevision: item.expect ?? undefined,
        });
      }
      return { committed, pending };
    } catch (e) {
      failure = classified(e, signal);
      if (!preconditionsPassed)
        operation.trace('workspace.preconditions', {
          outcome: 'failed',
          reason: failure,
          count: pending.length,
          guardCount: guards.length,
        });
      for (const ref of pending.slice(0, 64))
        operation.trace('workspace.document.pending', traceDocument(ref));
      return {
        committed,
        pending,
        ...(invalidReferences && { invalidReferences }),
        reason: failure,
        error: e instanceof Error ? e.message : '写入失败',
      };
    } finally {
      const outcome = !failure
        ? 'ok'
        : committed.length
          ? 'partial'
          : ['conflict', 'cancelled'].includes(failure)
            ? failure
            : 'failed';
      operation.finish(outcome, committed.length, pending.length, failure);
      if (committed.length) this.changed(bookId, committed, operation);
    }
  }
  async deleteDocument(bookId: string, ref: DocRef, signal?: AbortSignal, diagnostic = noDiagnostic) {
    let expect: string;
    try {
      await this.writes.get(bookId);
      const root = await this.checkedRoot(bookId),
        current = await this.revision(root, bookId, ref);
      if (!current) throw new WorkspaceError('文档不存在', 'ENOENT');
      expect = current;
    } catch (error) {
      const operation = beginCommit(bookId, diagnostic, 'delete', 1),
        reason = classified(error, signal);
      operation.trace('workspace.preconditions', {
        ...traceDocument(ref),
        outcome: 'failed',
        reason,
        count: 1,
      });
      operation.finish('failed', 0, 1, reason);
      throw error;
    }
    return this.writeChanges(bookId, [{ ...refOf(ref), expect, delete: true }], signal, [], diagnostic);
  }
  writeDocument(bookId: string, doc: Manuscript, signal?: AbortSignal, diagnostic = noDiagnostic) {
    return this.writeChanges(
      bookId,
      [{ ...refOf(doc), expect: doc.revision || null, fields: doc.fields, body: doc.body }],
      signal,
      [],
      diagnostic,
    );
  }
  managedPath(path: string): { bookId: string; doc: DocRef } | undefined {
    const parts = relative(this.canonicalRoot, path).split(sep),
      [bookId, second, third] = parts;
    if (!isId(bookId)) return undefined;
    const file = second?.toLowerCase();
    if (parts.length === 2 && file === 'book.md') return { bookId, doc: { type: 'book', id: bookId } };
    if (parts.length === 2 && file === 'outline.md')
      return { bookId, doc: { type: 'outline', id: 'outline' } };
    if (parts.length === 3 && third.endsWith('.md')) {
      const type = itemTypes.find((type) => itemFolders[type] === file),
        id = third.slice(0, -3);
      if (type && isId(id)) return { bookId, doc: { type, id } };
    }
  }
  async writeRaw(
    bookId: string,
    doc: DocRef,
    content: string,
    signal: AbortSignal,
    expect?: string,
    diagnostic = noDiagnostic,
  ) {
    let current: string | null | undefined, parsed: Manuscript;
    try {
      current = await this.revision(await this.checkedRoot(bookId), bookId, doc);
      if (expect !== undefined && current !== expect)
        throw new WorkspaceError('文件已变化，请重新读取', 'conflict');
      parsed = parseDocument(doc, Buffer.from(content));
    } catch (error) {
      const operation = beginCommit(bookId, diagnostic, 'write', 1),
        reason = classified(error, signal);
      if (reason === 'conflict')
        operation.trace('workspace.conflict', {
          ...traceDocument(doc),
          reason,
          step: 'plan',
          actualRevision: current ?? undefined,
          expectedRevision: expect,
        });
      operation.trace('workspace.preconditions', {
        ...traceDocument(doc),
        outcome: 'failed',
        reason,
        count: 1,
      });
      operation.finish(reason === 'conflict' ? 'conflict' : 'failed', 0, 1, reason);
      throw error;
    }
    const report = await this.writeChanges(
      bookId,
      [{ ...parsed, expect: current }],
      signal,
      [],
      diagnostic,
    );
    if (report.error) throw new WorkspaceError(JSON.stringify(report), report.reason);
    return report;
  }
  watchExternal(invalidate: (bookId?: string) => void) {
    let watcher: FSWatcher | undefined, debounce: ReturnType<typeof setTimeout> | undefined;
    const books = new Set<string>();
    try {
      watcher = watch(this.canonicalRoot, { recursive: true, persistent: false }, (_type, name) => {
        if (name?.endsWith('.tmp') || name?.startsWith('.pending-')) return;
        const [id, folder] = name?.split(/[\\/]/) ?? [];
        if (folder === '.fiction-writer') return;
        if (id && !isId(id)) return;
        books.add(id || '');
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          const impacted = [...books];
          books.clear();
          for (const bookId of impacted) invalidate(bookId || undefined);
        }, 120);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
        invalidate();
      });
    } catch {
      /* Focus reconciling still works when recursive watch is unavailable. */
    }
    return () => {
      clearTimeout(debounce);
      watcher?.close();
    };
  }
}
