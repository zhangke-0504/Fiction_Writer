import type { Manuscript } from '../../shared/contracts.js';
import { activeCluePhase } from './chapter-boundary.js';
import { clueSections, noteExcerpt, type NoteExcerpt } from './story-notes.js';

const gatePattern = /<!--\s*reveal:([a-zA-Z0-9_-]+)\s*-->/gu;
const protectedLabel = '(?:揭示事实|保密事实)';
const explicitFact = new RegExp(
  `^\\s*(?:[-*+]\\s*)?(?:\\*\\*)?${protectedLabel}\\s*(?:\\*\\*)?[:：](?:\\*\\*)?\\s*([^\\r\\n]+)$`,
  'gmu',
);
const clause = (text: string) =>
  text
    .normalize('NFKC')
    .trim()
    .replace(/[。.!！?？;；]+$/u, '')
    .trim();

/** Payoff prose stays gated by source. Only an explicitly identified proposition can gate its copies elsewhere. */
export function protectedFacts(body: string) {
  const reveal = clueSections(body).reveal;
  return [...(reveal?.text ?? '').matchAll(explicitFact)]
    .map((match) => clause(match[1]))
    .filter((claim) => claim.length >= 4 && claim.length <= 800);
}

function claimInUnit(text: string, facts: string[]) {
  const unit = clause(text);
  // A neighbouring label or quotation may surround a complete assertion. A repeated noun or fragment isn't an assertion.
  return facts.some((fact) => {
    for (let from = unit.indexOf(fact); from >= 0; from = unit.indexOf(fact, from + fact.length)) {
      if (
        (!from || /[\s:：>「『“"（(【：]/u.test(unit[from - 1])) &&
        (from + fact.length === unit.length ||
          /[\s:：」』”")）】,，。!?！？；;]/u.test(unit[from + fact.length]))
      )
        return true;
    }
    return false;
  });
}

export function storyVisibility(clues: Manuscript[], chapters: Manuscript[], target?: Manuscript) {
  const accessible = new Set<string>();
  const facts = new Set<string>();
  for (const clue of clues) {
    const phase = target && activeCluePhase(clue, chapters, target);
    if (phase && !phase.hidden) accessible.add(clue.id);
    else for (const fact of protectedFacts(clue.body)) facts.add(fact);
  }
  const assertions = [...facts];
  function withheld(text: string) {
    const masked: [number, number][] = [];
    for (const match of text.matchAll(gatePattern)) {
      const from = match.index;
      const after = from + match[0].length;
      if (accessible.has(match[1])) {
        masked.push([from, after]);
        continue;
      }
      // Allow standalone markers before the next paragraph as well as inline markers within a paragraph.
      const leading = /^\s*/u.exec(text.slice(after))![0].length;
      const start = after + leading;
      const next = /\r?\n[ \t]*\r?\n|<!--\s*(?:chapter|beat|reveal):/u.exec(text.slice(start));
      masked.push([from, next ? start + next.index : text.length]);
    }
    if (assertions.length) {
      for (const unit of text.matchAll(/[^\r\n。！？!?；;]+[。！？!?；;]*/gu))
        if (claimInUnit(unit[0], assertions)) masked.push([unit.index, unit.index + unit[0].length]);
    }
    return masked.sort((a, b) => a[0] - b[0]);
  }
  function spans(text: string) {
    const result: NoteExcerpt[] = [];
    let start = 0;
    for (const [from, to] of withheld(text)) {
      if (from > start) {
        const part = noteExcerpt(text, start, from);
        if (part) result.push(part);
      }
      start = Math.max(start, to);
    }
    const tail = noteExcerpt(text, start);
    if (tail) result.push(tail);
    return result;
  }
  return {
    spans,
    visible: (text: string) =>
      spans(text)
        .map(({ text }) => text)
        .join('\n\n'),
    safe: (text: string) => !withheld(text).length,
  };
}
