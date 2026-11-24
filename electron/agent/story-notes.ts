import { parser } from '@lezer/markdown';
import type { Manuscript } from '../../shared/contracts.js';

const placeholder =
  /^(?:待补(?:充|写)?|待写|待定|占位(?:符)?|暂无(?:说明|内容)?|无|略|tbd|todo|placeholder|n\/?a|\.{2,}|…+)$/iu;
export function hasStoryDescription(body: string) {
  return body
    .replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .split(/\r?\n/u)
    .some((line) => {
      const text = line
        .normalize('NFKC')
        .trim()
        .replace(/^[-*+>]\s*/u, '')
        .replace(/^[*_`「【]+|[*_`」】。.!！]+$/gu, '')
        .trim();
      return (
        /[\p{L}\p{N}]/u.test(text) &&
        !/^#{1,6}(?:\s|$)/u.test(text) &&
        !/^(?:id|type|name|kind|title|subjectIds|setupChapterId|payoffChapterId|setupBeatId|payoffBeatId|名称|类型|标题|关联主体)\s*[:：]/iu.test(
          text,
        ) &&
        !placeholder.test(text)
      );
    });
}

export type NoteExcerpt = { text: string; range: [number, number] };
export function noteExcerpt(body: string, start = 0, end = body.length): NoteExcerpt | undefined {
  const raw = body.slice(start, end);
  const text = raw.trim();
  if (!text) return;
  const from = start + raw.length - raw.trimStart().length;
  return { text, range: [from, from + text.length] };
}

/** Read marked top-level Markdown sections, not headings inside quoted text or code fences. */
export function noteSections(body: string) {
  const headings: { name: string; from: number; to: number }[] = [];
  parser.parse(body).iterate({
    enter(node) {
      if (!/^ATXHeading[1-6]$/u.test(node.name) || node.node.parent?.name !== 'Document') return;
      const name = body
        .slice(node.from, node.to)
        .replace(/^#{1,6}\s+|\s+#+\s*$/gu, '')
        .trim();
      headings.push({ name, from: node.from, to: node.to });
    },
  });
  const sections = new Map<string, NoteExcerpt | undefined>();
  headings.forEach((heading, i) => {
    sections.set(
      heading.name,
      sections.has(heading.name) ? undefined : noteExcerpt(body, heading.to, headings[i + 1]?.from),
    );
  });
  return sections;
}

export function clueSections(body: string) {
  return { visible: storyPart(body, 'visible', true), reveal: storyPart(body, 'reveal', true) };
}

const planLine =
  /(?:^|\n)\s*(?:#{1,6}\s*)?(?:回收(?:真相|方式)?|揭示事实|保密事实|后续(?:安排|计划)?|计划|未来(?:剧情|事件)?|大纲)\s*(?:[:：]|\n)/u;
const aliases = {
  stable: ['稳定设定', '长期设定', '核心设定'],
  visible: ['可见线索', '埋设', '埋设方式', '表象', '读者可见'],
  reveal: ['回收真相', '回收', '回收方式'],
} as const;
export type StoryPart = keyof typeof aliases;

/** One compatibility reader for both saved notes and unsaved candidates. Undefined means no usable section. */
export function storyPart(body: string, part: StoryPart, generated = false): NoteExcerpt | undefined {
  const sections = noteSections(body);
  const labels: readonly string[] = aliases[part];
  const named = labels.filter((name) => sections.has(name));
  if (named.length > 1) return;
  let span = named.length ? sections.get(named[0]) : undefined;
  if (!named.length && !generated) {
    if (part === 'stable') {
      const future = body.search(planLine);
      span = noteExcerpt(body, 0, future < 0 ? body.length : future);
    } else {
      const matches = [
        ...body.matchAll(
          new RegExp(`(?:^|\\n)[ \\t]*(?:${labels.join('|')})[ \\t]*[:：][ \\t]*([^\\r\\n]+)`, 'gu'),
        ),
      ];
      if (matches.length === 1) {
        const [line, text] = matches[0];
        span = noteExcerpt(
          body,
          matches[0].index + line.length - text.length,
          matches[0].index + line.length,
        );
      } else if (
        !matches.length &&
        part === 'reveal' &&
        !aliases.visible.some((label) => sections.has(label))
      ) {
        // Legacy payoff-only prose is never admitted to a setup chapter.
        span = noteExcerpt(body);
      }
    }
  }
  if (span && part === 'visible') {
    const gate = span.text.search(
      /(?:^|\n)\s*(?:回收(?:真相|方式)?|揭晓|揭示事实|保密事实|真相)\s*[:：]|(?:回收|揭晓|真相)\s*(?:[:：]|时)/u,
    );
    if (gate >= 0) span = noteExcerpt(body, span.range[0], span.range[0] + gate);
  }
  return span && hasStoryDescription(span.text) ? span : undefined;
}

/** Repair only unambiguous heading names in an unsaved generated candidate. */
export function normalizeStoryHeadings(body: string) {
  const sections = noteSections(body);
  let next = body;
  for (const [canonical, ...other] of Object.values(aliases)) {
    const alternates = other.filter((name) => sections.has(name));
    if (!sections.has(canonical) && alternates.length === 1 && sections.get(alternates[0])) {
      const old = alternates[0];
      next = next.replace(new RegExp(`^(#{1,6} +)${old}(?=\\s*$|\\s+#+\\s*$)`, 'mu'), `$1${canonical}`);
    }
  }
  return next;
}

export const storyLabel = (doc: Pick<Manuscript, 'id' | 'fields'>) =>
  doc.fields.title ?? doc.fields.name ?? doc.id;

/** Resolve legacy beat anchors only when they identify one current chapter. */
export function clueAnchors(clue: Pick<Manuscript, 'fields'>, chapters: readonly Manuscript[]) {
  const { setupChapterId, payoffChapterId, setupBeatId, payoffBeatId } = clue.fields;
  const at = (id?: string, beat?: string) => {
    if (id) return chapters.find((chapter) => chapter.id === id);
    if (!beat) return;
    const matching = chapters.filter((chapter) => chapter.fields.beatIds?.includes(beat));
    if (matching.length === 1) return matching[0];
  };
  return { setup: at(setupChapterId, setupBeatId), payoff: at(payoffChapterId, payoffBeatId) };
}
