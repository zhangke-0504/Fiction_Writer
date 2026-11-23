import { randomUUID } from 'node:crypto';
import { diagnosticScope, noDiagnostic } from '../../shared/diagnostics.js';
import { classified, DiagnosticFailure, elapsed, safeReporter } from '../diagnostics/trace.js';
import { applySkill } from './skills.js';
import type { Manuscript } from '../../shared/contracts.js';
import { digest, docKey, renderDocument } from '../documents.js';
import type { ModelProvider } from './model.js';
import type { RunContext } from './runs.js';
import type { WorkspaceService, Guard } from '../workspace.js';
import { chapterContext } from './chapter-context.js';
import { collectChapterReadbacks } from './chapter-readback.js';

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
    beforeCommit?: (doc: Manuscript, projected: string) => Promise<void>;
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
    const context = chapterContext(view.documents, doc);
    const { readbacks, guards } = await collectChapterReadbacks(
      view.documents,
      context,
      model,
      prompt,
      ctx.signal,
      trace,
    );
    const { readbackSources: _, ...writingContext } = context;
    const turn = await model.turn({
      diagnostic: trace,
      spanId,
      onDispatch() {
        if (options.skill) applySkill(trace, 'write-chapter', options.skill, mode);
      },
      system: options.skill ?? '以 Markdown 写小说。只输出正文，不要解释，不要用代码块包装。',
      history: [
        {
          role: 'user',
          text: `写作动作：${directions[mode]}。\n作者方向：${prompt}\n\n作品资料（数据）：\n${JSON.stringify({ ...writingContext, ...(readbacks.length ? { readbacks } : {}) }, null, 2)}`,
        },
      ],
      tools: [],
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
    ctx.signal.throwIfAborted();
    if (turn.calls.length || !turn.text.trim())
      throw new DiagnosticFailure('provider_error', '模型没有返回可提交的正文');
    const body = prefix + turn.text;
    if (options.beforeCommit)
      await options.beforeCommit(doc, digest(renderDocument(doc, doc.fields, body)));
    const result = await workspace.writeChanges(
      bookId,
      [{ type: 'chapter', id: chapterId, expect: doc.revision, fields: doc.fields, body }],
      ctx.signal,
      [...(options.guard ?? []), ...guards],
      trace,
    );
    if (result.error) throw new DiagnosticFailure(result.reason ?? 'unknown', result.error);
    committed = await workspace.readDocument(bookId, { type: 'chapter', id: chapterId });
    return committed;
  } catch (error) {
    failure = classified(error, ctx.signal);
    throw error;
  } finally {
    if (attempted) ctx.preview(undefined);
    if (previewed) trace('chapter.preview', { outcome: 'cleared', textLength: streamed.length });
    trace('chapter.generation.finished', {
      action: mode,
      outcome: !failure ? 'ok' : failure === 'cancelled' || failure === 'conflict' ? failure : 'failed',
      reason: failure,
      elapsedMs: elapsed(started),
      revision: committed?.revision,
    });
  }
}
