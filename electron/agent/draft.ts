import { randomUUID } from 'node:crypto';
import { diagnosticScope, noDiagnostic } from '../../shared/diagnostics.js';
import { classified, DiagnosticFailure, elapsed, safeReporter } from '../diagnostics/trace.js';
import { applySkill } from './skills.js';
import type { InsertedScene } from './edit-proposal.js';
import type { Change, Manuscript, WriteReport } from '../../shared/contracts.js';
import { chapterPlacementFingerprint, digest, docKey } from '../documents.js';
import type { AssistantTurn, ModelProvider, ModelRequest } from './model.js';
import type { RunContext } from './runs.js';
import type { WorkspaceService, Guard } from '../workspace.js';
import { chapterContext, projectChapter } from './chapter-context.js';
import type { ChapterPlan } from './chapter-boundary.js';
import {
  insertionPoint,
  insertPassage,
  outlineInsertion,
  assessInsertion,
  type ChapterInsertion,
  type InsertionQualityIssue,
} from './chapter-insertion.js';
import {
  prepareWritingDispatch,
  reportWritingBlock,
  reportWritingOutputLimit,
} from './writing-diagnostics.js';
import { collectChapterReadbacks } from './chapter-readback.js';
import { chapterMemoryQuery, recallBookMemory, type ReportMemoryDispatch } from './book-memory.js';
import {
  buildWritingRequest,
  WritingContextFailure,
  type ChapterAction,
  type WritingBlock,
  type WritingIntent,
  writingDirection,
  writingSources,
} from './writing-request.js';

export class DraftCommitFailure extends DiagnosticFailure {
  constructor(
    readonly report: WriteReport,
    readonly scene?: InsertedScene,
  ) {
    super(report.reason ?? 'unknown', report.error ?? '写入未完整提交');
  }
}

const insertionIssueText: Record<InsertionQualityIssue, string> = {
  echo_only: '只复述了锚点旁的已有正文，没有可提交的新增段落',
  neighbor_echo: '新增段落重复了锚点附近的旧文',
  boundary_echo: '新增段落首尾跨句或分句重复了相邻旧段，请从新的动作或内容开始或收束',
  repeated_passage: '新增段落内部重复了句段',
  work_note: '新增段落混入了工作说明或稿外章次回指',
  obvious_typo: '新增段落把代词“自己”写成了“自已”，请保留原意并订正',
};

export class InsertionQualityFailure extends DiagnosticFailure {
  constructor(readonly issues: InsertionQualityIssue[]) {
    super('insertion_quality', issues.map((issue) => insertionIssueText[issue]).join('；'));
  }
}

export async function draftChapter(
  workspace: WorkspaceService,
  ctx: RunContext,
  model: ModelProvider,
  chapterId: string,
  mode: ChapterAction,
  prompt: string | WritingIntent,
  options: {
    skill?: string;
    guard?: Guard[];
    retryIncomplete?: boolean;
    whole?: boolean;
    plan?: ChapterPlan;
    insertion?: ChapterInsertion;
    expectedPlacement?: string;
    budgetPurpose?: ModelRequest['budgetPurpose'];
    directProse?: boolean;
    captureInsertion?: (scene: InsertedScene) => void;
    onInsertionCorrection?: (issues: InsertionQualityIssue[]) => void;
  } = {},
) {
  const bookId = ctx.session.bookId,
    spanId = randomUUID();
  const trace = diagnosticScope(safeReporter(ctx.diagnostic ?? noDiagnostic), {
    workspaceRef: bookId,
    documentRef: docKey({ type: 'chapter', id: chapterId }),
    lane: 'draft',
    spanId,
  });
  const started = performance.now();
  const scope = {
    kind: 'chapter' as const,
    action: mode,
    whole: options.whole,
    chapterSkill: options.skill,
  };
  let attempted = false,
    previewed = false,
    streamed = '',
    committed: Manuscript | undefined;
  let failure: string | undefined;
  let partial = false;
  const clearPreview = () => {
    if (attempted) ctx.preview(undefined);
    if (previewed) trace('chapter.preview', { outcome: 'cleared', textLength: streamed.length });
    attempted = previewed = false;
    streamed = '';
  };
  trace('chapter.generation.started', { action: mode });
  try {
    if (!bookId) throw new DiagnosticFailure('invalid_options', '此操作需要小说会话');
    const view = await workspace.readAll(bookId),
      doc = view.documents.find((d) => d.type === 'chapter' && d.id === chapterId);
    if (!doc) throw new DiagnosticFailure('missing', '目标章节不存在或无法读取');
    if (mode === 'draft' && doc.body.trim())
      throw new DiagnosticFailure('conflict', '这章已有正文。可选择续写，或明确请求重写。');
    const prefix =
      mode === 'append'
        ? doc.body +
          (doc.body && !doc.body.endsWith('\n\n') ? (doc.body.endsWith('\n') ? '\n' : '\n\n') : '')
        : '';
    const offset = mode === 'insert' ? insertionPoint(doc, options.insertion) : undefined;
    const compose = (text: string) =>
      offset === undefined ? prefix + text : insertPassage(doc.body, offset, text);
    const outline =
      mode === 'insert' &&
      options.insertion?.outline &&
      view.documents.find(({ type }) => type === 'outline');
    if (mode === 'insert' && options.insertion?.outline && !outline)
      throw new WritingContextFailure(
        'context_required',
        '需要增补的大纲不存在或无法读取。',
        [{ type: 'outline', id: 'outline' }],
        [{ kind: 'invalid_anchor' }],
      );
    const nextOutline = outline && outlineInsertion(outline, doc, options.insertion!.outline!);
    const intent: WritingIntent = typeof prompt === 'string' ? { author: prompt } : prompt;
    const placement = chapterPlacementFingerprint(view.documents);
    if (options.expectedPlacement !== undefined && placement !== options.expectedPlacement)
      throw new WritingContextFailure('conflict', '已核对的章节顺序或状态变化，请重新读取。', [
        { type: 'chapter', id: chapterId },
      ]);
    const context = chapterContext(view.documents, doc, undefined, {
      plan: options.plan,
      mode,
      author: intent.currentAuthor ?? intent.author,
      direction: [intent.author, intent.confirmed, intent.arrangement].filter(Boolean).join('\n'),
      insertion:
        offset === undefined
          ? undefined
          : { offset, outlineAddition: options.insertion?.outline?.addition },
    });
    const scopedIntent = {
      ...intent,
      confirmed: intent.confirmed && context.visible(intent.confirmed),
      arrangement: intent.arrangement && context.visible(intent.arrangement),
    };
    let reportAttachedMemory: ReportMemoryDispatch | undefined;
    const memory = await recallBookMemory(workspace, bookId, {
      query: chapterMemoryQuery(view.documents, doc, writingDirection(scopedIntent)),
      chapterId,
      documents: view.documents,
      signal: ctx.signal,
      diagnostic: {
        trigger: 'draft',
        report: trace,
        captureDispatch(report) {
          reportAttachedMemory = report;
        },
      },
    });
    const structural = context.blocks.filter(({ group }) => group === 'book' || group === 'outline');
    const evidence = context.blocks.filter(({ group }) => group !== 'book' && group !== 'outline');
    const blocks = [...structural, ...context.memory(memory), ...evidence];
    const compile = (supplement: WritingBlock[], correction?: string) =>
      buildWritingRequest(model, scope, scopedIntent, [...supplement, ...blocks], {
        budgetPurpose: options.budgetPurpose,
        project: projectChapter,
        correction,
      });
    const initial = compile([]);
    const { readbacks, guards } = await collectChapterReadbacks(
      view.documents,
      context.readbackContext(initial.included),
      model,
      writingDirection(scopedIntent),
      ctx.signal,
      trace,
      ctx,
      context.chapterRange,
    );
    const supplement: WritingBlock[] = readbacks.map((row) => {
      const guard = guards.find(({ id }) => id === row.chapterId);
      return {
        group: 'readback',
        value: row,
        sources:
          guard && row.text !== undefined && row.offset !== undefined
            ? [{ ...guard, range: [row.offset, row.offset + row.text.length] }]
            : undefined,
      };
    });
    const compiled = supplement.length ? compile(supplement) : initial;
    const generate = (spanId: string, request = compiled) => {
      attempted = true;
      const attached = projectChapter(request.included);
      const reportDispatch = prepareWritingDispatch(trace, scope, request, spanId);
      return model.turn({
        ...request.request,
        diagnostic: trace,
        spanId,
        onDispatch(dispatchedSpanId) {
          reportDispatch(dispatchedSpanId);
          reportAttachedMemory?.(diagnosticScope(trace, { spanId: dispatchedSpanId }), attached.memory);
          if (options.skill) applySkill(trace, 'write-chapter', options.skill, mode);
        },
        directProse: options.directProse,
        signal: ctx.signal,
        onText(delta) {
          ctx.signal.throwIfAborted();
          streamed += delta;
          if (streamed.length > 300_000) throw new Error('生成正文超过上限');
          ctx.preview({ bookId, chapterId, content: compose(streamed), base: doc.revision });
          if (!previewed) {
            previewed = true;
            trace('chapter.preview', { outcome: 'started' });
          }
        },
      });
    };
    const sources = [
      ...new Map(
        [
          ...writingSources(compiled.included),
          ...(options.guard ?? []),
          ...(outline ? [outline] : []),
        ].map((row) => [docKey(row), row]),
      ).values(),
    ];
    const checkRetry = async () => {
      const current = await workspace.readAll(bookId);
      const byKey = new Map(current.documents.map((entry) => [docKey(entry), entry]));
      for (const source of [doc, ...sources]) {
        ctx.signal.throwIfAborted();
        if (byKey.get(docKey(source))?.revision !== source.revision)
          throw new DiagnosticFailure('conflict', `${docKey(source)} 已变化，请重新读取后再写作`);
      }
      if (chapterPlacementFingerprint(current.documents) !== placement)
        throw new DiagnosticFailure('conflict', '章节顺序或前后已写状态已变化，请重新核对衔接。');
      if (offset !== undefined) insertionPoint(byKey.get(docKey(doc))!, options.insertion);
      ctx.signal.throwIfAborted();
    };
    let turn: AssistantTurn;
    try {
      turn = await generate(spanId);
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (!options.retryIncomplete || classified(error) !== 'incomplete_stream') throw error;
      clearPreview();
      await checkRetry();
      trace('chapter.retry', { reason: 'incomplete_stream' });
      turn = await generate(randomUUID());
    }
    const inspect = (candidate: AssistantTurn, attempt: number) => {
      ctx.signal.throwIfAborted();
      if (candidate.calls.length || !candidate.text.trim())
        throw new DiagnosticFailure('provider_error', '模型没有返回可提交的正文');
      if (offset === undefined) return { text: candidate.text, issues: [] as InsertionQualityIssue[] };
      if (candidate.text.trim().length > 2200)
        throw new DiagnosticFailure('output_limit', '返回内容超过局部增补范围，未写入。');
      const result = assessInsertion(doc.body, offset, candidate.text, intent.author);
      trace('chapter.insertion.checked', {
        outcome: result.issues.length ? 'rejected' : 'ok',
        issue: result.issues[0],
        count: result.issues.length,
        attempt,
      });
      return result;
    };
    let resultText = inspect(turn, 1);
    if (resultText.issues.length) {
      options.onInsertionCorrection?.(resultText.issues);
      clearPreview();
      const correction =
        '上一次候选未写入。重新生成同一处的新增段落；须解决：' +
        resultText.issues.map((issue) => insertionIssueText[issue]).join('；') +
        '。';
      const corrected = compile(supplement, correction);
      // Guard evidence actually delivered to either request, even if their budgets differ.
      for (const source of writingSources(corrected.included))
        if (!sources.some((entry) => docKey(entry) === docKey(source))) sources.push(source);
      await checkRetry();
      trace('chapter.retry', { reason: 'insertion_quality' });
      resultText = inspect(await generate(randomUUID(), corrected), 2);
      if (resultText.issues.length) throw new InsertionQualityFailure(resultText.issues);
    }
    const fragment = resultText.text;
    const body = compose(fragment);
    const scene =
      offset === undefined || !options.captureInsertion
        ? undefined
        : {
            offset,
            size: body.length - doc.body.length,
            fragmentOffset: body.slice(offset, offset + body.length - doc.body.length).indexOf(fragment),
            length: fragment.length,
            digest: digest(fragment),
          };
    const changes: Change[] = [
      { type: 'chapter', id: chapterId, expect: doc.revision, fields: doc.fields, body },
    ];
    if (outline && typeof nextOutline === 'string')
      changes.push({
        type: 'outline',
        id: outline.id,
        expect: outline.revision,
        fields: outline.fields,
        body: nextOutline,
      });
    const result = await workspace.writeChanges(
      bookId,
      changes,
      ctx.signal,
      sources,
      trace,
      false,
      placement,
    );
    if (result.error) {
      partial = result.committed.length > 0;
      throw new DraftCommitFailure(result, scene);
    }
    committed = await workspace.readDocument(bookId, { type: 'chapter', id: chapterId });
    if (scene) options.captureInsertion?.(scene);
    return committed;
  } catch (error) {
    if (error instanceof WritingContextFailure) reportWritingBlock(trace, scope, error);
    failure = classified(error, ctx.signal);
    if (failure === 'output_limit') reportWritingOutputLimit(trace, scope);
    throw error;
  } finally {
    clearPreview();
    trace('chapter.generation.finished', {
      action: mode,
      outcome: !failure
        ? 'ok'
        : partial
          ? 'partial'
          : failure === 'cancelled' || failure === 'conflict'
            ? failure
            : 'failed',
      reason: failure,
      elapsedMs: elapsed(started),
      revision: committed?.revision,
    });
  }
}
