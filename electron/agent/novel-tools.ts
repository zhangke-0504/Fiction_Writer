import { randomUUID } from 'node:crypto';
import { classified, DiagnosticFailure } from '../diagnostics/trace.js';
import type {
  Change,
  DocRef,
  Fields,
  LocalWritingProgress,
  Manuscript,
  ToolResult,
  WriteReport,
} from '../../shared/contracts.js';
import type { WorkspaceService, Guard } from '../workspace.js';
import {
  chapterPlacementFingerprint,
  digest,
  docKey,
  isId,
  renderDocument,
  storyLinks,
} from '../documents.js';
import { draftChapter, DraftCommitFailure, InsertionQualityFailure } from './draft.js';
import type { ChapterPlan } from './chapter-boundary.js';
import {
  insertionAnchor,
  insertPassage,
  safeInsertionEchoCut,
  outlineInsertion,
  type ChapterInsertion,
} from './chapter-insertion.js';
import { checkBookEditPlan, ConfirmedBookEdit } from './book-edit.js';
import { assetPatchFields, patchAssetDescription, type AssetPatch } from './asset-patch.js';
import type { BookTaskScope, ScopeOperation } from './task-scope.js';
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
import {
  exactRange,
  expandParagraphGap,
  patchBody,
  patchEntryLimit,
  patchFragmentLimit,
  reviewProsePatch,
  type ParagraphGapEdit,
  type PatchEvidence,
  type ProseEdit,
} from './chapter-patch.js';
import { chapterAssetRequirements } from './chapter-context.js';
import {
  blocksProsePatch,
  prosePatchIntent,
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
import {
  defaultRoundLimit,
  object,
  str,
  ToolFailure,
  type LocalTool,
  type NarrowedWritingStep,
} from './loop.js';
import { hasStoryDescription } from './story-notes.js';
import { type DocumentPage, type ReadDocument } from './tool-context.js';
import {
  bookContextDescription,
  bookContextDiscovery,
  bookContextProperties,
  bookDocumentIdSchema as idSchema,
  bookIndexReadKey,
  bookRevisionSchema as revisionSchema,
  bookSearchTool,
  readBookContext,
  type BookContextArgs,
  type ReferenceIndex,
} from './book-read-tools.js';
import type { ModelProvider } from './model.js';
import type { SkillCatalog, SkillName } from './skills.js';
import type { RunContext } from './runs.js';
import {
  noteSyncTargets,
  preservesSyncEvidence,
  sceneText,
  syncStoryNote,
  type SceneStage,
  type NoteSyncTarget,
} from './story-sync.js';
import { observedCommit } from './tool-receipts.js';
import { diagnosticScope, noDiagnostic } from '../../shared/diagnostics.js';
import {
  goalProblem,
  inspectNovelGoal,
  maxGoalAssets,
  maxGoalChapters,
  sameChapterIds,
  validChapterIds,
  validGoalAssets,
  type GoalAsset,
  type NovelCheck,
  type NovelTaskState,
} from './novel-goal.js';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const activeTypes = ['outline', 'subject', 'clue', 'chapter'] as const;
type CurrentInsertion = {
  runId: string;
  sessionId: string;
  chapterId: string;
  revision: string;
  anchor: string;
  insertion: ChapterInsertion;
  commit: EditCommit;
  consumed?: boolean;
};
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
const patchPart = str('如已登记同章子目标，填对应 part。删除与补入各用自己的 part。', 64);
const paragraphQuote = (description: string) => ({
  ...str(description, patchFragmentLimit),
  pattern: '^[^\\r\\n\\u2028\\u2029]*\\S[^\\r\\n\\u2028\\u2029]*$',
});

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

type BookReads = {
  readSet: Map<string, Guard>;
  sourceReads: Map<string, { revision: string; ranges: [number, number][] }>;
  offsets: Map<string, { revision: string; next: number }>;
  targetedReads: Set<string>;
};

/** The per-run read set prevents edits based on stale story data. It is never persisted as story content. */
export class NovelTools {
  private wholeGuideDelivered = false;
  private task?: NovelTaskState;
  private goalActivationFailure?: ToolFailure;
  private inheritedDirections: string[] = [];
  private get target() {
    return this.task?.chapterIds;
  }
  private readonly referenceFailures = new Map<string, number>();
  private readonly chapterFailures = new Map<string, ToolFailure>();
  private readonly insertionFailures = new Map<string, ToolFailure>();
  private readonly currentInsertions = new Map<string, CurrentInsertion>();
  private readonly reads: BookReads = {
    readSet: new Map(),
    sourceReads: new Map(),
    offsets: new Map(),
    targetedReads: new Set(),
  };
  private populatedAtStart?: Set<string>;
  private readonly draftedHere = new Map<string, string>();
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
  constructor(
    private workspace: WorkspaceService,
    private bookId: string,
    private provider: ModelProvider,
    private skills: SkillCatalog,
    private input: { authorPrompt?: string; selectedChapterId?: string; scope?: BookTaskScope } = {},
  ) {}
  captureStart(documents: Manuscript[]) {
    this.populatedAtStart ??= new Set(
      documents.filter((d) => d.type === 'chapter' && d.body.trim()).map((d) => d.id),
    );
  }
  /** Compatibility entry for legacy fixtures; real sessions use captureStart and BookTaskScope. */
  prepareEdit(ctx: RunContext, documents: Manuscript[]) {
    this.captureStart(documents);
    if (this.input.scope) return '';
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
      return `\n本轮承接同会话已确认方案（不是整书任务或全局权限）。活动范围：${JSON.stringify(this.edit.plan)}。未提交的目标：${JSON.stringify(this.edit.remaining(documents))}。已写入的不重做。资产调用按方案的 kind/action/id，fields 与关联由方案提供。按需读取正文和大纲当前修订，用 book_generate_chapter mode=insert、insertion.targetId 匹配方案位置，附本章唯一原文锚点和当前大纲 revision。每处成功后的大纲 revision 会更新；不要用通用覆盖。正文必须实际写入；该 Run 新段若仍有边界回声，用其成功插入回执请求 book_clean_insert_echo，拒绝时报告，不扩大授权。已写正文相关的新资料用 book_generate_assets action=update 同步，只传资料类型和 ID。待同步：${JSON.stringify(this.syncStatus(this.syncTargets(documents), ctx))}。`;
    }
    if (this.editMode === 'proposal')
      return '\n作者本轮只问方案，不写入作品。用索引查真实主体和章节 ID，定向查目标章、已有设定和大纲后，用 book_propose_edits 登记一份范围完整的建议，最终可见方案会随回复给出。中期多个迹象和后期实际登场要分别列章；登场与伏笔计划回收可以是不同章。列出新资料、真实关联与章锚点，不要提前执行。';
    if (this.editMode === 'unresolved')
      return '\n本轮确认没有唯一可核对的同会话方案，不允许把它当全书写权限；请指出缺少的方案，不重复尝试生成。如需执行清楚的直接写作指令，不必先登记方案。';
    return '';
  }
  private requireEditAction() {
    if (this.editMode === 'proposal' || this.editMode === 'unresolved')
      throw new ToolFailure('invalid_options', '当前仅讨论或没有明确可承接的确认方案，不执行作品修改。');
  }
  private noteSyncAllowed(key: string) {
    if (this.input.scope) return true; // Individual updates still require a scope; surface evidence-based pending work.
    const kind = key.startsWith('subject/') ? '主体|角色|人物|反派' : '伏笔|线索';
    const restriction = new RegExp(
      `(?:不要|别|禁止|不许|不必|无需|不)\\s*(?:再\\s*)?(?:同步|更新|修改|改写|改动|改|动)\\s*(?:这些|相关|本次新建的?|新建的?)?\\s*(?:资料|说明|资产|${kind})`,
      'u',
    );
    return !restriction.test((this.input.authorPrompt ?? '').normalize('NFKC'));
  }
  private syncTargets(
    documents: Manuscript[],
    history?: readonly EditCommit[],
    includeRestricted = false,
  ) {
    const allows = (key: string) => includeRestricted || this.noteSyncAllowed(key);
    const edit = this.edit;
    if (!edit) {
      return noteSyncTargets(
        history ?? this.directCommits,
        documents,
        new Set([...this.createdHere].filter(allows)),
        this.directPassages,
      );
    }
    const allowed = new Set(
      edit.plan.assets
        .filter((a) => a.action === 'create')
        .map(assetTarget)
        .filter(allows),
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
    return noteSyncTargets(history ?? edit.commits, documents, allowed, passages);
  }
  scopeSyncTargets = (documents: Manuscript[]) => this.syncTargets(documents, undefined, true);

  private syncStatus(targets: readonly NoteSyncTarget[], ctx: RunContext) {
    return targets
      .filter(({ synced }) => !synced)
      .map((target) => {
        const { key, passages, ready, document } = target;
        const type = document?.type;
        const scope = this.input.scope;
        const operation: 'subject.sync' | 'clue.sync' = key.startsWith('subject/')
          ? 'subject.sync'
          : 'clue.sync';
        const canSync =
          !scope ||
          (document &&
            (type === 'subject' || type === 'clue') &&
            scope.assetUpdateRoute(type, document.id, ctx, target) === 'sync');
        return {
          key,
          passages,
          ready,
          operation,
          next: !ready ? 'conflict' : canSync ? 'book_generate_assets(update)' : 'book_task_scope',
        };
      });
  }
  private reportPendingSync(documents: Manuscript[], ctx: RunContext) {
    for (const { key, passages, ready } of this.syncStatus(this.syncTargets(documents), ctx))
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
  private async reconcileAssets(
    input: AssetInput,
    ctx: RunContext,
    currentTargets?: readonly NoteSyncTarget[],
  ) {
    const targets =
      currentTargets ?? this.syncTargets((await this.workspace.readAll(this.bookId)).documents);
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
    const patchBases = new Map<string, { document: Manuscript; revision: string }>();
    for (const target of requested) {
      const t = target!;
      try {
        const write = editWriteContext(ctx);
        const saved = await syncStoryNote(this.workspace, this.bookId, write.ctx, this.provider, t);
        if (!saved.reused) {
          const revision = write.revisions([saved])[t.key];
          saved.revision = revision;
          if (t.document) patchBases.set(t.key, { document: t.document, revision });
          const commit: EditCommit = {
            target: t.key,
            revisions: { [t.key]: revision },
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
    const documents = (await this.workspace.readAll(this.bookId)).documents;
    for (const document of documents) {
      const base = patchBases.get(docKey(document));
      if (base?.revision === document.revision)
        this.input.scope?.preserveAssetPatch(base.document, document);
    }
    await this.publishEdit(ctx);
    return { assets, pendingSync: this.syncStatus(this.syncTargets(documents), ctx) };
  }
  qualifiesForWholeGuideBudget = () => this.editMode === 'direct' && this.wholeWork;
  skillApplied(name: SkillName) {
    if (name === 'generate-novel') this.wholeGuideDelivered = true;
  }
  // For manual acceptance, the per-run cap is uniform regardless of goal size.
  roundLimit = () => defaultRoundLimit;
  budgetPurpose = () =>
    this.wholeGuideDelivered && this.qualifiesForWholeGuideBudget()
      ? ('long-writing' as const)
      : undefined;
  /** Recovery uses current targets and receipts, never the truncated model output. */
  narrowedWritingStep = async (
    ctx: RunContext,
    prospective: readonly ToolResult[] = [],
  ): Promise<NarrowedWritingStep | undefined> => {
    const edit = this.editMode === 'confirmed' && this.edit?.hasTargets ? this.edit : undefined;
    const scope = this.input.scope;
    const whole = scope?.whole;
    const scoped = !!scope?.items.length && !whole;
    if (ctx.session.bookId !== this.bookId || (!scoped && !edit && !(whole && this.wholeGuideDelivered)))
      return;
    const view = await this.workspace.readAll(this.bookId);
    ctx.signal.throwIfAborted();
    if (view.diagnostics.length) return;
    const docs = view.documents;
    // For next-step selection only. No provisional page updates the real read set.
    const reads = prospective.length
      ? {
          readSet: new Map(this.reads.readSet),
          sourceReads: new Map(this.reads.sourceReads),
          offsets: new Map(this.reads.offsets),
          targetedReads: new Set(this.reads.targetedReads),
        }
      : this.reads;
    for (const result of prospective) this.observeRead(result, reads);
    const byKey = new Map(docs.map((doc) => [docKey(doc), doc]));
    const options: {
      name: string;
      hint: string;
      accepts: (args: Record<string, unknown>) => boolean;
    }[] = [];
    const add = (name: string, hint: string, accepts: (args: Record<string, unknown>) => boolean) =>
      options.push({ name, hint, accepts });
    const readKeys = new Set<string>();
    const readDoc = (key: string) => {
      const doc = byKey.get(key);
      if (!doc || readKeys.has(key)) return;
      readKeys.add(key);
      const cursor = reads.offsets.get(key);
      const offset = cursor?.revision === doc.revision ? cursor.next : 0;
      if (
        reads.targetedReads.has(this.documentReadKey(doc, offset)) ||
        (doc.type !== 'chapter' && reads.readSet.get(key)?.revision === doc.revision)
      )
        return;
      add(
        'book_get_context',
        `核对 ${key}（offset=${offset}）`,
        (a) =>
          a.type === doc.type &&
          a.documentId === doc.id &&
          (a.offset ?? 0) === offset &&
          !a.index &&
          !a.novelGoal,
      );
    };
    const readIndex = (index: ReferenceIndex) => {
      if (reads.targetedReads.has(bookIndexReadKey(docs, index, 0))) return;
      add(
        'book_get_context',
        `核对 ${index} 索引首页`,
        (a) => a.index === index && (a.offset ?? 0) === 0 && !a.type && !a.documentId && !a.novelGoal,
      );
    };
    const offerAsset = (kind: string, id: string | undefined, action: string, sync = false) => {
      add(
        'book_generate_assets',
        `${sync ? '只传 ID 同步' : action} ${kind}/${id ?? '一个必要的新资料'}`,
        (a) => {
          const target = Array.isArray(a.targets) && a.targets.length === 1 && asRecord(a.targets[0]);
          return (
            !!target &&
            a.kind === kind &&
            a.action === action &&
            (!sync || (target.fields === undefined && target.relatedSubjectIds === undefined)) &&
            (id ? target.id === id : isId(target.id) && !byKey.has(`${kind}/${target.id}`))
          );
        },
      );
    };
    const plan = (status: string, complete = false): NarrowedWritingStep => ({
      status,
      complete,
      canAdvance: options.length > 0,
      instructions: options
        .slice(0, 8)
        .map(({ name, hint }) => `${name}：${hint}`)
        .join('；'),
      accepts: (name: string, args: Record<string, unknown>) =>
        options.slice(0, 8).some((entry) => entry.name === name && entry.accepts(args)),
      ...(scope && { toolNames: [...new Set(options.slice(0, 8).map(({ name }) => name))] }),
    });

    if (scope && scoped) {
      const targets = this.syncTargets(docs);
      const { remaining, done, total } = scope.summarize(docs, targets);
      const sync = this.syncStatus(targets, ctx).filter(
        ({ key, operation }) => !scope.item(operation, key.split('/')[1]),
      );
      const bySyncKey = new Map(targets.map((target) => [target.key, target]));
      const status = `本轮任务已核对 ${done}/${total + sync.length} 项；待做：${
        [
          ...remaining.map(({ operation, id, part }) => `${operation}/${id}${part ? '/' + part : ''}`),
          ...sync.map(({ key }) => `同步 ${key}`),
        ]
          .slice(0, 6)
          .join('、') || '无'
      }`;
      if (!remaining.length && !sync.length) return plan(status, true);

      const unread = (doc: Manuscript) => reads.readSet.get(docKey(doc))?.revision !== doc.revision;
      for (const { operation, id, part } of remaining) {
        if (!scope.allows(operation, id, ctx, part)) continue;
        const [kind, action] = operation.split('.');
        const key = `${kind}/${id}`;
        const doc = byKey.get(key);
        if (kind === 'subject' || kind === 'clue') {
          const route = scope.assetUpdateRoute(kind, id, ctx, bySyncKey.get(key));
          if (action === 'sync' && route === 'sync') {
            offerAsset(kind, id, 'update', true);
          } else if (action === 'update' && doc && route === 'open') {
            if (unread(doc)) readDoc(key);
            else offerAsset(kind, id, action);
          } else if (action === 'create' && !doc) offerAsset(kind, id, action);
          else if (action === 'fill' && doc && !hasStoryDescription(doc.body))
            offerAsset(kind, id, action);
          continue;
        }
        if (operation === 'outline.write' || operation === 'chapter.catalog') {
          // The existing outline writer validates references against current, read revisions.
          const basis = doc && unread(doc) ? doc : undefined;
          if (basis) {
            readDoc(docKey(basis));
            continue;
          }
          add('book_apply_changes', `仅 ${operation}/${id}，不要合并其他文档`, (a) => {
            const op =
              Array.isArray(a.operations) && a.operations.length === 1 && asRecord(a.operations[0]);
            return (
              !!op &&
              op.type === kind &&
              op.id === id &&
              op.action === (doc ? 'update' : 'create') &&
              (kind !== 'chapter' || !op.body)
            );
          });
          continue;
        }
        if (!doc || kind !== 'chapter') continue;
        if (operation === 'chapter.patch') {
          const hasProse = reads.sourceReads.get(key)?.revision === doc.revision;
          if (!hasProse || reads.offsets.has(key)) readDoc(key);
          if (hasProse)
            add(
              'book_patch_chapter',
              `仅修订 ${id}${part ? '/' + part : ''} 的已读短文`,
              (a) =>
                a.chapterId === id &&
                a.revision === doc.revision &&
                Array.isArray(a.edits) &&
                !!a.edits.length &&
                a.edits.every((entry) => {
                  const edit = asRecord(entry);
                  return !!edit && edit.part === part;
                }),
            );
        } else if (operation === 'chapter.insert' || operation === 'chapter.replace') {
          if (unread(doc)) readDoc(key);
          else
            add(
              'book_generate_chapter',
              `仅 ${action} ${id}，使用当前版本`,
              (a) =>
                a.chapterId === id &&
                a.mode === action &&
                (action === 'insert'
                  ? asRecord(a.insertion)?.revision === doc.revision
                  : a.insertion === undefined),
            );
        } else if (
          (operation === 'chapter.draft' && !doc.body.trim()) ||
          operation === 'chapter.append'
        ) {
          add(
            'book_generate_chapter',
            `仅 ${action} ${id}`,
            (a) => a.chapterId === id && a.mode === action && a.insertion === undefined,
          );
        }
      }
      return plan(status);
    }

    if (edit) {
      const remaining = new Set(edit.remaining(docs));
      try {
        edit.verifyPlacement(docs);
        edit.verifySharedDocuments(
          docs,
          edit.plan.passages.flatMap((p) => [`chapter/${p.chapterId}`, 'outline/outline']),
        );
        for (const a of edit.plan.assets) edit.verifyRecorded(docs, assetTarget(a));
        for (const p of edit.plan.passages) edit.verifyRecorded(docs, passageTarget(p));
      } catch (error) {
        if (error instanceof ToolFailure) return;
        throw error;
      }
      const sync = this.syncStatus(this.syncTargets(docs), ctx);
      const { done, total } = this.editProgress(docs);
      const status = `确认方案已核对 ${done}/${total} 项；待做：${[...remaining, ...sync.map(({ key }) => `同步 ${key}`)].slice(0, 6).join('、') || '无'}`;
      if (!remaining.size && !sync.length) return plan(status, true);
      for (const a of edit.plan.assets) {
        const key = assetTarget(a);
        if (!remaining.has(key)) continue;
        if (a.action === 'create' && byKey.has(key)) return { ...plan(status), canAdvance: false };
        try {
          if (
            edit.assets({ kind: a.kind, action: a.action, targets: [{ id: a.id }] }, docs).pending.length
          )
            offerAsset(a.kind, a.id, a.action);
        } catch (error) {
          if (error instanceof ToolFailure) return;
          throw error;
        }
        if (a.action !== 'create') readDoc(key);
      }
      for (const p of edit.plan.passages) {
        if (!remaining.has(passageTarget(p))) continue;
        const chapter = byKey.get(`chapter/${p.chapterId}`),
          outline = byKey.get('outline/outline');
        if (!chapter || !outline) continue;
        try {
          edit.linked(p, docs);
        } catch (error) {
          if (error instanceof ToolFailure) continue;
          throw error;
        }
        add(
          'book_generate_chapter',
          `仅增补 ${p.chapterId} 的位置 ${p.id}，使用最新原文锚点和大纲版本`,
          (a) => {
            const insertion = asRecord(a.insertion);
            return (
              a.mode === 'insert' &&
              a.chapterId === p.chapterId &&
              insertion?.targetId === p.id &&
              insertion.revision === chapter.revision &&
              asRecord(insertion.outline)?.revision === outline.revision
            );
          },
        );
        readDoc(`chapter/${p.chapterId}`);
        readDoc('outline/outline');
      }
      for (const { key, ready } of sync) {
        if (!ready) continue;
        const [kind, id] = key.split('/');
        offerAsset(kind, id, 'update');
      }
      return plan(status);
    }

    if (!this.task) {
      if (!whole) return;
      const action = whole.operation === 'novel.resume' ? 'resume' : 'register';
      add('book_get_context', `novelGoal.${action}，沿用完整整书目标，不分批登记`, (a) => {
        const goal = asRecord(a.novelGoal);
        return (
          goal?.action === action &&
          !goal.updateDirection &&
          !a.type &&
          !a.documentId &&
          !a.index &&
          a.offset === undefined
        );
      });
      readIndex('chapters');
      for (const doc of docs.filter((d) => d.type === 'book' || d.type === 'outline'))
        readDoc(docKey(doc));
      return plan('本轮已登记整书范围，但目标尚未激活，无法判定具体卡在哪一章');
    }
    const check = this.check(view);
    const status = `已保存正文 ${check.done}/${check.total} 章${goalProblem(check) ? `；${goalProblem(check)}` : ''}`;
    if (check.catalogConflict) return plan(status);
    if (check.complete) {
      const local = this.localProgress(docs);
      if (local && !local.complete)
        return plan(
          `${status}；局部核对 ${local.summary.done}/${local.summary.total} 项。${local.message}`,
        );
      return plan(status, true);
    }
    const outline = docs.find((d) => d.type === 'outline');
    const needsOutline = !outline?.body.trim();
    // Only append the next missing directory entry; order and existing references stay with the original validator.
    if (check.missingChapters.length) {
      const id = check.missingChapters[0];
      const chapters = docs.filter((d) => d.type === 'chapter');
      const present = chapters.map((d) => d.id);
      const nextOrder = Math.max(0, ...chapters.map((d) => d.fields.order ?? 0)) + 1;
      if (sameChapterIds(present, this.task.chapterIds.slice(0, present.length)))
        add('book_apply_changes', `仅建立目录项 ${id}，不在参数内写正文`, (a) => {
          const op =
            Array.isArray(a.operations) && a.operations.length === 1 && asRecord(a.operations[0]);
          return (
            !!op &&
            op.type === 'chapter' &&
            op.action === 'create' &&
            op.id === id &&
            !op.body &&
            (asRecord(op.fields)?.order === undefined || asRecord(op.fields)?.order === nextOrder)
          );
        });
    }
    const unreadOutline =
      needsOutline && outline && reads.readSet.get(docKey(outline))?.revision !== outline.revision;
    if (needsOutline && !unreadOutline) {
      add('book_apply_changes', '只提交一份完整且简短的大纲，不覆写已有正文或大纲', (a) => {
        const op = Array.isArray(a.operations) && a.operations.length === 1 && asRecord(a.operations[0]);
        return (
          !!op &&
          op.type === 'outline' &&
          op.id === (outline?.id ?? 'outline') &&
          op.action === (outline ? 'update' : 'create') &&
          typeof op.body === 'string' &&
          !!op.body.trim()
        );
      });
    }
    for (const ref of check.missingAssetRefs) {
      const doc = byKey.get(docKey(ref));
      if (this.referenceFailures.has(docKey(ref))) continue;
      if (!doc) offerAsset(ref.type, ref.id, 'create');
      else if (!hasStoryDescription(doc.body)) offerAsset(ref.type, ref.id, 'fill');
      if (doc) readDoc(docKey(ref));
    }
    if (
      !docs.some((d) => d.type === 'subject' && hasStoryDescription(d.body)) &&
      !check.missingAssetRefs.some((d) => d.type === 'subject')
    )
      offerAsset('subject', undefined, 'create');
    if (
      check.catalogReady &&
      check.missingAssets.includes('有说明且关联埋设与回收章节的伏笔') &&
      !check.missingAssetRefs.some((d) => d.type === 'clue')
    )
      offerAsset('clue', undefined, 'create');
    if (check.catalogReady && check.firstUnwritten && !this.chapterFailures.has(check.firstUnwritten)) {
      add(
        'book_generate_chapter',
        `仅写下一空白章 ${check.firstUnwritten}`,
        (a) => a.mode === 'draft' && a.chapterId === check.firstUnwritten && !a.insertion,
      );
      readDoc(`chapter/${check.firstUnwritten}`);
    }
    if (unreadOutline) readDoc(docKey(outline));
    return plan(status);
  };
  private documentReadKey(doc: Guard, offset: number) {
    return `${docKey(doc)}:${doc.revision}:${offset}`;
  }
  restorePrimaryFailure() {
    const last = [...this.chapterFailures].reverse().find(([id]) => this.target?.includes(id));
    if (last) throw last[1];
  }
  private get wholeWork() {
    return !!this.input.scope?.whole;
  }
  private missingGoal() {
    const action = this.input.scope?.whole?.operation === 'novel.resume' ? 'resume' : 'register';
    const goal =
      action === 'register' ? '，chapterIds 须为完整有序目标，包含已保存的章节' : '，沿用原目标，不另建';
    return new ToolFailure(
      'novel_goal_required',
      `整书目标尚未激活。${this.wholeGuideDelivered ? '' : '先加载 generate-novel；'}` +
        `按本轮已登记的 novel.${action} 调用 book_get_context.novelGoal.${action}${goal}。`,
    );
  }
  private requireGoal() {
    if (this.wholeWork && !this.target) throw this.missingGoal();
    return this.target;
  }
  private localProgress(documents: Manuscript[]) {
    if (!this.input.scope) return;
    const targets = this.syncTargets(documents);
    const check = this.input.scope.summarize(documents, targets);
    const pending = targets.filter((item) => !item.synced);
    // Only the independently registered sync action represents this synchronization target.
    const separate = pending.filter(
      ({ key }) =>
        !check.remaining.some((item) => {
          const [kind, id] = key.split('/');
          return item.operation === `${kind}.sync` && item.id === id;
        }),
    );
    const total = check.total + separate.length;
    if (!total) return;
    const remaining: LocalWritingProgress['remaining'] = [
      ...check.remaining.map(({ operation, id, part, assetPatch, assetPending }) => ({
        operation,
        id,
        ...(part && { part }),
        ...(assetPatch
          ? { assetMode: 'patch' as const }
          : assetPending
            ? { assetMode: 'pending' as const }
            : {}),
      })),
      ...separate.map(({ key }) => {
        const [kind, id] = key.split('/');
        return { operation: `${kind}.sync`, id };
      }),
    ];
    const limit = 12;
    const summary: LocalWritingProgress = {
      done: check.done,
      total,
      remaining: remaining.slice(0, limit),
      omitted: Math.max(0, remaining.length - limit),
    };
    const labels = [
      ...check.remaining.map(({ id, part, purpose }) => (part ? `${id}：${purpose}` : id)),
      ...separate.map(({ key }) => `待同步 ${key}`),
    ];
    const message = labels.length
      ? `仍需核对或提交：${labels.slice(0, limit).join('、')}${summary.omitted ? `（另有 ${summary.omitted} 项）` : ''}`
      : undefined;
    return { summary, complete: remaining.length === 0, noWrite: check.noWrite, message };
  }
  private publish(
    documents: Manuscript[],
    ctx: RunContext,
    check?: NovelCheck,
    goalMessage = check && goalProblem(check),
  ) {
    const local = this.localProgress(documents);
    const hasWhole = this.wholeWork;
    if (!hasWhole && !local) return;
    const complete = (!hasWhole || check?.complete === true) && (!local || local.complete);
    if (hasWhole && local) {
      ctx.progress({
        step: complete ? '任务已完成' : '本轮写作进度',
        done: local.summary.done,
        total: local.summary.total,
        complete,
        whole: {
          ...(check && { chapters: { done: check.done, total: check.total } }),
          complete: check?.complete ?? false,
          message: check ? goalMessage : '整书目标尚未激活。',
        },
        local: local.summary,
      });
    } else if (hasWhole) {
      ctx.progress({
        step: check ? '已保存章节正文' : '整书目标尚未激活',
        done: check?.done ?? 0,
        total: check?.total ?? 0,
        complete,
        message: goalMessage,
      });
    } else if (local) {
      ctx.progress({
        step: complete ? (local.noWrite ? '已满足，无需写入' : '任务已完成') : '任务未全部完成',
        done: local.summary.done,
        total: local.summary.total,
        complete,
        message: local.message,
        local: local.summary,
      });
    }
    return { complete, local };
  }
  private check(
    view: Awaited<ReturnType<WorkspaceService['readAll']>>,
    task = this.task!,
    references = [...this.referenceFailures.keys()],
  ) {
    return inspectNovelGoal(view, task.chapterIds, references, task.knownCatalog, task.requiredAssets);
  }
  private async goalView(
    args: GoalRequest,
    view: Awaited<ReturnType<WorkspaceService['readAll']>>,
    ctx: RunContext,
  ) {
    if (!this.wholeGuideDelivered)
      throw new ToolFailure('novel_goal_required', '整书目标需要先送达 generate-novel 指南。');
    const continuation = ctx.continuation;
    let goal = this.task;
    let directions: string[] = [];
    let references = [...this.referenceFailures.keys()];
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
      if (goal && !sameChapterIds(goal.chapterIds, ids))
        throw new ToolFailure('novel_goal_conflict', '已登记的目标章范围或顺序不能在同一任务中变更。');
      if (!goal) {
        if (continuation)
          throw new ToolFailure(
            'novel_goal_conflict',
            '已有未完成整书目标；只有本轮明确续接才可登记 novel.resume 并核对原目标。',
          );
        const registration = this.input.scope?.item('novel.register', this.bookId);
        const expected = registration?.count;
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
        const historical = registration?.sourceAuthorLine;
        const original = historical === undefined ? undefined : ctx.history?.lines[historical];
        if (original?.role === 'user') directions = [original.text];
        goal = {
          chapterIds: [...ids],
          originalLine: historical ?? ctx.authorLine,
          knownCatalog: existing,
          pendingReferences: [],
        };
      }
      goal = this.withGoalAssets(goal, args.assetRefs ?? []);
    } else if (args.action === 'resume' && !goal && continuation) {
      goal = {
        ...continuation.task,
        ...(args.updateDirection && ctx.authorLine !== undefined && { amendmentLine: ctx.authorLine }),
      };
      directions = [continuation.originalDirection, continuation.amendedDirection].filter(
        (s): s is string => !!s,
      );
      references = goal.pendingReferences;
    }
    if (!goal) throw this.missingGoal();
    const check = this.check(view, goal, references);
    const report = () =>
      (ctx.diagnostic ?? noDiagnostic)('novel.goal', {
        operation: args.action,
        outcome: check.catalogConflict ? 'conflict' : 'ok',
        done: check.done,
        total: check.total,
      });
    if (args.action === 'resume' && check.catalogConflict) {
      report();
      const failure = new ToolFailure(
        'novel_goal_conflict',
        goalProblem(check) ?? '请核对原目录。',
        check,
      );
      if (!this.task) this.goalActivationFailure = failure;
      throw failure;
    }
    const activated = !this.task;
    if (goal !== this.task) {
      ctx.signal.throwIfAborted();
      await this.saveGoal(ctx, check, goal, references);
    }
    if (activated) {
      this.inheritedDirections = directions;
      for (const key of references) this.referenceFailures.set(key, 0);
      this.reportReused(view.documents, ctx);
    }
    this.publish(view.documents, ctx, check);
    report();
    return {
      ...check,
      ...(args.action === 'resume' && {
        originalDirection: this.inheritedDirections[0],
        amendedDirection: this.inheritedDirections[1],
        lastFailedChapterId: this.task?.failedChapterId,
      }),
    };
  }
  private withGoalAssets(task: NovelTaskState, refs: DocRef[]) {
    if (!refs.length) return task;
    const prior = task.requiredAssets ?? [];
    const next = [
      ...new Map(
        [...prior, ...refs].map((ref) => [docKey(ref), { type: ref.type, id: ref.id }]),
      ).values(),
    ];
    if (!validGoalAssets(next))
      throw new ToolFailure('result_limit', '整书要核对的资产超出上限，请核对这次安排。');
    return next.length === prior.length ? task : { ...task, requiredAssets: next };
  }
  private includeAssets(refs: DocRef[]) {
    if (!this.task) return false;
    const goal = this.withGoalAssets(this.task, refs);
    if (goal === this.task) return false;
    this.task = goal;
    return true;
  }
  private async saveGoal(
    ctx: RunContext,
    check: NovelCheck,
    goal = this.task,
    references = [...this.referenceFailures.keys()],
  ) {
    if (!goal || ctx.signal.aborted) return;
    const task = {
      ...goal,
      knownCatalog: [
        ...new Set([
          ...goal.knownCatalog,
          ...check.chapterIds.filter((id) => !check.missingChapters.includes(id)),
        ]),
      ],
      pendingReferences: references,
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
  private reportWritingResult(view: Awaited<ReturnType<WorkspaceService['readAll']>>, ctx: RunContext) {
    const check = this.target ? this.check(view) : undefined;
    const failure = check?.firstUnwritten ? this.chapterFailures.get(check.firstUnwritten) : undefined;
    const result = this.publish(view.documents, ctx, check, failure?.message);
    if (result) {
      const { complete, local } = result;
      const anyDone = (check?.done ?? 0) > 0 || (local?.summary.done ?? 0) > 0;
      ctx.taskOutcome?.(
        complete
          ? !this.wholeWork && local?.noWrite
            ? 'no_write_needed'
            : 'fulfilled'
          : anyDone
            ? 'partial'
            : 'incomplete',
      );
      if (local)
        ctx.diagnostic?.('writing.task_result', {
          count: local.summary.total,
          done: local.summary.done,
          outcome: local.complete
            ? local.noWrite
              ? 'reused'
              : 'ok'
            : local.summary.done
              ? 'partial'
              : 'failed',
        });
    }
    return { check, failure };
  }
  async reportInterruptedTask(ctx: RunContext) {
    if (!this.input.scope?.items.length) return;
    if (ctx.signal.aborted) {
      ctx.taskOutcome?.('cancelled');
      ctx.diagnostic?.('writing.task_result', { outcome: 'cancelled' });
    } else this.reportWritingResult(await this.workspace.readAll(this.bookId), ctx);
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
          `方案未全部提交：${remaining.join('、')}。已保存的内容保留，可在同一会话继续。`,
        );
      }
      return;
    }
    if (!this.input.scope?.items.length) return;
    const { check, failure } = this.reportWritingResult(await this.workspace.readAll(this.bookId), ctx);
    if (!this.wholeWork) return;
    if (!check) throw this.goalActivationFailure ?? this.missingGoal();
    if (check.complete) await ctx.saveNovelTask(null);
    else
      throw new DiagnosticFailure(
        failure ? failure.diagnosticReason : 'novel_incomplete',
        `整书未完成：${failure ? failure.message : (goalProblem(check) ?? '请核对现稿')}`,
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
  private remember(doc: Guard, reads = this.reads) {
    reads.readSet.set(docKey(doc), { type: doc.type, id: doc.id, revision: doc.revision });
  }
  private async context(args: BookContextArgs & { novelGoal?: GoalRequest }, ctx: RunContext) {
    if (args.novelGoal && this.editMode !== 'direct')
      throw new ToolFailure('invalid_options', '本轮不是整书请求，不登记或续接整书目标。');
    if (args.novelGoal) {
      const { action } = args.novelGoal;
      const allowed =
        action === 'check'
          ? !!this.target
          : this.input.scope?.allows(
              action === 'resume' ? 'novel.resume' : 'novel.register',
              this.bookId,
              ctx,
            );
      if (!allowed) {
        if (this.wholeWork) throw this.missingGoal();
        throw new ToolFailure('invalid_options', '当前没有此作品的本轮整书范围；局部任务不需激活整书。');
      }
      return this.goalView(args.novelGoal, await this.workspace.readAll(this.bookId), ctx);
    }
    const { value, indexKey, requestedOffset } = await readBookContext(
      this.workspace,
      this.bookId,
      args,
      ctx.signal,
    );
    ctx.onToolResultDispatch?.((_report, result) => {
      if (indexKey) {
        if ((result.value as { pageState?: string })?.pageState !== 'deferred')
          this.reads.targetedReads.add(indexKey);
      } else this.observeRead(result, this.reads, requestedOffset);
    });
    return value;
  }
  private observeRead(result: ToolResult, reads: BookReads, requestedOffset?: number) {
    if (!result.ok || !asRecord(result.value)?.pageState) return;
    const page = result.value as Partial<DocumentPage> & { documents?: ReadDocument[] };
    if (page.range && typeof page.document?.body === 'string') {
      reads.targetedReads.add(this.documentReadKey(page.document, requestedOffset ?? page.range[0]));
      this.rememberRange(page.document, ...page.range, reads);
    }
    for (const row of page.documents ?? []) {
      if (typeof row.body === 'string') this.rememberRange(row, 0, row.bodyLength, reads);
      else if (row.type === 'chapter') this.remember(row, reads);
    }
  }
  private rememberRange(doc: ReadDocument, start: number, end: number, reads: BookReads) {
    const key = docKey(doc);
    if (doc.type === 'chapter' || doc.bodyLength === 0) this.remember(doc, reads);
    if (start >= end) return;
    const current = reads.sourceReads.get(key);
    const earlier = current?.revision === doc.revision ? current.ranges : [];
    const next: [number, number][] = [...earlier, [start, end] as [number, number]].sort(
      (a, b) => a[0] - b[0],
    );
    const merged: [number, number][] = [];
    for (const [from, to] of next) {
      const last = merged.at(-1);
      if (last && last[1] >= from) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    }
    reads.sourceReads.set(key, { revision: doc.revision, ranges: merged });
    const first = merged[0];
    if (first[0] === 0 && first[1] >= doc.bodyLength) {
      this.remember(doc, reads);
      reads.offsets.delete(key);
    } else if (first[0] === 0) reads.offsets.set(key, { revision: doc.revision, next: first[1] });
  }
  private readCovers(doc: Manuscript, start: number, end: number) {
    const read = this.reads.sourceReads.get(docKey(doc));
    return (
      read?.revision === doc.revision && read.ranges.some(([from, to]) => from <= start && end <= to)
    );
  }
  private requirePatchQuote(doc: Manuscript, quote: string, evidence = false) {
    const { start, end } = exactRange(doc.body, quote, evidence ? 'patch_evidence' : 'patch_anchor');
    if (!this.readCovers(doc, start, end))
      throw new ToolFailure(
        evidence ? 'patch_evidence' : 'context_required',
        '请按章节 ID 定向读取当前修订及对应完整短原文。',
        { chapterId: doc.id },
      );
  }
  private recordsDraftForCorrection(chapterId: string, ctx: RunContext) {
    return (
      !!this.populatedAtStart &&
      !this.populatedAtStart.has(chapterId) &&
      this.target?.includes(chapterId) &&
      this.editMode === 'direct' &&
      !ctx.continuation &&
      this.input.scope?.whole?.operation === 'novel.register'
    );
  }
  private issueInsertionRef(
    ctx: RunContext,
    chapterId: string,
    revision: string,
    insertion: ChapterInsertion | undefined,
    commit: EditCommit,
  ) {
    const { anchor, scene, revisions } = commit;
    if (
      !scene ||
      !anchor ||
      !insertion ||
      ctx.narrowedWriting ||
      ctx.signal.aborted ||
      revisions['chapter/' + chapterId] !== revision ||
      (insertion.outline && !revisions['outline/outline'])
    )
      return;
    const insertionRef = randomUUID();
    this.currentInsertions.set(insertionRef, {
      runId: ctx.id,
      sessionId: ctx.session.id,
      chapterId,
      revision,
      anchor,
      insertion,
      commit,
    });
    ctx.diagnostic?.('chapter.insertion.receipt', {
      documentRef: 'chapter/' + chapterId,
      insertionRef,
      revision,
    });
    return insertionRef;
  }
  private async cleanInsertion(
    chapterId: string,
    revision: string,
    insertionRef: string,
    ctx: RunContext,
  ) {
    const receipt = this.currentInsertions.get(insertionRef);
    const ref = { type: 'chapter' as const, id: chapterId };
    const chapterKey = docKey(ref);
    let wrote = false;
    if (this.input.scope)
      ctx = this.input.scope.track(ctx, [{ operation: 'chapter.cleanup', id: chapterId }]);
    const report = diagnosticScope(ctx.diagnostic ?? noDiagnostic, {
      documentRef: chapterKey,
      insertionRef: receipt?.runId === ctx.id ? insertionRef : undefined,
    });
    const reject = (reason: string, message: string): never => {
      throw new ToolFailure(reason, message, { chapterId });
    };
    try {
      ctx.signal.throwIfAborted();
      const taskScope = this.input.scope;
      const author = (this.input.authorPrompt ?? '').normalize('NFKC');
      if (
        ctx.session.bookId !== this.bookId ||
        ctx.narrowedWriting ||
        this.task ||
        this.editMode === 'proposal' ||
        this.editMode === 'unresolved' ||
        (!taskScope &&
          (proposalOnly(author) ||
            /(?:不要|别|禁止|不允许|不许|不得|不能|无需|不必|不)\s*(?:(?:再|自动|直接|自行|擅自)\s*)?(?:删|移除|去掉|清理|去重|修订|改稿|(?:改动?|修改|动)(?:正文|新增|这段|插入段|原文))|(?:do not|don't|never) (?:edit|clean|remove|delete)\b/iu.test(
              author,
            )))
      )
        reject('insert_cleanup_scope', '当前增补范围不允许回声清理。');
      if (
        !receipt ||
        receipt.consumed ||
        receipt.runId !== ctx.id ||
        receipt.sessionId !== ctx.session.id ||
        receipt.chapterId !== chapterId
      )
        throw new ToolFailure(
          'insert_cleanup_receipt',
          '这个插入回执不属于本 Run 的可用提交，或已被使用。',
          { chapterId },
        );
      const { documents } = await this.workspace.readAll(this.bookId);
      const doc = documents.find((row) => docKey(row) === chapterKey);
      if (!doc || doc.revision !== revision || revision !== receipt.revision)
        throw new ToolFailure('conflict', '章节已不是该次插入的提交版本，不重新猜测清理位置。', {
          chapterId,
        });
      if (this.edit) {
        this.edit.verifyPlacement(documents);
        this.edit.passage(chapterId, receipt.insertion.targetId);
        this.edit.verifySharedDocuments(documents, [chapterKey]);
      } else if (
        taskScope
          ? !taskScope.allows('chapter.cleanup', chapterId, ctx)
          : !passageTargetAllowed(
              author,
              documents.filter((row) => row.type === 'chapter'),
              chapterId,
              this.input.selectedChapterId,
            )
      )
        reject('insert_cleanup_scope', '此位置已不在本轮允许的增补范围内。');
      const scene = receipt.commit.scene!;
      const start = scene.offset + scene.fragmentOffset;
      const fragment = doc.body.slice(start, start + scene.length);
      const original = doc.body.slice(0, scene.offset) + doc.body.slice(scene.offset + scene.size);
      if (
        fragment.length !== scene.length ||
        digest(fragment) !== scene.digest ||
        insertPassage(original, scene.offset, fragment) !== doc.body
      )
        reject('insert_cleanup_receipt', '当前片段与已写回执不一致，未清理。');
      const anchor = insertionAnchor(
        { ...doc, revision: receipt.insertion.revision, body: original },
        receipt.insertion,
      );
      if (anchor.key !== receipt.anchor || anchor.offset !== scene.offset)
        reject('insert_cleanup_receipt', '不能核实原插入锚点，未清理。');
      const before = doc.body.slice(0, start);
      const after = doc.body.slice(start + scene.length);
      const cut = safeInsertionEchoCut(before, fragment, after);
      if (!cut)
        throw new ToolFailure(
          'insert_cleanup_unsafe',
          '未找到唯一且可安全删除的插入边界回声，保留已保存内容。',
          { chapterId },
        );
      const body = before + cut.kept + after;
      const projectedRevision = digest(renderDocument(doc, doc.fields, body));
      const prospective = { ...doc, body, revision: projectedRevision };
      const nextDocs = documents.map((entry) => (docKey(entry) === chapterKey ? prospective : entry));
      const history = this.edit?.commits ?? this.directCommits;
      if (!history.includes(receipt.commit) || (this.edit && !ctx.recordEditCommit))
        reject('insert_cleanup_receipt', '缺少可记录的原插入提交。');
      const commit: EditCommit = {
        target: receipt.commit.target,
        anchor: receipt.anchor,
        revisions: { [chapterKey]: projectedRevision },
        cleanup: {
          previousRevision: revision,
          from: start + cut.from,
          to: start + cut.to,
          digest: digest(cut.kept),
          preservedSync: [],
        },
      };
      const projectedHistory = [...history, commit];
      for (const entry of history) {
        if (!entry.revisions[chapterKey] || !entry.scene) continue;
        if (!sceneText(entry, history, doc) || !sceneText(entry, projectedHistory, prospective))
          reject('insert_cleanup_receipt', '不能验证同章片段在清理前后的定位，未写入。');
      }
      const pending: string[] = [],
        retained: string[] = [],
        guards: Guard[] = [];
      const projectedSync = this.syncTargets(nextDocs, projectedHistory, true);
      const priorSync = this.syncTargets(documents, history, true);
      const associated = new Set(
        history.flatMap((entry) => (entry.revisions[chapterKey] ? (entry.scene?.assets ?? []) : [])),
      );
      for (const key of associated) {
        const prior = priorSync.find((entry) => entry.key === key);
        const next = projectedSync.find((entry) => entry.key === key);
        if (!prior?.ready || !next?.ready || !prior.document)
          throw new ToolFailure('insert_cleanup_sync', '关联资料或来源已变化，不能维护同步一致性。', {
            chapterId,
          });
        guards.push(
          prior.document,
          ...prior.sceneSources
            .map(({ chapter }) => chapter)
            .filter((chapter) => chapter.id !== chapterId),
        );
        if (preservesSyncEvidence(prior, next, chapterId)) retained.push(key);
        else if (
          this.input.scope
            ? this.input.scope.assetUpdateRoute(
                prior.document.type === 'subject' ? 'subject' : 'clue',
                prior.document.id,
                ctx,
                next,
              ) === 'sync'
            : this.noteSyncAllowed(key)
        )
          pending.push(key);
        else reject('insert_cleanup_sync', '清理后须重新核验相关资料，但作者限制了所需同步；未写入。');
      }
      commit.cleanup!.preservedSync = retained;
      ctx.signal.throwIfAborted();
      const write = editWriteContext(ctx);
      const result = await this.workspace.writeChanges(
        this.bookId,
        [{ ...ref, fields: doc.fields, body, expect: revision }],
        ctx.signal,
        [...new Map(guards.map((guard) => [docKey(guard), guard])).values()],
        write.ctx.diagnostic,
        false,
        chapterPlacementFingerprint(documents),
      );
      wrote = result.committed.some((entry) => docKey(entry) === chapterKey);
      if (wrote) receipt.consumed = true;
      if (result.error) throw new ToolFailure(result.reason ?? 'io_failure', result.error, result);
      const actual = write.revisions([ref])[chapterKey];
      if (actual !== projectedRevision)
        reject('io_failure', '清理后提交版本未能核实，请读取现稿，不要重放。');
      if (this.edit) await this.edit.record(ctx, commit);
      else this.directCommits.push(commit);
      for (const state of this.inserted.values())
        if (state.chapterId === chapterId) state.revision = actual;
      this.remember(prospective);
      await this.publishEdit(ctx);
      report('chapter.insertion.cleanup', {
        outcome: 'ok',
        revision: actual,
        expectedRevision: revision,
        syncPending: pending.length,
        syncRetained: retained.length,
      });
      return {
        chapterId,
        insertionRef,
        revision: actual,
        cleaned: true,
        pendingSync: this.syncStatus(this.syncTargets(nextDocs), ctx),
      };
    } catch (error) {
      const reason = classified(error, ctx.signal);
      report('chapter.insertion.cleanup', {
        outcome: wrote ? 'partial' : reason === 'cancelled' ? 'cancelled' : 'failed',
        reason,
      });
      throw error;
    }
  }
  private async patchChapter(
    chapterId: string,
    revision: string,
    requestedEdits: (ProseEdit | ParagraphGapEdit)[],
    evidence: PatchEvidence[] = [],
    ctx: RunContext,
  ) {
    const ref = { type: 'chapter' as const, id: chapterId };
    const taskScope = this.input.scope;
    const reportPatch = diagnosticScope(ctx.diagnostic ?? noDiagnostic, { documentRef: docKey(ref) });
    const parts = new Set(
      requestedEdits.map(({ part }) => part).filter((part): part is string => !!part),
    );
    try {
      ctx.signal.throwIfAborted();
      const requestedGap = requestedEdits.find((edit) => 'paragraphGap' in edit);
      if (requestedGap && (requestedEdits.length !== 1 || evidence.length))
        throw new ToolFailure(
          'invalid_arguments',
          '段间空白收尾只接受一处，不和其他补丁或来源章证据混用。',
        );
      const targets = taskScope?.patchTargets(chapterId, requestedEdits, ctx);
      const explicitScope =
        !!targets?.length &&
        targets.every(({ operation, id, part }) => taskScope!.allows(operation, id, ctx, part));
      const author =
        taskScope?.instruction('chapter.patch', chapterId, targets) ?? this.input.authorPrompt ?? '';
      if (
        ctx.session.bookId !== this.bookId ||
        this.editMode !== 'direct' ||
        (!taskScope && (proposalOnly(author) || blocksProsePatch(author)))
      )
        throw new ToolFailure('patch_not_authorized', '当前请求不授权修改章节原文。');
      if (requestedGap && !explicitScope)
        throw new ToolFailure('patch_not_authorized', '段间空白收尾需要本轮已登记的章节补丁范围。');
      const { documents } = await this.workspace.readAll(this.bookId);
      const chapters = documents.filter((d) => d.type === 'chapter');
      const intent = !taskScope
        ? prosePatchIntent(author, chapters, this.input.selectedChapterId)
        : undefined;
      const explicit = explicitScope || intent?.chapterId === chapterId;
      const owned =
        !explicit &&
        !ctx.continuation &&
        this.target?.includes(chapterId) &&
        this.draftedHere.get(chapterId);
      if (!explicit && !owned)
        throw new ToolFailure(
          'patch_not_authorized',
          '须由本轮作者指定定点修订，或目标是本轮从空白写出的整书新稿。',
        );
      const doc = chapters.find((d) => d.id === chapterId);
      if (!doc) throw new ToolFailure('missing', '目标章不存在。');
      if (doc.revision !== revision || (owned && revision !== owned))
        throw new ToolFailure('conflict', '目标章修订已变化；不会用旧补丁覆盖当前正文。');
      const gap = requestedGap && expandParagraphGap(doc.body, requestedGap);
      const edits = gap
        ? [gap.edit]
        : requestedEdits.filter((edit): edit is ProseEdit => !('paragraphGap' in edit));
      if (gap && gap.edit.quote === gap.edit.replacement) {
        this.requirePatchQuote(doc, gap.edit.quote);
        throw new ToolFailure('patch_scope', '该处段间已有 1 个空行，无需改动。', { chapterId });
      }
      const body = patchBody(doc.body, edits);
      for (const { quote } of edits) this.requirePatchQuote(doc, quote);
      if (!explicit && !evidence.length)
        throw new ToolFailure('patch_evidence', '新稿事实勘误需要已读取的前章短原文和版本。');
      const guards: Guard[] = [];
      for (const entry of evidence) {
        const source = chapters.find((d) => d.id === entry.chapterId);
        if (
          !source ||
          source.id === doc.id ||
          (!explicit &&
            (source.fields.order === undefined ||
              doc.fields.order === undefined ||
              source.fields.order >= doc.fields.order))
        )
          throw new ToolFailure(
            'patch_evidence',
            '勘误来源须为同作品真实的已保存证据；新稿自修只能引用前章。',
          );
        if (source.revision !== entry.revision)
          throw new ToolFailure('conflict', '引用的证据章已变化，未提交修订。');
        this.requirePatchQuote(source, entry.quote, true);
        guards.push({ type: 'chapter', id: source.id, revision: source.revision });
      }
      if (explicit && intent?.exact) {
        if (
          edits.length !== 1 ||
          edits[0].quote !== intent.exact.quote ||
          edits[0].replacement !== intent.exact.replacement
        )
          throw new ToolFailure('patch_scope', '修订超出作者明确指定的原文或替换文本。');
      } else if (explicit) {
        await reviewProsePatch(
          this.provider,
          { ...ctx, diagnostic: reportPatch },
          {
            author,
            chapter: { id: doc.id, title: doc.fields.title, order: doc.fields.order },
            edits,
            ...(gap && { paragraphGap: gap.lineBreaks }),
          },
          explicitScope,
        );
      } else await reviewProsePatch(this.provider, ctx, { evidence, edits });
      ctx.signal.throwIfAborted();
      const patchContext = { ...ctx, diagnostic: reportPatch };
      const write = editWriteContext(
        taskScope && targets ? taskScope.track(patchContext, targets) : patchContext,
      );
      const result = await this.workspace.writeChanges(
        this.bookId,
        [{ ...ref, fields: doc.fields, body, expect: doc.revision }],
        ctx.signal,
        guards,
        write.ctx.diagnostic,
      );
      if (result.error) throw new ToolFailure(result.reason ?? 'unknown', result.error, result);
      const savedRevision = write.revisions([ref])[docKey(ref)];
      reportPatch('chapter.patch.finished', {
        outcome: 'ok',
        count: edits.length,
        revision: savedRevision,
      });
      return {
        chapterId,
        revision: savedRevision,
        patched: edits.length,
        factCorrection: !explicit,
        ...(parts.size ? { parts: [...parts] } : {}),
      };
    } catch (error) {
      const reason = classified(error, ctx.signal);
      reportPatch('chapter.patch.finished', {
        outcome: reason === 'cancelled' ? 'cancelled' : 'failed',
        reason,
      });
      for (const part of parts)
        reportPatch('chapter.patch.part', {
          partRef: part,
          outcome: reason === 'cancelled' ? 'cancelled' : 'failed',
          reason,
        });
      if (error instanceof DiagnosticFailure && !(error instanceof ToolFailure))
        throw new ToolFailure(reason, error.message, { chapterId });
      throw error;
    }
  }
  private async patchAsset(kind: 'subject' | 'clue', id: string, patch: AssetPatch, ctx: RunContext) {
    const ref = { type: kind, id };
    const key = docKey(ref);
    const operation = `${kind}.update` as const;
    const scope = this.input.scope;
    const report = diagnosticScope(ctx.diagnostic ?? noDiagnostic, { documentRef: key });
    try {
      ctx.signal.throwIfAborted();
      if (!isId(id)) throw new ToolFailure('invalid_arguments', '请使用有效的资料 ID。');
      if (
        !scope ||
        ctx.session.bookId !== this.bookId ||
        this.editMode !== 'direct' ||
        this.wholeWork ||
        ctx.narrowedWriting
      )
        throw new ToolFailure('patch_not_authorized', '资料定点修订仅用于绑定作品的普通范围任务。');
      if (!scope.allowsAssetPatch(operation, id, ctx, patch))
        throw new ToolFailure(
          'patch_not_authorized',
          '此精确修订不匹配本轮的 assetPatch 登记；文档级更新或只待办不能代替。',
        );

      const changed = () =>
        new ToolFailure('conflict', '资料已变化；请回读当前短文后重新登记，不重用旧补丁。');
      const doc = await this.workspace.readDocument(this.bookId, ref).catch((error: unknown) => {
        if (classified(error, ctx.signal) === 'missing') throw changed();
        throw error;
      });
      if (doc.revision !== patch.revision) throw changed();
      const { body, start, end } = patchAssetDescription(doc.body, patch);
      if (!this.readCovers(doc, start, end))
        throw new ToolFailure(
          'context_required',
          '请按资料类型和 ID 回读当前版本的完整短原文；搜索命中不是原文。',
        );
      ctx.signal.throwIfAborted();
      const witness = body.slice(Math.max(0, start - 24), start + patch.replacement.length + 24);
      const write = editWriteContext(
        scope.track({ ...ctx, diagnostic: report }, [
          {
            operation,
            id,
            assetPatch: patch,
            assetPatchWitness:
              witness && body.indexOf(witness) === body.lastIndexOf(witness) ? witness : undefined,
          },
        ]),
      );
      const result = await this.workspace.writeChanges(
        this.bookId,
        [{ ...ref, fields: doc.fields, body, expect: patch.revision }],
        ctx.signal,
        [],
        write.ctx.diagnostic,
      );
      if (result.reason === 'conflict') throw changed();
      if (result.error) throw new ToolFailure(result.reason ?? 'unknown', result.error, result);
      const revision = write.revisions([ref])[key];
      const prior = this.directCommits
        .filter((entry) => entry.target === key && entry.revisions[key])
        .at(-1);
      if (this.createdHere.has(key) && prior?.revisions[key] === patch.revision)
        this.directCommits.push({ target: key, revisions: { [key]: revision } });
      report('asset.patch.finished', { docType: kind, outcome: 'ok', count: 1, revision });
      return { kind, id, revision, patched: 1 };
    } catch (error) {
      const reason = classified(error, ctx.signal);
      report('asset.patch.finished', {
        docType: kind,
        outcome: reason === 'cancelled' ? 'cancelled' : 'failed',
        reason,
      });
      throw error;
    }
  }
  private assetUpdateHint(
    kind: 'subject' | 'clue',
    id: string,
    route: ReturnType<BookTaskScope['assetUpdateRoute']>,
  ) {
    const key = `${kind}/${id}`;
    switch (route) {
      case 'patch':
        return `${key} 仅有定点登记；符合当前修订及精确参数时用 book_patch_asset，不能同步或全文更新。`;
      case 'pending':
        return `${key} 只登记为待办，没有可执行的资料更新。`;
      case 'needs_sync_scope':
        return `${key} 有本轮已提交的关联场景。如作者允许同步，先独立登记 ${kind}.sync，再用 book_generate_assets(update) 只传 ID；不能用开放式更新代替。`;
      case 'sync_conflict':
        return `${key} 的同步来源或目标资料已变化或无法核对；暂留待办，不改走全文更新。`;
      case 'sync':
        return `${key} 已登记受限同步，用 book_generate_assets(update) 只传 ID。`;
      case 'open':
        return `${key} 已登记开放式更新，回读当前资料后用 book_generate_assets(update)。`;
      default:
        return `${key} 没有本轮有效的资料更新登记。`;
    }
  }

  private async apply(operations: Mutation[], ctx: RunContext) {
    this.requireEditAction();
    if (this.edit)
      throw new ToolFailure(
        'invalid_options',
        '已确认的局部方案使用资产工具和逐章 insert；不能用通用工具扩大写入范围。',
      );
    const target = this.requireGoal();
    const scope = this.input.scope;
    if (scope && !target) {
      const asset = operations.find(
        ({ type, action, id }) =>
          (type === 'subject' || type === 'clue') && action === 'update' && isId(id),
      );
      if (asset && (asset.type === 'subject' || asset.type === 'clue')) {
        const { documents } = await this.workspace.readAll(this.bookId);
        const sync = this.scopeSyncTargets(documents).find(({ key }) => key === docKey(asset));
        const route = scope.assetUpdateRoute(asset.type, asset.id, ctx, sync);
        throw new ToolFailure(
          'asset_update_route',
          'book_apply_changes 不支持普通范围任务的资料更新。' +
            this.assetUpdateHint(asset.type, asset.id, route),
        );
      }
    }
    if (
      scope &&
      !target &&
      !operations.every(
        ({ type, id, action }) =>
          action !== 'delete' &&
          (type === 'outline'
            ? scope.allows('outline.write', id, ctx)
            : type === 'chapter' && scope.allows('chapter.catalog', id, ctx)),
      )
    )
      throw new ToolFailure('invalid_options', '通用目录或大纲动作不在本轮有效范围。');
    if (
      !scope &&
      !target &&
      wantsPassageAddition(this.input.authorPrompt ?? '') &&
      operations.some(
        ({ type, action }) => type === 'chapter' || type === 'outline' || action !== 'create',
      )
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
    if (scope) {
      const scoped = operations.flatMap<{ operation: ScopeOperation; id: string }>(
        ({ type, id, action }) => {
          const operation =
            type === 'outline' ? 'outline.write' : type === 'chapter' ? 'chapter.catalog' : undefined;
          return action !== 'delete' && operation && scope.allows(operation, id, ctx)
            ? [{ operation, id }]
            : [];
        },
      );
      if (scoped.length) ctx = scope.track(ctx, scoped);
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
    const outlineAndCatalog = operations.every(
      (op) => op.action !== 'delete' && (op.type === 'outline' || op.type === 'chapter'),
    );
    if (outlineAndCatalog) {
      const linked = operations.flatMap((op) =>
        op.type === 'outline' ? storyLinks(op.body ?? '') : [],
      );
      // Guard delivered source revisions cited by the candidate, not unread or unrelated cards.
      for (const ref of new Map(linked.map(({ ref }) => [docKey(ref), ref])).values()) {
        const read = this.reads.sourceReads.get(docKey(ref));
        if (read) guards.push({ ...ref, revision: read.revision });
      }
    } else if (operations.some((m) => m.type !== 'chapter' || m.action === 'delete')) {
      const unread: DocRef[] = [];
      for (const doc of documents) {
        if (!['outline', 'subject', 'clue'].includes(doc.type)) continue;
        const read = this.reads.readSet.get(docKey(doc));
        if (read?.revision === doc.revision) guards.push(read);
        else unread.push({ type: doc.type, id: doc.id });
      }
      if (unread.length)
        throw new ToolFailure(
          'context_required',
          `请先用 book_get_context 读取大纲及相关故事资产：有 ${unread.length} 项未读或已变化。不要用 index 代替全文；用 includeBodies: true 显式读取资料页并翻页，或按返回的 ID 读取。`,
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
      if (old && this.reads.readSet.get(key)?.revision !== old.revision)
        throw new Error(`先读取当前版本：${key}`);
      if (m.action === 'delete') return { ...ref, expect: old!.revision, delete: true };
      if (m.type === 'chapter' && m.body !== undefined && m.body !== '')
        throw new ToolFailure(
          'chapter_body_not_supported',
          '目录工具只改标题、顺序或关联。经授权的定点修订用 book_patch_chapter；新写、续写或插入用 book_generate_chapter。',
          { chapterId: m.id },
        );
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
      if (!change || 'delete' in change) this.reads.readSet.delete(docKey(ref));
      else
        this.reads.readSet.set(docKey(ref), {
          ...ref,
          revision: digest(renderDocument(ref, change.fields, change.body)),
        });
    }
    if (target) {
      this.recordReferences(operations, report);
      if (!ctx.signal.aborted) {
        const view = await this.workspace.readAll(this.bookId);
        const check = this.check(view);
        this.publish(view.documents, ctx, check, report.error);
        await this.saveGoal(ctx, check);
      }
    }
    if (report.error) throw new ToolFailure(report.reason ?? 'unknown', report.error, report);
    return report;
  }
  private writingIntent(
    arrangement?: string,
    confirmed?: string,
    author = this.input.authorPrompt,
  ): WritingIntent {
    return {
      author,
      currentAuthor: this.input.authorPrompt ?? this.input.scope?.currentAuthor,
      continued: this.inheritedDirections,
      confirmed,
      arrangement,
    };
  }
  private async generateAssets(input: AssetInput, arrangement: string | undefined, ctx: RunContext) {
    if (ctx.session.bookId !== this.bookId)
      throw new ToolFailure('invalid_options', '生成资料必须使用本次会话绑定的作品。');
    this.requireEditAction();
    const taskScope = this.input.scope;
    const operation = `${input.kind}.${input.action}` as ScopeOperation;
    const expectedRevisions = new Map<string, string>();
    if (taskScope && input.action === 'update') {
      const { documents } = await this.workspace.readAll(this.bookId);
      const sync = this.scopeSyncTargets(documents);
      const routes = input.targets.map(({ id }) => ({
        id,
        route: taskScope.assetUpdateRoute(
          input.kind,
          id,
          ctx,
          sync.find(({ key }) => key === `${input.kind}/${id}`),
        ),
      }));
      const blocked = routes.find(({ route }) => route !== 'sync' && route !== 'open');
      if (blocked) {
        const { id, route } = blocked;
        const hint = this.assetUpdateHint(input.kind, id, route);
        const reason =
          route === 'sync_conflict'
            ? 'conflict'
            : route === 'unregistered'
              ? 'invalid_options'
              : 'asset_update_route';
        throw new ToolFailure(reason, hint);
      }
      if (routes.some(({ route }) => route === 'sync')) {
        if (routes.some(({ route }) => route !== 'sync'))
          throw new ToolFailure('asset_update_route', '受限同步与开放式更新须分别调用；本批未提交。');
        ctx = taskScope.track(
          ctx,
          routes.map(({ id }) => ({ operation: `${input.kind}.sync`, id })),
        );
        return this.reconcileAssets(input, ctx, sync);
      }
      for (const { id } of input.targets) {
        const doc = documents.find((entry) => entry.type === input.kind && entry.id === id);
        if (!doc || this.reads.readSet.get(docKey(doc))?.revision !== doc.revision)
          throw new ToolFailure('context_required', '更新前须读取相应资料的当前版本。');
        expectedRevisions.set(id, doc.revision);
      }
    }
    const permitted =
      !!taskScope && input.targets.every(({ id }) => taskScope.allows(operation, id, ctx));
    const whole = !!this.target && input.action !== 'update';
    if (taskScope)
      ctx = taskScope.track(
        ctx,
        input.targets.map(({ id }) => ({ operation, id })),
      );
    if (
      taskScope &&
      operation === 'subject.create' &&
      input.targets.some(
        ({ id, relatedSubjectIds }) =>
          new Set(relatedSubjectIds ?? []).size < (taskScope.item(operation, id)?.relatedMinimum ?? 0),
      )
    )
      throw new ToolFailure('invalid_arguments', '关联的不同既有主体数不足登记要求。');
    if (taskScope && !permitted && !whole)
      throw new ToolFailure('invalid_options', '这些资料与动作不在本轮有效执行范围。');
    if (input.action === 'update' && this.edit) {
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
    let authorized: DocRef[] = [];
    const scopedWrite = taskScope && input.action === 'create' ? editWriteContext(ctx) : undefined;
    const recordCreation = (ref: DocRef, revision: string) => {
      const key = docKey(ref);
      this.createdHere.add(key);
      if (scopedWrite) this.directCommits.push({ target: key, revisions: { [key]: revision } });
    };
    const checkpoint = async () => {
      if (!this.task || ctx.signal.aborted) return;
      const view = await this.workspace.readAll(this.bookId);
      const check = this.check(view);
      this.publish(view.documents, ctx, check);
      await this.saveGoal(ctx, check);
    };
    try {
      const result = await generateStoryAssets(
        this.workspace,
        scopedWrite?.ctx ?? ctx,
        this.provider,
        input,
        this.writingIntent(
          arrangement,
          undefined,
          permitted
            ? input.targets.map(({ id }) => taskScope!.instruction(operation, id)).join('\n')
            : undefined,
        ),
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
        permitted || (!!taskScope && whole),
        expectedRevisions,
      );
      if (input.action === 'create') {
        const observed = scopedWrite?.revisions(result.assets);
        for (const saved of result.assets)
          recordCreation(saved, observed?.[docKey(saved)] ?? saved.revision);
      }
      if (target) {
        for (const saved of result.assets) this.referenceFailures.delete(docKey(saved));
        await checkpoint();
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
  private async generate(
    chapterId: string,
    mode: ChapterAction,
    direction: string,
    plan: ChapterPlan & { insertion?: ChapterInsertion },
    ctx: RunContext,
  ) {
    this.requireEditAction();
    const scope = this.input.scope;
    const operation = `chapter.${mode}` as ScopeOperation;
    const scoped = scope?.allows(operation, chapterId, ctx);
    if (scope)
      ctx = scope.track(ctx, [
        { operation, id: chapterId },
        ...(mode === 'insert' && plan.insertion?.outline && scope.allows('outline.write', 'outline', ctx)
          ? [{ operation: 'outline.write' as const, id: 'outline' }]
          : []),
      ]);
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
    if (scope && !target && !scoped)
      throw new ToolFailure(
        mode === 'insert'
          ? 'insert_not_authorized'
          : mode === 'replace'
            ? 'rewrite_not_authorized'
            : 'invalid_options',
        '该章及动作不在本轮有效执行范围，请核对作者请求。',
      );
    if (mode === 'insert') {
      const { documents } = await this.workspace.readAll(this.bookId);
      if (scope) {
        const chapter = documents.find((doc) => doc.type === 'chapter' && doc.id === chapterId);
        if (!chapter) throw new ToolFailure('missing', `目标章 ${chapterId} 不存在。`, { chapterId });
        if (!plan.insertion)
          throw new ToolFailure('invalid_arguments', '定点插入需要原文锚点和章节版本。', { chapterId });
        if (chapter.revision !== plan.insertion.revision)
          throw new ToolFailure('conflict', `目标章 ${chapterId} 已改版，请重新读取并定位原文。`, {
            chapterId,
          });
        if (this.reads.readSet.get(docKey(chapter))?.revision !== chapter.revision)
          throw new ToolFailure('context_required', '插入前须读取目标章的当前版本。', { chapterId });
        const known = new Set(documents.map(docKey));
        const linked: DocRef[] = [
          ...(plan.subjectIds ?? []).map((id): DocRef => ({ type: 'subject', id })),
          ...(plan.clueIds ?? []).map((id): DocRef => ({ type: 'clue', id })),
        ];
        const missing = linked.filter((ref) => !known.has(docKey(ref)));
        if (missing.length)
          throw new ToolFailure(
            'invalid_references',
            `当前作品没有这些场景资料：${missing.map(docKey).join('、')}。请按实际资料修正引用。`,
            { chapterId, missing },
          );
      }
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
            pendingSync: this.syncStatus(this.syncTargets(documents), ctx),
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
            pendingSync: this.syncStatus(
              this.syncTargets((await this.workspace.readAll(this.bookId)).documents),
              ctx,
            ),
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
        !scope &&
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
        if (scoped?.stage === 'setup' || scoped?.stage === 'reveal') entryStage = scoped.stage;
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
    } else if (!scope && mode !== 'replace' && wantsPassageAddition(this.input.authorPrompt ?? '')) {
      throw new ToolFailure(
        'insert_not_authorized',
        '本轮是指定剧情位置的局部登场增补，请读取既有章并用 insert，不能跳到续写或新章。',
        { chapterId },
      );
    }
    if (mode === 'replace') {
      const { documents } = await this.workspace.readAll(this.bookId);
      const authorized = scope
        ? scoped?.id
        : rewriteTarget(
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
      if (scope && this.reads.readSet.get(docKey(replacement))?.revision !== replacement.revision)
        throw new ToolFailure('context_required', '重写前须读取目标章当前版本。');
      guards = [replacement];
    }
    const insertionKey = anchorKey && plan.insertion && anchorKey + ':' + plan.insertion.revision;
    const previousFailure = insertionKey
      ? this.insertionFailures.get(insertionKey)
      : this.chapterFailures.get(chapterId);
    if (previousFailure) throw previousFailure;
    const draftOwned = mode === 'draft' && this.recordsDraftForCorrection(chapterId, ctx);
    const write = mode === 'insert' || edit || draftOwned ? editWriteContext(ctx) : undefined;
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
      const body = scene && { ...scene, assets: sceneAssets };
      const commit = { target: sceneTarget, anchor: anchorKey, revisions, scene: body };
      if (edit && editPassage) await edit.record(ctx, commit);
      else {
        if (body && sceneAssets.length)
          this.directPassages.set(sceneTarget, {
            chapterId,
            stage: entryStage ?? 'addition',
            assets: sceneAssets,
          });
        this.directCommits.push(commit);
      }
      return commit;
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
          [scoped?.purpose, direction].filter(Boolean).join('\n'),
          editPassage?.note ??
            (entryStage === 'setup'
              ? '此处只在正文留下场景安排中的可观察迹象，不提前揭示身份、安排实际登场或回收伏笔。'
              : entryStage === 'reveal'
                ? '按场景安排在正文写出实际登场、对决或揭示；回收仅限本章允许披露的伏笔，不把未来计划写成既成事实。'
                : undefined),
          scoped && scope?.instruction(operation, chapterId),
        ),
        {
          plan,
          insertion: plan.insertion,
          expectedPlacement,
          skill: await this.skills.load('write-chapter', ctx.diagnostic),
          guard: guards,
          retryIncomplete: true,
          onInsertionCorrection: insertionKey
            ? (issues) =>
                this.insertionFailures.set(
                  insertionKey,
                  new ToolFailure(
                    'insertion_quality',
                    '该位置已尝试定向修正；未保存时请报告问题，不要原样重发。',
                    { chapterId, issues },
                  ),
                )
            : undefined,
          budgetPurpose: target ? 'long-writing' : undefined,
          directProse: !!target || mode === 'insert',
          captureInsertion:
            mode === 'insert'
              ? (value) => {
                  scene = value;
                }
              : undefined,
          whole: !!target,
        },
      );
      this.remember(saved);
      let outlineRevision: string | undefined;
      let insertionRef: string | undefined;
      if (mode === 'insert') {
        const state = { chapterId, revision: saved.revision, outlineUpdated: !!plan.insertion?.outline };
        this.inserted.set(anchorKey ?? chapterId, state);
        if (!edit) this.inserted.set(chapterId, state);
        const expected: DocRef[] = [{ type: 'chapter', id: chapterId }];
        if (plan.insertion?.outline) expected.push({ type: 'outline', id: 'outline' });
        const revisions = write!.revisions(expected);
        outlineRevision = revisions['outline/outline'];
        const commit = await recordScene(revisions, scene);
        insertionRef = this.issueInsertionRef(ctx, chapterId, saved.revision, plan.insertion, commit);
        await this.publishEdit(ctx);
      }
      if (draftOwned && write && !ctx.signal.aborted) {
        const ref = { type: 'chapter' as const, id: chapterId };
        this.draftedHere.set(chapterId, write.revisions([ref])[chapterKey]);
      }
      if (target && !ctx.signal.aborted) {
        if (this.task?.failedChapterId === chapterId) this.task.failedChapterId = undefined;
        const view = await this.workspace.readAll(this.bookId);
        const check = this.check(view);
        this.publish(view.documents, ctx, check);
        await this.saveGoal(ctx, check);
      }
      return {
        chapterId,
        revision: saved.revision,
        ...(mode === 'insert' && {
          inserted: true,
          outlineUpdated: !!plan.insertion?.outline,
          outlineRevision,
          ...(insertionRef && { insertionRef }),
          ...((edit || scope) && {
            pendingSync: this.syncStatus(
              this.syncTargets((await this.workspace.readAll(this.bookId)).documents),
              ctx,
            ),
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
          ...(error instanceof InsertionQualityFailure && { issues: error.issues }),
        },
      );
      if (
        !(error instanceof WritingContextFailure) &&
        (target || reason === 'incomplete_stream' || reason === 'output_limit')
      )
        (insertionKey ? this.insertionFailures : this.chapterFailures).set(
          insertionKey || chapterId,
          failure,
        );
      if (target && this.task && !ctx.signal.aborted) {
        this.task.failedChapterId = chapterId;
        const view = await this.workspace.readAll(this.bookId);
        const check = this.check(view);
        this.publish(view.documents, ctx, check, failure.message);
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
      discovery: {
        purpose: '拟定作品修改方案，记录供后续确认的范围',
        aliases: ['只给方案', '修改建议', '改稿计划'],
      },
      schema: editPlanSchema,
      execute: async (args, ctx) => {
        if (
          !ctx.stageEditProposal ||
          (!this.input.scope && this.editMode !== 'proposal') ||
          ctx.session.bookId !== this.bookId
        )
          throw new ToolFailure('invalid_options', '只有作者明确询问绑定作品的方案时才可登记建议。');
        const plan = readEditPlan(args);
        if (!plan) throw new ToolFailure('invalid_arguments', '方案须包含有界的资产或位置及简要安排。');
        const { documents } = await this.workspace.readAll(this.bookId);
        checkBookEditPlan(plan, documents);
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
      ...(this.input.scope || this.editMode === 'proposal' ? [proposalTool] : []),
      {
        name: 'book_get_context',
        description: `${bookContextDescription}按写入要求核对有关现稿，不反复读取未变化的同版资料。仅本轮明确的整书请求用 book_task_scope 登记 novel.register 或 novel.resume，加载指南后用 novelGoal 激活；check 只核对活动目标。局部读取不传 novelGoal。`,
        discovery: {
          ...bookContextDiscovery,
          aliases: [...bookContextDiscovery.aliases, '激活整书目标', '核对整书目标'],
        },
        schema: object(
          {
            ...bookContextProperties,
            novelGoal: object(
              {
                action: {
                  type: 'string',
                  enum: ['register', 'resume', 'check'],
                  description:
                    'register 建完整目标（含已有稿）；resume 恢复已保存目标；check 核对本轮目标',
                },
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
      bookSearchTool(this.workspace, this.bookId),
      {
        name: 'book_apply_changes',
        description:
          '提交已登记的大纲和章节目录，不接受章节正文。独立写大纲：先读取目标当前版，再按需取用主体、伏笔和前文，不必扫读全书；用真实 Markdown 链接标明采用的来源。可与已登记目录同批提交；可选关系字段用 null 清除。整书范围先激活目标；已有资料的说明走 book_generate_assets(update) 或 book_patch_asset，不在这里生成或改写。按实际提交结果汇报。',
        discovery: {
          purpose: '提交作品大纲与章节目录变更',
          aliases: ['新建章节目录', '调整章序', '写入大纲'],
        },
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
      ...(this.input.scope
        ? [
            {
              name: 'book_patch_asset',
              description:
                '普通范围任务定点修订已有主体或伏笔一处短说明。用 book_get_context 按类型和 ID 回读当前版；查找预览不是原文。用 book_task_scope 的 subject.update／clue.update.assetPatch 登记确切 revision、quote、replacement 后提交相同变更，不写其它字段或生成整份说明。无法定点时按授权用原全文更新或保留待办。',
              discovery: {
                purpose: '修订已有主体或伏笔的一处说明短句，把原句改成指定文字',
                aliases: ['人物卡', '人物简介', '主体说明', '伏笔说明', '定点替换', '短句局部修订'],
              },
              schema: object({
                kind: { type: 'string', enum: ['subject', 'clue'] },
                id: idSchema,
                ...assetPatchFields,
              }),
              execute: ({ kind, id, revision, quote, replacement }, ctx) =>
                this.patchAsset(kind, id, { revision, quote, replacement }, ctx),
            } satisfies LocalTool,
          ]
        : []),
      {
        name: 'book_generate_assets',
        description:
          '独立生成或补齐一小批同类主体／伏笔说明，每个目标按自己的关联取材；缺少其他资料不必先补。create 主体传 fields:{name,kind}，可传 relatedSubjectIds；伏笔传 fields:{title}，按需加 subjectIds 与真实埋设／回收章 ID。未排期就省略，不建占位章。fill 只补空说明，保留字段。开放式 update 和已登记的 subject.sync／clue.sync 分开调用；同步只传对应 ID；资料定点用 book_patch_asset。不要在参数里写正文，按已提交回执汇报。',
        discovery: {
          purpose: '新建主体或伏笔、补齐空白资料、开放式改写整份说明或同步已写场景',
          aliases: ['生成人物卡', '补全伏笔资料', '整份说明更新', '同步关联场景'],
        },
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
        name: 'book_clean_insert_echo',
        description:
          '仅清理本轮刚提交的插入片段首尾可证实的相邻旧文回声。传成功 insert 返回的 insertionRef、章 ID 和该次提交的修订；不提供范围或新文，不修改旧稿。拒绝时保留现稿并报告。若返回待同步，用合法的资料同步动作核验。',
        discovery: { purpose: '清理本轮插入片段首尾的重复文字', aliases: ['清理回声'] },
        schema: object({
          chapterId: idSchema,
          revision: revisionSchema,
          insertionRef: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
        }),
        execute: async ({ chapterId, revision, insertionRef }, ctx) =>
          this.cleanInsertion(chapterId, revision, insertionRef, ctx),
      },
      {
        name: 'book_patch_chapter',
        description:
          '按当前作者明确授权定点修改一章的少量原文，不用于插入新场景或整章重写。先用 book_get_context 按章节 ID 读取当前版本与完整短原文。只需把一处段间空白缩为 1 个空行时，edits 只填一个 paragraphGap：用前段原样短尾和后段原样短首定位，不抄中间换行，不提交替换正文或 evidence。章内搬移优先同一批删除旧段并在新锚点补入；任一项不成立则整批不写。还需修订时重读新版本后继续，不重发旧补丁。只有本轮从空白生成并保持原提交版本的整书新稿，才可另凭已读取的前章原文证据做明确事实勘误。',
        discovery: {
          purpose: '定点替换、删除或搬移章节旧文，修整段间空白',
          aliases: ['改一句正文', '局部修订', '删除多余换行', '保留一个空行'],
        },
        schema: object(
          {
            chapterId: idSchema,
            revision: revisionSchema,
            edits: {
              type: 'array',
              minItems: 1,
              maxItems: patchEntryLimit,
              items: {
                anyOf: [
                  object(
                    {
                      quote: str(
                        '已读取的当前版中唯一的完整短原文，不得截断或归一化',
                        patchFragmentLimit,
                      ),
                      replacement: {
                        type: 'string',
                        maxLength: patchFragmentLimit,
                        description: '替换后的局部正文；空字符串表示定点删除',
                      },
                      part: patchPart,
                    },
                    ['quote', 'replacement'],
                  ),
                  object(
                    {
                      paragraphGap: object({
                        leftQuote: paragraphQuote('前段原样结尾的单行短文，不含分隔换行'),
                        rightQuote: paragraphQuote('后段原样开头的单行短文，不含分隔换行'),
                        blankLines: {
                          type: 'integer',
                          enum: [1],
                          description: '保留 1 个空行（2 个 LF）',
                        },
                      }),
                      part: patchPart,
                    },
                    ['paragraphGap'],
                  ),
                ],
              },
            },
            evidence: {
              type: 'array',
              minItems: 1,
              maxItems: patchEntryLimit,
              uniqueItems: true,
              items: object({
                chapterId: idSchema,
                revision: revisionSchema,
                quote: str('已读取的其他来源章精确短原文', patchFragmentLimit),
              }),
            },
          },
          ['chapterId', 'revision', 'edits'],
        ),
        execute: async ({ chapterId, revision, edits, evidence }, ctx) =>
          this.patchChapter(chapterId, revision, edits, evidence, ctx),
      },
      {
        name: 'book_generate_chapter',
        description:
          '每次流式生成一章。独立 draft 只需已保存的目标目录，可复用相关大纲、前文、主体和阶段可见的伏笔；subjectIds / clueIds 是选材线索，不是必需项。仅当前作者明确要求的证据不可用才因缺料停止。依次生成多章，下一章复用实际提交的前文。insert 先读目标版本与唯一原文锚点，可按需附本章大纲增补；成功后可凭 insertionRef 请求清理新增段回声。后接章已有正文时保留 nextBoundary；replace 仍需明确授权。整书先激活目标，再顺序写空白章。',
        discovery: {
          purpose: '起草空白章正文、续写或重写全章、在已有章节插入新场景',
          aliases: ['写新章正文', '增补场景', '插入过渡', '从空白写正文'],
        },
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
              description: '有助本章取材的真实主体 ID（可选）',
            },
            clueIds: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: idSchema,
              description: '有助本章取材的真实伏笔 ID（可选）；按目标章限制披露',
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
