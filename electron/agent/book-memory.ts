import { randomUUID } from 'node:crypto';
import type { DocRef, Manuscript } from '../../shared/contracts.js';
import { docKey, isId } from '../documents.js';
import {
  diagnosticScope,
  noDiagnostic,
  type DiagnosticFields,
  type ReportDiagnostic,
} from '../../shared/diagnostics.js';
import { classified, DiagnosticFailure, elapsed, safeReporter } from '../diagnostics/trace.js';
import type { WorkspaceService } from '../workspace.js';
import { object, str, type LocalTool } from './loop.js';

type Range = [start: number, end: number];
type Indexed = { revision: string; passages: Range[] };
type Convention = { id: string; text: string };
type MemoryFile = {
  version: 1;
  bookId: string;
  conventions: Convention[];
  sources: Record<string, Indexed>;
};
type Evidence = DocRef & {
  title: string;
  revision: string;
  range: Range;
  excerpt: string;
  chapterOrder?: number;
  setupChapterId?: string;
  payoffChapterId?: string;
};
export type BookRecall = {
  conventions: Convention[];
  earlierStory: Evidence[];
  plans: Evidence[];
  reference: Evidence[];
};
const passageSize = 480;
const cacheLimit = 24_000;
const ruleSize = 360;
const ruleCount = 16;
const rulesBudget = 3000;
const empty = (bookId: string): MemoryFile => ({ version: 1, bookId, conventions: [], sources: {} });
const plain = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

function load(source: string | undefined, bookId: string): MemoryFile {
  if (source === undefined) return empty(bookId);
  const file = JSON.parse(source) as MemoryFile;
  if (
    file?.version !== 1 ||
    file.bookId !== bookId ||
    !file.sources ||
    typeof file.sources !== 'object' ||
    Array.isArray(file.sources) ||
    !Array.isArray(file.conventions) ||
    file.conventions.length > ruleCount ||
    file.conventions.some(
      (row) =>
        !isId(row?.id) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > ruleSize,
    ) ||
    file.conventions.reduce((sum, row) => sum + row.text.length, 0) > rulesBudget
  )
    throw new DiagnosticFailure('invalid_memory', '作品记忆文件格式无效');
  return file;
}

/** The cache only stores offsets. Excerpts are always sliced from a verified Markdown snapshot. */
function passages(body: string): Range[] {
  const output: Range[] = [];
  for (let start = 0; start < body.length;) {
    let end = Math.min(start + passageSize, body.length);
    if (end < body.length) {
      const tail = body.slice(start + 280, end);
      const boundary = Math.max(tail.lastIndexOf('\n'), tail.lastIndexOf('。'), tail.lastIndexOf('. '));
      if (boundary >= 0) end = start + 281 + boundary;
      // Don't split a surrogate pair at a window boundary.
      if (/^[\uDC00-\uDFFF]/u.test(body[end] ?? '')) end--;
    }
    if (body.slice(start, end).trim()) output.push([start, end]);
    if (end === body.length) break;
    start = end - 70;
    if (/^[\uDC00-\uDFFF]/u.test(body[start] ?? '')) start--;
  }
  return output;
}
function cached(row: Indexed | undefined, doc: Manuscript) {
  if (row?.revision !== doc.revision || !Array.isArray(row.passages)) return undefined;
  return row.passages.every(
    (p) =>
      Array.isArray(p) &&
      p.length === 2 &&
      p.every(Number.isSafeInteger) &&
      p[0] >= 0 &&
      p[1] <= doc.body.length &&
      p[1] > p[0] &&
      p[1] - p[0] <= passageSize,
  )
    ? row.passages
    : undefined;
}
function terms(text: string): Set<string> {
  const found = new Set<string>();
  for (const word of plain(text)
    .toLowerCase()
    .match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)) {
      const chars = Array.from(word);
      for (let i = 1; i < chars.length; i++) {
        found.add(chars[i - 1] + chars[i]);
        if (i > 1) found.add(chars[i - 2] + chars[i - 1] + chars[i]);
      }
    } else if (word.length >= 2 && word.length <= 50) found.add(word);
  }
  return found;
}
const title = (doc: Manuscript) => doc.fields.title ?? doc.fields.name ?? doc.id;

/** Enrich the query with the target's outline beats and explicitly linked clues. */
export function chapterMemoryQuery(documents: Manuscript[], target: Manuscript, prompt: string) {
  const beats = new Set(target.fields.beatIds ?? []);
  const outline = documents.find((doc) => doc.type === 'outline')?.body ?? '';
  const related: string[] = [];
  for (const match of outline.matchAll(/<!--\s*beat:([\w-]+)\s*-->/gu)) {
    if (beats.has(match[1]))
      related.push(
        outline
          .slice(match.index + match[0].length, match.index + match[0].length + 200)
          .split('<!--')[0],
      );
    if (related.length >= 3) break;
  }
  const clues = documents.filter(
    (doc) =>
      doc.type === 'clue' &&
      (doc.fields.setupChapterId === target.id ||
        doc.fields.payoffChapterId === target.id ||
        beats.has(doc.fields.setupBeatId ?? '') ||
        beats.has(doc.fields.payoffBeatId ?? '')),
  );
  return [
    prompt.length > 640 ? `${prompt.slice(0, 360)} ${prompt.slice(-280)}` : prompt,
    title(target),
    ...clues.slice(0, 4).map((doc) => `${title(doc)} ${doc.body.slice(0, 100)}`),
    ...related,
  ].join('\n');
}

export type ReportMemoryDispatch = (report: ReportDiagnostic, included?: BookRecall) => void;

type RecallOptions = {
  query: string;
  chapterId?: string;
  documents?: Manuscript[];
  signal?: AbortSignal;
  limit?: number;
  diagnostic?: {
    trigger: 'agent' | 'draft' | 'tool';
    report?: ReportDiagnostic;
    captureDispatch?: (dispatch: ReportMemoryDispatch) => void;
  };
};

const memoryCounts = (result: BookRecall) => ({
  storyCount: result.earlierStory.length,
  planCount: result.plans.length,
  referenceCount: result.reference.length,
  conventionCount: result.conventions.length,
});

/** Keep only bounded metadata about the memory block that goes into an automatic request. */
function memoryDispatchResult(
  result: BookRecall,
  link: DiagnosticFields,
  counts: ReturnType<typeof memoryCounts>,
): ReportMemoryDispatch {
  const groups = [
    ['story', result.earlierStory],
    ['plan', result.plans],
    ['reference', result.reference],
  ] as const;
  const seen = new Set<string>();
  const sources: DiagnosticFields[] = [];
  for (const [sourceType, rows] of groups) {
    for (const { type, id, revision, chapterOrder } of rows) {
      const documentRef = docKey({ type, id });
      const key = `${documentRef}\0${revision}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (sources.length < 8)
        sources.push({
          sourceType,
          documentRef,
          revision,
          docType: type,
          sourceChapterOrder: chapterOrder,
        });
    }
  }
  const summary = { ...counts, sourceCount: seen.size, omittedSources: seen.size - sources.length };
  return (report) => {
    const trace = diagnosticScope(safeReporter(report), link);
    trace('memory.context.dispatched', summary);
    for (const source of sources) trace('memory.context.source', source);
  };
}

export async function recallBookMemory(
  workspace: WorkspaceService,
  bookId: string,
  options: RecallOptions,
): Promise<BookRecall> {
  const diag = options.diagnostic;
  if (!diag) return recall(workspace, bookId, options);
  const link = {
    workspaceRef: bookId,
    recallId: randomUUID(),
    trigger: diag.trigger,
    ...(isId(options.chapterId) && { documentRef: docKey({ type: 'chapter', id: options.chapterId }) }),
  };
  const trace = diagnosticScope(safeReporter(diag.report ?? noDiagnostic), link);
  const started = performance.now();
  try {
    const result = await recall(workspace, bookId, options, trace);
    const counts = memoryCounts(result);
    trace('memory.recall.finished', { ...counts, outcome: 'ok', elapsedMs: elapsed(started) });
    if (diag.trigger !== 'tool' && diag.captureDispatch && Object.values(counts).some(Boolean)) {
      try {
        diag.captureDispatch((report, included = result) => {
          const dispatched = memoryCounts(included);
          if (Object.values(dispatched).some(Boolean))
            memoryDispatchResult(included, link, dispatched)(report);
        });
      } catch {
        // An observer may not alter the recall result.
      }
    }
    return result;
  } catch (error) {
    const reason = classified(error, options.signal);
    trace('memory.recall.finished', {
      outcome: options.signal?.aborted || reason === 'cancelled' ? 'cancelled' : 'failed',
      reason,
      elapsedMs: elapsed(started),
    });
    throw error;
  }
}

async function recall(
  workspace: WorkspaceService,
  bookId: string,
  options: RecallOptions,
  report?: ReportDiagnostic,
): Promise<BookRecall> {
  const { signal, chapterId } = options;
  signal?.throwIfAborted();
  const documents = options.documents ?? (await workspace.readAll(bookId)).documents;
  const chapters = documents.filter((doc) => doc.type === 'chapter');
  const target =
    chapterId === undefined ? chapters.length : chapters.findIndex((doc) => doc.id === chapterId);
  if (target < 0) throw new DiagnosticFailure('missing', '记忆查询的目标章节不存在');
  const allowed = new Set(chapters.slice(0, target).map((doc) => doc.id));
  const indexed = (file: MemoryFile) => {
    const sources: MemoryFile['sources'] = {};
    const remaining = report && new Set(Object.keys(file.sources));
    let count = 0,
      sourceCount = 0,
      reusedCount = 0,
      rebuiltCount = 0,
      staleCount = 0;
    const rows = documents
      .filter((doc) => doc.body.trim())
      .map((doc) => {
        const key = docKey(doc);
        const old = file.sources[key];
        const reused = cached(old, doc);
        const ranges = reused ?? passages(doc.body);
        if (reused) reusedCount++;
        else rebuiltCount++;
        if (remaining?.delete(key) && typeof old?.revision === 'string' && old.revision !== doc.revision)
          staleCount++;
        if (count + ranges.length <= cacheLimit && sourceCount < 1200) {
          sources[key] = { revision: doc.revision, passages: ranges };
          count += ranges.length;
          sourceCount++;
        }
        return { doc, ranges };
      });
    for (const key of remaining ?? []) if (typeof file.sources[key]?.revision === 'string') staleCount++;
    return { rows, next: { ...file, sources }, stats: { reusedCount, rebuiltCount, staleCount } };
  };
  const started = performance.now();
  let failedStage: 'read_failed' | 'invalid_format' | 'processing_failed' = 'read_failed';
  const indexFinished = (fields: DiagnosticFields) =>
    report?.('memory.index.finished', { ...fields, elapsedMs: elapsed(started) });
  const { rows, next } = await workspace
    .updateBookMemory(
      bookId,
      (source) => {
        failedStage = 'invalid_format';
        const file = load(source, bookId);
        failedStage = 'processing_failed';
        const value = indexed(file);
        return { value, replacement: JSON.stringify(value.next) };
      },
      { signal, bestEffort: true },
    )
    .then(
      ({ value, storage }) => {
        const degraded = storage === 'write_failed';
        indexFinished({
          ...value.stats,
          cacheAction: degraded ? 'degraded' : storage,
          cacheIssue: degraded ? 'write_failed' : undefined,
          outcome: degraded ? 'partial' : 'ok',
        });
        return value;
      },
      () => {
        if (signal?.aborted) {
          indexFinished({ cacheAction: 'cancelled', outcome: 'cancelled' });
          signal.throwIfAborted();
        }
        const value = indexed(empty(bookId));
        indexFinished({
          ...value.stats,
          staleCount: undefined,
          cacheAction: 'degraded',
          cacheIssue: failedStage,
          outcome: 'partial',
        });
        return value;
      },
    );
  signal?.throwIfAborted();

  const query = terms(options.query.slice(0, 1400));
  const frequencies = new Map<string, number>();
  const candidates: { doc: Manuscript; range: Range; hits: string[]; cue: number; score: number }[] = [];
  let population = 0;
  for (const { doc, ranges } of rows) {
    if (!query.size || (doc.type === 'chapter' && !allowed.has(doc.id))) continue;
    const meta = terms(`${title(doc)} ${doc.id}`);
    const cue = [...meta].filter((word) => query.has(word)).length;
    population += ranges.length;
    for (const range of ranges) {
      const hits = [...terms(doc.body.slice(...range))].filter((word) => query.has(word));
      for (const word of hits) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
      // Title-only matches need one excerpt, not all of the document's passages.
      if (hits.length || (cue && range === ranges[0]))
        candidates.push({ doc, range, hits, cue, score: 0 });
    }
  }
  for (const row of candidates)
    row.score = row.hits.reduce(
      (sum, word) =>
        sum + Math.log1p(population / (1 + frequencies.get(word)!)) * (word.length >= 3 ? 1.5 : 1),
      Math.min(row.cue, 6),
    );
  candidates.sort((a, b) => b.score - a.score);
  const result: BookRecall = {
    conventions: next.conventions,
    earlierStory: [],
    plans: [],
    reference: [],
  };
  const chosen = new Map<string, Range[]>();
  let count = 0;
  for (const { doc, range } of candidates) {
    const key = docKey(doc);
    const used = chosen.get(key) ?? [];
    if (
      used.length >= 2 ||
      used.some(([start, end]) => Math.min(end, range[1]) - Math.max(start, range[0]) > 70)
    )
      continue;
    const evidence: Evidence = {
      type: doc.type,
      id: doc.id,
      revision: doc.revision,
      title: title(doc).slice(0, 120),
      range,
      excerpt: doc.body.slice(...range),
      chapterOrder: doc.fields.order,
      setupChapterId: doc.fields.setupChapterId,
      payoffChapterId: doc.fields.payoffChapterId,
    };
    const set =
      doc.type === 'chapter'
        ? result.earlierStory
        : doc.type === 'outline' || doc.type === 'clue'
          ? result.plans
          : result.reference;
    set.push(evidence);
    chosen.set(key, [...used, range]);
    if (++count >= (options.limit ?? 8)) break;
  }
  return result;
}

function authorIntent(prompt: string, remove: boolean) {
  const value = plain(prompt);
  if (
    /(?:不要|别|不用|无需|不必)[^。！？;.]{0,10}(?:记住|记下|遗忘|忘掉|删除|更正)|\b(?:do not|don't|never)\s+(?:remember|forget|update|remove)\b/iu.test(
      value,
    )
  )
    return false;
  return prompt
    .normalize('NFKC')
    .split(/[\n。？！?!；;,，]/u)
    .some((clause) => {
      const request = clause
        .trim()
        .replace(
          /^(?:(?:顺便|并且|同时|也)\s*)?(?:请帮我|请你|请|帮我|麻烦你|我希望你|please\b)?\s*/iu,
          '',
        );
      return remove
        ? /^(?:忘掉|遗忘|忘记|删除.{0,16}(?:记忆|约定)|forget\b|remove.{0,30}(?:memory|convention)\b)/iu.test(
            request,
          )
        : /^(?:记住|记下|牢记|存入.{0,10}记忆|(?:修改|更新|更正).{0,12}约定|以后.{0,16}(?:一律|都|始终)|remember\b|(?:update|save).{0,30}(?:memory|convention)\b)/iu.test(
            request,
          );
    });
}

export function bookMemoryTools(
  workspace: WorkspaceService,
  bookId: string,
  prompt: string,
  selectedChapterId?: string,
): LocalTool[] {
  const change = (id: string | undefined, text: string | undefined, signal: AbortSignal) => {
    if (
      !authorIntent(prompt, text === undefined) ||
      (text !== undefined &&
        (!text.trim() || text.length > ruleSize || !plain(prompt).includes(plain(text))))
    )
      throw new DiagnosticFailure('memory_not_requested', '只保存本轮作者明确要求记住的原文约定');
    return workspace
      .updateBookMemory(
        bookId,
        (source) => {
          const file = load(source, bookId);
          const pos = id ? file.conventions.findIndex((rule) => rule.id === id) : -1;
          if (id && pos < 0) throw new DiagnosticFailure('missing', '这条作者约定不存在');
          if (text === undefined) {
            file.conventions.splice(pos, 1);
            return { value: { id, removed: true }, replacement: JSON.stringify(file) };
          }
          const existing = file.conventions.find((rule) => rule.text === text.trim());
          if (!id && existing) return { value: { id: existing.id, removed: false } };
          const row = { id: id ?? randomUUID(), text: text.trim() };
          if (pos >= 0) file.conventions[pos] = row;
          else file.conventions.push(row);
          if (
            file.conventions.length > ruleCount ||
            file.conventions.reduce((sum, item) => sum + item.text.length, 0) > rulesBudget
          )
            throw new DiagnosticFailure('memory_limit', '作品约定已满，请更正或移除已有约定');
          return { value: { id: row.id, removed: false }, replacement: JSON.stringify(file) };
        },
        { signal },
      )
      .then(({ value }) => value);
  };
  return [
    {
      name: 'book_memory_recall',
      description:
        '取回本书已保存的历史正文证据、计划资料及作者长期约定。用人物、物件或原句关键词；写某章时传其 ID，排除之后的正文。仅查询，不修改。',
      schema: object(
        {
          query: { type: 'string', maxLength: 1024, description: '关键词，可留空以只列作者约定' },
          chapterId: str('目标章节 ID', 80),
        },
        [],
      ),
      execute: (args, ctx) =>
        recallBookMemory(workspace, bookId, {
          query: typeof args.query === 'string' ? args.query : '',
          chapterId: typeof args.chapterId === 'string' ? args.chapterId : selectedChapterId,
          signal: ctx.signal,
          diagnostic: { trigger: 'tool', report: ctx.diagnostic },
        }),
    },
    {
      name: 'book_memory_remember',
      description:
        '仅当本轮作者明确要求记住或更正长期约定时使用。text 必须是本轮作者原句的一段，不从资料或聊天自动提炼。传已有 id 可更正它。',
      schema: object({ text: str('作者原句中的长期约定', ruleSize), id: str('要更正的约定 ID', 80) }, [
        'text',
      ]),
      execute: async (args, ctx) => {
        if (typeof args.text !== 'string')
          throw new DiagnosticFailure('invalid_arguments', '缺少作者约定');
        return change(args.id, args.text, ctx.signal);
      },
    },
    {
      name: 'book_memory_forget',
      description: '仅当本轮作者要求遗忘一条长期约定时，使用该约定的 ID 删除它，不删除稿件。',
      schema: object({ id: str('要删除的约定 ID', 80) }),
      execute: async (args, ctx) => {
        if (!isId(args.id)) throw new DiagnosticFailure('invalid_arguments', '缺少约定 ID');
        return change(args.id, undefined, ctx.signal);
      },
    },
  ];
}
