import type { DocRef, Manuscript } from '../../shared/contracts.js';
import { storyLabel } from './story-notes.js';

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().trim();
export function mentionsSource(text: string, label: string) {
  const name = normalize(label);
  if (!name) return false;
  return /^[a-z0-9_-]+$/u.test(name) ? text.split(/[^a-z0-9_-]+/u).includes(name) : text.includes(name);
}

const relyOn =
  /按照?|根据|依据|遵循|遵照|严格参照|(?:必须|务必|须)(?:使用|采用|参考|沿用)|\b(?:must (?:use|follow)|strictly follow|based on|rely on|according to)\b/gu;
const clueAction = /埋设|回收|揭晓|揭露|揭示|\b(?:pay off|reveal)\b/gu;
const optional =
  /可(?:以|酌情|选)?参考|仅供参考|供参考|若有|如有|有的话|如果有|不必|无需|不用|不需要|(?:不要|别|不得|不能)(?:用|依|按|参)|(?:先不|暂不|不|别|不要|不得|不能)(?:提前|在本章)?(?:埋设|回收|揭晓|揭露|揭示)|\b(?:may|optional|if available|(?:do not|don't|not yet) (?:use|reveal|pay off))\b/u;
const quotes = /^[\s:："'「『《“‘【[(]+/u;
const qualifier =
  /^(?:(?:现有|已有|已保存|原有|原先|当前|书里|书中|指定|这份|这张|这条|那个|主体|人物|角色|伏笔|线索|\b(?:the|saved|existing|subject|clue)\b)[的\s:：]*)+/u;

function namesSource(operand: string, label: string) {
  const name = normalize(label);
  if (!name || !operand.startsWith(name)) return false;
  return !/^[a-z0-9_-]+$/u.test(name) || !/^[a-z0-9_-]/u.test(operand.slice(name.length));
}

/** Prefer an optional hint unless the current author directly names a source as the basis of the work. */
export function explicitlyRequiresEvidence(author: string | undefined, ref: DocRef, doc?: Manuscript) {
  if (!author) return false;
  const names = doc ? [ref.id, storyLabel(doc)] : [ref.id];
  return normalize(author)
    .split(/[，,。；;！!？?\n]/u)
    .some((clause) => {
      if (optional.test(clause)) return false;
      const instructions = [
        ...clause.matchAll(relyOn),
        ...(ref.type === 'clue' ? clause.matchAll(clueAction) : []),
      ];
      return instructions.some((match) => {
        const operand = clause.slice(match.index + match[0].length).replace(quotes, '');
        const qualified = operand.replace(qualifier, '').replace(quotes, '');
        return names.some((name) => namesSource(operand, name) || namesSource(qualified, name));
      });
    });
}
