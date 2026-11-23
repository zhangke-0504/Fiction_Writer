import type { ChatLine, Manuscript } from '../../shared/contracts.js';
import { isId } from '../documents.js';

export const maxGoalChapters = 80;
export function validChapterIds(input: unknown): input is string[] {
  return (
    Array.isArray(input) &&
    input.length > 0 &&
    input.length <= maxGoalChapters &&
    input.every(isId) &&
    new Set(input.map((id) => id.toLowerCase())).size === input.length
  );
}
export const sameChapterIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Session history stores references to user messages, never another copy of creative instructions. */
export interface NovelTaskState {
  chapterIds: string[];
  originalLine: number;
  amendmentLine?: number;
  knownCatalog: string[];
  pendingReferences: string[];
  failedChapterId?: string;
}
export interface NovelContinuation {
  task: NovelTaskState;
  originalDirection: string;
  amendedDirection?: string;
}
export function readNovelTask(input: unknown, messages: ChatLine[]): NovelTaskState | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const task = input as NovelTaskState;
  const userLine = (i: number) => Number.isSafeInteger(i) && i >= 0 && messages[i]?.role === 'user';
  if (
    !validChapterIds(task.chapterIds) ||
    !userLine(task.originalLine) ||
    (task.amendmentLine !== undefined && !userLine(task.amendmentLine)) ||
    !Array.isArray(task.knownCatalog) ||
    !task.knownCatalog.every((id) => task.chapterIds.includes(id)) ||
    !Array.isArray(task.pendingReferences) ||
    !task.pendingReferences.every((key) => {
      if (typeof key !== 'string') return false;
      const [type, id, extra] = key.split('/');
      return !extra && ['outline', 'subject', 'clue', 'chapter'].includes(type) && isId(id);
    }) ||
    (task.failedChapterId !== undefined && !task.chapterIds.includes(task.failedChapterId))
  )
    return undefined;
  return {
    chapterIds: [...task.chapterIds],
    originalLine: task.originalLine,
    amendmentLine: task.amendmentLine,
    knownCatalog: [...new Set(task.knownCatalog)],
    pendingReferences: [...new Set(task.pendingReferences)],
    failedChapterId: task.failedChapterId,
  };
}

/** A simple check for an explicit numeric limit; this never decides which skill to activate. */
export function requestedChapterCount(prompt: string) {
  const counts = [
    ...prompt.normalize('NFKC').matchAll(/(?:写|写成|分成|共|大约|大概|约)\s*(\d{1,3})\s*章/giu),
  ];
  if (!counts.length || counts.some((match) => match[1] !== counts[0][1])) return undefined;
  const requested = Number(counts[0][1]);
  return requested > 0 ? requested : undefined;
}

export function inspectNovelGoal(
  { documents, diagnostics }: { documents: Manuscript[]; diagnostics: string[] },
  chapterIds: readonly string[],
  rejectedReferences: readonly string[] = [],
  knownCatalog: readonly string[] = [],
) {
  const chapters = documents.filter((doc) => doc.type === 'chapter');
  const byId = new Map(chapters.map((doc) => [doc.id, doc]));
  const byBeat = new Map<string, string | null>();
  for (const chapter of chapters)
    for (const beat of chapter.fields.beatIds ?? []) {
      if (!byBeat.has(beat)) byBeat.set(beat, chapter.id);
      else if (byBeat.get(beat) !== chapter.id) byBeat.set(beat, null);
    }
  const existing = chapterIds.filter((id) => byId.has(id));
  const missingChapters = chapterIds.filter((id) => !byId.has(id));
  const unexpectedChapters = chapters.filter((doc) => !chapterIds.includes(doc.id)).map((doc) => doc.id);
  const removedFromCatalog = knownCatalog.filter((id) => !byId.has(id));
  const catalogConflict =
    unexpectedChapters.length > 0 ||
    removedFromCatalog.length > 0 ||
    !sameChapterIds(
      existing,
      chapters.filter((doc) => chapterIds.includes(doc.id)).map((doc) => doc.id),
    ) ||
    new Set(chapters.map((doc) => doc.fields.order)).size !== chapters.length;
  const firstUnwritten = chapterIds.find((id) => !byId.get(id)?.body.trim());
  const unwritten = chapterIds.filter((id) => !byId.get(id)?.body.trim());
  const missingAssets: string[] = [];
  if (!documents.some((doc) => doc.type === 'outline' && doc.body.trim()))
    missingAssets.push('全书大纲');
  if (!documents.some((doc) => doc.type === 'subject')) missingAssets.push('主体');
  const hasLinkedClue = documents.some((doc) => {
    if (doc.type !== 'clue') return false;
    const { setupChapterId, payoffChapterId, setupBeatId, payoffBeatId } = doc.fields;
    const setup = setupChapterId ?? (setupBeatId && byBeat.get(setupBeatId));
    const payoff = payoffChapterId ?? (payoffBeatId && byBeat.get(payoffBeatId));
    return !!setup && !!payoff && byId.has(setup) && byId.has(payoff);
  });
  if (!hasLinkedClue) missingAssets.push('已关联埋设与回收章节的伏笔');
  const ready =
    !missingAssets.length &&
    !catalogConflict &&
    !missingChapters.length &&
    !diagnostics.length &&
    !rejectedReferences.length;
  return {
    chapterIds,
    done: chapterIds.length - unwritten.length,
    total: chapterIds.length,
    firstUnwritten,
    unwritten,
    missingChapters,
    unexpectedChapters,
    removedFromCatalog,
    catalogConflict,
    missingAssets,
    diagnostics: diagnostics.slice(0, 8).map((entry) => entry.slice(0, 300)),
    rejectedReferences,
    ready,
    complete: ready && !unwritten.length,
  };
}
export type NovelCheck = ReturnType<typeof inspectNovelGoal>;
export function goalProblem(check: NovelCheck) {
  if (check.removedFromCatalog.length)
    return `原目录中的章节已缺失或无法读取：${check.removedFromCatalog.slice(0, 4).join('、')}，请先核对现稿。`;
  if (check.catalogConflict) return '现有章节顺序、数量或 ID 与目标不一致，请先核对目录。';
  if (check.diagnostics.length) return `请先修正作品：${check.diagnostics[0]}`;
  if (check.rejectedReferences.length)
    return `这些资料的引用仍待修正：${check.rejectedReferences.slice(0, 4).join('、')}`;
  if (check.missingAssets.length) return `缺少：${check.missingAssets.join('、')}`;
  if (check.missingChapters.length) return `目录中缺少：${check.missingChapters.slice(0, 4).join('、')}`;
  return check.firstUnwritten ? `下一空白章：${check.firstUnwritten}` : undefined;
}
