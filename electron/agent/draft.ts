import type { Manuscript } from '../../shared/contracts.js';
import { digest, renderDocument } from '../documents.js';
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
  const bookId = ctx.session.bookId;
  if (!bookId) throw new Error('此操作需要小说会话');
  const view = await workspace.readAll(bookId),
    doc = view.documents.find((d) => d.type === 'chapter' && d.id === chapterId);
  if (!doc) throw new Error('目标章节不存在或无法读取');
  if (mode === 'draft' && doc.body.trim()) throw new Error('这章已有正文。可选择续写，或明确请求重写。');
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
  let streamed = '';
  try {
    const context = chapterContext(view.documents, doc);
    const { readbacks, guards } = await collectChapterReadbacks(
      view.documents,
      context,
      model,
      prompt,
      ctx.signal,
    );
    const { readbackSources: _, ...writingContext } = context;
    const turn = await model.turn({
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
      },
    });
    ctx.signal.throwIfAborted();
    if (turn.calls.length || !turn.text.trim()) throw new Error('模型没有返回可提交的正文');
    const body = prefix + turn.text;
    if (options.beforeCommit)
      await options.beforeCommit(doc, digest(renderDocument(doc, doc.fields, body)));
    const report = await workspace.writeChanges(
      bookId,
      [{ type: 'chapter', id: chapterId, expect: doc.revision, fields: doc.fields, body }],
      ctx.signal,
      [...(options.guard ?? []), ...guards],
    );
    if (report.error) throw new Error(report.error);
    return workspace.readDocument(bookId, { type: 'chapter', id: chapterId });
  } finally {
    ctx.preview(undefined);
  }
}
