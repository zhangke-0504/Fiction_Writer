import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Change } from '../shared/contracts.js';
import { WorkspaceService } from '../electron/workspace.js';
import { Journal } from '../electron/journal.js';
import { RunManager } from '../electron/agent/runs.js';
import { draftChapter } from '../electron/agent/draft.js';
import { chapterContext } from '../electron/agent/chapter-context.js';
import { WritingContextFailure, writingIssueDetails } from '../electron/agent/writing-request.js';
import type { ChapterPlan } from '../electron/agent/chapter-boundary.js';
import type { Script } from '../electron/agent/scripted.js';
import { captureWritingRequests, isolatedRequest } from './writing-request-fixture.js';
import { collectDiagnostics } from './diagnostic-fixture.js';

const revealed = 'ANSWER_AFTER_FIFTH_CHAPTER';
const note = '## 稳定设定\n罗蓝只戴右手手套。REQUIRED_GLOVE_RULE';
const surface = '本章只露出信封尾号十七。VISIBLE_ENVELOPE';
const answer = '尾号十七对应藏在桥下的旧档案。' + revealed;
const clueBody = `## 可见线索\n${surface}\n\n## 回收真相\n${answer}`;
const laterOpening = '窗仍关着，守夜人在柜台等信。';
const checkText = (out: string) => ({ role: 'assistant' as const, text: out, calls: [] });
const chapter = (id: string, order: number, body: string): Change => ({
  type: 'chapter',
  id,
  expect: null,
  fields: { title: id, order },
  body,
});

async function fixture(
  t: import('node:test').TestContext,
  options: { legacy?: boolean; initialNote?: string; later?: string; extra?: Change[] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'fw-chapter-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceService({ libraryRoot: join(root, 'library') });
  await workspace.init();
  const { id: bookId } = await workspace.createBook({
    title: '镇外的灯',
    summary: `港口的守夜人等待一封信。\n\n<!-- reveal:seal -->\n作者存档：${revealed}。`,
  });
  const outline = await workspace.readDocument(bookId, { type: 'outline', id: 'outline' });
  assert.equal(
    (
      await workspace.writeChanges(bookId, [
        {
          ...outline,
          expect: outline.revision,
          body: `<!-- chapter:setup -->\n\n让[罗蓝](subjects/luo.md)看见信封。\n\n<!-- reveal:seal -->\n补充未来规划：${revealed}\n\n<!-- chapter:payoff -->\n\n${answer}`,
        },
        {
          type: 'subject',
          id: 'luo',
          expect: null,
          fields: { name: '罗蓝', kind: 'character' },
          body:
            options.initialNote ??
            `${note}\n\n<!-- reveal:seal -->\n未来可能发生：${revealed}。\n\n## 计划\n另一个版本的${revealed}。`,
        },
        {
          type: 'subject',
          id: 'letter',
          expect: null,
          fields: { name: '信封', kind: 'item' },
          body: '信封边缘有蜡封。',
        },
        {
          type: 'subject',
          id: 'unrelated-empty',
          expect: null,
          fields: { name: '侍者', kind: 'character' },
          body: '   ',
        },
        {
          type: 'subject',
          id: 'spare',
          expect: null,
          fields: { name: '无关设定', kind: 'item' },
          body: 'OPTIONAL_DETAIL' + '甲'.repeat(5000),
        },
        {
          type: 'clue',
          id: 'seal',
          expect: null,
          fields: {
            title: '尾号的去向',
            subjectIds: ['letter'],
            setupChapterId: 'setup',
            payoffChapterId: 'payoff',
          },
          body: options.legacy ? `埋设：${surface}\n回收：${answer}` : clueBody,
        },
        chapter('before', 1, '上一章守夜人离开港口。PREVIOUS_ESTABLISHED'),
        chapter('setup', 2, ''),
        chapter('payoff', 4, options.later ?? ''),
        ...(options.extra ?? []),
      ])
    ).error,
    undefined,
  );
  const runs = new RunManager(join(root, 'state'), new Journal(() => {}));
  await runs.init();
  const session = await runs.create({ cwd: workspace.bookRoot(bookId), bookId }, '写作');
  const start = (
    chapterId: string,
    script: Script[],
    opts: { plan?: ChapterPlan; inputBudget?: number; direction?: string } = {},
  ) => {
    const { provider, requests } = captureWritingRequests(script, opts.inputBudget);
    const trace = collectDiagnostics();
    runs.start(
      session.id,
      '写这一章',
      async (ctx) => {
        await draftChapter(
          workspace,
          ctx,
          provider,
          chapterId,
          'draft',
          { author: '写这一章，不改其它章。', arrangement: opts.direction },
          { plan: opts.plan },
        );
      },
      'high',
      trace.report,
    );
    return {
      requests,
      trace,
      wait: async () => {
        await runs.wait(session.id);
        return runs.get(session.id).run!;
      },
    };
  };
  return { workspace, bookId, start };
}

for (const legacy of [false, true])
  test(
    legacy
      ? 'a labelled legacy setup uses only the safe authored excerpt'
      : 'bounded chapter input keeps real required notes and withholds known future clues across sources',
    async (t) => {
      const f = await fixture(t, { legacy });
      const op = f.start(
        'setup',
        [
          (request) => {
            isolatedRequest(request, 'OUTER_CHAT_ONLY');
            const text = JSON.stringify(request.history);
            assert.match(text, /REQUIRED_GLOVE_RULE/);
            assert.match(text, /VISIBLE_ENVELOPE/);
            assert.match(text, /PREVIOUS_ESTABLISHED/);
            assert.doesNotMatch(text, new RegExp(revealed + '|OPTIONAL_DETAIL'));
            return checkText('罗蓝戴着右手手套，注意到编号。');
          },
        ],
        { inputBudget: 3200, direction: `看见封条。\n\n<!-- reveal:seal -->\n回收答案是 ${revealed}` },
      );
      const result = await op.wait();
      assert.equal(result.status, 'completed', result.error);
      assert.deepEqual(
        op.requests.map(({ lane }) => lane),
        ['draft'],
      );
      const payoff = f.start('payoff', [
        ({ history }) => {
          assert.match(JSON.stringify(history), new RegExp(revealed));
          assert.match(JSON.stringify(history), /戴着右手手套/);
          return checkText('她翻开档案。');
        },
      ]);
      const paid = await payoff.wait();
      assert.equal(paid.status, 'completed', paid.error);
    },
  );

test('an empty or too large mandatory subject fails before dispatch', async (t) => {
  for (const initialNote of ['待补', '必要设定 ' + '甲'.repeat(6000)]) {
    const f = await fixture(t, { initialNote });
    const op = f.start('setup', [], { inputBudget: 3000 });
    const result = await op.wait();
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /subject\/luo/);
    assert.equal(op.requests.length, 0);
    assert.equal((await f.workspace.readDocument(f.bookId, { type: 'chapter', id: 'setup' })).body, '');
  }
});

test('an insertion uses sourced successor conditions and needs a new plan when the opening conflicts', async (t) => {
  const f = await fixture(t, {
    extra: [
      chapter(
        'next',
        3,
        `罗蓝从未见过信封。\n\n${laterOpening}\n\n这是后章的私人草稿标记。NEXT_RAW_PROSE`,
      ),
    ],
  });
  const target = { type: 'chapter' as const, id: 'next' };
  const before = await f.workspace.readDocument(f.bookId, target);
  const conflict = f.start('setup', [], { direction: '让罗蓝见到信封并交给同伴。' });
  const conflictRun = await conflict.wait();
  assert.equal(conflictRun.status, 'failed');
  assert.match(conflictRun.error!, /后接章 next 的开场条件冲突/);
  assert.equal(conflict.requests.length, 0);
  const plan = {
    nextBoundary: {
      chapterId: 'next',
      conditions: [{ quote: laterOpening, condition: '必须接到封闭的窗口和柜台值守。' }],
    },
  };
  const op = f.start(
    'setup',
    [
      ({ history }) => {
        const text = JSON.stringify(history);
        assert.match(text, /不能见到信封|封闭的窗口/);
        assert.match(text, /PREVIOUS_ESTABLISHED/);
        assert.doesNotMatch(text, new RegExp(`${laterOpening}|NEXT_RAW_PROSE|${revealed}`));
        return checkText('同伴在巷口看了一眼尾号。');
      },
    ],
    { plan, direction: '让同伴看见信封；罗蓝不在现场。' },
  );
  const success = await op.wait();
  assert.equal(success.status, 'completed', success.error);
  assert.equal((await f.workspace.readDocument(f.bookId, target)).revision, before.revision);
  assert.equal(
    (await f.workspace.readDocument(f.bookId, { type: 'clue', id: 'seal' })).fields.payoffChapterId,
    'payoff',
  );
});

for (const change of ['setting', 'placement'] as const)
  test(`a ${change} revision after dispatch cannot commit the draft`, async (t) => {
    const f = await fixture(t);
    const op = f.start('setup', [
      async () => {
        if (change === 'setting') {
          const subject = await f.workspace.readDocument(f.bookId, { type: 'subject', id: 'luo' });
          assert.equal(
            (
              await f.workspace.writeChanges(f.bookId, [
                { ...subject, expect: subject.revision, body: '作者修订的主体。' },
              ])
            ).error,
            undefined,
          );
        } else
          assert.equal(
            (
              await f.workspace.writeChanges(f.bookId, [
                chapter('new-neighbor', 3, '新出现的已写后章。'),
              ])
            ).error,
            undefined,
          );
        return checkText('不进入稿件。');
      },
    ]);
    const result = await op.wait();
    assert.equal(result.status, 'failed');
    assert.match(
      result.error!,
      change === 'setting' ? /subject\/luo 已变化/ : /章节顺序或前后已写状态已变化/,
    );
    assert.equal((await f.workspace.readDocument(f.bookId, { type: 'chapter', id: 'setup' })).body, '');
  });

test('diagnostics account for actually admitted blocks, omit raw content, and never mark a blocked request dispatched', async (t) => {
  const f = await fixture(t);
  const success = f.start('setup', [() => checkText('不进入日志的隐私内容。')], { inputBudget: 3200 });
  const ok = await success.wait();
  assert.equal(ok.status, 'completed', ok.error);
  assert.match(JSON.stringify(success.requests[0].wire.history), /REQUIRED_GLOVE_RULE/);
  assert.doesNotMatch(JSON.stringify(success.requests[0].wire.history), /OPTIONAL_DETAIL/);
  const summary = success.trace.rows.find(({ event }) => event === 'writing.context.dispatched');
  assert.equal(summary?.fields.template, 'write-chapter');
  assert.equal(summary?.fields.runId, ok.id);
  const groups = success.trace.rows.filter(({ event }) => event === 'writing.context.group');
  assert.ok(groups.every(({ fields }) => fields.spanId === summary?.fields.spanId));
  const subjects = groups.find(({ fields }) => fields.group === 'subject');
  assert.equal(subjects?.fields.includedRequired, 2);
  assert.equal(subjects?.fields.omittedOptional, 1);
  const provenance = success.trace.rows.filter(
    ({ event, fields }) => event === 'writing.context.source' && fields.group === 'subject',
  );
  assert.equal(provenance.length, 2);
  assert.ok(
    provenance.every(
      ({ fields }) =>
        typeof fields.documentRef === 'string' && fields.documentRef.match(/^[a-f0-9]{16}$/),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(success.trace.rows),
    /REQUIRED_GLOVE_RULE|OPTIONAL_DETAIL|ANSWER_AFTER_FIFTH_CHAPTER|不进入日志的隐私内容|subject\/luo/,
  );
  assert.deepEqual(success.trace.rejected, []);
  const blocked = f.start('payoff', [], { plan: { subjectIds: ['unrelated-empty'] } });
  assert.equal((await blocked.wait()).status, 'failed');
  assert.equal(blocked.requests.length, 0);
  assert.equal(
    blocked.trace.rows.find(({ event }) => event === 'writing.context.blocked')?.fields.reason,
    'context_required',
  );
  assert.ok(blocked.trace.rows.every(({ event }) => event !== 'writing.context.dispatched'));
  assert.deepEqual(blocked.trace.rejected, []);
});

test('chapter state notes require saved evidence, and nested reveal headings are not treated as surface text', async (t) => {
  const f = await fixture(t, {
    initialNote:
      note +
      '\n\n## 已发生变化\n\n<!-- chapter:before -->\n\n守夜人已经离开。\n原文：上一章守夜人离开港口。\n\n<!-- chapter:before -->\n\n罗蓝已经获知身份。UNVERIFIED_CHARACTER_STATE\n原文：这句话从没写过。',
  });
  const clue = await f.workspace.readDocument(f.bookId, { type: 'clue', id: 'seal' });
  assert.equal(
    (
      await f.workspace.writeChanges(f.bookId, [
        { ...clue, expect: clue.revision, body: clueBody.replace('## 回收真相', '### 回收真相') },
      ])
    ).error,
    undefined,
  );
  const op = f.start('setup', [
    ({ history }) => {
      const payload = JSON.stringify(history);
      assert.match(payload, /守夜人已经离开/);
      assert.doesNotMatch(payload, new RegExp('UNVERIFIED_CHARACTER_STATE|' + revealed));
      return checkText('开窗看见了码头。');
    },
  ]);
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
});

test('a saved card remains ready when a later reveal repeats common words and a complete shared premise', async (t) => {
  const premise = '旧弓只有岛上的人能拉开';
  const secret = '看守祠堂的尼勒其实是失踪的王子';
  const f = await fixture(t, {
    initialNote: `## 稳定设定\n罗蓝是守夜人的人证。${premise}。她把手套藏在衣袋。`,
  });
  const c = await f.workspace.readDocument(f.bookId, { type: 'clue', id: 'seal' });
  const o = await f.workspace.readDocument(f.bookId, { type: 'outline', id: 'outline' });
  assert.equal(
    (
      await f.workspace.writeChanges(f.bookId, [
        {
          ...c,
          expect: c.revision,
          body: `## 可见线索\n罗蓝向一个人证问起旧弓。${premise}。\n\n## 回收真相\n回收时再次提及「人证」。${premise}。\n揭示事实：${secret}。`,
        },
        {
          ...o,
          expect: o.revision,
          body: `<!-- chapter:setup -->\n\n[罗蓝](subjects/luo.md)先见到旧弓。${secret}。\n\n<!-- chapter:payoff -->\n\n${secret}。`,
        },
      ])
    ).error,
    undefined,
  );
  const original = await f.workspace.readDocument(f.bookId, { type: 'subject', id: 'luo' });
  const op = f.start('setup', [
    ({ history }) => {
      const input = JSON.stringify(history);
      assert.match(input, /罗蓝是守夜人的人证/);
      assert.match(input, new RegExp(premise));
      assert.match(input, /罗蓝先见到旧弓|先见到旧弓/);
      assert.doesNotMatch(input, new RegExp(secret));
      return checkText('罗蓝问了旧弓的事。');
    },
  ]);
  const result = await op.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.equal((await f.workspace.readDocument(f.bookId, original)).revision, original.revision);
  const paid = f.start('payoff', [
    ({ history }) => {
      assert.match(JSON.stringify(history), new RegExp(secret));
      return checkText('尼勒不得不承认自己的身份。');
    },
  ]);
  const reveal = await paid.wait();
  assert.equal(reveal.status, 'completed', reveal.error);
});

test('readiness distinguishes existing-but-private notes and does not blame dependencies of a blocked clue', async (t) => {
  const f = await fixture(t, {
    initialNote: '## 稳定设定\n\n<!-- reveal:seal -->\n这段是带阶段的既有说明。',
  });
  const view = await f.workspace.readAll(f.bookId);
  const doc = view.documents.find(({ id }) => id === 'setup')!;
  assert.throws(
    () => chapterContext(view.documents, doc),
    (error) => {
      assert.ok(error instanceof WritingContextFailure);
      assert.deepEqual(
        error.issues.map((issue) => issue.kind),
        ['no_visible_evidence'],
      );
      assert.doesNotMatch(writingIssueDetails(error).issues[0].next, /用 fill/);
      return true;
    },
  );
  const clue = view.documents.find(({ id }) => id === 'seal')!;
  const edited = view.documents.map((d) =>
    d === clue
      ? {
          ...clue,
          body: '## 回收真相\n一条只能给后章的线索。',
          fields: { ...clue.fields, subjectIds: ['not-present'] },
        }
      : d.id === 'luo'
        ? { ...d, body: note }
        : d,
  );
  assert.throws(
    () => chapterContext(edited, doc),
    (error) => {
      assert.ok(error instanceof WritingContextFailure);
      assert.deepEqual(
        error.issues.map(({ kind, ref }) => [kind, ref?.id]),
        [['missing_section', 'seal']],
      );
      return true;
    },
  );
});

test('nonempty private sources and empty sources are logged separately without their prose', async (t) => {
  const f = await fixture(t, { initialNote: '## 稳定设定\n\n<!-- reveal:seal -->\nPRIVATE_AT_SETUP' });
  const first = f.start('setup', []);
  await first.wait();
  const empty = f.start('setup', [], { plan: { subjectIds: ['unrelated-empty'] } });
  await empty.wait();
  const trace = [...first.trace.rows, ...empty.trace.rows];
  assert.ok(
    trace.some(
      ({ event, fields }) =>
        event === 'writing.context.issue' &&
        fields.issueKind === 'no_visible_evidence' &&
        fields.writingStage === 'selection',
    ),
  );
  assert.ok(
    trace.some(
      ({ event, fields }) =>
        event === 'writing.context.issue' && fields.issueKind === 'empty_description',
    ),
  );
  assert.ok(!trace.some(({ event }) => event === 'writing.context.dispatched'));
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_AT_SETUP|unrelated-empty/);
  assert.deepEqual([...first.trace.rejected, ...empty.trace.rejected], []);
});
