import type { DocRef, Manuscript } from '../../shared/contracts.js';
import { clueAnchors, storyLabel } from './story-notes.js';
import { WritingContextFailure, type WritingBlock } from './writing-request.js';

export type ChapterPlan = {
  subjectIds?: string[];
  clueIds?: string[];
  nextBoundary?: {
    chapterId: string;
    conditions: { quote: string; condition: string; conflict?: boolean }[];
  };
};

const openingSize = 4_000;
function explicitUnseen(opening: string, subjects: Manuscript[]) {
  const constraints: { quote: string; condition: string; person: string; item: string }[] = [];
  for (const person of subjects.filter((doc) => doc.fields.kind === 'character')) {
    const name = storyLabel(person);
    for (const thing of subjects.filter(
      (doc) => doc.fields.kind === 'item' || doc.fields.kind === 'scene',
    )) {
      const item = storyLabel(thing);
      const quote = [`${name}从未见过${item}`, `${name}没见过${item}`].find((text) =>
        opening.includes(text),
      );
      if (quote)
        constraints.push({
          quote,
          condition: `该衔接点前，${name}仍不能见到${item}。`,
          person: name,
          item,
        });
    }
  }
  return constraints.slice(0, 6);
}

/** An unchanged quote locates a boundary; it is not forwarded into the earlier prose request. */
export function nextChapterBoundary(
  next: Manuscript | undefined,
  docs: Manuscript[],
  refs: DocRef[],
  scope: ChapterPlan,
  direction: string,
  required: boolean,
  safe: (text: string) => string | undefined,
): WritingBlock | undefined {
  if (!next) {
    if (scope.nextBoundary)
      throw new WritingContextFailure(
        'context_required',
        '已没有该后接章节，请重新核对顺序。',
        [],
        [{ kind: 'invalid_anchor' }],
      );
    return;
  }
  const ref: DocRef = { type: 'chapter', id: next.id };
  if (scope.nextBoundary && scope.nextBoundary.chapterId !== next.id)
    throw new WritingContextFailure(
      'context_required',
      `请按当前目录核对后接章 ${next.id}（不是先前安排中的后接章）。`,
      [ref],
      [{ kind: 'invalid_anchor', ref, revision: next.revision }],
    );
  const subjects = docs.filter(
    (doc) =>
      doc.type === 'subject' &&
      refs.some((candidate) => candidate.type === 'subject' && candidate.id === doc.id),
  );
  const opening = next.body.slice(0, openingSize);
  const inferred = explicitUnseen(opening, subjects);
  const beats = direction
    .normalize('NFKC')
    .split(/[。；;，,\n]/u)
    .map((clause) => clause.replace(/\s+/gu, ''));
  const contradicts = inferred.some(({ person, item }) =>
    beats.some((beat) => {
      if (!beat.includes(person) || !beat.includes(item) || /没|未|不|别|禁止|不要|避免/u.test(beat))
        return false;
      const action = ['看见', '看到', '见到', '遇见', '接过', '拿到', '收到', '打开'].find((word) =>
        beat.includes(word),
      );
      return (
        !!action &&
        beat.indexOf(person) < beat.indexOf(action) &&
        beat.indexOf(action) < beat.indexOf(item)
      );
    }),
  );
  const supplied = scope.nextBoundary?.conditions ?? [];
  const constraints = [...supplied, ...inferred];
  const projected = [];
  for (const condition of constraints) {
    const quote = condition.quote.trim();
    const offset = opening.indexOf(quote);
    const text = safe(condition.condition.trim());
    if (quote.length < 4 || quote.length > 300 || offset < 0 || !text || text === quote)
      throw new WritingContextFailure(
        'context_required',
        `后接章 ${next.id} 的必要条件缺少可核对的开场出处或安全短述。`,
        [ref],
        [{ kind: 'invalid_anchor', ref, revision: next.revision }],
      );
    if (('conflict' in condition && condition.conflict) || contradicts)
      throw new WritingContextFailure(
        'conflict',
        `本章安排与后接章 ${next.id} 的开场条件冲突（原文位置 ${offset}）；请调整安排或由作者另行决定。`,
        [ref],
        [{ kind: 'continuity_conflict', ref, revision: next.revision }],
      );
    projected.push({ constraint: text, range: [offset, offset + quote.length] });
  }
  if (required && !projected.length)
    throw new WritingContextFailure(
      'context_required',
      `已有后接章 ${next.id}。请用 book_get_context 核对该章开场，再提供 nextBoundary 的短原文引用和必要衔接条件。`,
      [ref],
      [{ kind: 'invalid_anchor', ref, revision: next.revision }],
    );
  return {
    group: 'boundary',
    required: true,
    sources: [{ ...ref, revision: next.revision }],
    value: {
      chapterId: next.id,
      revision: next.revision,
      order: next.fields.order,
      conditions: projected,
      notice: projected.length
        ? '后接约束，不是已经发生的前文。'
        : '具体衔接条件未核实；不提前写后接情节。',
    },
  };
}

export function activeCluePhase(clue: Manuscript, chapters: Manuscript[], target: Manuscript) {
  const { setup, payoff } = clueAnchors(clue, chapters);
  const index = chapters.findIndex(({ id }) => id === target.id);
  const s = setup ? chapters.indexOf(setup) : undefined;
  const p = payoff ? chapters.indexOf(payoff) : undefined;
  const setupHere = s === index;
  const payoffHere = p === index;
  const ambiguous =
    (!setup &&
      !!clue.fields.setupBeatId &&
      !!target.fields.beatIds?.includes(clue.fields.setupBeatId)) ||
    (!payoff &&
      !!clue.fields.payoffBeatId &&
      !!target.fields.beatIds?.includes(clue.fields.payoffBeatId));
  return {
    due: setupHere || payoffHere || ambiguous,
    ambiguous,
    setup,
    payoff,
    revealAllowed: payoffHere,
    hidden: !payoffHere && (p === undefined || p > index),
    phase: payoffHere
      ? setupHere
        ? '本章计划埋设并回收'
        : '本章计划回收'
      : setupHere
        ? '本章计划埋设'
        : s !== undefined && s > index
          ? '未到计划埋设点，不得提前埋设或揭露'
          : p !== undefined && p < index
            ? '已过计划回收点，实际发生以现稿为准'
            : '回收前可见线索，是否已埋设以现稿为准',
  };
}
