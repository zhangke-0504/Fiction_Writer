import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchBody, type ProseEdit } from '../electron/agent/chapter-patch.js';

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
