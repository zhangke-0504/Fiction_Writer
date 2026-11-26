import type { DocRef, Fields, Manuscript, ToolResult } from '../../shared/contracts.js';
import type { BookRecall } from './book-memory.js';
import { excerpt, tokens } from './context-budget.js';

export const readResultBudget = { single: 2_048, batch: 6_144, history: 8_192 } as const;
const rereadHint = '此结果只保留可回读信息；需要原文时缩小查询或单独回读。';

export type ReadDocument = DocRef & {
  revision: string;
  fields?: Fields;
  bodyLength: number;
  body?: string;
};
export type DocumentPage = {
  document: ReadDocument;
  range: [number, number];
  nextOffset: number | null;
  pageState: 'partial' | 'complete' | 'deferred' | 'changed' | 'reference';
  rereadRange?: [number, number];
};
export type ReadPage<T, K extends string> = {
  offset: number;
  nextOffset: number | null;
  pageState: 'partial' | 'complete' | 'deferred';
} & Record<K, T[]>;
export type BookHit = DocRef & { revision: string; range: [number, number]; preview: string };
type Result = { value: unknown; cost: number };

const estimate = (value: unknown) => tokens(JSON.stringify(value ?? null));
const charge = (value: unknown, base: unknown) => Math.max(0, estimate(value) - estimate(base));
const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Boundaries use UTF-16 offsets into the parsed Markdown body. Never split a surrogate pair. */
export function charBoundary(text: string, offset: number) {
  return offset > 0 &&
    /[\uDC00-\uDFFF]/u.test(text.charAt(offset)) &&
    /[\uD800-\uDBFF]/u.test(text.charAt(offset - 1))
    ? offset - 1
    : offset;
}

export const documentRef = ({ type, id, revision, bodyLength }: ReadDocument): ReadDocument => ({
  type,
  id,
  revision,
  bodyLength,
});

export function documentRow(doc: Manuscript, include: boolean): ReadDocument {
  const { body, ...metadata } = doc;
  return { ...metadata, bodyLength: body.length, ...(include && { body }) };
}

function projectDocument(page: DocumentPage, limit: number, historical: boolean): Result {
  const {
    range: [start, end],
    document,
  } = page;
  const { body, fields } = document;
  if (body === undefined && page.pageState !== 'changed') return { value: page, cost: 0 };
  const base: DocumentPage = {
    ...page,
    document: documentRef(document),
    range: [start, start],
    nextOffset: start,
    pageState: historical ? 'reference' : 'deferred',
    ...(historical && { rereadRange: [start, end] }),
  };
  if (page.pageState === 'changed') return { value: page, cost: 0 };
  const pageCost = (value: DocumentPage) => Math.max(estimate(value.document.body), charge(value, base));
  if (pageCost(page) <= limit) return { value: page, cost: pageCost(page) };
  if (limit < 1 || !body) return { value: base, cost: 0 };
  const candidate = (length: number, includeFields: boolean): DocumentPage => {
    const next = start + length;
    return {
      document: {
        ...documentRef(document),
        ...(includeFields && { fields }),
        body: body.slice(0, length),
      },
      range: [start, next],
      nextOffset: next < document.bodyLength ? next : null,
      pageState: next < document.bodyLength ? 'partial' : 'complete',
    };
  };
  const first = body.codePointAt(0)! > 0xffff ? 2 : 1;
  const includeFields = pageCost(candidate(first, true)) <= limit;
  let low = 1,
    high = body.length,
    best: DocumentPage | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const size = charBoundary(body, mid);
    const next = candidate(size, includeFields);
    if (pageCost(next) > limit) high = mid - 1;
    else {
      if (size) best = next;
      low = mid + 1;
    }
  }
  return best ? { value: best, cost: pageCost(best) } : { value: base, cost: 0 };
}

function projectRows<K extends string>(value: Record<string, unknown>, key: K, limit: number): Result {
  const entries = value[key] as unknown[];
  const rowCost = (rows: unknown[]) => estimate(rows) - estimate([]);
  if (rowCost(entries) <= limit) return { value, cost: rowCost(entries) };
  const offset = value.offset as number;
  const base = { ...value, [key]: [], nextOffset: offset, pageState: 'deferred' };
  const rows: unknown[] = [];
  let output: Record<string, unknown> = base;
  for (const entry of entries) {
    const row = entry as ReadDocument;
    const choices =
      key === 'documents' ? [entry, { ...row, body: undefined }, documentRef(row)] : [entry];
    let appended = false;
    for (const choice of choices) {
      const nextOffset =
        rows.length + 1 === entries.length ? value.nextOffset : offset + rows.length + 1;
      const candidate = {
        ...value,
        [key]: [...rows, choice],
        nextOffset,
        pageState: nextOffset === null ? 'complete' : 'partial',
      };
      if (rowCost(candidate[key] as unknown[]) <= limit) {
        rows.push(choice);
        output = candidate;
        appended = true;
        break;
      }
    }
    if (!appended) break;
  }
  if (!entries.length) return { value, cost: 0 };
  if (!rows.length) return { value: base, cost: 0 };
  return { value: output, cost: rowCost(rows) };
}

function projectMemory(value: BookRecall, limit: number): Result {
  const base = { ...value, conventions: [], earlierStory: [], plans: [], reference: [] };
  const output: BookRecall = { ...base };
  const cost = charge(value, base);
  if (cost <= limit) return { value, cost };
  function add<K extends 'conventions' | 'earlierStory' | 'plans' | 'reference'>(key: K) {
    for (const item of value[key]) {
      const next = { ...output, [key]: [...output[key], item] };
      if (charge(next, base) > limit) break;
      Object.assign(output, next);
    }
  }
  for (const key of ['conventions', 'earlierStory', 'plans', 'reference'] as const) add(key);
  return { value: { ...output, limited: true, hint: rereadHint }, cost: charge(output, base) };
}

export function fitBookPage<T>(name: 'book_get_context' | 'book_search_text', value: T): T {
  return (projectReadResult(name, { ok: true, value }, readResultBudget.single)?.value ?? value) as T;
}

/** Work on disposable model-facing data only. A structured reference is outside the elastic text quota. */
export function projectReadResult(
  tool: string,
  envelope: ToolResult,
  limit: number,
  historical = false,
): Result | undefined {
  if (!envelope.ok) return;
  const value = envelope.value;
  const row = objectValue(value);
  if (tool === 'book_get_context' && row && typeof row.pageState === 'string') {
    if (row.document && Array.isArray(row.range))
      return projectDocument(row as DocumentPage, limit, historical);
    for (const key of ['documents', 'rows'] as const)
      if (Array.isArray(row[key])) return projectRows(row, key, limit);
  }
  if (tool === 'book_search_text' && row && Array.isArray(row.matches))
    return projectRows(row, 'matches', limit);
  if (tool === 'book_memory_recall' && row && Array.isArray(row.earlierStory))
    return projectMemory(row as BookRecall, limit);
  if (tool === 'read_file' || tool === 'search_text' || tool === 'list_files') {
    const cost = estimate(value);
    if (cost <= limit) return { value, cost };
    const base = {
      ...(typeof row?.start === 'number' && { start: row.start }),
      ...(typeof row?.total === 'number' && { total: row.total }),
      limited: true,
      hint: rereadHint,
    };
    if (tool === 'read_file' && limit > 80) {
      const text = excerpt(
        typeof row?.text === 'string' ? row.text : typeof value === 'string' ? value : '',
        limit - 80,
      );
      if (text && charge({ ...base, text }, base) <= limit)
        return { value: { ...base, text }, cost: charge({ ...base, text }, base) };
    }
    const key = tool === 'list_files' ? 'files' : 'matches';
    const rows: unknown[] = [];
    if (Array.isArray(row?.[key]))
      for (const entry of row[key]) {
        if (charge({ ...base, [key]: [...rows, entry] }, base) > limit) break;
        rows.push(entry);
      }
    return {
      value: rows.length ? { ...base, [key]: rows } : base,
      cost: rows.length ? charge({ ...base, [key]: rows }, base) : 0,
    };
  }
}

export function readIdentity(tool: string, value: unknown) {
  const row = objectValue(value);
  if (tool !== 'book_get_context' || !row?.document || !Array.isArray(row.range)) return;
  const { type, id, revision, body } = row.document as ReadDocument;
  if (typeof body === 'string' && body.length) return JSON.stringify([type, id, revision, ...row.range]);
}
