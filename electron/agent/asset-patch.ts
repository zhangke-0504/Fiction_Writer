import { parser } from '@lezer/markdown';
import { DiagnosticFailure } from '../diagnostics/trace.js';
import { exactRange, patchFragmentLimit } from './chapter-patch.js';
import { str } from './loop.js';

export type AssetPatch = { revision: string; quote: string; replacement: string };
export const assetPatchFields = {
  revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  quote: str('已回读的当前修订中唯一命中的短原文，保留空白和标点', patchFragmentLimit),
  replacement: { type: 'string', maxLength: patchFragmentLimit, description: '只替换这处的短文' },
};

export function sameAssetPatch(left?: AssetPatch, right?: AssetPatch) {
  if (!left || !right) return left === right;
  return (
    left.revision === right.revision &&
    left.quote === right.quote &&
    left.replacement === right.replacement
  );
}

function references(body: string) {
  const links: string[] = [];
  parser.parse(body).iterate({
    enter(node) {
      if (['Link', 'LinkReference', 'Autolink', 'Image'].includes(node.name))
        links.push(body.slice(node.from, node.to));
    },
  });
  return links;
}

export function patchAssetDescription(body: string, { quote, replacement }: AssetPatch) {
  if (
    quote.length > patchFragmentLimit ||
    replacement.length > patchFragmentLimit ||
    quote === replacement ||
    quote.trim() === body.trim() ||
    /[\p{Surrogate}]/u.test(quote + ' ' + replacement)
  )
    throw new DiagnosticFailure(
      'patch_scope',
      '资料补丁只替换一处短原文，不能覆盖整个说明或提交无变化的版本。',
    );
  const { start, end } = exactRange(body, quote);
  const next = body.slice(0, start) + replacement + body.slice(end);
  if (!next.trim()) throw new DiagnosticFailure('patch_scope', '资料补丁不能清空说明。');
  const before = references(body);
  const after = references(next);
  if (before.length !== after.length || before.some((link, i) => link !== after[i]))
    throw new DiagnosticFailure('patch_scope', '资料补丁须保留已有链接，不能添加或改变引用。');
  return { body: next, start, end };
}
