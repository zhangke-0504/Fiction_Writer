import type { Manuscript } from '../../shared/contracts.js';
import { storyLinks } from '../documents.js';
const indexName = (d: Manuscript) => d.fields.title ?? d.fields.name ?? d.id;
function excerpt(text: string, max: number) {
  if (text.length <= max) return text;
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  return `[开头与结尾摘录；全文 ${text.length} 字符]\n${paragraphs[0]?.slice(0, Math.floor(max / 3)) ?? ''}\n[…]\n${text.slice(-Math.floor((max * 2) / 3))}`;
}
export function chapterContext(
  documents: Manuscript[],
  target: Manuscript,
  precedingBudget = 43_000,
  assetScale = 1,
) {
  const scaled = (value: number) => Math.floor(value * assetScale);
  const chapters = documents.filter((d) => d.type === 'chapter');
  const index = chapters.findIndex((d) => d.id === target.id),
    chapterIds = new Map(chapters.map((d, i) => [d.id, i]));
  const previous = chapters.slice(0, index).filter((d) => d.body.trim());
  const selected: { header: string; text: string }[] = [];
  const fullyIncluded = new Set<string>();
  let budget = precedingBudget;
  // Keep recent chapters complete when possible. Reserve some room for early, source-labelled excerpts.
  for (let i = previous.length - 1; i >= 0; i--) {
    const chapter = previous[i],
      total = chapter.body.length;
    const reserved = Math.min(i * 310, Math.floor(precedingBudget / 5));
    const available = Math.max(0, budget - reserved);
    if (available < 160) break;
    const keep =
      total <= available
        ? total
        : i >= previous.length - 2
          ? Math.min(available, Math.floor(precedingBudget / 2))
          : Math.min(1200, available);
    const text = excerpt(chapter.body, keep);
    if (text === chapter.body) fullyIncluded.add(chapter.id);
    selected.unshift({ header: `前章 ${indexName(chapter)} [chapters/${chapter.id}.md]`, text });
    budget -= text.length;
  }
  const outline = documents.find((d) => d.type === 'outline');
  const clueRelevant = (d: Manuscript) => {
    const { setupChapterId, payoffChapterId, setupBeatId, payoffBeatId } = d.fields;
    const setup = setupChapterId ? chapterIds.get(setupChapterId) : undefined;
    const payoff = payoffChapterId ? chapterIds.get(payoffChapterId) : undefined;
    return (
      setup === index ||
      payoff === index ||
      ((setup === undefined || setup <= index) && (payoff === undefined || payoff >= index)) ||
      !!target.fields.beatIds?.some((id) => id === setupBeatId || id === payoffBeatId)
    );
  };
  const clues = documents.filter((d) => d.type === 'clue' && clueRelevant(d));
  const linked = new Set([
    ...clues.flatMap((d) => d.fields.subjectIds ?? []),
    ...storyLinks((outline?.body ?? '') + '\n' + target.body)
      .filter((link) => link.ref.type === 'subject')
      .map((link) => link.ref.id),
  ]);
  const subjects = documents
    .filter((d) => d.type === 'subject')
    .sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)));
  let castBudget = scaled(27_000);
  const cast = [...clues, ...subjects].flatMap((d) => {
    if (castBudget < 200) return [];
    const text = `[${d.type}/${d.id}] ${indexName(d)} ${JSON.stringify(d.fields)}\n${excerpt(d.body, Math.min(scaled(5500), castBudget))}`;
    castBudget -= text.length;
    return [text];
  });
  const book = documents.find((d) => d.type === 'book');
  const targetBody = excerpt(target.body, scaled(25_000));
  const abridged = previous.filter((d) => !fullyIncluded.has(d.id));
  if (targetBody !== target.body) abridged.push(target);
  return {
    book: book
      ? {
          title: book.fields.title,
          genre: book.fields.genre,
          style: book.fields.style,
          summary: excerpt(book.body, scaled(4000)),
        }
      : undefined,
    outline: excerpt(outline?.body ?? '', scaled(20_000)),
    target: {
      id: target.id,
      title: target.fields.title,
      order: target.fields.order,
      beatIds: target.fields.beatIds,
      body: targetBody,
    },
    previous: selected,
    earlierOmitted: previous.length - selected.length,
    readbackSources: abridged.map((chapter) => ({
      chapterId: chapter.id,
      title: indexName(chapter),
      order: chapter.fields.order,
      length: chapter.body.length,
    })),
    cast,
  };
}
