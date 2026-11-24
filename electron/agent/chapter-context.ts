import { parser } from '@lezer/markdown';
import type { DocRef, Manuscript } from '../../shared/contracts.js';
import { docKey, isId, storyLinks } from '../documents.js';
import type { BookRecall } from './book-memory.js';
import { storyVisibility } from './story-visibility.js';
import { activeCluePhase, nextChapterBoundary, type ChapterPlan } from './chapter-boundary.js';
import {
  clueSections,
  hasStoryDescription,
  noteExcerpt,
  noteSections,
  storyPart,
  storyLabel,
  type NoteExcerpt,
} from './story-notes.js';
import {
  groupedWritingData,
  WritingContextFailure,
  type ChapterAction,
  type WritingBlock,
  type WritingIssue,
  type WritingTarget,
} from './writing-request.js';

const source = (doc: Manuscript, range?: [number, number]): WritingTarget => ({
  type: doc.type,
  id: doc.id,
  revision: doc.revision,
  range,
});
const chapterOrder = (doc: Manuscript) => doc.fields.order ?? 0;
const chaptersOf = (documents: Manuscript[]) =>
  documents.filter((doc) => doc.type === 'chapter').sort((a, b) => chapterOrder(a) - chapterOrder(b));
function markedSpans(body: string) {
  const markers: { type?: 'chapter' | 'beat'; id?: string; from: number; to: number }[] = [];
  parser.parse(body).iterate({
    enter(node) {
      if (node.name === 'CommentBlock' || node.name === 'Comment') {
        const match = /^<!--\s*(beat|chapter):([A-Za-z0-9_-]+)\s*-->\s*$/u.exec(
          body.slice(node.from, node.to),
        );
        if (match && isId(match[2]))
          markers.push({
            type: match[1] as 'chapter' | 'beat',
            id: match[2],
            from: node.from,
            to: node.to,
          });
      } else if (node.node.parent?.name === 'Document' && /^ATXHeading[12]$/u.test(node.name)) {
        markers.push({ from: node.from, to: node.to });
      }
    },
  });
  return markers.map((marker, index) => ({
    ...marker,
    span: noteExcerpt(body, marker.to, markers[index + 1]?.from),
  }));
}

function chapterOutline(spans: ReturnType<typeof markedSpans>, target: Manuscript) {
  return spans
    .filter(
      ({ type, id, span }) =>
        span &&
        ((type === 'chapter' && id === target.id) ||
          (type === 'beat' && id && target.fields.beatIds?.includes(id))),
    )
    .map(({ span }) => span!);
}
function assetLinks(body: string) {
  return /subjects\/|foreshadowing\//u.test(body)
    ? storyLinks(body)
        .map(({ ref }) => ref)
        .filter(({ type }) => type === 'subject' || type === 'clue')
    : [];
}

/** Reuse outline indexing when reconciling a whole-book catalog. */
export function chapterAssetRequirements(documents: Manuscript[]) {
  const chapters = chaptersOf(documents);
  const outline = markedSpans(documents.find((doc) => doc.type === 'outline')?.body ?? '');
  const clues = documents.filter((entry) => entry.type === 'clue');
  return (target: Manuscript, plan: ChapterPlan = {}, includeClueSubjects = true) => {
    const planned = chapterOutline(outline, target);
    const direct: DocRef[] = [
      ...(plan.subjectIds ?? []).map((id): DocRef => ({ type: 'subject', id })),
      ...(plan.clueIds ?? []).map((id): DocRef => ({ type: 'clue', id })),
      ...(target.fields.subjectIds ?? []).map((id): DocRef => ({ type: 'subject', id })),
      ...assetLinks(target.body),
      ...planned.flatMap(({ text }) => assetLinks(text)),
    ];
    const refs = new Map(direct.map((ref) => [docKey(ref), ref]));
    for (const doc of clues) {
      if (activeCluePhase(doc, chapters, target).due || refs.has(docKey(doc))) {
        refs.set(docKey(doc), { type: 'clue', id: doc.id });
        if (includeClueSubjects)
          for (const id of doc.fields.subjectIds ?? [])
            refs.set(`subject/${id}`, { type: 'subject', id });
      }
    }
    return [...refs.values()];
  };
}

function excerpt(text: string, max: number) {
  if (text.length <= max) return text;
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  return `[开头与结尾摘录；全文 ${text.length} 字符]\n${paragraphs[0]?.slice(0, Math.floor(max / 3)) ?? ''}\n[…]\n${text.slice(-Math.floor((max * 2) / 3))}`;
}
type Previous = {
  chapterId: string;
  order: number;
  header: string;
  text: string;
  revision: string;
  abridged: boolean;
};
type Target = {
  id: string;
  title: string;
  order?: number;
  beatIds?: string[];
  body: string;
  insertion?: { before: string; after: string; intendedBeat?: string };
  revision: string;
};

const emptyMemory = (): BookRecall => ({ conventions: [], earlierStory: [], plans: [], reference: [] });
function memoryPiece<K extends keyof BookRecall>(
  key: K,
  row: BookRecall[K][number],
  sources?: WritingTarget[],
): WritingBlock {
  return { group: 'memory', value: { [key]: [row] }, sources, required: key === 'conventions' };
}

export function projectChapter(blocks: readonly WritingBlock[]) {
  const groups = groupedWritingData(blocks);
  const previous = ((groups.previous ?? []) as Previous[]).slice().sort((a, b) => a.order - b.order);
  const memory = emptyMemory();
  for (const piece of (groups.memory ?? []) as Partial<BookRecall>[]) {
    if (piece.conventions) memory.conventions.push(...piece.conventions);
    if (piece.earlierStory) memory.earlierStory.push(...piece.earlierStory);
    if (piece.reference) memory.reference.push(...piece.reference);
  }
  return {
    book: groups.book?.[0],
    outline: groups.outline ?? [],
    target: groups.target?.[0] as Target,
    previous,
    subjects: groups.subject ?? [],
    clues: groups.clue ?? [],
    nextBoundary: groups.boundary?.[0],
    memory,
    ...(groups.readback?.length && { readbacks: groups.readback }),
  };
}

export function chapterContext(
  documents: Manuscript[],
  target: Manuscript,
  precedingBudget = 43_000,
  options: {
    plan?: ChapterPlan;
    mode?: ChapterAction;
    direction?: string;
    insertion?: { offset: number; outlineAddition?: string };
  } = {},
) {
  const plan = options.plan ?? {};
  const chapters = chaptersOf(documents);
  // Only this exact snapshot supplies sources; callers must not include the later body as memory.
  const index = chapters.findIndex((chapter) => chapter.id === target.id);
  const prior = chapters.slice(0, index).filter((doc) => doc.body.trim());
  const successor = chapters.slice(index + 1).find((doc) => doc.body.trim());
  const clues = documents.filter((doc) => doc.type === 'clue');
  const discover = chapterAssetRequirements(documents);
  const refs = discover(target, plan);
  const direct = discover(target, plan, false);
  const required = new Set(refs.map(docKey));
  const visibility = storyVisibility(clues, chapters, target);
  const { safe, visible } = visibility;
  const chapterSpans = new Map<string, NoteExcerpt[]>();
  const chapterRange = (doc: Manuscript, from: number, to: number, focus?: [number, number]) => {
    let spans = chapterSpans.get(doc.id);
    if (!spans) {
      spans = visibility.spans(doc.body);
      chapterSpans.set(doc.id, spans);
    }
    const candidates = spans
      .map(({ range }) => noteExcerpt(doc.body, Math.max(range[0], from), Math.min(range[1], to)))
      .filter(
        (part): part is NoteExcerpt =>
          !!part && (!focus || (part.range[0] <= focus[0] && part.range[1] >= focus[1])),
      );
    return candidates.sort((a, b) => b.text.length - a.text.length)[0];
  };
  const missing: WritingIssue[] = [];
  const material: WritingBlock[] = [];
  const byKey = new Map(documents.map((doc) => [docKey(doc), doc]));
  const safeTitle = (doc: Manuscript) => (safe(storyLabel(doc)) ? storyLabel(doc) : doc.id);
  const titleBody = visible(target.body);
  const targetValue: Target = {
    id: target.id,
    title: safeTitle(target),
    order: target.fields.order,
    beatIds: target.fields.beatIds,
    body: options.insertion ? '' : excerpt(titleBody, 4000),
    ...(options.insertion && {
      insertion: {
        before:
          chapterRange(target, Math.max(0, options.insertion.offset - 2400), options.insertion.offset)
            ?.text ?? '',
        after:
          chapterRange(target, options.insertion.offset, options.insertion.offset + 2400)?.text ?? '',
        intendedBeat: options.insertion.outlineAddition && visible(options.insertion.outlineAddition),
      },
    }),
    revision: target.revision,
  };
  material.push({ group: 'target', value: targetValue, required: true, sources: [source(target)] });
  const boundary = nextChapterBoundary(
    successor,
    documents,
    refs,
    plan,
    options.direction ?? '',
    options.mode !== undefined &&
      (!options.insertion || !target.body.slice(options.insertion.offset).trim()),
    (text) => (safe(text) && text ? text : undefined),
  );
  if (boundary) material.push(boundary);
  const book = documents.find((doc) => doc.type === 'book');
  if (book)
    material.push({
      group: 'book',
      value: {
        title: safeTitle(book),
        genre: book.fields.genre && visible(book.fields.genre),
        style: book.fields.style && visible(book.fields.style),
        summary: visible(book.body).slice(0, 4000),
      },
      sources: [source(book, [0, Math.min(book.body.length, 4000)])],
    });
  const outline = documents.find((doc) => doc.type === 'outline');
  for (const span of chapterOutline(markedSpans(outline?.body ?? ''), target)) {
    const text = visible(span.text);
    if (outline && text)
      material.push({
        group: 'outline',
        value: { text, source: source(outline, span.range), status: '本章计划' },
        sources: [source(outline, span.range)],
      });
  }

  // Read complete mandatory notes or a specifically marked, usable section. Do not scale them away.
  const subjectBlock = (doc: Manuscript, must: boolean) => {
    const sections = noteSections(doc.body);
    const note = storyPart(doc.body, 'stable');
    const text = note && visible(note.text);
    if (!note || !text || !hasStoryDescription(text)) return;
    const state = sections.get('已发生变化');
    const earlierState = (state ? markedSpans(state.text) : []).flatMap(({ type, id, span }) => {
      if (type !== 'chapter' || !id || !span || !safe(span.text)) return [];
      const chapter = prior.find((entry) => entry.id === id);
      if (!chapter) return [];
      const quote =
        /^\s*(?:[-*>]\s*)?(?:原文|证据)\s*[:：]\s*(.+)$/mu
          .exec(span.text)?.[1]
          ?.trim()
          .replace(/^[「“]|[」”]$/gu, '') ?? span.text.trim();
      if (quote.length < 4 || quote.length > 400) return [];
      const offset = chapter.body.indexOf(quote);
      if (offset < 0) return [];
      return [
        { chapterId: id, text: span.text, source: source(chapter, [offset, offset + quote.length]) },
      ];
    });
    const sources = [source(doc, note.range), ...earlierState.map((row) => row.source)];
    return {
      group: 'subject',
      required: must,
      sources,
      value: {
        id: doc.id,
        kind: doc.fields.kind,
        name: safeTitle(doc),
        stable: must ? text : excerpt(text, 1700),
        earlierState,
        source: sources[0],
      },
    } satisfies WritingBlock;
  };
  const clueBlock = (doc: Manuscript, must: boolean) => {
    const phase = activeCluePhase(doc, chapters, target);
    if (
      phase.ambiguous ||
      (doc.fields.setupChapterId && !phase.setup) ||
      (doc.fields.payoffChapterId && !phase.payoff) ||
      (phase.setup && phase.payoff && chapterOrder(phase.setup) > chapterOrder(phase.payoff))
    )
      return;
    const surface = storyPart(doc.body, 'visible');
    const use = phase.revealAllowed ? storyPart(doc.body, 'reveal') : surface;
    const text = use && visible(use.text);
    if (!use || !text || !hasStoryDescription(text)) return;
    const sources = [
      source(doc, use.range),
      ...[phase.setup, phase.payoff]
        .filter((chapter): chapter is Manuscript => !!chapter)
        .map((chapter) => source(chapter)),
    ];
    const setup = phase.revealAllowed && surface && safe(surface.text) ? surface : undefined;
    return {
      group: 'clue',
      required: must,
      sources,
      value: {
        id: doc.id,
        title: safeTitle(doc),
        phase: phase.phase,
        subjectIds: doc.fields.subjectIds,
        setupChapterId: phase.setup?.id,
        payoffChapterId: phase.payoff?.id,
        ...(phase.revealAllowed
          ? { payoff: text, ...(setup && { visible: setup.text }) }
          : { visible: must ? text : excerpt(text, 1600) }),
        source: sources[0],
      },
    } satisfies WritingBlock;
  };
  const partFor = (doc: Manuscript) =>
    doc.type === 'subject'
      ? ('stable' as const)
      : activeCluePhase(doc, chapters, target).revealAllowed
        ? ('reveal' as const)
        : ('visible' as const);
  const issueFor = (ref: DocRef, doc?: Manuscript): WritingIssue => {
    if (!doc) return { kind: 'missing_asset', ref, chapterId: target.id };
    const part = partFor(doc);
    const phase = doc.type === 'clue' ? activeCluePhase(doc, chapters, target) : undefined;
    const invalid =
      phase &&
      (phase.ambiguous ||
        (doc.fields.setupChapterId && !phase.setup) ||
        (doc.fields.payoffChapterId && !phase.payoff) ||
        (phase.setup && phase.payoff && chapterOrder(phase.setup) > chapterOrder(phase.payoff)));
    return {
      kind: invalid
        ? 'invalid_anchor'
        : !hasStoryDescription(doc.body)
          ? 'empty_description'
          : !storyPart(doc.body, part)
            ? 'missing_section'
            : 'no_visible_evidence',
      ref,
      chapterId: target.id,
      part,
      revision: doc.revision,
    };
  };
  const subjectRefs = new Map(
    direct.filter(({ type }) => type === 'subject').map((ref) => [docKey(ref), ref]),
  );
  for (const ref of direct.filter(({ type }) => type === 'clue')) {
    const doc = byKey.get(docKey(ref));
    const block = doc && clueBlock(doc, true);
    if (!doc || !block) missing.push(issueFor(ref, doc));
    else {
      material.push(block);
      for (const id of doc.fields.subjectIds ?? [])
        subjectRefs.set(`subject/${id}`, { type: 'subject', id });
    }
  }
  if (options.insertion) {
    // A single hop through the new character's declared stable relationships keeps its linked actors in the actual scene prompt.
    for (const ref of [...subjectRefs.values()]) {
      const doc = byKey.get(docKey(ref));
      if (!doc) continue;
      const relations = noteSections(doc.body).get('关联主体')?.text ?? '';
      for (const { ref: linked } of storyLinks(visible(relations)))
        if (linked.type === 'subject') subjectRefs.set(docKey(linked), linked);
    }
  }
  for (const ref of subjectRefs.values()) {
    const doc = byKey.get(docKey(ref));
    const block = doc && subjectBlock(doc, true);
    if (block) material.push(block);
    else missing.push(issueFor(ref, doc));
  }
  if (missing.length) {
    const issues = missing.slice(0, 12);
    const marked = issues.flatMap(({ ref }) => (ref ? [ref] : []));
    const labels = {
      missing_asset: '没有资产',
      empty_description: '空说明',
      missing_section: '已有说明但小节缺失',
      no_visible_evidence: '已有说明但当前阶段无可核验段落',
      invalid_anchor: '锚点无效',
      continuity_conflict: '前后冲突',
      budget_limit: '预算不足',
    };
    throw new WritingContextFailure(
      'context_required',
      `目标章 ${target.id} 暂不能写：${issues.map(({ ref, kind }) => `${ref ? docKey(ref) : target.id}（${labels[kind]}）`).join('、')}。请按各问题的建议定向处理。`,
      marked,
      issues,
    );
  }

  const previous: Previous[] = [];
  let budget = precedingBudget;
  for (let i = prior.length - 1; i >= 0; i--) {
    const doc = prior[i];
    const established = visible(doc.body);
    if (!established) continue;
    const reserved = Math.min(i * 310, Math.floor(precedingBudget / 5));
    const available = Math.max(0, budget - reserved);
    if (available < 160) break;
    const keep = i === prior.length - 1 ? Math.min(available, 2400) : Math.min(available, 2500);
    const text = excerpt(established, keep);
    budget -= text.length;
    const row = {
      chapterId: doc.id,
      order: chapterOrder(doc),
      header: `前章 ${safeTitle(doc)} [chapters/${doc.id}.md]`,
      text,
      abridged: text !== doc.body.trim(),
      revision: doc.revision,
    };
    previous.unshift(row);
    material.push({
      group: 'previous',
      value: row,
      sources: [source(doc, row.abridged ? undefined : [0, doc.body.length])],
      required: i === prior.length - 1,
    });
  }
  for (const doc of documents
    .filter((entry) => entry.type === 'subject' && !required.has(docKey(entry)))
    .slice(0, 25)) {
    const block = subjectBlock(doc, false);
    if (block) material.push(block);
  }
  for (const doc of clues.filter((entry) => !required.has(docKey(entry))).slice(0, 16)) {
    const phase = activeCluePhase(doc, chapters, target);
    if (!phase.setup || chapterOrder(phase.setup) > chapterOrder(target) || !phase.hidden) continue;
    const block = clueBlock(doc, false);
    if (block) material.push(block);
  }
  return {
    blocks: material,
    refs,
    previous,
    visible,
    safe,
    chapterRange,
    memory(result: BookRecall): WritingBlock[] {
      // All plans are regenerated from individually selected chapter/foreshadowing blocks.
      // Never duplicate arbitrary outline/asset passages from general memory into prose.
      return [
        ...result.conventions
          .filter(({ text }) => safe(text))
          .map((row) => memoryPiece('conventions', row)),
        ...result.earlierStory.flatMap((row) => {
          const doc = prior.find((entry) => entry.id === row.id && entry.revision === row.revision);
          const part = doc && chapterRange(doc, row.range[0], row.range[1]);
          return part
            ? [
                memoryPiece(
                  'earlierStory',
                  {
                    ...row,
                    range: part.range,
                    excerpt: part.text,
                    title: safe(row.title) ? row.title : row.id,
                  },
                  [row],
                ),
              ]
            : [];
        }),
      ];
    },
    readbackContext(included: readonly WritingBlock[]) {
      const data = projectChapter(included);
      const full = new Set(
        data.previous.filter(({ abridged }) => !abridged).map(({ chapterId }) => chapterId),
      );
      const candidates =
        !options.insertion && targetValue.body !== titleBody ? [...prior, target] : prior;
      return {
        ...data,
        outline: JSON.stringify(data.outline),
        cast: [...data.subjects, ...data.clues].map((row) => JSON.stringify(row)),
        readbackSources: candidates
          .filter((doc) => !full.has(doc.id))
          .map((doc) => ({
            chapterId: doc.id,
            title: safeTitle(doc),
            order: doc.fields.order,
            length: doc.body.length,
          })),
      };
    },
  };
}
export type ChapterReadbackContext = ReturnType<ReturnType<typeof chapterContext>['readbackContext']>;
