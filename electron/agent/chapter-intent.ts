import type { Manuscript } from '../../shared/contracts.js';

const digits = '零一二三四五六七八九';
function chapterOrder(target: string) {
  const found = target.match(/^第\s*([\d零一二三四五六七八九十两]+)\s*章$/u)?.[1];
  if (!found) return Number(/^chapter\s+(\d+)$/i.exec(target)?.[1]);
  if (/^\d+$/.test(found)) return Number(found);
  const number = found.replaceAll('两', '二');
  if (number.length === 1 && number !== '十') return digits.indexOf(number);
  if (!/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(number)) return NaN;
  const [tens, ones] = number.split('十');
  return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
}

/** Destructive rewrite is authorized by the author's direct current command, not a tool argument. */
export function rewriteTarget(prompt: string, chapters: Manuscript[], selected?: string) {
  const source = prompt.normalize('NFKC').trim();
  const clause = /^([^\n，,。!！?？;；]+)([\n，,。!！?？;；]|$)/u.exec(source);
  if (
    !clause ||
    ['?', '？'].includes(clause[2]) ||
    /(?:不要|别|无需|禁止|不许|不得|不能|不必|避免)[^\n，。；!?]{0,24}(?:重写|重新写|覆盖)|\b(?:do not|don't|never)\s+rewrite\b/iu.test(
      source,
    )
  )
    return undefined;
  const request = clause[1].trim().replace(/^(?:(?:请帮我|请你|请|帮我|麻烦你)\s*|please\s+)/iu, '');
  const raw =
    /^(?:从头\s*)?(?:重写|重新写)\s*(.+)$/u.exec(request)?.[1] ??
    /^(?:把|将)\s*(.+?)\s*(?:从头\s*)?(?:重写|重新写)$/u.exec(request)?.[1] ??
    /^rewrite\s+(.+)$/iu.exec(request)?.[1];
  if (!raw) return undefined;
  const target = raw
    .trim()
    .replace(/(?:的)?(?:正文|全文)\s*$/u, '')
    .trim()
    .replace(/^[「『《“"']|[」』》”"']$/gu, '');
  if (/^(?:本章|当前章(?:节)?|选中章(?:节)?|这[一]?章)$/u.test(target)) return selected;
  const order = chapterOrder(target);
  const matches = chapters.filter((doc) =>
    Number.isInteger(order) && order > 0
      ? doc.fields.order === order
      : doc.id === target || doc.fields.title === target,
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

/** Use the earliest referenced chapter if ambiguous, so recall cannot add later prose. */
export function memoryChapterTarget(prompt: string, chapters: Manuscript[], selected?: string) {
  const text = prompt.normalize('NFKC');
  const orders = new Set(
    [...text.matchAll(/第\s*[\d零一二三四五六七八九十两]+\s*章|\bchapter\s+\d+\b/giu)].map(([value]) =>
      chapterOrder(value),
    ),
  );
  return (
    chapters.find(
      (chapter) =>
        orders.has(chapter.fields.order ?? -1) ||
        (chapter.fields.title &&
          chapter.fields.title.length >= 3 &&
          text.includes(chapter.fields.title.normalize('NFKC'))),
    )?.id ?? selected
  );
}
