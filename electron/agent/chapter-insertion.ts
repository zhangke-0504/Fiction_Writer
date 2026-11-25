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

export type InsertionQualityIssue =
  'echo_only' | 'neighbor_echo' | 'boundary_echo' | 'repeated_passage' | 'work_note' | 'obvious_typo';

// These keys are for comparison only. Neither the saved text nor the insertion offset is normalized.
const sentenceKey = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase();
const sentences = (value: string) =>
  value
    .split(/(?:[。！？!?；;.]+|\n[ \t]*\r?\n+)/u)
    .map(sentenceKey)
    .filter(Boolean);
const minEcho = 14;
const workNote =
  /(?:^|\n)\s*(?:#{1,6}\s*|[-*>]\s*)?(?:【|\*\*)?(?:写作备注|写作说明|创作说明|工作说明|插入说明|本段说明)(?:】|\*\*)?\s*[:：]|(?:把|将)第[零一二三四五六七八九十百两\d]+章(?:里|中|的)?(?:那|这)(?:笔|段|份|张|件|条|场|个)|(?:读者|作者)(?:在|到)第[零一二三四五六七八九十百两\d]+章(?:已经|将会|会|才)(?:看到|知道|得知)/u;

type Edge = 'head' | 'tail';
type Span = { from: number; to: number };
const clauseBreak = /[。！？!?；;，,、.：:]|\n[ \t]*\r?\n/u;
const edgeWindow = 1000;

function paragraphs(text: string) {
  const found: Span[] = [];
  parser.parse(text).iterate({
    enter(node) {
      if (node.name === 'Paragraph' && node.node.parent?.name === 'Document')
        found.push({ from: node.from, to: node.to });
    },
  });
  return found;
}

function edgeParagraph(text: string, edge: Edge) {
  // The adjacent block must really be a paragraph; don't search past intervening Markdown.
  const clean = text.trim();
  const rows = paragraphs(clean);
  const block = edge === 'head' ? rows[0] : rows.at(-1);
  return block && (edge === 'head' ? block.from === 0 : block.to === clean.length)
    ? {
        text: clean.slice(block.from, block.to),
        offset: text.length - text.trimStart().length + block.from,
      }
    : undefined;
}

function edgeUnits(text: string, edge: Edge) {
  const units: (Span & { value: string })[] = [];
  let from = 0;
  for (const raw of text) {
    const to = from + raw.length;
    for (const value of sentenceKey(raw)) units.push({ value, from, to });
    from = to;
  }
  return edge === 'head' ? units : units.reverse();
}

function unitGap(text: string, units: Span[], index: number, edge: Edge) {
  const prior = units[index - 1],
    next = units[index];
  if (edge === 'head') return text.slice(prior?.to ?? 0, next?.from ?? text.length);
  return text.slice(next?.to ?? 0, prior?.from ?? text.length);
}

/** Exact text in normalized space; cuts still refer to the untouched source string. */
export function insertionBoundaryEcho(original: string, offset: number, fragment: string) {
  const matches: { edge: Edge; range: Span; wholeParagraph: boolean }[] = [];
  const inputs = [
    { edge: 'head', neighbor: original.slice(0, offset), near: 'tail' },
    { edge: 'tail', neighbor: original.slice(offset), near: 'head' },
  ] as const;
  for (const { edge, neighbor, near } of inputs) {
    const candidate = edgeParagraph(fragment, edge);
    const old = edgeParagraph(neighbor, near);
    if (!candidate || !old) continue;
    const curr = edgeUnits(candidate.text, edge);
    const best = new Set<number>();
    const cap = edgeWindow * 2; // Raw UTF-16 bound before normalizing each old edge.
    const windows =
      old.text.length <= cap * 2
        ? [{ text: old.text, first: true, last: true }]
        : [
            { text: old.text.slice(0, cap), first: edge === 'head', last: edge === 'tail' },
            { text: old.text.slice(-cap), first: edge === 'tail', last: edge === 'head' },
          ];
    for (const { text, first, last } of windows) {
      const prev = edgeUnits(text, edge);
      const starts = first ? [0] : [];
      // Also compare the neighboring paragraph's opposite edge, e.g. its last sentence.
      if (last)
        for (let i = 1; i < prev.length; i++)
          if (clauseBreak.test(unitGap(text, prev, i, edge))) starts.push(i);
      for (const start of starts) {
        let max = 0;
        const limit = Math.min(curr.length, prev.length - start, edgeWindow);
        while (max < limit && curr[max].value === prev[start + max].value) max++;
        for (let length = max; length >= minEcho; length--) {
          const completeOldEdge = last && start + length === prev.length;
          if (start > 0 && !completeOldEdge) continue;
          if (length !== curr.length && !clauseBreak.test(unitGap(candidate.text, curr, length, edge)))
            continue;
          // The artificial edge of a cropped window is not a real text boundary.
          if (
            !completeOldEdge &&
            (start + length === prev.length ||
              !clauseBreak.test(unitGap(text, prev, start + length, edge)))
          )
            continue;
          best.add(length);
          break;
        }
      }
    }
    // More than one cut at this edge would not be a unique safe deletion.
    for (const count of best) {
      const wholeParagraph = count === curr.length;
      const range =
        edge === 'head'
          ? {
              from: 0,
              to: wholeParagraph
                ? candidate.offset + candidate.text.length
                : candidate.offset + curr[count].from,
            }
          : {
              from: wholeParagraph ? candidate.offset : candidate.offset + curr[count - 1].from,
              to: fragment.length,
            };
      matches.push({ edge, range, wholeParagraph });
    }
  }
  return matches;
}

/** Stronger than candidate rejection: return a single cut proven safe in saved Markdown. */
export function safeInsertionEchoCut(before: string, fragment: string, after: string) {
  const echoes = insertionBoundaryEcho(before + after, before.length, fragment);
  if (echoes.length !== 1) return;
  const { edge, range: raw, wholeParagraph } = echoes[0];
  const range = { ...raw };
  if (wholeParagraph && edge === 'head') {
    const rest = fragment.slice(range.to);
    range.to += rest.length - rest.trimStart().length;
  } else if (wholeParagraph && edge === 'tail') {
    range.from = fragment.slice(0, range.from).trimEnd().length;
  }
  // Never delete Markdown delimiters, nor unmatched quotation/bracket punctuation.
  const removed = fragment.slice(range.from, range.to);
  if (/[#*_\x60<>\[\]{}()（）「」『』“”"'~\\|]/u.test(removed)) return;
  const kept = fragment.slice(0, range.from) + fragment.slice(range.to);
  if (!kept.trim()) return;
  // A suffix cut must leave a complete boundary, not a dangling conjunction or comma.
  if (edge === 'tail' && !wholeParagraph && !/[。！？!?；;.]\s*$/u.test(kept)) return;
  const shape = (text: string) => {
    const nodes: string[] = [];
    parser.parse(text).iterate({
      enter(node) {
        nodes.push(node.name);
      },
    });
    return nodes;
  };
  const previous = shape(before + fragment + after);
  if (wholeParagraph) {
    // Plain paragraph deletion is the only permitted Markdown structure change.
    const count = paragraphs(before + fragment.slice(0, range.from)).length;
    const indexes = previous.flatMap((name, i) => (name === 'Paragraph' ? [i] : []));
    const index = indexes[count];
    if (index === undefined) return;
    previous.splice(index, 1);
  }
  const next = shape(before + kept + after);
  if (previous.length !== next.length || previous.some((type, i) => type !== next[i])) return;
  return { ...range, kept };
}

export function assessInsertion(
  original: string,
  offset: number,
  fragment: string,
  authorDirection = '',
) {
  const text = trimInsertionEcho(original, offset, fragment);
  const issues: InsertionQualityIssue[] = [];
  if (!text) return { text, issues: ['echo_only'] as InsertionQualityIssue[] };
  const parts = sentences(text);
  const neighborKeys = [
    sentenceKey(original.slice(Math.max(0, offset - 1000), offset)),
    sentenceKey(original.slice(offset, offset + 1000)),
  ];
  const spans = (from: number, width: number) => parts.slice(from, from + width).join('');
  let echo = false,
    repeat = false;
  for (let start = 0; start < parts.length && !(echo && repeat); start++) {
    // Look at a long sentence or a short sequence of sentences, not isolated words or names.
    for (let width = 1; width <= 4 && start + width <= parts.length; width++) {
      const key = spans(start, width);
      if (key.length < minEcho) continue;
      if (!echo && neighborKeys.some((neighbor) => neighbor.includes(key))) echo = true;
      if (!repeat && start + width * 2 <= parts.length && key === spans(start + width, width))
        repeat = true;
    }
  }
  if (echo) issues.push('neighbor_echo');
  else if (insertionBoundaryEcho(original, offset, text).length) issues.push('boundary_echo');
  if (repeat) issues.push('repeated_passage');
  if (workNote.test(text)) issues.push('work_note');
  // Check the generated candidate only. A spelling supplied in the source or by the author stays available as literal text.
  if (
    /[我你他她它咱]自已/u.test(text) &&
    !original.includes('自已') &&
    !authorDirection.includes('自已')
  )
    issues.push('obvious_typo');
  return { text, issues };
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
