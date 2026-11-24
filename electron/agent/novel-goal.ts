import type { ChatLine, DocRef, Manuscript } from '../../shared/contracts.js';
import { docKey, isId } from '../documents.js';
import { chapterAssetRequirements } from './chapter-context.js';
import { clueAnchors, hasStoryDescription } from './story-notes.js';

export const maxGoalChapters = 80;
export const maxGoalAssets = 2048;
export type GoalAsset = DocRef & { type: 'subject' | 'clue' };
export function validGoalAssets(input: unknown): input is GoalAsset[] {
  return (
    Array.isArray(input) &&
    input.length <= maxGoalAssets &&
    input.every(
      (row) =>
        !!row && typeof row === 'object' && ['subject', 'clue'].includes(row.type) && isId(row.id),
    )
  );
}
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
  requiredAssets?: GoalAsset[];
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
    (task.requiredAssets !== undefined && !validGoalAssets(task.requiredAssets)) ||
    (task.failedChapterId !== undefined && !task.chapterIds.includes(task.failedChapterId))
  )
    return undefined;
  return {
    chapterIds: [...task.chapterIds],
    originalLine: task.originalLine,
    amendmentLine: task.amendmentLine,
    knownCatalog: [...new Set(task.knownCatalog)],
    pendingReferences: [...new Set(task.pendingReferences)],
    requiredAssets: task.requiredAssets?.map(({ type, id }) => ({ type, id })),
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
  requiredAssets: readonly GoalAsset[] = [],
) {
  const chapters = documents.filter((doc) => doc.type === 'chapter');
  const byId = new Map(chapters.map((doc) => [doc.id, doc]));
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
  const documentMap = new Map(documents.map((doc) => [docKey(doc), doc]));
  const targeted = new Map<string, DocRef>(requiredAssets.map((row) => [docKey(row), row]));
  const requirements = chapterAssetRequirements(documents);
  for (const chapter of chapters.filter((doc) => chapterIds.includes(doc.id)))
    for (const row of requirements(chapter)) targeted.set(docKey(row), row);
  // Existing linked subjects stay part of any explicitly requested clue, even if the note is still empty.
  for (const ref of targeted.values()) {
    if (ref.type !== 'clue') continue;
    const clue = documentMap.get(docKey(ref));
    for (const id of clue?.fields.subjectIds ?? [])
      targeted.set(`subject/${id}`, { type: 'subject', id });
  }
  const validClue = (doc: Manuscript) => {
    const { setup, payoff } = clueAnchors(doc, chapters);
    return (
      hasStoryDescription(doc.body) &&
      !!setup &&
      !!payoff &&
      chapterIds.includes(setup.id) &&
      chapterIds.includes(payoff.id) &&
      (setup.fields.order ?? 0) <= (payoff.fields.order ?? 0) &&
      (doc.fields.subjectIds ?? []).every((id) =>
        hasStoryDescription(documentMap.get(`subject/${id}`)?.body ?? ''),
      )
    );
  };
  const missingAssetRefs = [...targeted.values()].filter((ref) => {
    const doc = documentMap.get(docKey(ref));
    return !doc || (ref.type === 'clue' ? !validClue(doc) : !hasStoryDescription(doc.body));
  });
  if (!documents.some((doc) => doc.type === 'outline' && doc.body.trim()))
    missingAssets.push('全书大纲');
  if (!documents.some((doc) => doc.type === 'subject' && hasStoryDescription(doc.body)))
    missingAssets.push('带说明的主体');
  if (!documents.some((doc) => doc.type === 'clue' && validClue(doc)))
    missingAssets.push('有说明且关联埋设与回收章节的伏笔');
  if (missingAssetRefs.length)
    missingAssets.push(
      `需补说明或有效关联：${missingAssetRefs.slice(0, 12).map(docKey).join('、')}${missingAssetRefs.length > 12 ? ` 等 ${missingAssetRefs.length} 项` : ''}`,
    );
  const catalogReady = !catalogConflict && !missingChapters.length && !diagnostics.length;
  const ready = catalogReady && !missingAssets.length && !rejectedReferences.length;
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
    missingAssetRefs: missingAssetRefs.slice(0, 24),
    catalogReady,
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
  if (check.missingChapters.length) return '目录中缺少：' + check.missingChapters.slice(0, 4).join('、');
  if (check.missingAssets.length) return `缺少：${check.missingAssets.join('、')}`;
  return check.firstUnwritten ? `下一空白章：${check.firstUnwritten}` : undefined;
}
