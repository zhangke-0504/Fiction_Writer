import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessInsertion, insertionBoundaryEcho } from '../electron/agent/chapter-insertion.js';

const before = '托尼按住了话筒。那人的技术确实很强……整个理事会都给他让了路。文件落地了。';
const after = '门外下起雨。';
const original = before + '\r\n\r\n' + after;
const check = (candidate: string) => assessInsertion(original, before.length, candidate);

test('detects sentence echoes inside a candidate with normalized punctuation', () => {
  const candidate = '档案员重新点亮台灯。那人的技术确实很强，整个理事会都给他让了路！接着她打开窗口。';
  assert.deepEqual(check(candidate), { text: candidate, issues: ['neighbor_echo'] });
});

test('detects internal long sentence and two-sentence repetition, not short speech', () => {
  const repeated = '档案员把窗台上的红色文件封进了旧皮箱';
  assert.deepEqual(check(repeated + '。' + repeated + '！').issues, ['repeated_passage']);
  assert.deepEqual(check('灯光重新亮起了。人影拉长到门口。灯光重新亮起了！人影拉长到门口。').issues, [
    'repeated_passage',
  ]);
  assert.deepEqual(check('“不，不。不！”他翻到租约的第五章。\n\n“看这一条。”').issues, []);
});

test('recognizes drafting references and preserves the safe original echo behavior', () => {
  assert.deepEqual(check('她把第五章那笔直播租约的凭证调了出来。').issues, ['work_note']);
  assert.deepEqual(check('写作备注：此处增加悬念。').issues, ['work_note']);
  const novel = '“好，好。”托尼重新翻开文件。';
  assert.deepEqual(check([before, novel, after].join('\n\n')), { text: novel, issues: [] });
  assert.deepEqual(check(after), { text: '', issues: ['echo_only'] });
});

const greenOld =
  '哈尔低头看自己的手。指缝里还留着黄光蹭过的余温。他想起那张记录页，线索被他压在抽屉最里面。';
const greenNew =
  '哈尔低头看自己的手。指缝里还留着黄光蹭过的余温，他把它翻到背面，瞧见记录页上有个全新的蓝色印记。';
const greenKept = '他把它翻到背面，瞧见记录页上有个全新的蓝色印记。';

test('finds the Green Lantern boundary across incompatible sentence breaks without trimming it', () => {
  const draft = greenNew.replace('。指缝', '。\r\n指缝').replace('余温，', '余温,  ');
  const result = assessInsertion(greenOld, greenOld.length, draft);
  assert.deepEqual(result, { text: draft, issues: ['boundary_echo'] });
  const match = insertionBoundaryEcho(greenOld, greenOld.length, draft);
  assert.equal(match.length, 1);
  assert.equal(draft.slice(match[0].range.to), greenKept);
});

test('recognizes a mirrored suffix against the next paragraph, but not short dialogue or nonadjacent prose', () => {
  const next = '窗外还有灯光。旧纸页贴在发烫的铁窗上。里面装着账簿。';
  const suffix = '他解开新的锁扣。旧纸页贴在发烫的铁窗上，里面装着账簿。';
  assert.equal(insertionBoundaryEcho(next, 0, suffix)[0]?.edge, 'tail');
  const len = greenOld.length + '\n\n隔壁的房间仍然很安静。'.length;
  assert.deepEqual(insertionBoundaryEcho(greenOld + '\n\n隔壁的房间仍然很安静。', len, greenNew), []);
  assert.deepEqual(
    insertionBoundaryEcho(
      '“好，好。”他走到门前。',
      '“好，好。”他走到门前。'.length,
      '“好，好。”她从另一条路悄悄溜走。',
    ),
    [],
  );
});

test('flags a newly introduced reflexive typo but honors an author-supplied literal', () => {
  const typo = '她把单子按在桌上，低声说：“我自已一笔一笔算。”';
  assert.deepEqual(check(typo).issues, ['obvious_typo']);
  assert.deepEqual(check(typo.replace('自已', '自己')).issues, []);
  assert.deepEqual(assessInsertion(original, before.length, typo, '引述字条上的“我自已”').issues, []);
});
