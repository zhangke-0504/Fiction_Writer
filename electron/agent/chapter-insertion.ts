import { parser } from '@lezer/markdown';
import type { Manuscript } from '../../shared/contracts.js';
import { digest } from '../documents.js';
import { WritingContextFailure } from './writing-request.js';

export type ChapterInsertion = {
  revision: string;
  quote: string;
  place: 'before' | 'after';
  outline?: { revision: string; addition: string };
  targetId?: string;
};

export function insertionAnchor(doc: Manuscript, insertion?: ChapterInsertion) {
  const ref = { type: 'chapter' as const, id: doc.id };
  const invalid = (message: string) =>
    new WritingContextFailure(
      'context_required',
      message,
      [ref],
      [{ kind: 'invalid_anchor', ref, chapterId: doc.id, revision: doc.revision }],
    );
  if (
    !insertion ||
    insertion.quote.trim().length < 4 ||
    insertion.quote.length > 600 ||
    !['before', 'after'].includes(insertion.place) ||
    !doc.body.trim()
  )
    throw invalid('插入需要已保存的章节、当前版本、唯一的短原文及前／后位置。');
  if (insertion.revision !== doc.revision)
    throw new WritingContextFailure(
      'conflict',
      `章节 ${doc.id} 版本已变化，请重新读取插入位置。`,
      [ref],
      [{ kind: 'invalid_anchor', ref, chapterId: doc.id, revision: doc.revision }],
    );
  const from = doc.body.indexOf(insertion.quote);
  if (from < 0 || doc.body.indexOf(insertion.quote, from + 1) >= 0)
    throw invalid('插入原文找不到或不唯一，请提供该章内唯一的段落引用。');
  const to = from + insertion.quote.length;
  let boundary: number | undefined;
  let paragraph = '';
  parser.parse(doc.body).iterate({
    enter(node) {
      if (
        node.name === 'Paragraph' &&
        node.node.parent?.name === 'Document' &&
        from >= node.from &&
        to <= node.to
      ) {
        boundary = insertion.place === 'before' ? node.from : node.to;
        paragraph = doc.body.slice(node.from, node.to).trimEnd();
      }
    },
  });
  if (boundary === undefined)
    throw invalid('插入原文须位于一个正文段落内，不跨越标题、代码块或多个段落。');
  // Lezer can leave the CR of a CRLF separator inside the paragraph range. Do not split the pair.
  const offset =
    doc.body[boundary - 1] === '\r' && doc.body[boundary] === '\n' ? boundary - 1 : boundary;
  return { offset, key: digest(JSON.stringify([doc.id, insertion.place, paragraph])) };
}

export function insertionPoint(doc: Manuscript, insertion?: ChapterInsertion) {
  return insertionAnchor(doc, insertion).offset;
}

/** Preserve both surrounding byte slices; add only the separators this insert needs. */
export function insertPassage(original: string, offset: number, fragment: string) {
  const text = fragment.trim();
  if (!text) return original;
  const previous = original.slice(0, offset),
    next = original.slice(offset);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const after = (value: string) =>
    !value || /\r?\n[ \t]*\r?\n$/u.test(value) ? '' : /\r?\n$/u.test(value) ? eol : eol + eol;
  const before = !next || /^\r?\n[ \t]*\r?\n/u.test(next) ? '' : /^\r?\n/u.test(next) ? eol : eol + eol;
  return previous + after(previous) + text + before + next;
}

/** Drop verbatim copies of the immediate neighboring paragraphs from a model's new text only. */
export function trimInsertionEcho(original: string, offset: number, fragment: string) {
  const edges = (text: string) => {
    let first: { text: string; end: number } | undefined;
    let last: { text: string; start: number } | undefined;
    parser.parse(text).iterate({
      enter(node) {
        if (node.name !== 'Paragraph' || node.node.parent?.name !== 'Document') return;
        const exact = text.slice(node.from, node.to).replaceAll('\r\n', '\n');
        if (node.from === 0) first = { text: exact, end: node.to };
        if (node.to === text.length) last = { text: exact, start: node.from };
      },
    });
    return { first, last };
  };
  const text = fragment.trim();
  const { first, last } = edges(text);
  const previous = first && edges(original.slice(0, offset).trimEnd()).last;
  const next = last && edges(original.slice(offset).trimStart()).first;
  return text
    .slice(
      first && previous?.text === first.text ? first.end : 0,
      last && next?.text === last.text ? last.start : text.length,
    )
    .trim();
}

export function outlineInsertion(
  outline: Manuscript,
  chapter: Manuscript,
  update: NonNullable<ChapterInsertion['outline']>,
) {
  const ref = { type: 'outline' as const, id: outline.id };
  if (outline.revision !== update.revision)
    throw new WritingContextFailure(
      'conflict',
      '大纲已修订，请核对原位置后再增补。',
      [ref],
      [{ kind: 'invalid_anchor', ref, chapterId: chapter.id }],
    );
  const addition = update.addition.trim();
  if (!addition || addition.length > 800 || /<!--|^\s*#{1,6}\s+/mu.test(addition))
    throw new WritingContextFailure(
      'context_required',
      '仅允许为目标章增补一小段安排，不接收新大纲或其他章标记。',
      [ref],
      [{ kind: 'invalid_anchor', ref, chapterId: chapter.id }],
    );
  const markers: { tag: string; id: string; from: number }[] = [];
  parser.parse(outline.body).iterate({
    enter(node) {
      if (node.name !== 'CommentBlock' && node.name !== 'Comment') return;
      const match = /^<!--\s*(chapter|beat):([a-zA-Z0-9_-]+)\s*-->\s*$/u.exec(
        outline.body.slice(node.from, node.to),
      );
      if (match) markers.push({ tag: match[1], id: match[2], from: node.from });
    },
  });
  const exact = markers.filter(({ tag, id }) => tag === 'chapter' && id === chapter.id);
  const target = exact.length
    ? exact
    : markers.filter(({ tag, id }) => tag === 'beat' && chapter.fields.beatIds?.includes(id));
  if (target.length === 1) {
    const offset = markers[markers.indexOf(target[0]) + 1]?.from ?? outline.body.length;
    return insertPassage(outline.body, offset, addition);
  }
  // Old or ambiguous outline shapes remain intact: append a separately identifiable chapter plan.
  return insertPassage(
    outline.body,
    outline.body.length,
    `<!-- chapter:${chapter.id} -->\n\n${addition}`,
  );
}

/** Compact, verified suggestions; the caller is still free to choose another unique paragraph. */
export function suggestInsertionPoints(doc: Manuscript) {
  const anchors: string[] = [];
  parser.parse(doc.body).iterate({
    enter(node) {
      if (node.name !== 'Paragraph' || node.node.parent?.name !== 'Document') return;
      const raw = doc.body.slice(node.from, node.to).trim();
      const first = raw.match(/^[^。！？\r\n]+[。！？]?/u)?.[0] ?? raw;
      const quote = first.slice(0, 160).trim();
      if (quote.length < 6 || doc.body.indexOf(quote) !== doc.body.lastIndexOf(quote)) return;
      anchors.push(quote);
    },
  });
  return [
    ...new Set(
      [anchors[Math.floor(anchors.length / 4)], anchors[Math.floor(anchors.length / 2)]].filter(Boolean),
    ),
  ].map((quote) => ({ revision: doc.revision, quote, place: 'before' as const }));
}
