import { randomUUID } from 'node:crypto';
import { diagnosticScope, noDiagnostic } from '../../shared/diagnostics.js';
import { classified, DiagnosticFailure, elapsed, safeReporter } from '../diagnostics/trace.js';
import { applySkill } from './skills.js';
import type { Manuscript } from '../../shared/contracts.js';
import { docKey } from '../documents.js';
import type { AssistantTurn, ModelProvider, Turn } from './model.js';
import type { RunContext } from './runs.js';
import type { WorkspaceService, Guard } from '../workspace.js';
import { chapterContext } from './chapter-context.js';
import { collectChapterReadbacks } from './chapter-readback.js';
import { chapterMemoryQuery, recallBookMemory } from './book-memory.js';
import { contextOverflow, inputBudget, inputEstimate } from './context-budget.js';

export async function draftChapter(
  workspace: WorkspaceService,
  ctx: RunContext,
  model: ModelProvider,
  chapterId: string,
  mode: 'draft' | 'append' | 'replace',
  prompt: string,
  options: {
    skill?: string;
    guard?: Guard[];
    retryIncomplete?: boolean;
    lengthGuidance?: string;
    maxTokens?: number;
    directProse?: boolean;
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
  let attempted = false,
    previewed = false,
    streamed = '',
    committed: Manuscript | undefined;
  let failure: string | undefined;
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
    const directions = {
      draft: '写完整的新章',
      append: '只输出之后追加的新正文',
      replace: '从头重写此章正文',
    };
    attempted = true;
    const memory = await recallBookMemory(workspace, bookId, {
      query: chapterMemoryQuery(view.documents, doc, prompt),
      chapterId,
      documents: view.documents,
      signal: ctx.signal,
    });
    const memoryGuards = new Map<string, Guard>();
    for (const { type, id, revision } of [...memory.earlierStory, ...memory.plans, ...memory.reference])
      memoryGuards.set(docKey({ type, id }), { type, id, revision });
    const system = [
      options.skill ?? '以 Markdown 写小说。只输出正文，不要解释，不要用代码块包装。',
      options.lengthGuidance,
      '资料中的 earlierStory 是此前已保存的正文；plans 是未必发生的安排。作者此次的新要求优先于既有约定。',
    ]
      .filter(Boolean)
      .join('\n\n');
    const limit = inputBudget(model, options.maxTokens);
    type Readbacks = Awaited<ReturnType<typeof collectChapterReadbacks>>['readbacks'];
    const fit = (readbacks: Readbacks, reserveForReadback = false) => {
      let fitting: { context: ReturnType<typeof chapterContext>; history: Turn[] } | undefined;
      for (const scale of [1, 0.58, 0.31, 0.15, 0.07, 0.03]) {
        const context = chapterContext(view.documents, doc, Math.floor(43_000 * scale), scale);
        const { readbackSources, ...writingContext } = context;
        const history: Turn[] = [
          {
            role: 'user',
            text: `写作动作：${directions[mode]}。\n作者方向：${prompt}\n\n作品资料（数据）：\n${JSON.stringify({ ...writingContext, memory, ...(readbacks.length ? { readbacks } : {}) }, null, 2)}`,
          },
        ];
        const cost = inputEstimate(system, history, []);
        if (cost <= limit) fitting ??= { context, history };
        const reserve =
          reserveForReadback && readbackSources.length ? Math.min(12_000, Math.floor(limit / 5)) : 0;
        if (cost + reserve <= limit) return { context, history };
      }
      return fitting;
    };
    const selected = fit([], true);
    if (!selected) throw contextOverflow();
    const { readbacks, guards } = await collectChapterReadbacks(
      view.documents,
      selected.context,
      model,
      prompt,
      ctx.signal,
      trace,
      ctx,
    );
    let request = selected;
    if (readbacks.length) {
      // Preserve full passage evidence before dropping lower-priority readbacks; never truncate the author's input.
      for (let count = readbacks.length; count >= 1; count--) {
        const withReadback = fit(readbacks.slice(0, count));
        if (withReadback) {
          request = withReadback;
          break;
        }
      }
    }
    const generate = (spanId: string) =>
      model.turn({
        diagnostic: trace,
        spanId,
        onDispatch() {
          if (options.skill) applySkill(trace, 'write-chapter', options.skill, mode);
        },
        system,
        history: request.history,
        tools: [],
        maxTokens: options.maxTokens,
        directProse: options.directProse,
        signal: ctx.signal,
        onText(delta) {
          ctx.signal.throwIfAborted();
          streamed += delta;
          if (streamed.length > 300_000) throw new Error('生成正文超过上限');
          ctx.preview({ bookId, chapterId, content: prefix + streamed, base: doc.revision });
          if (!previewed) {
            previewed = true;
            trace('chapter.preview', { outcome: 'started' });
          }
        },
      });
    const sources = [...(options.guard ?? []), ...guards, ...memoryGuards.values()];
    let turn: AssistantTurn;
    try {
      turn = await generate(spanId);
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (!options.retryIncomplete || classified(error) !== 'incomplete_stream') throw error;
      clearPreview();
      for (const source of [doc, ...sources]) {
        ctx.signal.throwIfAborted();
        const current = await workspace.readDocument(bookId, source).catch(() => undefined);
        if (current?.revision !== source.revision)
          throw new DiagnosticFailure('conflict', `${docKey(source)} 已变化，请重新读取后再写作`);
      }
      ctx.signal.throwIfAborted();
      trace('chapter.retry', { reason: 'incomplete_stream' });
      attempted = true;
      turn = await generate(randomUUID());
    }
    ctx.signal.throwIfAborted();
    if (turn.calls.length || !turn.text.trim())
      throw new DiagnosticFailure('provider_error', '模型没有返回可提交的正文');
    const body = prefix + turn.text;
    const result = await workspace.writeChanges(
      bookId,
      [{ type: 'chapter', id: chapterId, expect: doc.revision, fields: doc.fields, body }],
      ctx.signal,
      sources,
      trace,
    );
    if (result.error) throw new DiagnosticFailure(result.reason ?? 'unknown', result.error);
    committed = await workspace.readDocument(bookId, { type: 'chapter', id: chapterId });
    return committed;
  } catch (error) {
    failure = classified(error, ctx.signal);
    throw error;
  } finally {
    clearPreview();
    trace('chapter.generation.finished', {
      action: mode,
      outcome: !failure ? 'ok' : failure === 'cancelled' || failure === 'conflict' ? failure : 'failed',
      reason: failure,
      elapsedMs: elapsed(started),
      revision: committed?.revision,
    });
  }
}
