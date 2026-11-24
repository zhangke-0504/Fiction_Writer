import { classified, DiagnosticFailure } from '../diagnostics/trace.js';
import type { Change, DocRef, Fields, Manuscript, WriteReport } from '../../shared/contracts.js';
import type { WorkspaceService, Guard } from '../workspace.js';
import {
  chapterPlacementFingerprint,
  digest,
  docKey,
  isId,
  renderDocument,
  storyBeats,
  storyLinks,
} from '../documents.js';
import { draftChapter, DraftCommitFailure } from './draft.js';
import type { ChapterPlan } from './chapter-boundary.js';
import { suggestInsertionPoints, type ChapterInsertion } from './chapter-insertion.js';
import { chapterAssetRequirements } from './chapter-context.js';
import {
  minimumExistingSubjects,
  passageTargetAllowed,
  rewriteTarget,
  wantsPassageAddition,
} from './chapter-intent.js';
import { assetBatchSize, generateStoryAssets, type AssetInput } from './story-assets.js';
import {
  WritingContextFailure,
  writingIssueDetails,
  type ChapterAction,
  type WritingIntent,
} from './writing-request.js';
import { defaultRoundLimit, object, str, ToolFailure, type LocalTool } from './loop.js';
import type { ModelProvider } from './model.js';
import type { SkillCatalog, SkillName } from './skills.js';
import type { RunContext } from './runs.js';
import { diagnosticScope, noDiagnostic } from '../../shared/diagnostics.js';
import {
  goalProblem,
  inspectNovelGoal,
  maxGoalAssets,
  maxGoalChapters,
  requestedChapterCount,
  sameChapterIds,
  validChapterIds,
  validGoalAssets,
  type GoalAsset,
  type NovelCheck,
  type NovelTaskState,
} from './novel-goal.js';

const activeTypes = ['outline', 'subject', 'clue', 'chapter'] as const;
type GoalRequest = {
  action: 'register' | 'resume' | 'check';
  chapterIds?: string[];
  updateDirection?: boolean;
  assetRefs?: GoalAsset[];
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
  private readonly createdHere = new Set<string>();
  private inserted?: { chapterId: string; revision?: string; outlineUpdated: boolean };
  private get connectedEntry() {
    return (
      minimumExistingSubjects(this.input.authorPrompt ?? '') > 0 &&
      /伏笔|线索/u.test(this.input.authorPrompt ?? '')
    );
  }
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
  // For manual acceptance, the per-run cap is uniform regardless of goal size.
  roundLimit = () => defaultRoundLimit;
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
      this.task?.requiredAssets,
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
    let expanded = false;
    if (args.assetRefs !== undefined && (args.action !== 'register' || !validGoalAssets(args.assetRefs)))
      throw new ToolFailure(
        'invalid_arguments',
        '使用 register 登记本次确定要生成的主体／伏笔稳定 ID。',
      );
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
      expanded = this.includeAssets(args.assetRefs ?? []);
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
    if (activated || expanded) await this.saveGoal(ctx, check);
    if (activated) this.reportReused(view.documents, ctx);
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
  private includeAssets(refs: DocRef[]) {
    if (!this.task || !refs.length) return false;
    const prior = this.task.requiredAssets ?? [];
    const next = [
      ...new Map(
        [...prior, ...refs].map((ref) => [docKey(ref), { type: ref.type, id: ref.id }]),
      ).values(),
    ];
    if (!validGoalAssets(next))
      throw new ToolFailure('result_limit', '整书要核对的资产超出上限，请核对这次安排。');
    if (next.length === prior.length) return false;
    this.task.requiredAssets = next;
    return true;
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
    if (this.connectedEntry && !this.inserted?.outlineUpdated)
      throw new DiagnosticFailure(
        'context_required',
        '关联增补未完成：还没有一处经核对的登场正文及对应大纲提交。已保存的资料保留。',
      );
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
    if (args.index)
      return {
        ...referenceIndex(view.documents, args.index, offset),
        ...(this.connectedEntry &&
          args.index === 'chapters' && { entryChoices: this.entryChoices(view.documents) }),
      };
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
    if (
      !target &&
      wantsPassageAddition(this.input.authorPrompt ?? '') &&
      (this.connectedEntry ||
        operations.some(
          ({ type, action }) => type === 'chapter' || type === 'outline' || action !== 'create',
        ))
    )
      throw new ToolFailure(
        'invalid_options',
        '本轮的登场增补使用版本及锚点保护的 insert（可随该章附加大纲安排）。它不授权通用工具替换既有文档或调整目录。',
      );
    if (target)
      for (const mutation of operations) {
        if (
          ['subject', 'clue'].includes(mutation.type) &&
          (mutation.action === 'create' || mutation.body !== undefined)
        )
          throw new ToolFailure(
            'invalid_options',
            '整书新建或补齐主体／伏笔说明须用 book_generate_assets，不能只建占位或直接填 body。',
            { refs: [{ type: mutation.type, id: mutation.id }] },
          );
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
  private writingIntent(arrangement?: string): WritingIntent {
    return { author: this.input.authorPrompt, continued: this.inheritedDirections, arrangement };
  }
  private entryChoices(documents: Manuscript[], ids?: Set<string>) {
    const chapters = documents.filter((doc) => doc.type === 'chapter');
    const outlineRevision = documents.find((doc) => doc.type === 'outline')?.revision;
    return {
      outlineRevision,
      chapters: chapters
        .filter(
          (doc) =>
            doc.body.trim() &&
            (!ids || ids.has(doc.id)) &&
            passageTargetAllowed(
              this.input.authorPrompt ?? '',
              chapters,
              doc.id,
              this.input.selectedChapterId,
            ),
        )
        .map((doc) => ({
          chapterId: doc.id,
          title: doc.fields.title,
          order: doc.fields.order,
          insertion: suggestInsertionPoints(doc),
        })),
      note: '可从候选选一章；伏笔 setupChapterId 与登场章相同，另填一个真实的计划 payoffChapterId（不用改回收章）。锚点是建议，也可定向读取现稿换一处。',
    };
  }
  private async generateAssets(input: AssetInput, arrangement: string | undefined, ctx: RunContext) {
    if (ctx.session.bookId !== this.bookId)
      throw new ToolFailure('invalid_options', '生成资料必须使用本次会话绑定的作品。');
    const target = this.requireGoal();
    if (
      this.connectedEntry &&
      input.kind === 'clue' &&
      input.action === 'create' &&
      Array.isArray(input.targets)
    ) {
      const { documents } = await this.workspace.readAll(this.bookId);
      const chapters = documents.filter(({ type }) => type === 'chapter');
      const actor = documents.find((doc) => doc.type === 'subject' && this.createdHere.has(docKey(doc)));
      if (
        !actor ||
        input.targets.some(
          ({ fields }) =>
            !fields?.setupChapterId ||
            !fields.payoffChapterId ||
            !fields.subjectIds?.includes(actor.id) ||
            !passageTargetAllowed(
              this.input.authorPrompt ?? '',
              chapters,
              fields.setupChapterId,
              this.input.selectedChapterId,
            ),
        )
      )
        throw new ToolFailure(
          'invalid_arguments',
          '新增登场伏笔须关联已保存的新角色，填实际中期埋设章 setupChapterId 和有效的计划回收章 payoffChapterId；不用修改回收章。',
          { actorId: actor?.id, entryChoices: this.entryChoices(documents) },
        );
    }
    if (
      this.connectedEntry &&
      input.kind === 'subject' &&
      input.action === 'create' &&
      [...this.createdHere].some((key) => key.startsWith('subject/'))
    )
      throw new ToolFailure('conflict', '本轮已有新反派说明，请复用已保存的主体，不再生成第二个。');
    let authorized: DocRef[] = [];
    const checkpoint = async () => {
      if (!this.task || ctx.signal.aborted) return;
      const check = this.check(await this.workspace.readAll(this.bookId));
      this.publish(check, ctx);
      await this.saveGoal(ctx, check);
    };
    try {
      const result = await generateStoryAssets(
        this.workspace,
        ctx,
        this.provider,
        input,
        this.writingIntent(arrangement),
        !!target,
        async (refs) => {
          authorized = refs;
          if (this.includeAssets(refs)) await checkpoint();
          if (this.task && refs.some((ref) => (this.referenceFailures.get(docKey(ref)) ?? 0) >= 3))
            throw new ToolFailure(
              'invalid_references',
              '这批资料多次引用无效，请重新核查标识或报告缺项。',
              { refs },
            );
        },
      );
      if (input.action === 'create')
        for (const saved of result.assets) this.createdHere.add(docKey(saved));
      if (target) {
        for (const saved of result.assets) this.referenceFailures.delete(docKey(saved));
        await checkpoint();
      }
      if (this.connectedEntry && input.kind === 'clue' && input.action === 'create') {
        const { documents } = await this.workspace.readAll(this.bookId);
        const actor = documents.find(
          (doc) => doc.type === 'subject' && this.createdHere.has(docKey(doc)),
        );
        const saved = new Set(result.assets.map(docKey));
        const linked = documents.filter(
          (doc) =>
            doc.type === 'clue' &&
            saved.has(docKey(doc)) &&
            doc.fields.subjectIds?.includes(actor?.id ?? ''),
        );
        const chapters = new Set(
          linked.flatMap(({ fields }) => (fields.setupChapterId ? [fields.setupChapterId] : [])),
        );
        return {
          ...result,
          entryReady: {
            ...this.entryChoices(documents, chapters),
            subjectIds: actor ? [actor.id] : [],
            clueIds: linked.map(({ id }) => id),
            next: '可用 book_generate_chapter mode=insert：选同一个埋设章及一个 insertion 锚点，附 outline:{revision:outlineRevision,addition:只写本章登场与埋设的简短安排}。无需重新扫描全书。',
          },
        };
      }
      return result;
    } catch (error) {
      if (error instanceof WritingContextFailure)
        throw new ToolFailure(error.diagnosticReason, error.message, writingIssueDetails(error));
      if (
        target &&
        error instanceof ToolFailure &&
        ['invalid_references', 'unbound_foreshadowing'].includes(error.diagnosticReason)
      ) {
        const report = error.value as Partial<WriteReport> | undefined;
        const keys =
          report?.invalidReferences?.map(({ document }) => docKey(document)) ?? authorized.map(docKey);
        for (const key of new Set(keys))
          this.referenceFailures.set(key, Math.min(3, (this.referenceFailures.get(key) ?? 0) + 1));
        await checkpoint();
      }
      throw error;
    }
  }
  private entryPlan(
    documents: Manuscript[],
    chapterId: string,
    plan: ChapterPlan & { insertion?: ChapterInsertion },
  ) {
    const inBook = documents.filter((doc) => this.createdHere.has(docKey(doc)));
    const actor = inBook.find(({ type }) => type === 'subject');
    const admitted = inBook.filter(
      (doc) =>
        doc.type === 'clue' &&
        doc.fields.setupChapterId === chapterId &&
        doc.fields.subjectIds?.includes(actor?.id ?? '') &&
        documents.some(
          (chapter) => chapter.type === 'chapter' && chapter.id === doc.fields.payoffChapterId,
        ),
    );
    if (!actor || !admitted.length || !plan.insertion?.outline)
      throw new ToolFailure(
        'context_required',
        '本轮要求新反派及其伏笔实际登场。先保存其关联说明和绑定同一埋设章的伏笔，再对该章 insert 并附上当前版本的大纲增补。',
        {
          chapterId,
          existingActorId: actor?.id,
          linkedClueIds: admitted.map(({ id }) => id),
          needsOutline: !plan.insertion?.outline,
        },
      );
    const newClues = admitted.map(({ id }) => id);
    const addition = plan.insertion.outline.addition;
    const refs = new Set(storyLinks(addition).map(({ ref }) => docKey(ref)));
    const actualRefs = [actor, ...admitted]
      .filter((doc) => !refs.has(docKey(doc)))
      .map((doc) => {
        const label =
          (doc.fields.name ?? doc.fields.title ?? doc.id).replace(/[\r\n\[\]]/gu, ' ').trim() || doc.id;
        return `[${label}](${doc.type === 'subject' ? 'subjects' : 'foreshadowing'}/${doc.id}.md)`;
      });
    return {
      ...plan,
      subjectIds: [...new Set([...(plan.subjectIds ?? []), actor.id])],
      clueIds: [...new Set([...(plan.clueIds ?? []), ...newClues])],
      insertion: {
        ...plan.insertion,
        outline: {
          ...plan.insertion.outline,
          addition: addition + (actualRefs.length ? ' ' + actualRefs.join(' ') : ''),
        },
      },
    };
  }
  private async generate(
    chapterId: string,
    mode: ChapterAction,
    direction: string,
    plan: ChapterPlan & { insertion?: ChapterInsertion },
    ctx: RunContext,
  ) {
    const target = this.requireGoal();
    let guards: Guard[] = [];
    let expectedPlacement: string | undefined;
    if (target) {
      if (mode !== 'draft' || !target.includes(chapterId))
        throw new ToolFailure('novel_goal_conflict', '整书只能为目标中的空白章生成正文。');
      const view = await this.workspace.readAll(this.bookId);
      const check = this.check(view);
      const current = view.documents.find((doc) => doc.type === 'chapter' && doc.id === chapterId);
      if (!check.catalogReady)
        throw new ToolFailure('novel_goal_conflict', goalProblem(check) ?? '请先核对写作前提。', check);
      if (current?.body.trim()) return { chapterId, revision: current.revision, reused: true };
      if (check.firstUnwritten !== chapterId)
        throw new ToolFailure('novel_goal_conflict', `不能跳过空白章 ${check.firstUnwritten}。`, check);
      if (current && this.includeAssets(chapterAssetRequirements(view.documents)(current, plan)))
        await this.saveGoal(ctx, this.check(view));
      // Preserve the checked catalog across the hand-off to the renderer.
      expectedPlacement = chapterPlacementFingerprint(view.documents);
      ctx = {
        ...ctx,
        diagnostic: diagnosticScope(ctx.diagnostic ?? noDiagnostic, {
          chapterIndex: target.indexOf(chapterId) + 1,
        }),
      };
    }
    if (mode === 'insert') {
      if (this.inserted)
        throw new ToolFailure('conflict', '本轮的局部增补已经提交，不在其他章重复插入。', this.inserted);
      const { documents } = await this.workspace.readAll(this.bookId);
      if (
        !passageTargetAllowed(
          this.input.authorPrompt ?? '',
          documents.filter((doc) => doc.type === 'chapter'),
          chapterId,
          this.input.selectedChapterId,
        )
      )
        throw new ToolFailure(
          'insert_not_authorized',
          '本轮须明确要求在此章或此剧情位置增补正文；生成资料不授权插入或整章覆盖。',
          { chapterId },
        );
      if (this.connectedEntry) plan = this.entryPlan(documents, chapterId, plan);
      expectedPlacement = chapterPlacementFingerprint(documents);
    } else if (plan.insertion) {
      throw new ToolFailure('invalid_arguments', '仅 insert 接受局部插入锚点与大纲增补。');
    } else if (mode !== 'replace' && wantsPassageAddition(this.input.authorPrompt ?? '')) {
      throw new ToolFailure(
        'insert_not_authorized',
        '本轮是指定剧情位置的局部登场增补，请读取既有章并用 insert，不能跳到续写或新章。',
        { chapterId },
      );
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
      const saved = await draftChapter(
        this.workspace,
        ctx,
        this.provider,
        chapterId,
        mode,
        this.writingIntent(direction),
        {
          plan,
          insertion: plan.insertion,
          expectedPlacement,
          skill: await this.skills.load('write-chapter', ctx.diagnostic),
          guard: guards,
          retryIncomplete: true,
          maxTokens: target ? this.provider.extendedOutputTokens : undefined,
          directProse: !!target || mode === 'insert',
          whole: !!target,
        },
      );
      this.remember(saved);
      if (mode === 'insert')
        this.inserted = {
          chapterId,
          revision: saved.revision,
          outlineUpdated: !!plan.insertion?.outline,
        };
      if (target && !ctx.signal.aborted) {
        if (this.task?.failedChapterId === chapterId) this.task.failedChapterId = undefined;
        const check = this.check(await this.workspace.readAll(this.bookId));
        this.publish(check, ctx);
        await this.saveGoal(ctx, check);
      }
      return {
        chapterId,
        revision: saved.revision,
        ...(mode === 'insert' && { inserted: true, outlineUpdated: !!plan.insertion?.outline }),
      };
    } catch (error) {
      const reason = classified(error, ctx.signal);
      const partial =
        error instanceof DraftCommitFailure && error.report.committed.length > 0
          ? error.report
          : undefined;
      if (
        mode === 'insert' &&
        partial?.committed.some((doc) => doc.type === 'chapter' && doc.id === chapterId)
      )
        this.inserted = {
          chapterId,
          outlineUpdated: partial.committed.some(({ type }) => type === 'outline'),
        };
      const failure = new ToolFailure(
        reason,
        partial
          ? '增补仅部分提交，请查阅已提交和待处理项，不重复插入。'
          : `章节 ${chapterId} 未保存：${error instanceof Error ? error.message : '写作失败'}`,
        {
          chapterId,
          ...(partial ?? {}),
          ...(error instanceof WritingContextFailure && writingIssueDetails(error)),
        },
      );
      if (
        !(error instanceof WritingContextFailure) &&
        (target || reason === 'incomplete_stream' || reason === 'output_limit')
      )
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
          '读取当前作品。按 type/documentId 定向读取；index=chapters/subjects/beats 查真实 ID；offset 分页。按写入要求核对有关现稿，不反复读取未变化的同版资料。整书用 novelGoal 登记、续接或检查目标，不负责执行生成。',
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
                assetRefs: {
                  type: 'array',
                  maxItems: maxGoalAssets,
                  items: object({
                    type: { type: 'string', enum: ['subject', 'clue'] },
                    id: idSchema,
                  }),
                  description: 'register 可增加已明确属于此目标的主体／伏笔；不会删除已登记资料',
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
          '提交小说资料变更。若用整书 Skill，先用 book_get_context 的 novelGoal 登记／续接。修改既有或已变化的故事资料前，调用不带 index/type 的 book_get_context，读完各页或按 ID 补读。本轮已显式读到的资料未变化时无需重复取回。可批量提交；引用用真实 ID，可选关系字段用 null 清除。AI 生成或补齐主体／伏笔说明用 book_generate_assets；整书不能在这里新建或填写它们。',
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
        name: 'book_generate_assets',
        description:
          '生成或补齐一小批同类主体／伏笔的 Markdown 说明，适用于整书和单独任务。create 提供新 ID 及必要字段；fill 只补空或占位；update 需要作者本轮明确授权指定已有资料。已有字段在 fill/update 时保留。用真实章节和主体 ID，不在参数里写说明正文。',
        schema: object(
          {
            kind: { type: 'string', enum: ['subject', 'clue'] },
            action: { type: 'string', enum: ['create', 'fill', 'update'] },
            targets: {
              type: 'array',
              minItems: 1,
              maxItems: assetBatchSize,
              items: object(
                {
                  id: idSchema,
                  relatedSubjectIds: {
                    type: 'array',
                    maxItems: 12,
                    uniqueItems: true,
                    items: idSchema,
                    description:
                      '新主体关联的、已经存在的主体 ID；若作者要求与多个既有主体有关联按数量提供',
                  },
                  fields: object(
                    {
                      name: str(undefined, 500),
                      kind: { type: 'string', enum: ['character', 'item', 'scene'] },
                      title: str(undefined, 500),
                      subjectIds: { type: 'array', maxItems: 32, uniqueItems: true, items: idSchema },
                      setupChapterId: idSchema,
                      payoffChapterId: idSchema,
                    },
                    [],
                  ),
                },
                ['id'],
              ),
            },
            direction: str('简短创作安排，不是作者授权；可列出需结合的原文关键词', 16000),
          },
          ['kind', 'action', 'targets'],
        ),
        execute: async ({ kind, action, targets, direction }, ctx) =>
          this.generateAssets({ kind, action, targets }, direction, ctx),
      },
      {
        name: 'book_generate_chapter',
        description:
          '流式生成空白章、续写、明确重写或在旧章锚点只插入新段落。insert 是作者要求新增出场／场景时的局部能力，先读该章拿版本和唯一短原文；可一并传有版本的大纲章节增补。用 subjectIds / clueIds 指定内容依赖。若没有已写过渡且后章已有正文，提供 nextBoundary。整书只按序写空白章，replace 需本轮明确授权。',
        schema: object(
          {
            chapterId: idSchema,
            mode: { type: 'string', enum: ['draft', 'append', 'replace', 'insert'] },
            insertion: object(
              {
                revision: {
                  type: 'string',
                  pattern: '^[a-f0-9]{64}$',
                  description: 'book_get_context 读取该章取得的当前 revision',
                },
                quote: str('该章内只能出现一次的短原文，必须在同一正文段落内', 600),
                place: { type: 'string', enum: ['before', 'after'] },
                outline: object({
                  revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                  addition: str(
                    '只为该章或其情节点附加简短安排，可用真实主体／伏笔 Markdown 链接，不能替换全书大纲',
                    800,
                  ),
                }),
              },
              ['revision', 'quote', 'place'],
            ),
            direction: str(undefined, 16_000),
            subjectIds: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: idSchema,
              description: '本章明确需要的主体 ID',
            },
            clueIds: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: idSchema,
              description: '本章明确需要的伏笔 ID；用已有埋设／回收位置决定可见信息',
            },
            nextBoundary: object({
              chapterId: idSchema,
              conditions: {
                type: 'array',
                minItems: 1,
                maxItems: 6,
                items: object(
                  {
                    quote: str('后接已写章开场的短原文，后台核对，不送入本章正文请求', 300),
                    condition: str('不透露后续情节的必要衔接条件', 400),
                    conflict: { type: 'boolean', description: '该条件与本次安排明确冲突时设为 true' },
                  },
                  ['quote', 'condition'],
                ),
              },
            }),
          },
          ['chapterId', 'mode'],
        ),
        execute: async (
          { chapterId, mode, direction, subjectIds, clueIds, nextBoundary, insertion },
          ctx,
        ) =>
          this.generate(
            chapterId,
            mode,
            direction ?? '',
            { subjectIds, clueIds, nextBoundary, insertion },
            ctx,
          ),
      },
    ];
  }
}
