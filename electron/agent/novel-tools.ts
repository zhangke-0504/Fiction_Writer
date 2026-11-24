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
import {
  insertionAnchor,
  outlineInsertion,
  suggestInsertionPoints,
  type ChapterInsertion,
} from './chapter-insertion.js';
import { checkBookEditPlan, ConfirmedBookEdit } from './book-edit.js';
import {
  approvesEdit,
  assetTarget,
  confirmedEdit,
  continuesEdit,
  maxEditTargets,
  passageTarget,
  proposalOnly,
  readEditPlan,
  type EditPassage,
  type EditCommit,
  type InsertedScene,
} from './edit-proposal.js';
import { chapterAssetRequirements } from './chapter-context.js';
import {
  minimumExistingSubjects,
  passageTargetAllowed,
  chapterStage,
  wantsStagedAntagonist,
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
import { noteSyncTargets, syncStoryNote, type SceneStage } from './story-sync.js';
import { observedCommit } from './tool-receipts.js';
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
const editIdList = { type: 'array', maxItems: maxEditTargets, uniqueItems: true, items: idSchema };
const editPlanSchema = object({
  summary: str('简短、可展示的修改目的；不写正文或整份说明', 800),
  assets: {
    type: 'array',
    maxItems: maxEditTargets,
    items: object(
      {
        kind: { type: 'string', enum: ['subject', 'clue'] },
        action: { type: 'string', enum: ['create', 'fill', 'update'] },
        id: idSchema,
        relatedSubjectIds: editIdList,
        fields: object(
          {
            name: str(undefined, 160),
            kind: { type: 'string', enum: ['character', 'item', 'scene'] },
            title: str(undefined, 160),
            subjectIds: editIdList,
            setupChapterId: idSchema,
            payoffChapterId: str('计划回收的真实章节 ID，晚于埋设章，不必是反派登场章', 128),
          },
          [],
        ),
      },
      ['kind', 'action', 'id'],
    ),
  },
  passages: {
    type: 'array',
    maxItems: maxEditTargets,
    items: object(
      {
        id: str('本方案中不同的稳定位置 ID', 128),
        chapterId: idSchema,
        stage: {
          type: 'string',
          enum: ['setup', 'reveal', 'addition'],
          description: 'setup=埋设或迹象；reveal=实际登场或揭示，不代表伏笔已经回收；addition=其他增补',
        },
        note: str('本章读者能看到的简短安排；埋设段不写未来真相', 360),
        subjectIds: editIdList,
        clueIds: editIdList,
      },
      ['id', 'chapterId', 'stage', 'note'],
    ),
  },
});
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
function editWriteContext(ctx: RunContext) {
  const saved = new Map<string, string>();
  return {
    ctx: {
      ...ctx,
      diagnostic: ((event, fields) => {
        if (event === 'workspace.document.committed') {
          const row = observedCommit(fields);
          if (row?.operation === 'write' && row.revision) saved.set(docKey(row), row.revision);
        }
        ctx.diagnostic?.(event, fields);
      }) satisfies NonNullable<RunContext['diagnostic']>,
    },
    revisions(refs: readonly DocRef[]) {
      return Object.fromEntries(
        refs.map((ref) => {
          const key = docKey(ref);
          const rev = saved.get(key);
          if (!rev)
            throw new ToolFailure(
              'io_failure',
              `未取得 ${key} 的实际写入回执；先核对现稿，不重复写入。`,
            );
          return [key, rev];
        }),
      );
    },
  };
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
  private readonly directCommits: EditCommit[] = [];
  private readonly directPassages = new Map<
    string,
    { chapterId: string; stage: SceneStage; assets: string[] }
  >();
  private readonly inserted = new Map<
    string,
    { chapterId: string; revision?: string; outlineUpdated: boolean }
  >();
  private edit?: ConfirmedBookEdit;
  private editMode: 'direct' | 'proposal' | 'confirmed' | 'unresolved' = 'direct';
  private get stagedEntry() {
    return wantsStagedAntagonist(this.input.authorPrompt ?? '');
  }
  private get connectedEntry() {
    return (
      this.stagedEntry ||
      (minimumExistingSubjects(this.input.authorPrompt ?? '') > 0 &&
        /伏笔|线索/u.test(this.input.authorPrompt ?? ''))
    );
  }
  constructor(
    private workspace: WorkspaceService,
    private bookId: string,
    private provider: ModelProvider,
    private skills: SkillCatalog,
    private input: { authorPrompt?: string; selectedChapterId?: string } = {},
  ) {}
  prepareEdit(ctx: RunContext, documents: Manuscript[]) {
    const author = this.input.authorPrompt ?? '';
    const confirmed = confirmedEdit(ctx.bookEdit, ctx.history?.lines ?? [], author);
    if (proposalOnly(author)) this.editMode = 'proposal';
    else if (
      confirmed &&
      confirmed.proposal.bookId === this.bookId &&
      confirmed.proposal.sessionId === ctx.session.id
    ) {
      this.edit = new ConfirmedBookEdit(confirmed, documents);
      this.editMode = 'confirmed';
    } else if (approvesEdit(author) || (continuesEdit(author) && ctx.bookEdit && !ctx.continuation))
      this.editMode = 'unresolved';
    const progress = this.edit ? this.editProgress(documents) : undefined;
    const done = progress?.done ?? 0;
    if (this.editMode !== 'direct')
      ctx.diagnostic?.('writing.edit.scope', {
        editMode: this.editMode,
        count: progress?.total ?? 0,
        done,
      });
    if (this.edit && progress) {
      ctx.progress({
        step: '执行已确认方案',
        total: progress.total,
        done,
        complete: done === progress.total,
      });
      return `\n本轮承接同会话已确认方案（不是整书任务或全局权限）。活动范围：${JSON.stringify(this.edit.plan)}。未提交的目标：${JSON.stringify(this.edit.remaining(documents))}。已写入的不重做。资产调用按方案的 kind/action/id，fields 与关联由方案提供。按需读取正文和大纲当前修订，用 book_generate_chapter mode=insert、insertion.targetId 匹配方案位置，附本章唯一原文锚点和当前大纲 revision。每处成功后的大纲 revision 会更新；不要用通用覆盖。正文必须实际写入。已写正文相关的新资料用 book_generate_assets action=update 同步，只传资料类型和 ID。待同步：${JSON.stringify(this.syncStatus(documents))}。`;
    }
    if (this.editMode === 'proposal')
      return '\n作者本轮只问方案，不写入作品。用索引查真实主体和章节 ID，定向查目标章、已有设定和大纲后，用 book_propose_edits 登记一份范围完整的建议，最终可见方案会随回复给出。中期多个迹象和后期实际登场要分别列章；登场与伏笔计划回收可以是不同章。列出新资料、真实关联与章锚点，不要提前执行。';
    if (this.editMode === 'unresolved')
      return '\n本轮确认没有唯一可核对的同会话方案，不允许把它当全书写权限；请指出缺少的方案，不重复尝试生成。如需执行清楚的直接写作指令，不必先登记方案。';
    if (this.stagedEntry) {
      ctx.progress({ step: '执行关联增补', done: 0, total: 5, complete: false });
      ctx.diagnostic?.('writing.edit.scope', { editMode: 'direct', count: 5, done: 0 });
      return '\n作者已直接要求改稿，不要停在方案或再问确认。先用 book_generate_assets 保存一个新反派：顶层 kind="subject", action="create", targets:[{id:"新ID",fields:{name:"角色名",kind:"character"},relatedSubjectIds:["旧主体ID1","旧主体ID2"]}]；主体 fields 只填 name 和 kind，不填 title 或伏笔字段。接着用同工具保存关联伏笔；以章节索引的 entryChoices 为准，至少选两个中期章分别写迹象，再在一个后期章写反派本人登场。每处 book_generate_chapter mode=insert，都附唯一锚点及当时的大纲 revision 和只针对该章的短安排；每次成功后使用返回的新 outlineRevision。伏笔的回收章仅是计划，不等于登场章，不另改回收章；最后按 pendingSync 回执对本轮新建资料用 book_generate_assets action=update 同步，只传资料类型和 ID。全部完成再总结。禁止用通用工具或整章重写绕过。';
    }
    return this.connectedEntry
      ? '\n按插入回执的 pendingSync 用 book_generate_assets action=update 同步本轮新资料。'
      : '';
  }
  private requireEditAction() {
    if (this.editMode === 'proposal' || this.editMode === 'unresolved')
      throw new ToolFailure('invalid_options', '当前仅讨论或没有明确可承接的确认方案，不执行作品修改。');
  }
  private noteSyncAllowed(key: string) {
    const kind = key.startsWith('subject/') ? '主体|角色|人物|反派' : '伏笔|线索';
    const restriction = new RegExp(
      `(?:不要|别|禁止|不许|不必|无需|不)\\s*(?:再\\s*)?(?:同步|更新|修改|改写|改动|改|动)\\s*(?:这些|相关|本次新建的?|新建的?)?\\s*(?:资料|说明|资产|${kind})`,
      'u',
    );
    return !restriction.test((this.input.authorPrompt ?? '').normalize('NFKC'));
  }
  private syncTargets(documents: Manuscript[]) {
    const edit = this.edit;
    if (!edit) {
      return noteSyncTargets(
        this.directCommits,
        documents,
        new Set([...this.createdHere].filter((key) => this.noteSyncAllowed(key))),
        this.directPassages,
      );
    }
    const allowed = new Set(
      edit.plan.assets
        .filter((a) => a.action === 'create')
        .map(assetTarget)
        .filter((key) => this.noteSyncAllowed(key)),
    );
    const passages = new Map(
      edit.plan.passages.map((p) => [
        passageTarget(p),
        {
          chapterId: p.chapterId,
          stage: p.stage,
          assets: [
            ...(p.subjectIds?.map((id) => `subject/${id}`) ??
              [...allowed].filter((key) => key.startsWith('subject/'))),
            ...(p.clueIds?.map((id) => `clue/${id}`) ??
              [...allowed].filter((key) => key.startsWith('clue/'))),
          ],
        },
      ]),
    );
    return noteSyncTargets(edit.commits, documents, allowed, passages);
  }
  private syncStatus(documents: Manuscript[]) {
    return this.syncTargets(documents)
      .filter((t) => !t.synced)
      .map(({ key, passages, ready }) => ({ key, passages, ready }));
  }
  private reportPendingSync(documents: Manuscript[], ctx: RunContext) {
    for (const { key, passages, ready } of this.syncStatus(documents))
      ctx.diagnostic?.('writing.edit.sync', {
        documentRef: key,
        outcome: 'pending',
        reason: ready ? 'book_edit_incomplete' : 'conflict',
        count: passages.length,
      });
  }
  private editProgress(documents: Manuscript[]) {
    const sync = this.syncTargets(documents);
    const remaining = this.edit!.remaining(documents).concat(
      sync.filter((t) => !t.synced).map((t) => `待同步 ${t.key}`),
    );
    const total = this.edit!.total + sync.length;
    return { remaining, total, done: total - remaining.length };
  }
  private async publishEdit(ctx: RunContext) {
    if (!this.edit || ctx.signal.aborted) return;
    const { remaining, total, done } = this.editProgress(
      (await this.workspace.readAll(this.bookId)).documents,
    );
    ctx.progress({
      step: '执行已确认方案',
      total,
      done,
      complete: !remaining.length,
      message: remaining.length ? `尚待核对或提交：${remaining.join('、')}` : undefined,
    });
  }
  private async reconcileAssets(input: AssetInput, ctx: RunContext) {
    const documents = (await this.workspace.readAll(this.bookId)).documents;
    const targets = this.syncTargets(documents);
    const requested = input.targets.map(({ id }) =>
      targets.find((t) => t.key === `${input.kind}/${id}`),
    );
    if (input.targets.some(({ id }) => !this.noteSyncAllowed(`${input.kind}/${id}`)))
      throw new ToolFailure('invalid_options', '作者本轮限制更新这类资料。');
    if (!requested.some(Boolean)) return;
    if (
      requested.some((t) => !t) ||
      new Set(requested).size !== requested.length ||
      input.targets.some((t) => t.fields !== undefined || t.relatedSubjectIds !== undefined)
    )
      throw new ToolFailure('invalid_options', '资料同步批次只能包含本次增补关联的新资料 ID。');
    const assets = [];
    for (const target of requested) {
      const t = target!;
      try {
        const saved = await syncStoryNote(this.workspace, this.bookId, ctx, this.provider, t);
        if (!saved.reused) {
          const commit: EditCommit = {
            target: t.key,
            revisions: { [t.key]: saved.revision },
            synced: t.revisions,
          };
          if (this.edit) await this.edit.record(ctx, commit);
          else this.directCommits.push(commit);
        }
        ctx.diagnostic?.('writing.edit.sync', {
          documentRef: t.key,
          outcome: saved.reused ? 'reused' : 'ok',
          count: t.passages.length,
        });
        assets.push(saved);
      } catch (error) {
        ctx.diagnostic?.('writing.edit.sync', {
          documentRef: t.key,
          outcome: 'failed',
          reason: classified(error, ctx.signal),
          count: t.passages.length,
        });
        throw error;
      }
    }
    await this.publishEdit(ctx);
    return {
      assets,
      pendingSync: this.syncStatus((await this.workspace.readAll(this.bookId)).documents),
    };
  }
  skillApplied(name: SkillName) {
    if (this.editMode !== 'direct' || this.stagedEntry) return;
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
    if (this.editMode === 'proposal' || this.editMode === 'unresolved') return;
    if (this.edit) {
      const { documents } = await this.workspace.readAll(this.bookId);
      const { remaining, total, done } = this.editProgress(documents);
      this.reportPendingSync(documents, ctx);
      ctx.progress({
        step: '执行已确认方案',
        total,
        done,
        complete: !remaining.length,
        message: remaining.length ? `尚待核对或提交：${remaining.join('、')}` : undefined,
      });
      ctx.diagnostic?.('writing.edit.scope', {
        editMode: 'confirmed',
        outcome: remaining.length ? 'partial' : 'ok',
        count: total,
        done,
        reason: remaining.length ? 'book_edit_incomplete' : undefined,
      });
      if (remaining.length) {
        throw new DiagnosticFailure(
          'book_edit_incomplete',
          `方案未全部提交（${done}/${total}）：${remaining.join('、')}。已保存的内容保留，可在同一会话继续。`,
        );
      }
      return;
    }
    if (this.stagedEntry) {
      const { documents } = await this.workspace.readAll(this.bookId);
      const { chapters, setups, clues } = this.stagedProgress(documents);
      const actor = documents.find((doc) => doc.type === 'subject' && this.createdHere.has(docKey(doc)));
      const reveal = chapters.find(
        (chapter) => chapterStage(chapters, chapter.id) === 'reveal' && this.committedEntry(chapter),
      );
      const missingSetups = [...new Set(clues.map((doc) => doc.fields.setupChapterId!))].filter(
        (id) => !setups.includes(id),
      );
      const missing = [
        !actor && '新反派说明',
        !clues.length && '关联伏笔说明',
        setups.length < 2 && `中期迹象及对应大纲（已保存 ${setups.length}/2 章）`,
        missingSetups.length && `伏笔埋设章 ${missingSetups.join('、')}`,
        !reveal && '后期登场及对应大纲',
      ].filter(Boolean);
      const sync = this.syncTargets(documents);
      const pending = sync.filter((t) => !t.synced).map((t) => `待同步 ${t.key}`);
      missing.push(...pending);
      this.reportPendingSync(documents, ctx);
      const total = 5 + sync.length;
      const done =
        sync.length -
        pending.length +
        Number(!!actor) +
        Number(!!clues.length && !missingSetups.length) +
        Math.min(2, setups.length) +
        Number(!!reveal);
      ctx.progress({
        step: '执行关联增补',
        total,
        done,
        complete: !missing.length,
        message: missing.length ? missing.join('；') : undefined,
      });
      ctx.diagnostic?.('writing.edit.scope', {
        editMode: 'direct',
        outcome: missing.length ? 'partial' : 'ok',
        count: total,
        done,
        reason: missing.length ? 'book_edit_incomplete' : undefined,
      });
      if (missing.length)
        throw new DiagnosticFailure(
          'book_edit_incomplete',
          `关联增补未全部提交：${missing.join('；')}。已保存的内容保留。`,
        );
    }
    if (this.connectedEntry && ![...this.inserted.values()].some((item) => item.outlineUpdated))
      throw new DiagnosticFailure(
        'context_required',
        '关联增补未完成：还没有一处经核对的登场正文及对应大纲提交。已保存的资料保留。',
      );
    if (this.connectedEntry && !this.stagedEntry) {
      const documents = (await this.workspace.readAll(this.bookId)).documents;
      const pending = this.syncStatus(documents);
      this.reportPendingSync(documents, ctx);
      if (pending.length)
        throw new DiagnosticFailure(
          'book_edit_incomplete',
          `关联增补还有待同步资料：${pending.map((t) => t.key).join('、')}。`,
        );
    }
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
    if (args.novelGoal && (this.editMode !== 'direct' || this.stagedEntry))
      throw new ToolFailure('invalid_options', '本轮不是整书请求，不登记或续接整书目标。');
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
    this.requireEditAction();
    if (this.edit)
      throw new ToolFailure(
        'invalid_options',
        '已确认的局部方案使用资产工具和逐章 insert；不能用通用工具扩大写入范围。',
      );
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
  private writingIntent(arrangement?: string, confirmed?: string): WritingIntent {
    return {
      author: this.input.authorPrompt,
      continued: this.inheritedDirections,
      confirmed,
      arrangement,
    };
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
          ...(this.stagedEntry ? { stage: chapterStage(chapters, doc.id) } : {}),
        })),
      note: this.stagedEntry
        ? 'setup 候选仅写中期迹象；reveal 候选仅用于后期实际登场。新伏笔选择实际写入的 setup 章，payoff 只是计划。'
        : '可从候选选一章；伏笔 setupChapterId 与登场章相同，另填一个真实的计划 payoffChapterId（不用改回收章）。锚点是建议，也可定向读取现稿换一处。',
    };
  }
  private async generateAssets(input: AssetInput, arrangement: string | undefined, ctx: RunContext) {
    if (ctx.session.bookId !== this.bookId)
      throw new ToolFailure('invalid_options', '生成资料必须使用本次会话绑定的作品。');
    this.requireEditAction();
    if (input.action === 'update' && (this.edit || this.connectedEntry)) {
      const synced = await this.reconcileAssets(input, ctx);
      if (synced) return synced;
    }
    if (this.edit) {
      const edit = this.edit;
      const scope = edit.assets(input, (await this.workspace.readAll(this.bookId)).documents);
      if (!scope.pending.length) return { assets: scope.reused, reused: true };
      const write = editWriteContext(ctx);
      const save = async (refs: readonly DocRef[]) => {
        for (const item of scope.pending.filter((item) =>
          refs.some((ref) => docKey(ref) === assetTarget(item)),
        )) {
          const key = assetTarget(item);
          await edit.record(ctx, {
            target: key,
            revisions: write.revisions([{ type: item.kind, id: item.id }]),
          });
        }
        await this.publishEdit(ctx);
      };
      let result: Awaited<ReturnType<typeof generateStoryAssets>>;
      try {
        result = await generateStoryAssets(
          this.workspace,
          write.ctx,
          this.provider,
          {
            ...input,
            targets: scope.pending.map(({ id, fields, relatedSubjectIds }) => ({
              id,
              fields,
              relatedSubjectIds,
            })),
          },
          this.writingIntent(
            arrangement,
            `${edit.plan.summary}\n本次仅处理：${scope.pending.map(assetTarget).join('、')}`,
          ),
          false,
          undefined,
          true,
        );
      } catch (error) {
        const partial =
          error instanceof ToolFailure && (error.value as Partial<WriteReport> | undefined);
        if (partial && Array.isArray(partial.committed) && partial.committed.length)
          await save(partial.committed);
        if (error instanceof WritingContextFailure)
          throw new ToolFailure(error.diagnosticReason, error.message, writingIssueDetails(error));
        throw error;
      }
      await save(result.assets);
      return { assets: [...scope.reused, ...result.assets] };
    }
    const target = this.requireGoal();
    if (this.stagedEntry && input.action !== 'create')
      throw new ToolFailure('invalid_options', '本轮只新建反派及伏笔，不修改既有资料。');
    if (
      this.stagedEntry &&
      input.kind === 'subject' &&
      (input.targets.length !== 1 || input.targets[0].fields?.kind !== 'character')
    )
      throw new ToolFailure(
        'invalid_arguments',
        '请调用 kind="subject", action="create"，targets 只放一个反派：{id, fields:{name, kind:"character"}, relatedSubjectIds:[已有主体ID,...]}。主体 fields 内不要填 title。',
      );
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
            (this.stagedEntry && chapterStage(chapters, fields.setupChapterId) !== 'setup') ||
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
    const scopedWrite =
      this.connectedEntry && input.action === 'create' ? editWriteContext(ctx) : undefined;
    const recordCreation = (ref: DocRef, revision: string) => {
      const key = docKey(ref);
      this.createdHere.add(key);
      if (scopedWrite) this.directCommits.push({ target: key, revisions: { [key]: revision } });
    };
    const checkpoint = async () => {
      if (!this.task || ctx.signal.aborted) return;
      const check = this.check(await this.workspace.readAll(this.bookId));
      this.publish(check, ctx);
      await this.saveGoal(ctx, check);
    };
    try {
      const result = await generateStoryAssets(
        this.workspace,
        scopedWrite?.ctx ?? ctx,
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
        for (const saved of result.assets) recordCreation(saved, saved.revision);
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
            ...this.entryChoices(documents, this.stagedEntry ? undefined : chapters),
            subjectIds: actor ? [actor.id] : [],
            clueIds: linked.map(({ id }) => id),
            next: this.stagedEntry
              ? '先分别 insert 至少两个中期迹象，再在后期候选中选一章实际登场。每处附本章短大纲；成功后使用返回的新大纲 revision。'
              : '可用 book_generate_chapter mode=insert：选同一个埋设章及一个 insertion 锚点，附 outline:{revision:outlineRevision,addition:只写本章登场与埋设的简短安排}。无需重新扫描全书。',
          },
        };
      }
      return result;
    } catch (error) {
      const partial =
        error instanceof ToolFailure ? (error.value as Partial<WriteReport> | undefined) : undefined;
      if (scopedWrite && partial?.committed?.length) {
        const revisions = scopedWrite.revisions(partial.committed);
        for (const ref of partial.committed) recordCreation(ref, revisions[docKey(ref)]);
      }
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
  private committedEntry(chapter: Manuscript) {
    const saved = this.inserted.get(chapter.id);
    return saved?.outlineUpdated && saved.revision === chapter.revision;
  }
  private stagedProgress(documents: Manuscript[]) {
    const chapters = documents.filter(({ type }) => type === 'chapter');
    const setups = chapters
      .filter(
        (chapter) => chapterStage(chapters, chapter.id) === 'setup' && this.committedEntry(chapter),
      )
      .map(({ id }) => id);
    const clues = documents.filter((doc) => doc.type === 'clue' && this.createdHere.has(docKey(doc)));
    return { chapters, setups, clues };
  }
  private entryPlan(
    documents: Manuscript[],
    chapterId: string,
    plan: ChapterPlan & { insertion?: ChapterInsertion },
  ) {
    const inBook = documents.filter((doc) => this.createdHere.has(docKey(doc)));
    const actor = inBook.find(({ type }) => type === 'subject');
    const { chapters, setups, clues } = this.stagedProgress(documents);
    const stage = this.stagedEntry ? chapterStage(chapters, chapterId) : undefined;
    const order = (id?: string) => chapters.find((chapter) => chapter.id === id)?.fields.order ?? -1;
    if (
      stage === 'reveal' &&
      (setups.length < 2 || clues.some((clue) => !setups.includes(clue.fields.setupChapterId!)))
    )
      throw new ToolFailure(
        'context_required',
        '先保存至少两个不同中期章的迹象和大纲，并完成新伏笔的埋设，再写后期登场。',
        { setups },
      );
    const admitted = inBook.filter(
      (doc) =>
        doc.type === 'clue' &&
        (doc.fields.setupChapterId === chapterId ||
          (stage &&
            setups.includes(doc.fields.setupChapterId!) &&
            order(doc.fields.setupChapterId) < order(chapterId))) &&
        doc.fields.subjectIds?.includes(actor?.id ?? '') &&
        documents.some(
          (chapter) => chapter.type === 'chapter' && chapter.id === doc.fields.payoffChapterId,
        ),
    );
    if (!actor || !admitted.length || !plan.insertion?.outline)
      throw new ToolFailure(
        'context_required',
        stage
          ? '先用资产工具保存关联反派和伏笔。中期迹象必须埋设或承接一个已提交的较早埋设；每处应附上当前版本的大纲增补。'
          : '本轮要求新反派及其伏笔实际登场。先保存其关联说明和绑定同一埋设章的伏笔，再对该章 insert 并附上当前版本的大纲增补。',
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
    this.requireEditAction();
    const edit = this.edit;
    if (edit && mode !== 'insert')
      throw new ToolFailure(
        'insert_not_authorized',
        '已确认的方案是局部增补，不授权新章、续写或整章覆盖。',
      );
    const target = this.requireGoal();
    let editPassage: EditPassage | undefined;
    let entryStage: 'setup' | 'reveal' | undefined;
    let anchorKey: string | undefined;
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
      if (!edit && this.connectedEntry && !this.stagedEntry && this.inserted.size)
        throw new ToolFailure(
          'conflict',
          '本轮的局部增补已经提交，不在其他章重复插入。',
          [...this.inserted.values()][0],
        );
      const { documents } = await this.workspace.readAll(this.bookId);
      if (edit) {
        edit.verifyPlacement(documents);
        editPassage = edit.passage(chapterId, plan.insertion?.targetId);
        const key = passageTarget(editPassage);
        edit.verifySharedDocuments(documents, [`chapter/${chapterId}`, 'outline/outline']);
        const saved = edit.verifyRecorded(documents, key);
        const outline = documents.find((d) => d.type === 'outline');
        const chapter = documents.find((doc) => doc.type === 'chapter' && doc.id === chapterId);
        if (saved[`chapter/${chapterId}`] && saved['outline/outline'])
          return {
            chapterId,
            revision: chapter?.revision,
            outlineRevision: outline?.revision,
            inserted: true,
            outlineUpdated: true,
            reused: true,
            pendingSync: this.syncStatus(documents),
          };
        if (!plan.insertion?.outline || !outline || !chapter)
          throw new ToolFailure(
            'context_required',
            '该处增补需要目标章和大纲的当前版本，以及本章的短大纲增补。',
            { chapterId },
          );
        const links = edit.linked(editPassage, documents);
        const update = edit.outline(editPassage, plan.insertion.outline, documents);
        if (saved[`chapter/${chapterId}`]) {
          const next = outlineInsertion(outline, chapter, update);
          const write = editWriteContext(ctx);
          const report = await this.workspace.writeChanges(
            this.bookId,
            [{ ...outline, expect: outline.revision, body: next }],
            ctx.signal,
            [chapter],
            write.ctx.diagnostic,
          );
          if (report.error) throw new ToolFailure(report.reason ?? 'unknown', report.error, report);
          const revisions = write.revisions(report.committed);
          await edit.record(ctx, { target: key, revisions, anchor: edit.anchorFor(key)! });
          await this.publishEdit(ctx);
          return {
            chapterId,
            revision: chapter.revision,
            outlineRevision: revisions['outline/outline'],
            inserted: true,
            outlineUpdated: true,
            reused: true,
            pendingSync: this.syncStatus((await this.workspace.readAll(this.bookId)).documents),
          };
        }
        try {
          anchorKey = insertionAnchor(chapter, plan.insertion).key;
        } catch (error) {
          if (error instanceof WritingContextFailure)
            throw new ToolFailure(error.diagnosticReason, error.message, writingIssueDetails(error));
          throw error;
        }
        if (edit.getAnchors().includes(anchorKey))
          throw new ToolFailure(
            'conflict',
            '此章同一锚点侧已有提交，请为另一个目的选择不同的合法位置。',
            { chapterId },
          );
        plan = { ...plan, ...links, insertion: { ...plan.insertion, outline: update } };
      } else if (
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
      else {
        if (this.stagedEntry) {
          const chapters = documents.filter((doc) => doc.type === 'chapter');
          entryStage = chapterStage(chapters, chapterId);
          if (
            this.inserted.has(chapterId) ||
            (entryStage === 'reveal' &&
              chapters.some(
                (chapter) =>
                  chapterStage(chapters, chapter.id) === 'reveal' && this.inserted.has(chapter.id),
              ))
          )
            throw new ToolFailure('conflict', '此章或后期登场已经提交（可能部分提交），不要重复插入。', {
              chapterId,
            });
        }
        if (this.connectedEntry) plan = this.entryPlan(documents, chapterId, plan);
        if (plan.insertion) {
          const chapter = documents.find((d) => d.type === 'chapter' && d.id === chapterId);
          if (chapter && chapter.revision === plan.insertion.revision) {
            try {
              anchorKey = insertionAnchor(chapter, plan.insertion).key;
            } catch (error) {
              if (error instanceof WritingContextFailure)
                throw new ToolFailure(error.diagnosticReason, error.message, writingIssueDetails(error));
              throw error;
            }
          }
        }
        if (anchorKey && this.inserted.has(anchorKey))
          throw new ToolFailure(
            'conflict',
            '本轮的局部增补已经提交，不重复插入同一处。',
            this.inserted.get(anchorKey),
          );
        if (!anchorKey && this.inserted.has(chapterId))
          throw new ToolFailure(
            'conflict',
            '本轮的局部增补已经提交，请核对该章新版本。',
            this.inserted.get(chapterId),
          );
      }
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
    const write = edit || this.connectedEntry ? editWriteContext(ctx) : undefined;
    const chapterKey = `chapter/${chapterId}`;
    const created = edit
      ? new Set(edit.plan.assets.filter((a) => a.action === 'create').map(assetTarget))
      : this.createdHere;
    const sceneAssets = [
      ...new Set([
        ...(plan.subjectIds ?? []).map((id) => `subject/${id}`),
        ...(plan.clueIds ?? []).map((id) => `clue/${id}`),
      ]),
    ].filter((key) => created.has(key));
    const sceneTarget = editPassage ? passageTarget(editPassage) : `passage/${anchorKey ?? chapterId}`;
    const recordScene = async (revisions: Record<string, string>, scene?: InsertedScene) => {
      const body = scene && sceneAssets.length ? { ...scene, assets: sceneAssets } : undefined;
      if (edit && editPassage) {
        await edit.record(ctx, { target: sceneTarget, anchor: anchorKey, revisions, scene: body });
      } else if (this.connectedEntry && body) {
        this.directPassages.set(sceneTarget, {
          chapterId,
          stage: entryStage ?? 'addition',
          assets: sceneAssets,
        });
        this.directCommits.push({ target: sceneTarget, revisions, scene: body });
      }
    };
    let scene: InsertedScene | undefined;
    try {
      const saved = await draftChapter(
        this.workspace,
        write?.ctx ?? ctx,
        this.provider,
        chapterId,
        mode,
        this.writingIntent(
          direction,
          editPassage?.note ??
            (entryStage === 'setup'
              ? '此处只在正文留下可观察的迹象；反派不得本人出场或被揭示身份，不提前回收伏笔。'
              : entryStage === 'reveal'
                ? '此处要在正文写出反派本人实际登场；回收仅限本章允许披露的伏笔，不把未来计划写成既成事实。'
                : undefined),
        ),
        {
          plan,
          insertion: plan.insertion,
          expectedPlacement,
          skill: await this.skills.load('write-chapter', ctx.diagnostic),
          guard: guards,
          retryIncomplete: true,
          maxTokens: target ? this.provider.extendedOutputTokens : undefined,
          directProse: !!target || mode === 'insert',
          captureInsertion: sceneAssets.length
            ? (value) => {
                scene = value;
              }
            : undefined,
          whole: !!target,
        },
      );
      this.remember(saved);
      let outlineRevision: string | undefined;
      if (mode === 'insert') {
        const state = { chapterId, revision: saved.revision, outlineUpdated: !!plan.insertion?.outline };
        this.inserted.set(anchorKey ?? chapterId, state);
        if (!edit) this.inserted.set(chapterId, state);
        if (plan.insertion?.outline)
          outlineRevision = write
            ? write.revisions([{ type: 'outline', id: 'outline' }])['outline/outline']
            : (await this.workspace.readDocument(this.bookId, { type: 'outline', id: 'outline' }))
                .revision;
        if (write) {
          await recordScene(
            write.revisions([
              { type: 'chapter', id: chapterId },
              { type: 'outline', id: 'outline' },
            ]),
            scene,
          );
          await this.publishEdit(ctx);
        }
      }
      if (target && !ctx.signal.aborted) {
        if (this.task?.failedChapterId === chapterId) this.task.failedChapterId = undefined;
        const check = this.check(await this.workspace.readAll(this.bookId));
        this.publish(check, ctx);
        await this.saveGoal(ctx, check);
      }
      return {
        chapterId,
        revision: saved.revision,
        ...(mode === 'insert' && {
          inserted: true,
          outlineUpdated: !!plan.insertion?.outline,
          outlineRevision,
          ...((edit || this.connectedEntry) && {
            pendingSync: this.syncStatus((await this.workspace.readAll(this.bookId)).documents),
          }),
        }),
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
      ) {
        const state = {
          chapterId,
          outlineUpdated: partial.committed.some(({ type }) => type === 'outline'),
        };
        this.inserted.set(anchorKey ?? chapterId, state);
        if (!edit) this.inserted.set(chapterId, state);
        if (write) {
          const revisions = write.revisions(partial.committed);
          if (revisions[chapterKey])
            await recordScene(revisions, error instanceof DraftCommitFailure ? error.scene : undefined);
          await this.publishEdit(ctx);
        }
      }
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
    const proposalTool: LocalTool = {
      name: 'book_propose_edits',
      description:
        '作者只问修改方案时保存用于后续确认的范围，不修改作品。assets 和 passages 分列，按真实 ID 和章节位置说明；先查索引。创建主体字段 name/kind，可在同级写 relatedSubjectIds；新伏笔在 fields 里写 title/subjectIds/setupChapterId/payoffChapterId。不同中期迹象用不同位置、后期实际登场用 stage=reveal；payoffChapterId 是计划回收，允许与登场分章。',
      schema: editPlanSchema,
      execute: async (args, ctx) => {
        if (!ctx.stageEditProposal || this.editMode !== 'proposal' || ctx.session.bookId !== this.bookId)
          throw new ToolFailure('invalid_options', '只有作者明确询问绑定作品的方案时才可登记建议。');
        const plan = readEditPlan(args);
        if (!plan) throw new ToolFailure('invalid_arguments', '方案须包含有界的资产或位置及简要安排。');
        const { documents } = await this.workspace.readAll(this.bookId);
        checkBookEditPlan(plan, documents, this.input.authorPrompt ?? '');
        const keys = new Set(plan.assets.filter((a) => a.action !== 'create').map(assetTarget));
        ctx.stageEditProposal(plan, {
          placement: chapterPlacementFingerprint(documents),
          existingAssets: Object.fromEntries(
            documents.filter((d) => keys.has(docKey(d))).map((d) => [docKey(d), d.revision]),
          ),
        });
        ctx.diagnostic?.('writing.edit.scope', {
          editMode: 'proposal',
          outcome: 'ok',
          count: plan.assets.length + plan.passages.length,
        });
        return {
          staged: true,
          assetCount: plan.assets.length,
          passageCount: plan.passages.length,
          note: '方案会随本轮回复展示，作品尚未修改。不要调用写入工具。',
        };
      },
    };
    return [
      ...(this.editMode === 'proposal' ? [proposalTool] : []),
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
          '生成或补齐一小批同类主体／伏笔的 Markdown 说明，适用于整书和单独任务。create 的新主体使用 targets:[{id, fields:{name,kind}, relatedSubjectIds}]，新伏笔使用 targets:[{id, fields:{title,subjectIds,setupChapterId,payoffChapterId}}]；不要混用两类 fields。fill 只补空或占位。关联增补后的 pendingSync 用 update，只传相应 ID，按实际片段同步。普通 update 需要明确授权指定已有资料。已有字段在 fill/update 时保留。用真实章节和主体 ID，不在参数里写说明正文。',
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
                      name: str('仅新主体：名称', 500),
                      kind: {
                        type: 'string',
                        enum: ['character', 'item', 'scene'],
                        description: '仅新主体：人物用 character',
                      },
                      title: str('仅新伏笔：名称，主体不用 title', 500),
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
                targetId: str('承接明确方案时用对应位置 ID；直接单章请求不传', 128),
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
