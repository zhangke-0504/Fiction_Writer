import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expandParagraphGap,
  patchBody,
  type ParagraphGapEdit,
  type ProseEdit,
} from '../electron/agent/chapter-patch.js';

const padding = '这是保留的段落。'.repeat(30);
const raw = '保留开场。\r\n\r\n坏日期是星期三，预留短句。\r\n\r\n保留结尾。' + padding;

test('composes several exact local replacements against one snapshot, including deletion', () => {
  assert.equal(
    patchBody(raw, [
      { quote: '，预留短句', replacement: '' },
      { quote: '星期三', replacement: '星期五' },
    ]),
    raw.replace('，预留短句', '').replace('星期三', '星期五'),
  );
});

for (const [reason, edits] of [
  ['patch_anchor', [{ quote: '不存在', replacement: '' }]],
  ['patch_anchor', [{ quote: '这是保留的段落', replacement: '不写' }]],
  [
    'patch_anchor',
    [
      { quote: '日期是星期', replacement: '日期是星期' + '五' },
      { quote: '星期三', replacement: '星期五' },
    ],
  ],
  ['patch_scope', [{ quote: raw, replacement: '整章重写' }]],
  ['patch_scope', [{ quote: '星期三', replacement: '星期三' }]],
  ['patch_scope', [{ quote: '', replacement: '新段落' }]],
] as [string, ProseEdit[]][]) {
  test('rejects ' + reason + ' for ' + edits[0].quote.slice(0, 20), () => {
    assert.throws(() => patchBody(raw, edits), { diagnosticReason: reason });
  });
}

const gapEdit: ParagraphGapEdit = {
  paragraphGap: { leftQuote: '黑暗中等候。', rightQuote: '钟声响起时，', blankLines: 1 },
  part: 'spacing',
};
const left = '他独自留在台阶的黑暗中等候。';
const right = '钟声响起时，他终于放下手上的东西。';
const sixLf = '\n'.repeat(6);
const adjacent = left + sixLf + right;

test('expands only the selected gap into an exact local patch and preserves the remaining bytes', () => {
  const untouched = `\n\n${padding}\r\n\r\n保留 CRLF。${sixLf}这处也有六个 LF，仍保持原样。\n`;
  const original = adjacent + untouched;
  const { edit, lineBreaks } = expandParagraphGap(original, gapEdit);
  const { leftQuote, rightQuote } = gapEdit.paragraphGap;
  assert.deepEqual(edit, {
    quote: leftQuote + sixLf + rightQuote,
    replacement: `${leftQuote}\n\n${rightQuote}`,
    part: 'spacing',
  });
  assert.deepEqual(lineBreaks, { beforeLf: 6, afterLf: 2 });
  assert.equal(patchBody(original, [edit]), `${left}\n\n${right}${untouched}`);
});

for (const [name, body] of [
  ['missing end', `不同的结尾。${sixLf}${right}`],
  ['left quote is not a suffix', `${left}并没有结束。${sixLf}${right}`],
  ['right quote is not a prefix', `${left}${sixLf}不是开头的${right}`],
  ['an intervening block', `${left}\n\n***\n\n${right}`],
  ['one paragraph', `${left}\n${right}`],
  ['a fenced code block', `\`\`\`\n${adjacent}\n\`\`\``],
  ['a nested list', `- ${left}${sixLf}  ${right}`],
  ['repeated pair with different separator lengths', `${adjacent}\n\n${left}\n\n${right}`],
]) {
  test(`rejects an unlocatable or ambiguous paragraph gap: ${name}`, () => {
    assert.throws(() => expandParagraphGap(body, gapEdit), { diagnosticReason: 'patch_anchor' });
  });
}

for (const [name, separator] of [
  ['CRLF', '\r\n'.repeat(6)],
  ['mixed line endings starting with CRLF', '\r\n\n\n'],
  ['mixed line endings ending with CRLF', '\n\n\r\n'],
  ['space-only blank line', '\n \n\n'],
  ['tab-only blank line', '\n\t\n\n'],
]) {
  test(`rejects an unsupported paragraph separator: ${name}`, () => {
    assert.throws(() => expandParagraphGap(left + separator + right, gapEdit), {
      diagnosticReason: 'patch_scope',
    });
  });
}

test('a same-width gap expands to an unchanged edit, not a patch', () => {
  const body = `${left}\n\n${right}\n\n${padding}`;
  const { edit, lineBreaks } = expandParagraphGap(body, gapEdit);
  assert.deepEqual(lineBreaks, { beforeLf: 2, afterLf: 2 });
  assert.equal(edit.quote, edit.replacement);
  assert.throws(() => patchBody(body, [edit]), { diagnosticReason: 'patch_scope' });
});

test('the expanded quote still obeys the ordinary global uniqueness and local size limits', () => {
  const repeatedQuote = `${adjacent}\n\n\`\`\`\n${adjacent}\n\`\`\`\n\n${padding}`;
  const { edit } = expandParagraphGap(repeatedQuote, gapEdit);
  assert.throws(() => patchBody(repeatedQuote, [edit]), { diagnosticReason: 'patch_anchor' });
  const tooLong = left + '\n'.repeat(601) + right + '\n\n' + padding.repeat(10);
  assert.throws(() => patchBody(tooLong, [expandParagraphGap(tooLong, gapEdit).edit]), {
    diagnosticReason: 'patch_scope',
  });
});
