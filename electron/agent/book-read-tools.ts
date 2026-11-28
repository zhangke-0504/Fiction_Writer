import { setImmediate as yieldToWorker } from 'node:timers/promises';
import type { Manuscript } from '../../shared/contracts.js';
import { digest, storyBeats } from '../documents.js';
import type { WorkspaceService } from '../workspace.js';
import { object, str, ToolFailure, type LocalTool, type ReadToolContext } from './local-tool.js';
import {
  charBoundary,
  documentRef,
  documentRow,
  fitBookPage,
  type BookHit,
  type DocumentPage,
  type ReadDocument,
  type ReadPage,
} from './tool-context.js';

const indexes = ['chapters', 'subjects', 'beats'] as const;
export type ReferenceIndex = (typeof indexes)[number];
const indexPageSize = 60;
const documentPageSize = 6_000;
const types = ['book', 'outline', 'subject', 'clue', 'chapter'] as const;
const typeSchema = { type: 'string', enum: types };
export const bookDocumentIdSchema = str('使用文件的稳定 ID，而不是名称', 128);
export const bookRevisionSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const page = { type: 'integer', minimum: 0 };
export const bookContextProperties = {
  type: typeSchema,
  documentId: bookDocumentIdSchema,
  offset: page,
  length: {
    type: 'integer',
    minimum: 1,
    maximum: documentPageSize,
    description: '定向读取原文时可选；兼用于取修订所需的精确短句',
  },
  includeBodies: {
    type: 'boolean',
    description: '显式请求目录页中能装下的完整短资料；章节正文仍按 ID 读。',
  },
  revision: bookRevisionSchema,
  index: { type: 'string', enum: indexes },
};
export const bookContextDescription =
  '读取当前作品。按 type/documentId 定向读取；index=chapters/subjects/beats 查真实 ID；offset/length 只读有界原文；按实际 nextOffset 和 revision 续页。目录默认仅元数据，includeBodies 可请求完整短资料，长资料按 ID 翻页。';
export const bookContextDiscovery = {
  purpose: '按章节编号或文档 ID 读取指定范围原文和修订，查看作品目录',
  aliases: ['查章节顺序', '核对章节原文', '回读资料', '读取当前版本'],
};

type BookQuery = { type?: Manuscript['type']; documentId?: string; offset?: number };
export type BookContextArgs = BookQuery & {
  length?: number;
  index?: ReferenceIndex;
  includeBodies?: boolean;
  revision?: string;
};

function referenceIndex(documents: Manuscript[], index: ReferenceIndex, offset: number) {
  const rows =
    index === 'beats'
      ? [...new Set(storyBeats(documents.find((doc) => doc.type === 'outline')?.body ?? ''))].map(
          (id) => ({ id }),
        )
      : documents
          .filter((doc) => doc.type === (index === 'chapters' ? 'chapter' : 'subject'))
          .map(({ id, fields, body }) =>
            index === 'chapters'
              ? { id, title: fields.title?.slice(0, 120), order: fields.order, hasBody: !!body.trim() }
              : { id, name: fields.name?.slice(0, 120), kind: fields.kind },
          );
  return {
    index,
    offset,
    rows: rows.slice(offset, offset + indexPageSize),
    nextOffset: offset + indexPageSize < rows.length ? offset + indexPageSize : null,
    pageState: offset + indexPageSize < rows.length ? 'partial' : 'complete',
  };
}

function indexKey(value: ReturnType<typeof referenceIndex>) {
  return `index:${value.index}:${value.offset}:${digest(JSON.stringify(value))}`;
}

export function bookIndexReadKey(documents: Manuscript[], index: ReferenceIndex, offset: number) {
  return indexKey(referenceIndex(documents, index, offset));
}

function documentPage(
  doc: Manuscript,
  args: BookContextArgs,
  offset: number,
): DocumentPage & { hint?: string } {
  const row = documentRow(doc, false);
  if (args.revision && args.revision !== doc.revision)
    return {
      document: documentRef(row),
      range: [0, 0],
      nextOffset: 0,
      pageState: 'changed',
      hint: '修订已变化，请按现版重新定位原文，不与旧页合并。',
    };
  const start = charBoundary(doc.body, Math.min(offset, doc.body.length));
  let end = charBoundary(doc.body, Math.min(doc.body.length, start + (args.length ?? documentPageSize)));
  if (end === start && start < doc.body.length) end += doc.body.codePointAt(start)! > 0xffff ? 2 : 1;
  return fitBookPage('book_get_context', {
    document: { ...row, body: doc.body.slice(start, end) },
    range: [start, end],
    nextOffset: end < doc.body.length ? end : null,
    pageState: end < doc.body.length ? 'partial' : 'complete',
  } satisfies DocumentPage);
}

export async function readBookContext(
  workspace: WorkspaceService,
  bookId: string,
  args: BookContextArgs,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const offset = Math.min(Number.MAX_SAFE_INTEGER, args.offset ?? 0);
  if (!args.index && args.type && args.documentId) {
    const doc = await workspace
      .readDocument(bookId, { type: args.type, id: args.documentId }, signal)
      .catch((e) => {
        signal.throwIfAborted();
        throw new Error('文档不存在或无法读取，请核对 type 和 ID', { cause: e });
      });
    signal.throwIfAborted();
    return { value: documentPage(doc, args, offset), requestedOffset: offset };
  }
  const { documents } = await workspace.readAll(bookId, signal);
  signal.throwIfAborted();
  if (args.index) {
    const value = referenceIndex(documents, args.index, offset);
    return { value: fitBookPage('book_get_context', value), indexKey: indexKey(value) };
  }
  if (args.documentId) {
    const matches = documents.filter((doc) => doc.id === args.documentId);
    if (matches.length !== 1) throw new Error('文档不存在或 ID 不唯一，请同时指定 type');
    return { value: documentPage(matches[0], args, offset), requestedOffset: offset };
  }
  const sorted = documents
    .filter((doc) => !args.type || doc.type === args.type)
    .sort((a, b) => types.indexOf(a.type) - types.indexOf(b.type));
  const rows = sorted
    .slice(offset, offset + 45)
    .map((doc) =>
      documentRow(
        doc,
        !!args.includeBodies && doc.type !== 'chapter' && doc.body.length <= documentPageSize,
      ),
    );
  const nextOffset = offset + rows.length < sorted.length ? offset + rows.length : null;
  const value: ReadPage<ReadDocument, 'documents'> & { hint: string } = {
    offset,
    documents: rows,
    nextOffset,
    pageState: nextOffset === null ? 'complete' : 'partial',
    hint: '按 type/documentId 定向读取缺少正文的文档。目录默认仅元数据；需要成批读取短资料时使用 includeBodies。',
  };
  return { value: fitBookPage('book_get_context', value) };
}

export function bookSearchTool(workspace: WorkspaceService, bookId: string): LocalTool<ReadToolContext> {
  return {
    name: 'book_search_text',
    description:
      '在当前作品按字面搜索正文或资料，按可选类型和文档 ID 缩小范围；返回修订、位置和预览，不是写入原文证据。按 nextOffset 翻页。',
    discovery: {
      purpose: '在作品中搜索章节原文或资料中的字面词句，定位匹配位置',
      aliases: ['全文搜索', '章内关键词', '查找原文片段', '只读查找'],
    },
    schema: object(
      {
        query: str('要查的原文字面词句', 120),
        type: typeSchema,
        documentId: bookDocumentIdSchema,
        offset: page,
      },
      ['query'],
    ),
    async execute({ query, type, documentId, offset: start }, { signal }) {
      if (typeof query !== 'string' || !query.length)
        throw new ToolFailure('invalid_arguments', '请提供要搜索的非空文字。');
      signal.throwIfAborted();
      const { documents, diagnostics } = await workspace.readAll(bookId, signal);
      const offset = Math.min(Number.MAX_SAFE_INTEGER, start ?? 0);
      const matches: BookHit[] = [];
      let seen = 0,
        more = false;
      for (const [i, doc] of documents.entries()) {
        if (i && i % 16 === 0) await yieldToWorker();
        signal.throwIfAborted();
        if ((type && doc.type !== type) || (documentId && doc.id !== documentId)) continue;
        for (
          let at = doc.body.indexOf(query);
          at !== -1;
          at = doc.body.indexOf(query, at + query.length)
        ) {
          if (seen++ < offset) {
            if (seen % 8192 === 0) {
              await yieldToWorker();
              signal.throwIfAborted();
            }
            continue;
          }
          if (matches.length === 20) {
            more = true;
            break;
          }
          const end = at + query.length;
          const left = charBoundary(doc.body, Math.max(0, at - 56));
          const right = charBoundary(doc.body, Math.min(doc.body.length, end + 56));
          matches.push({
            type: doc.type,
            id: doc.id,
            revision: doc.revision,
            range: [at, end],
            preview: doc.body.slice(left, right),
          });
        }
        if (more) break;
      }
      signal.throwIfAborted();
      return fitBookPage('book_search_text', {
        offset,
        matches,
        nextOffset: more ? offset + matches.length : null,
        pageState: more ? 'partial' : 'complete',
        ...(diagnostics.length && { incomplete: true }),
        hint: '命中仅用于定位；需精确依据时在同一修订按范围回读。',
      });
    },
  };
}

export function bookReadTools(
  workspace: WorkspaceService,
  bookId: string,
): LocalTool<ReadToolContext>[] {
  return [
    {
      name: 'book_get_context',
      description: bookContextDescription,
      discovery: bookContextDiscovery,
      schema: object(bookContextProperties, []),
      async execute(args, { signal }) {
        return (await readBookContext(workspace, bookId, args, signal)).value;
      },
    },
    bookSearchTool(workspace, bookId),
  ];
}
