import type { Change, DocRef, Fields, Manuscript } from '../../shared/contracts.js';
import type { WorkspaceService, Guard } from '../workspace.js';
import { docKey, isId } from '../documents.js';
import { draftChapter } from './draft.js';
import { object, str, type LocalTool } from './loop.js';
import type { ModelProvider } from './model.js';
import type { WritingSkills } from './skills.js';
import type { RunContext } from './runs.js';

const activeTypes = ['outline', 'subject', 'clue', 'chapter'] as const;
type EditableType = (typeof activeTypes)[number];
type Mutation = {
  type: EditableType;
  id: string;
  action: 'create' | 'update' | 'delete';
  fields?: Record<string, unknown>;
  body?: string;
};
const typeSchema = { type: 'string', enum: ['book', ...activeTypes] };
const idSchema = str('使用文件的稳定 ID，而不是名称', 128);
const page = { type: 'integer', minimum: 0 };
const fieldSchema = object(
  {
    title: str(undefined, 500),
    name: str(undefined, 500),
    kind: { type: 'string', enum: ['character', 'item', 'scene'] },
    order: { type: 'integer', minimum: 1 },
    subjectIds: { type: 'array', maxItems: 200, items: idSchema },
    beatIds: { type: 'array', maxItems: 200, items: idSchema },
    ...Object.fromEntries(
      ['setupChapterId', 'payoffChapterId', 'setupBeatId', 'payoffBeatId'].map((k) => [
        k,
        { anyOf: [idSchema, { type: 'null' }] },
      ]),
    ),
  },
  [],
);
function projection(doc: Manuscript, include = true) {
  const { body, ...row } = doc;
  return include ? { ...row, body } : { ...row, bodyLength: body.length };
}
const priority: Record<Manuscript['type'], number> = {
  book: 0,
  outline: 1,
  subject: 2,
  clue: 3,
  chapter: 4,
};

/** The per-run read set prevents edits based on stale story data. It is never persisted as story content. */
export class NovelTools {
  private readonly readSet = new Map<string, Guard>();
  private readonly offsets = new Map<string, { revision: string; next: number }>();
  constructor(
    private workspace: WorkspaceService,
    private bookId: string,
    private provider: ModelProvider,
    private skills: WritingSkills,
  ) {}
  private remember(doc: Manuscript) {
    this.readSet.set(docKey(doc), { type: doc.type, id: doc.id, revision: doc.revision });
  }
  private async context(args: { type?: Manuscript['type']; documentId?: string; offset?: number }) {
    const view = await this.workspace.readAll(this.bookId);
    const documents = view.documents
      .filter((d) => !args.type || d.type === args.type)
      .sort((a, b) => priority[a.type] - priority[b.type]);
    const offset = args.offset ?? 0;
    if (args.documentId) {
      const matches = documents.filter((d) => d.id === args.documentId);
      if (matches.length !== 1) throw new Error('文档不存在或 ID 不唯一，请同时指定 type');
      const doc = matches[0],
        key = docKey(doc),
        end = Math.min(doc.body.length, offset + 44_000),
        continued = this.offsets.get(key);
      if (offset === 0 || (continued?.revision === doc.revision && continued.next === offset)) {
        if (end === doc.body.length) {
          this.remember(doc);
          this.offsets.delete(key);
        } else this.offsets.set(key, { revision: doc.revision, next: end });
      }
      return {
        document: { ...projection(doc, false), body: doc.body.slice(offset, end) },
        nextOffset: end < doc.body.length ? end : null,
        diagnostics: view.diagnostics.slice(0, 25),
      };
    }
    const rows: unknown[] = [];
    let i = offset,
      bytes = 0;
    for (; i < documents.length && rows.length < 45; i++) {
      const doc = documents[i],
        bodyIncluded = doc.type !== 'chapter' && doc.body.length <= 36_000;
      const result = projection(doc, bodyIncluded),
        size = JSON.stringify(result).length;
      if (rows.length && bytes + size > 86_000) break;
      rows.push(result);
      bytes += size;
      if (bodyIncluded || doc.type === 'chapter') this.remember(doc);
    }
    return {
      documents: rows,
      nextOffset: i < documents.length ? i : null,
      diagnostics: view.diagnostics.slice(0, 25),
      hint: '仅给出章节元数据；需要独立正文或超长故事资料，传 type/documentId，并用 offset 读完全文。',
    };
  }
  private async apply(operations: Mutation[], ctx: RunContext) {
    const { documents } = await this.workspace.readAll(this.bookId);
    const existing = new Map(documents.map((doc) => [docKey(doc), doc]));
    const guards: Guard[] = [];
    if (operations.some((m) => m.type !== 'chapter' || m.action === 'delete')) {
      for (const doc of documents)
        if (['outline', 'subject', 'clue'].includes(doc.type)) {
          const read = this.readSet.get(docKey(doc));
          if (read?.revision !== doc.revision)
            throw new Error(
              `请先用 book_get_context 读取大纲及相关故事资产（缺少或已变化：${docKey(doc)}）`,
            );
          guards.push(read);
        }
    }
    let nextOrder =
      1 + Math.max(0, ...documents.filter((d) => d.type === 'chapter').map((d) => d.fields.order ?? 0));
    const changes: Change[] = operations.map((m) => {
      const ref: DocRef = { type: m.type, id: m.id };
      if (!activeTypes.includes(m.type) || !isId(m.id)) throw new Error('操作包含无效的文档身份');
      const key = docKey(ref),
        old = existing.get(key);
      if ((m.action === 'create' && old) || (m.action !== 'create' && !old))
        throw new Error(`不符合创建或更新前提：${key}`);
      if (old && this.readSet.get(key)?.revision !== old.revision)
        throw new Error(`先读取当前版本：${key}`);
      if (m.action === 'delete') return { ...ref, expect: old!.revision, delete: true };
      if (m.type === 'chapter' && m.body !== undefined && m.body !== '')
        throw new Error('请用 book_generate_chapter 生成正文；目录编辑只改标题、顺序或关联');
      const fields = { ...old?.fields, ...m.fields } as Fields & Record<string, unknown>;
      for (const field of Object.keys(fields)) if (fields[field] === null) delete fields[field];
      if (m.type === 'chapter' && !old && fields.order === undefined) fields.order = nextOrder++;
      return {
        ...ref,
        expect: old?.revision ?? null,
        fields,
        body: m.type === 'chapter' ? (old?.body ?? '') : (m.body ?? old?.body ?? ''),
      };
    });
    const report = await this.workspace.writeChanges(this.bookId, changes, ctx.signal, guards);
    if (report.error) throw new Error(JSON.stringify(report));
    // A later independent batch needs a fresh view of the changed files.
    for (const doc of report.committed) this.readSet.delete(docKey(doc));
    return report;
  }
  tools(): LocalTool[] {
    return [
      {
        name: 'book_get_context',
        description:
          '读取当前作品。先读尽大纲、主体和伏笔，按需读文档正文。offset 用于分页；小说 ID 隐式绑定。',
        schema: object({ type: typeSchema, documentId: idSchema, offset: page }, []),
        execute: async (args) => this.context(args),
      },
      {
        name: 'book_apply_changes',
        description:
          '提交一批小说资料增删改，程序校验明确引用；先阅读当前大纲与相关资产。create/update/delete 接受稳定 ID；可选关系字段用 null 清除。',
        schema: object({
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: 60,
            items: object(
              {
                type: { type: 'string', enum: activeTypes },
                id: idSchema,
                action: { type: 'string', enum: ['create', 'update', 'delete'] },
                fields: fieldSchema,
                body: { type: 'string', maxLength: 110_000 },
              },
              ['type', 'id', 'action'],
            ),
          },
        }),
        execute: async ({ operations }, ctx) => this.apply(operations, ctx),
      },
      {
        name: 'book_generate_chapter',
        description:
          '生成空白章或续写已有章。程序组装前文、主体、大纲与伏笔并流式预览。重写已有章需作者在面板明确选中重写。',
        schema: object(
          {
            chapterId: idSchema,
            mode: { type: 'string', enum: ['draft', 'append'] },
            direction: str(undefined, 16_000),
          },
          ['chapterId', 'mode'],
        ),
        execute: async ({ chapterId, mode, direction }, ctx) => {
          const saved = await draftChapter(
            this.workspace,
            ctx,
            this.provider,
            chapterId,
            mode,
            direction ?? '',
            { skill: this.skills.chapter },
          );
          this.remember(saved);
          return { chapterId, revision: saved.revision };
        },
      },
    ];
  }
}
