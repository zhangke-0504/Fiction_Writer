import { classified, DiagnosticFailure } from '../diagnostics/trace.js';
import type { Change, DocRef, Fields, Manuscript, WriteReport } from '../../shared/contracts.js';
import type { WorkspaceService, Guard } from '../workspace.js';
import { digest, docKey, isId, renderDocument, storyBeats } from '../documents.js';
import { draftChapter } from './draft.js';
import { rewriteTarget } from './chapter-intent.js';
import { defaultRoundLimit, object, str, ToolFailure, type LocalTool } from './loop.js';
import type { ModelProvider } from './model.js';
import type { SkillCatalog, SkillName } from './skills.js';
import type { RunContext } from './runs.js';
import { diagnosticScope, noDiagnostic } from '../../shared/diagnostics.js';
import {
  goalProblem,
  inspectNovelGoal,
  maxGoalChapters,
  requestedChapterCount,
  sameChapterIds,
  validChapterIds,
  type NovelCheck,
  type NovelTaskState,
} from './novel-goal.js';

const activeTypes = ['outline', 'subject', 'clue', 'chapter'] as const;
type GoalRequest = {
  action: 'register' | 'resume' | 'check';
  chapterIds?: string[];
  updateDirection?: boolean;
};
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
const indexes = ['chapters', 'subjects', 'beats'] as const;
type ReferenceIndex = (typeof indexes)[number];
const indexPageSize = 60;
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
    rows: rows.slice(offset, offset + indexPageSize),
    nextOffset: offset + indexPageSize < rows.length ? offset + indexPageSize : null,
  };
}
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
  private wholeSkill = false;
  private task?: NovelTaskState;
  private inheritedDirections: string[] = [];
  private get target() {
    return this.task?.chapterIds;
  }
  private readonly referenceFailures = new Map<string, number>();
  private readonly chapterFailures = new Map<string, ToolFailure>();
  private readonly readSet = new Map<string, Guard>();
  private readonly offsets = new Map<string, { revision: string; next: number }>();
  constructor(
    private workspace: WorkspaceService,
    private bookId: string,
    private provider: ModelProvider,
    private skills: SkillCatalog,
    private input: { authorPrompt?: string; selectedChapterId?: string } = {},
  ) {}
  skillApplied(name: SkillName) {
    if (name === 'generate-novel') this.wholeSkill = true;
  }
  // The shared loop keeps its baseline budget. A verified target adds at most one round per chapter.
  roundLimit = () => defaultRoundLimit + (this.target?.length ?? 0);
  outputTokens = () => (this.wholeSkill ? this.provider.extendedOutputTokens : undefined);
  restorePrimaryFailure() {
    const last = [...this.chapterFailures.values()].at(-1);
    if (this.wholeSkill && last) throw last;
  }
  private requireGoal() {
    if (this.wholeSkill && !this.target)
      throw new ToolFailure(
        'novel_goal_required',
        '请先通过 book_get_context 的 novelGoal 登记或续接整书目标。',
      );
    return this.target;
  }
  private publish(check: NovelCheck, ctx: RunContext, message = goalProblem(check)) {
    ctx.progress({
      step: '已保存章节正文',
      done: check.done,
      total: check.total,
      complete: check.complete,
      message,
    });
  }
  private check(view: Awaited<ReturnType<WorkspaceService['readAll']>>) {
    return inspectNovelGoal(
      view,
      this.target!,
      [...this.referenceFailures.keys()],
      this.task?.knownCatalog,
    );
  }
  private async goalView(
    args: GoalRequest,
    view: Awaited<ReturnType<WorkspaceService['readAll']>>,
    ctx: RunContext,
  ) {
    if (!this.wholeSkill)
      throw new ToolFailure('novel_goal_required', '整书目标需要先检索并加载对应 Skill。');
    const continuation = ctx.continuation;
    let activated = false;
    if (args.action === 'register') {
      const ids = args.chapterIds;
      if (!validChapterIds(ids) || ctx.authorLine === undefined)
        throw new ToolFailure(
          'invalid_arguments',
          '请提供完整且不重复的目标章节 ID，并从作者请求发起。',
        );
      if (this.target && !sameChapterIds(this.target, ids))
        throw new ToolFailure('novel_goal_conflict', '已登记的目标章范围或顺序不能在同一任务中变更。');
      if (!this.target) {
        if (continuation)
          throw new ToolFailure(
            'novel_goal_conflict',
            '已有未完成整书目标，请用 novelGoal.resume 核对现稿和原指令。',
          );
        const expected = requestedChapterCount(this.input.authorPrompt ?? '');
        if (expected && expected !== ids.length)
          throw new ToolFailure(
            'novel_goal_conflict',
            `作者指定了 ${expected} 章，不能登记 ${ids.length} 章。`,
          );
        const existing = view.documents.filter((doc) => doc.type === 'chapter').map((doc) => doc.id);
        if (
          !sameChapterIds(
            existing,
            ids.filter((id) => existing.includes(id)),
          )
        )
          throw new ToolFailure('novel_goal_conflict', '目标必须保留当前目录的章节 ID 及相对顺序。');
        this.task = {
          chapterIds: [...ids],
          originalLine: ctx.authorLine,
          knownCatalog: existing,
          pendingReferences: [],
        };
        activated = true;
      }
    } else if (args.action === 'resume') {
      if (!continuation && !this.task)
        throw new ToolFailure('novel_goal_required', '此会话没有可供续接的整书目标，请按当前稿件登记。');
      if (!this.task && continuation) {
        this.task = structuredClone(continuation.task);
        this.inheritedDirections = [
          continuation.originalDirection,
          continuation.amendedDirection,
        ].filter((s): s is string => !!s);
        if (args.updateDirection && ctx.authorLine !== undefined)
          this.task.amendmentLine = ctx.authorLine;
        for (const key of this.task.pendingReferences) this.referenceFailures.set(key, 0);
        activated = true;
      }
    }
    this.requireGoal();
    const check = this.check(view);
    this.publish(check, ctx);
    if (activated) {
      await this.saveGoal(ctx, check);
      this.reportReused(view.documents, ctx);
    }
    (ctx.diagnostic ?? noDiagnostic)('novel.goal', {
      operation: args.action,
      outcome: check.catalogConflict ? 'conflict' : 'ok',
      done: check.done,
      total: check.total,
    });
    if (args.action === 'resume' && check.catalogConflict)
      throw new ToolFailure('novel_goal_conflict', goalProblem(check) ?? '请核对原目录。', check);
    return {
      ...check,
      ...(args.action === 'resume' && {
        originalDirection: this.inheritedDirections[0],
        amendedDirection: this.inheritedDirections[1],
        lastFailedChapterId: this.task?.failedChapterId,
      }),
    };
  }
  private async saveGoal(ctx: RunContext, check: NovelCheck) {
    if (!this.task || ctx.signal.aborted) return;
    const task = {
      ...this.task,
      knownCatalog: [
        ...new Set([
          ...this.task.knownCatalog,
          ...check.chapterIds.filter((id) => !check.missingChapters.includes(id)),
        ]),
      ],
      pendingReferences: [...this.referenceFailures.keys()],
    };
    await ctx.saveNovelTask(task);
    this.task = task;
  }
  private reportReused(documents: Manuscript[], ctx: RunContext) {
    const report = ctx.diagnostic ?? noDiagnostic;
    for (const doc of documents)
      if (doc.type === 'chapter' && doc.body.trim()) {
        const index = this.target?.indexOf(doc.id) ?? -1;
        if (index >= 0)
          report('novel.chapter.reused', {
            documentRef: docKey(doc),
            chapterIndex: index + 1,
            reason: 'existing_content',
          });
      }
  }
  async assertFinished(ctx: RunContext) {
    if (!this.wholeSkill) return;
    if (!this.target)
      throw new DiagnosticFailure('novel_goal_required', '整书未完成：未登记可核对的章节目标。');
    const check = this.check(await this.workspace.readAll(this.bookId));
    const failure = check.firstUnwritten && this.chapterFailures.get(check.firstUnwritten);
    this.publish(check, ctx, failure ? failure.message : undefined);
    if (check.complete) await ctx.saveNovelTask(null);
    else
      throw new DiagnosticFailure(
        failure ? failure.diagnosticReason : 'novel_incomplete',
        `整书未完成（已保存 ${check.done}/${check.total} 章）：${failure ? failure.message : (goalProblem(check) ?? '请核对现稿')}`,
      );
  }
  private recordReferences(operations: Mutation[], report: WriteReport) {
    for (const doc of report.committed) this.referenceFailures.delete(docKey(doc));
    const invalid =
      report.invalidReferences?.map((issue) => docKey(issue.document)) ??
      (report.reason === 'unbound_foreshadowing'
        ? operations.filter((m) => m.type === 'clue' && m.action === 'create').map(docKey)
        : []);
    for (const key of new Set(invalid))
      this.referenceFailures.set(key, (this.referenceFailures.get(key) ?? 0) + 1);
  }
  private remember(doc: Manuscript) {
    this.readSet.set(docKey(doc), { type: doc.type, id: doc.id, revision: doc.revision });
  }
  private async context(
    args: {
      type?: Manuscript['type'];
      documentId?: string;
      offset?: number;
      index?: ReferenceIndex;
      novelGoal?: GoalRequest;
    },
    ctx: RunContext,
  ) {
    const view = await this.workspace.readAll(this.bookId);
    if (args.novelGoal) return this.goalView(args.novelGoal, view, ctx);
    const offset = args.offset ?? 0;
    if (args.index) return referenceIndex(view.documents, args.index, offset);
    const documents = view.documents
      .filter((d) => !args.type || d.type === args.type)
      .sort((a, b) => priority[a.type] - priority[b.type]);
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
    const target = this.requireGoal();
    if (target)
      for (const mutation of operations) {
        if (
          mutation.action === 'delete' ||
          (mutation.type === 'chapter' && !target.includes(mutation.id))
        )
          throw new ToolFailure('novel_goal_conflict', '整书补齐不能删除现稿或修改目标范围之外的章节。');
        if ((this.referenceFailures.get(docKey(mutation)) ?? 0) >= 3)
          throw new ToolFailure(
            'invalid_references',
            `${docKey(mutation)}：多次修正仍有无效引用，请报告未完成项。`,
          );
      }
    const before = await this.workspace.readAll(this.bookId);
    if (target && this.check(before).catalogConflict)
      throw new ToolFailure(
        'novel_goal_conflict',
        goalProblem(this.check(before)) ?? '该目录已变化，请核对现稿。',
      );
    const { documents } = before;
    const existing = new Map(documents.map((doc) => [docKey(doc), doc]));
    const guards: Guard[] = [];
    if (operations.some((m) => m.type !== 'chapter' || m.action === 'delete')) {
      const unread: DocRef[] = [];
      for (const doc of documents) {
        if (!['outline', 'subject', 'clue'].includes(doc.type)) continue;
        const read = this.readSet.get(docKey(doc));
        if (read?.revision === doc.revision) guards.push(read);
        else unread.push({ type: doc.type, id: doc.id });
      }
      if (unread.length)
        throw new ToolFailure(
          'context_required',
          `请先用 book_get_context 读取大纲及相关故事资产：有 ${unread.length} 项未读或已变化。不要用 index 代替全文；用空参数读取并翻完各页，或按返回的 ID 读。`,
          { unread: unread.slice(0, 25), remaining: Math.max(0, unread.length - 25) },
        );
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
    const report = await this.workspace.writeChanges(
      this.bookId,
      changes,
      ctx.signal,
      guards,
      ctx.diagnostic,
      !!target,
    );
    // The model already knows bytes it submitted. If the writer or an external editor changed
    // those bytes (including implicit relation cleanup), the revision will not match and a read is required.
    const submitted = new Map(changes.map((change) => [docKey(change), change]));
    for (const ref of report.committed) {
      const change = submitted.get(docKey(ref));
      if (!change || 'delete' in change) this.readSet.delete(docKey(ref));
      else
        this.readSet.set(docKey(ref), {
          ...ref,
          revision: digest(renderDocument(ref, change.fields, change.body)),
        });
    }
    if (target) {
      this.recordReferences(operations, report);
      if (!ctx.signal.aborted) {
        const check = this.check(await this.workspace.readAll(this.bookId));
        this.publish(check, ctx, report.error);
        await this.saveGoal(ctx, check);
      }
    }
    if (report.error) throw new ToolFailure(report.reason ?? 'unknown', report.error, report);
    return report;
  }
  private async generate(
    chapterId: string,
    mode: 'draft' | 'append' | 'replace',
    direction: string,
    ctx: RunContext,
  ) {
    const target = this.requireGoal();
    let guards: Guard[] = [];
    if (target) {
      if (mode !== 'draft' || !target.includes(chapterId))
        throw new ToolFailure('novel_goal_conflict', '整书只能为目标中的空白章生成正文。');
      const view = await this.workspace.readAll(this.bookId);
      const check = this.check(view);
      const current = view.documents.find((doc) => doc.type === 'chapter' && doc.id === chapterId);
      if (!check.ready)
        throw new ToolFailure('novel_goal_conflict', goalProblem(check) ?? '请先核对写作前提。', check);
      if (current?.body.trim()) return { chapterId, revision: current.revision, reused: true };
      if (check.firstUnwritten !== chapterId)
        throw new ToolFailure('novel_goal_conflict', `不能跳过空白章 ${check.firstUnwritten}。`, check);
      guards = view.documents;
      ctx = {
        ...ctx,
        diagnostic: diagnosticScope(ctx.diagnostic ?? noDiagnostic, {
          chapterIndex: target.indexOf(chapterId) + 1,
        }),
      };
    }
    if (mode === 'replace') {
      const { documents } = await this.workspace.readAll(this.bookId);
      const authorized = rewriteTarget(
        this.input.authorPrompt ?? '',
        documents.filter((doc) => doc.type === 'chapter'),
        this.input.selectedChapterId,
      );
      const replacement = documents.find((doc) => doc.type === 'chapter' && doc.id === authorized);
      if (!replacement || replacement.id !== chapterId)
        throw new ToolFailure(
          'rewrite_not_authorized',
          '仅当作者在当前消息明确要求重写指定章节时才允许覆盖原文。',
        );
      guards = [replacement];
    }
    const previousFailure = this.chapterFailures.get(chapterId);
    if (previousFailure) throw previousFailure;
    try {
      const writingDirection = [
        ...this.inheritedDirections.map((text) => `先前作者要求：${text}`),
        this.input.authorPrompt && `本轮作者要求（明确的新要求优先）：${this.input.authorPrompt}`,
        direction && `本章写作安排（不得覆盖作者要求）：${direction}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const saved = await draftChapter(
        this.workspace,
        ctx,
        this.provider,
        chapterId,
        mode,
        writingDirection,
        {
          skill: await this.skills.load('write-chapter', ctx.diagnostic),
          guard: guards,
          retryIncomplete: true,
          maxTokens: target ? this.provider.extendedOutputTokens : undefined,
          directProse: !!target,
          lengthGuidance: target
            ? '这是整书中的独立一章。除非作者本人明确要求每章的篇幅（本章写作安排不算），本章以约 1200–1800 汉字完成，最多约 2000 汉字。写出有起伏和完整收束的场景，以叙事呈现而不是梗概；避免重复和长篇推演以免正文被输出上限截断。'
            : undefined,
        },
      );
      this.remember(saved);
      if (target && !ctx.signal.aborted) {
        if (this.task?.failedChapterId === chapterId) this.task.failedChapterId = undefined;
        const check = this.check(await this.workspace.readAll(this.bookId));
        this.publish(check, ctx);
        await this.saveGoal(ctx, check);
      }
      return { chapterId, revision: saved.revision };
    } catch (error) {
      const reason = classified(error, ctx.signal);
      const failure = new ToolFailure(
        reason,
        `章节 ${chapterId} 未保存：${error instanceof Error ? error.message : '写作失败'}`,
        { chapterId },
      );
      if (target || reason === 'incomplete_stream' || reason === 'output_limit')
        this.chapterFailures.set(chapterId, failure);
      if (target && this.task && !ctx.signal.aborted) {
        this.task.failedChapterId = chapterId;
        const check = this.check(await this.workspace.readAll(this.bookId));
        this.publish(check, ctx, failure.message);
        await this.saveGoal(ctx, check);
      }
      throw failure;
    }
  }
  tools(): LocalTool[] {
    return [
      {
        name: 'book_get_context',
        description:
          '读取当前作品。改动前先读尽大纲、主体和伏笔，按需读文档正文。index=chapters/subjects/beats 查真实 ID；offset 分页。整书 Skill 用 novelGoal 登记、续接或检查目标，不负责执行生成。',
        schema: object(
          {
            type: typeSchema,
            documentId: idSchema,
            offset: page,
            index: { type: 'string', enum: indexes },
            novelGoal: object(
              {
                action: { type: 'string', enum: ['register', 'resume', 'check'] },
                chapterIds: {
                  type: 'array',
                  items: idSchema,
                  minItems: 1,
                  maxItems: maxGoalChapters,
                  uniqueItems: true,
                },
                updateDirection: {
                  type: 'boolean',
                  description: '只在作者本轮明确改变之前的续写方向时设为 true',
                },
              },
              ['action'],
            ),
          },
          [],
        ),
        execute: async (args, ctx) => this.context(args, ctx),
      },
      {
        name: 'book_apply_changes',
        description:
          '提交小说资料变更。若用整书 Skill，先用 book_get_context 的 novelGoal 登记／续接。修改既有或已变化的故事资料前，调用不带 index/type 的 book_get_context，读完各页或按 ID 补读。本轮已经提交且未变化的内容无需重复读取。可批量提交；引用用真实 ID，可选关系字段用 null 清除。',
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
          '流式生成空白章、续写或明确重写指定章。整书中按序写空白章；终止失败时告知作者，不要重复相同调用或跳过失败章节。replace 只接受本轮作者明确授权。',
        schema: object(
          {
            chapterId: idSchema,
            mode: { type: 'string', enum: ['draft', 'append', 'replace'] },
            direction: str(undefined, 16_000),
          },
          ['chapterId', 'mode'],
        ),
        execute: async ({ chapterId, mode, direction }, ctx) =>
          this.generate(chapterId, mode, direction ?? '', ctx),
      },
    ];
  }
}
