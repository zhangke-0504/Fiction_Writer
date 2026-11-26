import { randomUUID } from 'node:crypto';
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
  patchBody,
  patchEntryLimit,
  patchFragmentLimit,
  reviewProsePatch,
  type ProseEdit,
  type PatchEvidence,
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
import type { ModelProvider } from './model.js';
import type { SkillCatalog, SkillName } from './skills.js';
import type { RunContext } from './runs.js';
import {
  noteSyncTargets,
  preservesSyncEvidence,
  sceneText,
  syncStoryNote,
  type SceneStage,
} from './story-sync.js';
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
const typeSchema = { type: 'string', enum: ['book', ...activeTypes] };
const idSchema = str('使用文件的稳定 ID，而不是名称', 128);
const page = { type: 'integer', minimum: 0 };
const revisionSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
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
  private readonly insertionFailures = new Map<string, ToolFailure>();
  private readonly currentInsertions = new Map<string, CurrentInsertion>();
  private readonly targetedReads = new Set<string>();
  private readonly readSet = new Map<string, Guard>();
  private readonly chapterReads = new Map<string, { revision: string; ranges: [number, number][] }>();
  private populatedAtStart?: Set<string>;
  private readonly draftedHere = new Map<string, string>();
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
      return `\n本轮承接同会话已确认方案（不是整书任务或全局权限）。活动范围：${JSON.stringify(this.edit.plan)}。未提交的目标：${JSON.stringify(this.edit.remaining(documents))}。已写入的不重做。资产调用按方案的 kind/action/id，fields 与关联由方案提供。按需读取正文和大纲当前修订，用 book_generate_chapter mode=insert、insertion.targetId 匹配方案位置，附本章唯一原文锚点和当前大纲 revision。每处成功后的大纲 revision 会更新；不要用通用覆盖。正文必须实际写入；该 Run 新段若仍有边界回声，用其成功插入回执请求 book_clean_insert_echo，拒绝时报告，不扩大授权。已写正文相关的新资料用 book_generate_assets action=update 同步，只传资料类型和 ID。待同步：${JSON.stringify(this.syncStatus(documents))}。`;
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
  canDeliverWholeSkill = () => this.editMode === 'direct';
  skillApplied(name: SkillName) {
    if (this.canDeliverWholeSkill() && name === 'generate-novel') this.wholeSkill = true;
  }
  // For manual acceptance, the per-run cap is uniform regardless of goal size.
  roundLimit = () => defaultRoundLimit;
  budgetPurpose = () => (this.wholeSkill ? ('long-writing' as const) : undefined);
  /** Recovery uses current targets and receipts, never the truncated model output. */
  narrowedWritingStep = async (ctx: RunContext): Promise<NarrowedWritingStep | undefined> => {
    const edit = this.editMode === 'confirmed' && this.edit?.hasTargets ? this.edit : undefined;
    const scope = this.input.scope;
    const scoped = !!scope?.items.length && !this.wholeWork;
    if (
      ctx.session.bookId !== this.bookId ||
      (!scoped && !edit && !(this.wholeSkill && this.canDeliverWholeSkill()))
    )
      return;
    const view = await this.workspace.readAll(this.bookId);
    ctx.signal.throwIfAborted();
    if (view.diagnostics.length) return;
    const docs = view.documents;
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
      const cursor = this.offsets.get(key);
      const offset = cursor?.revision === doc.revision ? cursor.next : 0;
      if (
        this.targetedReads.has(this.documentReadKey(doc, offset)) ||
        (doc.type !== 'chapter' && this.readSet.get(key)?.revision === doc.revision)
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
      if (this.targetedReads.has(this.indexReadKey(docs, index, 0))) return;
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
      const { remaining, done, total } = scope.summarize(docs);
      const sync = this.syncStatus(docs);
      const status = `本轮任务已核对 ${done}/${total} 项；待做：${
        [
          ...remaining.map(({ operation, id, part }) => `${operation}/${id}${part ? '/' + part : ''}`),
          ...sync.map(({ key }) => `同步 ${key}`),
        ]
          .slice(0, 6)
          .join('、') || '无'
      }`;
      if (!remaining.length && !sync.length) return plan(status, true);

      const unread = (doc: Manuscript) => this.readSet.get(docKey(doc))?.revision !== doc.revision;
      const syncKeys = new Set(sync.map(({ key }) => key));
      for (const { key, ready } of sync) {
        const [kind, id] = key.split('/');
        if (ready && (kind === 'subject' || kind === 'clue') && scope.allows(`${kind}.update`, id, ctx))
          offerAsset(kind, id, 'update', true);
      }
      for (const { operation, id, part } of remaining) {
        if (!scope.allows(operation, id, ctx, part)) continue;
        const [kind, action] = operation.split('.');
        const key = `${kind}/${id}`;
        const doc = byKey.get(key);
        if (kind === 'subject' || kind === 'clue') {
          if (action === 'update' && doc && !syncKeys.has(key)) {
            if (unread(doc)) readDoc(key);
            else offerAsset(kind, id, action);
          } else if (action === 'create' && !doc) offerAsset(kind, id, action);
          else if (action === 'fill' && doc && !hasStoryDescription(doc.body))
            offerAsset(kind, id, action);
          continue;
        }
        if (operation === 'outline.write' || operation === 'chapter.catalog') {
          // The existing outline writer validates references against current, read revisions.
          const basis =
            operation === 'outline.write'
              ? docs.find(
                  (entry) => ['outline', 'subject', 'clue'].includes(entry.type) && unread(entry),
                )
              : doc && unread(doc)
                ? doc
                : undefined;
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
          const hasProse = this.chapterReads.get(id)?.revision === doc.revision;
          if (!hasProse || this.offsets.has(key)) readDoc(key);
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
      const sync = this.syncStatus(docs);
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
      const action = ctx.continuation ? 'resume' : 'register';
      const operation = action === 'resume' ? 'novel.resume' : 'novel.register';
      if (scope && !scope.allows(operation, this.bookId, ctx)) {
        add(
          'book_task_scope',
          '先登记 ' + operation + '（作品 ID：' + this.bookId + '），保留完整目标',
          (a) => {
            const item = Array.isArray(a.items) && a.items.length === 1 && asRecord(a.items[0]);
            return !!item && item.operation === operation && item.id === this.bookId;
          },
        );
      } else {
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
      }
      readIndex('chapters');
      for (const doc of docs.filter((d) => d.type === 'book' || d.type === 'outline'))
        readDoc(docKey(doc));
      return plan('整书指引已派发，目标尚未在本轮核对，无法判定具体卡在哪一章');
    }
    const check = this.check(view);
    const status = `已保存正文 ${check.done}/${check.total} 章${goalProblem(check) ? `；${goalProblem(check)}` : ''}`;
    if (check.catalogConflict) return plan(status);
    if (check.complete) return plan(status, true);
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
    const outlineBasis = needsOutline
      ? docs.filter(
          (doc) =>
            ['outline', 'subject', 'clue'].includes(doc.type) &&
            this.readSet.get(docKey(doc))?.revision !== doc.revision,
        )
      : [];
    if (needsOutline && !outlineBasis.length) {
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
    if (check.ready && check.firstUnwritten && !this.chapterFailures.has(check.firstUnwritten)) {
      add(
        'book_generate_chapter',
        `仅写下一空白章 ${check.firstUnwritten}`,
        (a) => a.mode === 'draft' && a.chapterId === check.firstUnwritten && !a.insertion,
      );
      readDoc(`chapter/${check.firstUnwritten}`);
    }
    for (const d of outlineBasis) readDoc(docKey(d));
    return plan(status);
  };
  private documentReadKey(doc: Manuscript, offset: number) {
    return `${docKey(doc)}:${doc.revision}:${offset}`;
  }
  private indexReadKey(docs: Manuscript[], index: ReferenceIndex, offset: number) {
    return `index:${index}:${offset}:${digest(JSON.stringify(referenceIndex(docs, index, offset)))}`;
  }
  restorePrimaryFailure() {
    const last = [...this.chapterFailures.values()].at(-1);
    if (this.wholeSkill && last) throw last;
  }
  private get wholeWork() {
    return this.wholeSkill || !!this.input.scope?.whole;
  }
  private missingGoal(ctx: RunContext) {
    const action = ctx.continuation ? 'resume' : 'register';
    const operation = action === 'resume' ? 'novel.resume' : 'novel.register';
    const scope = this.input.scope;
    const next =
      scope && !scope.allows(operation, this.bookId, ctx)
        ? '用 book_task_scope 登记 ' + operation + '（id=' + this.bookId + '），不要逐章登记；再'
        : '';
    const goal =
      action === 'register' ? '，chapterIds 须为完整有序目标，包含已保存的章节' : '，沿用原目标，不另建';
    return new ToolFailure(
      'novel_goal_required',
      '整书目标未登记或尚未恢复。' +
        (this.wholeSkill ? '' : '先加载 generate-novel；') +
        next +
        '调用 book_get_context 的 novelGoal.' +
        action +
        goal +
        '。',
    );
  }
  private requireGoal(ctx: RunContext) {
    if (this.wholeWork && !this.target) throw this.missingGoal(ctx);
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
        const expected = this.input.scope
          ? this.input.scope.whole?.count
          : requestedChapterCount(this.input.authorPrompt ?? '');
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
        const historical = this.input.scope?.whole?.sourceAuthorLine;
        const originalLine = historical ?? ctx.authorLine;
        const original = historical === undefined ? undefined : ctx.history?.lines[historical];
        if (original?.role === 'user') this.inheritedDirections = [original.text];
        this.task = {
          chapterIds: [...ids],
          originalLine,
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
    this.requireGoal(ctx);
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
  async reportInterruptedTask(ctx: RunContext) {
    if (!this.input.scope?.items.length) return;
    if (ctx.signal.aborted) {
      ctx.taskOutcome?.('cancelled');
      ctx.diagnostic?.('writing.task_result', { outcome: 'cancelled' });
    } else if (this.wholeWork) {
      const check = this.target && this.check(await this.workspace.readAll(this.bookId));
      ctx.taskOutcome?.(check && check.done > 0 ? 'partial' : 'incomplete');
    } else await this.assertFinished(ctx);
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
    if (this.input.scope && !this.wholeWork) {
      const { documents } = await this.workspace.readAll(this.bookId);
      const check = this.input.scope.summarize(documents);
      const pending = this.syncTargets(documents).filter((item) => !item.synced);
      const undisclosed = pending.filter(
        (item) =>
          !check.remaining.some(({ operation, id }) => `${operation.split('.')[0]}/${id}` === item.key),
      );
      const complete = !check.remaining.length && !pending.length;
      const remaining = [
        ...check.remaining.map(({ id, part, purpose }) => (part ? `${id}：${purpose}` : id)),
        ...undisclosed.map(({ key }) => `待同步 ${key}`),
      ];
      const total = check.total + undisclosed.length;
      if (!total) return;
      ctx.taskOutcome?.(
        complete
          ? check.noWrite
            ? 'no_write_needed'
            : 'fulfilled'
          : check.done
            ? 'partial'
            : 'incomplete',
      );
      ctx.progress({
        step: complete ? (check.noWrite ? '已满足，无需写入' : '任务已完成') : '任务未全部完成',
        total,
        done: check.done,
        complete,
        message: remaining.length ? `仍需核对或提交：${remaining.join('、')}` : undefined,
      });
      ctx.diagnostic?.('writing.task_result', {
        count: total,
        done: check.done,
        outcome: complete ? (check.noWrite ? 'reused' : 'ok') : check.done ? 'partial' : 'failed',
      });
      return;
    }
    if (!this.wholeWork) return;
    if (!this.target) {
      if (this.input.scope) ctx.taskOutcome?.('incomplete');
      throw this.missingGoal(ctx);
    }
    const check = this.check(await this.workspace.readAll(this.bookId));
    const failure = check.firstUnwritten && this.chapterFailures.get(check.firstUnwritten);
    this.publish(check, ctx, failure ? failure.message : undefined);
    if (this.input.scope)
      ctx.taskOutcome?.(check.complete ? 'fulfilled' : check.done ? 'partial' : 'incomplete');
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
      length?: number;
      index?: ReferenceIndex;
      novelGoal?: GoalRequest;
    },
    ctx: RunContext,
  ) {
    const view = await this.workspace.readAll(this.bookId);
    if (args.novelGoal && this.editMode !== 'direct')
      throw new ToolFailure('invalid_options', '本轮不是整书请求，不登记或续接整书目标。');
    if (args.novelGoal) {
      if (
        this.input.scope &&
        !this.input.scope.allows(
          args.novelGoal.action === 'resume' ? 'novel.resume' : 'novel.register',
          this.bookId,
          ctx,
        ) &&
        !(args.novelGoal.action === 'check' && this.target)
      ) {
        if (this.wholeWork) throw this.missingGoal(ctx);
        throw new ToolFailure('invalid_options', '当前没有此作品的有效整书目标范围。');
      }
      return this.goalView(args.novelGoal, view, ctx);
    }
    const offset = args.offset ?? 0;
    if (args.index) {
      this.targetedReads.add(this.indexReadKey(view.documents, args.index, offset));
      return referenceIndex(view.documents, args.index, offset);
    }
    const documents = view.documents
      .filter((d) => !args.type || d.type === args.type)
      .sort((a, b) => priority[a.type] - priority[b.type]);
    if (args.documentId) {
      const matches = documents.filter((d) => d.id === args.documentId);
      if (matches.length !== 1) throw new Error('文档不存在或 ID 不唯一，请同时指定 type');
      const doc = matches[0],
        key = docKey(doc),
        end = Math.min(doc.body.length, offset + (args.length ?? 44_000)),
        continued = this.offsets.get(key);
      if (offset === 0 || (continued?.revision === doc.revision && continued.next === offset)) {
        this.targetedReads.add(this.documentReadKey(doc, offset));
        if (end === doc.body.length) {
          this.remember(doc);
          this.offsets.delete(key);
        } else this.offsets.set(key, { revision: doc.revision, next: end });
      }
      const result = {
        document: { ...projection(doc, false), body: doc.body.slice(offset, end) },
        nextOffset: end < doc.body.length ? end : null,
        diagnostics: view.diagnostics.slice(0, 25),
      };
      if (
        doc.type === 'chapter' &&
        offset < end &&
        JSON.stringify({ ok: true, value: result }).length <= 120_000
      )
        this.rememberChapterRange(doc, offset, end);
      return result;
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
  private rememberChapterRange(doc: Manuscript, start: number, end: number) {
    const current = this.chapterReads.get(doc.id);
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
    this.chapterReads.set(doc.id, { revision: doc.revision, ranges: merged.slice(0, 64) });
  }
  private requirePatchQuote(doc: Manuscript, quote: string, evidence = false) {
    const { start, end } = exactRange(doc.body, quote, evidence ? 'patch_evidence' : 'patch_anchor');
    const read = this.chapterReads.get(doc.id);
    if (read?.revision !== doc.revision || !read.ranges.some(([from, to]) => from <= start && end <= to))
      throw new ToolFailure(
        evidence ? 'patch_evidence' : 'context_required',
        '请按章节 ID 定向读取当前修订及对应完整短原文。',
        { chapterId: doc.id },
      );
  }
  private recordsDraftForCorrection(chapterId: string, ctx: RunContext) {
    const author = this.input.authorPrompt?.normalize('NFKC') ?? '';
    return (
      !!this.populatedAtStart &&
      !this.populatedAtStart.has(chapterId) &&
      this.target?.includes(chapterId) &&
      this.wholeSkill &&
      this.editMode === 'direct' &&
      !ctx.continuation &&
      (this.input.scope
        ? this.input.scope.whole?.operation === 'novel.register'
        : !proposalOnly(author) &&
          !blocksProsePatch(author) &&
          !/^(?:请\s*)?(?:继续|接着|续写)/u.test(author.trim()) &&
          /(?:写完|写成|写|创作|生成|编写|撰写|完成|补全|补齐|构思并写)[^。；;\n]{0,32}(?:整本|一整本|全书|整部|本书|这本小说|一部小说|[\d零一二三四五六七八九十两百]+\s*章)|(?:整本|全书|整部)[^。；;\n]{0,16}(?:写完|创作|生成)/u.test(
            author,
          ))
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
            ? this.input.scope.allows(
                `${key.split('/')[0]}.update` as ScopeOperation,
                key.split('/')[1],
                ctx,
              )
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
        pendingSync: this.syncStatus(nextDocs),
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
    edits: ProseEdit[],
    evidence: PatchEvidence[] = [],
    ctx: RunContext,
  ) {
    const ref = { type: 'chapter' as const, id: chapterId };
    const taskScope = this.input.scope;
    const reportPatch = diagnosticScope(ctx.diagnostic ?? noDiagnostic, { documentRef: docKey(ref) });
    const parts = new Set(edits.map(({ part }) => part).filter((part): part is string => !!part));
    try {
      ctx.signal.throwIfAborted();
      const targets = taskScope?.patchTargets(chapterId, edits, ctx);
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
        await reviewProsePatch(this.provider, ctx, {
          author,
          chapter: { id: doc.id, title: doc.fields.title, order: doc.fields.order },
          edits,
        });
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
  private async apply(operations: Mutation[], ctx: RunContext) {
    this.requireEditAction();
    if (this.edit)
      throw new ToolFailure(
        'invalid_options',
        '已确认的局部方案使用资产工具和逐章 insert；不能用通用工具扩大写入范围。',
      );
    const target = this.requireGoal(ctx);
    const scope = this.input.scope;
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
    if (scope && !target)
      ctx = scope.track(
        ctx,
        operations.map(({ type, id }) => ({
          operation: type === 'outline' ? 'outline.write' : 'chapter.catalog',
          id,
        })),
      );
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
  private writingIntent(
    arrangement?: string,
    confirmed?: string,
    author = this.input.authorPrompt,
  ): WritingIntent {
    return {
      author,
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
    const permitted =
      !!taskScope && input.targets.every(({ id }) => taskScope.allows(operation, id, ctx));
    const whole = !!this.target && input.action !== 'update';
    const expectedRevisions = new Map<string, string>();
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
    if (input.action === 'update' && (this.edit || taskScope)) {
      const synced = await this.reconcileAssets(input, ctx);
      if (synced) return synced;
    }
    if (taskScope && input.action === 'update') {
      const { documents } = await this.workspace.readAll(this.bookId);
      for (const { id } of input.targets) {
        const doc = documents.find((entry) => entry.type === input.kind && entry.id === id);
        if (!doc || this.readSet.get(docKey(doc))?.revision !== doc.revision)
          throw new ToolFailure('context_required', '更新前须读取相应资料的当前版本。');
        expectedRevisions.set(id, doc.revision);
      }
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
    const target = this.requireGoal(ctx);
    let authorized: DocRef[] = [];
    const scopedWrite = taskScope && input.action === 'create' ? editWriteContext(ctx) : undefined;
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
      if (input.action === 'create')
        for (const saved of result.assets) recordCreation(saved, saved.revision);
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
    if (scope) ctx = scope.track(ctx, [{ operation, id: chapterId }]);
    const edit = this.edit;
    if (edit && mode !== 'insert')
      throw new ToolFailure(
        'insert_not_authorized',
        '已确认的方案是局部增补，不授权新章、续写或整章覆盖。',
      );
    const target = this.requireGoal(ctx);
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
        if (this.readSet.get(docKey(chapter))?.revision !== chapter.revision)
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
      if (scope && this.readSet.get(docKey(replacement))?.revision !== replacement.revision)
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
          scoped?.purpose ?? direction,
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
          ...(insertionRef && { insertionRef }),
          ...((edit || scope) && {
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
        description:
          '读取当前作品。按 type/documentId 定向读取；index=chapters/subjects/beats 查真实 ID；offset/length 可读限定范围内的精确原文与版本。按写入要求核对有关现稿，不反复读取未变化的同版资料。整书先登记 book_task_scope 的 novel.register 或 novel.resume，再用 novelGoal 激活完整目标；check 只核对活动目标。',
        schema: object(
          {
            type: typeSchema,
            documentId: idSchema,
            offset: page,
            length: {
              type: 'integer',
              minimum: 1,
              maximum: 6000,
              description: '定向读取原文时可选；兼用于取修订所需的精确短句',
            },
            index: { type: 'string', enum: indexes },
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
      {
        name: 'book_apply_changes',
        description:
          '提交小说资料及章节目录变更，不接受章节正文。局部修订用 book_patch_chapter。若用整书 Skill，先用 book_get_context 的 novelGoal 登记／续接。修改既有或已变化的故事资料前，调用不带 index/type 的 book_get_context，读完各页或按 ID 补读。本轮已显式读到的资料未变化时无需重复取回。可批量提交；引用用真实 ID，可选关系字段用 null 清除。AI 生成或补齐主体／伏笔说明用 book_generate_assets；整书不能在这里新建或填写它们。',
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
        name: 'book_clean_insert_echo',
        description:
          '仅清理本轮刚提交的插入片段首尾可证实的相邻旧文回声。传成功 insert 返回的 insertionRef、章 ID 和该次提交的修订；不提供范围或新文，不修改旧稿。拒绝时保留现稿并报告。若返回待同步，用合法的资料同步动作核验。',
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
          '按当前作者明确授权定点修改一章的少量原文，不用于插入新场景或整章重写。先用 book_get_context 读取精确短文与当前版本。章内搬移优先同一批删除旧段并在新锚点补入；任一项不成立则整批不写。还需修订时重读新版本后继续，不重发旧补丁。只有本轮从空白生成并保持原提交版本的整书新稿，才可另凭已读取的前章原文证据做明确事实勘误。',
        schema: object(
          {
            chapterId: idSchema,
            revision: revisionSchema,
            edits: {
              type: 'array',
              minItems: 1,
              maxItems: patchEntryLimit,
              items: object(
                {
                  quote: str('已读取的当前版中唯一的完整短原文，不得截断或归一化', patchFragmentLimit),
                  replacement: {
                    type: 'string',
                    maxLength: patchFragmentLimit,
                    description: '替换后的局部正文；空字符串表示定点删除',
                  },
                  part: str('如已登记同章子目标，填对应 part。删除与补入各用自己的 part。', 64),
                },
                ['quote', 'replacement'],
              ),
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
          '流式生成空白章、续写、明确重写或在旧章锚点只插入新段落。insert 在旧章补写场景，先读该章拿版本和唯一短原文。已有角色和伏笔可直接按 ID 引用，无需新建资料或改目录。若需要更新本章大纲才附局部增补，已有相关安排时不用重复加。正常插入成功可返回 insertionRef，只有本轮凭该回执可请求清理新增片段的确定回声。用 subjectIds / clueIds 指定内容依赖。若没有已写过渡且后章已有正文，提供 nextBoundary。整书先用 novelGoal.register/resume 激活完整目标，再按序 draft 空白章；独立单章不需要整书目标。replace 需本轮明确授权。',
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
