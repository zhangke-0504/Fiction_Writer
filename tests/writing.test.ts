import { collectDiagnostics } from './diagnostic-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceService } from '../electron/workspace.js';
import { RunManager } from '../electron/agent/runs.js';
import { Journal } from '../electron/journal.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import { runAgent } from '../electron/agent/loop.js';
import { ProviderError } from '../electron/agent/provider.js';
import { ScriptedProvider } from '../electron/agent/scripted.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { fileURLToPath } from 'node:url';
import { chapterContext } from '../electron/agent/chapter-context.js';
import { draftChapter } from '../electron/agent/draft.js';
import type { Manuscript } from '../shared/contracts.js';
const text = (value: string) => ({ role: 'assistant' as const, text: value, calls: [] });
const call = (id: string, name: string, args: unknown) => ({
  ...text(''),
  calls: [{ id, name, args: JSON.stringify(args) }],
});
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'fw-writing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceService({ libraryRoot: join(root, 'library') });
  await workspace.init();
  const { id } = await workspace.createBook({ title: '雾中归航', summary: '寻找灯塔', style: '克制' });
  const journal = new Journal(() => {}),
    runs = new RunManager(join(root, 'state'), journal);
  await runs.init();
  const session = await runs.create({ cwd: workspace.bookRoot(id), bookId: id }, '测试');
  const skillsPath = fileURLToPath(new URL('../skills', import.meta.url));
  const catalog = new SkillCatalog(skillsPath);
  const skills = {
    chapter: await catalog.load('write-chapter'),
    consistency: await catalog.load('story-consistency'),
  };
  const outline = await workspace.readDocument(id, { type: 'outline', id: 'outline' });
  const report = await workspace.writeChanges(id, [
    { ...outline, expect: outline.revision, body: '父亲留下 [钥匙](subjects/key.md)。' },
    {
      type: 'subject',
      id: 'key',
      expect: null,
      fields: { name: '钥匙', kind: 'item' },
      body: '父亲留下。',
    },
    {
      type: 'subject',
      id: 'town',
      expect: null,
      fields: { name: '海岬', kind: 'scene' },
      body: '一处无关的岸。',
    },
    {
      type: 'chapter',
      id: 'one',
      expect: null,
      fields: { title: '潮起', order: 1 },
      body: '月升后，远处有蓝光。',
    },
    {
      type: 'chapter',
      id: 'two',
      expect: null,
      fields: { title: '归航', order: 2 },
      body: '她推开小门。',
    },
    {
      type: 'clue',
      id: 'promise',
      expect: null,
      fields: {
        title: '钥匙的来历',
        subjectIds: ['key'],
        setupChapterId: 'one',
        payoffChapterId: 'two',
      },
      body: '父亲留下钥匙，约定重逢。',
    },
  ]);
  assert.equal(report.error, undefined);
  return { workspace, root, id, runs, session, skills, catalog };
}

test('reference index uses canonical IDs, paginates and does not authorize a write', async (t) => {
  const { workspace, id, runs, session, skills, catalog } = await fixture(t);
  const outline = await workspace.readDocument(id, { type: 'outline', id: 'outline' });
  const indexed = Array.from({ length: 61 }, (_, i) => `<!-- beat:story-${i} -->`).join('\n\n');
  assert.equal(
    (
      await workspace.writeDocument(id, {
        ...outline,
        body: `${outline.body}\n\n${indexed}\n\n\`\`\`md\n<!-- beat:not-a-real-id -->\n\`\`\``,
      })
    ).error,
    undefined,
  );
  const provider = new ScriptedProvider([
    () => call('beats', 'book_get_context', { index: 'beats' }),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"nextOffset":60/);
      assert.match(JSON.stringify(history.at(-1)), /story-59/);
      assert.doesNotMatch(JSON.stringify(history.at(-1)), /story-60|not-a-real-id/);
      return call('beats-next', 'book_get_context', { index: 'beats', offset: 60 });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"rows":\[\{"id":"story-60"\}\],"nextOffset":null/);
      return call('ids', 'book_get_context', { index: 'subjects' });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"id":"key"/);
      assert.doesNotMatch(JSON.stringify(history.at(-1)), /父亲留下/);
      return call('chapters', 'book_get_context', { index: 'chapters' });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"id":"one","title":"潮起","order":1,"hasBody":true/);
      return call('no-write', 'book_apply_changes', {
        operations: [{ type: 'subject', id: 'key', action: 'update', body: '不应修改' }],
      });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /先用 book_get_context/);
      return text('需要读原文');
    },
  ]);
  runs.start(session.id, '读取索引', async (ctx) => {
    await runAgent(
      ctx,
      provider,
      '',
      [],
      '读取索引',
      new NovelTools(workspace, id, provider, catalog).tools(),
    );
  });
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.equal((await workspace.readDocument(id, { type: 'subject', id: 'key' })).body, '父亲留下。');
});

test('an invalid foreshadowing reference returns concrete repairs without writing the batch', async (t) => {
  const { workspace, id, runs, session, skills, catalog } = await fixture(t);
  const trace = collectDiagnostics();
  const outline = await workspace.readDocument(id, { type: 'outline', id: 'outline' });
  assert.equal(
    (
      await workspace.writeDocument(id, {
        ...outline,
        body: `${outline.body}\n\n<!-- beat:real-departure -->`,
      })
    ).error,
    undefined,
  );
  assert.equal(
    (
      await workspace.writeChanges(id, [
        {
          type: 'clue',
          id: 'legacy',
          expect: null,
          fields: { title: '旧伏笔', setupBeatId: 'real-departure' },
          body: '原稿',
        },
      ])
    ).error,
    undefined,
  );
  const invalid = {
    type: 'clue',
    id: 'hint-troy-embers',
    action: 'create',
    body: '灰烬下埋着归乡的线索。',
    fields: {
      title: '特洛伊余烬',
      subjectIds: ['key'],
      setupBeatId: 'beat-departure',
      payoffChapterId: 'two',
    },
  };
  const provider = new ScriptedProvider([
    () => call('read', 'book_get_context', { includeBodies: true }),
    () => call('invalid', 'book_apply_changes', { operations: [invalid] }),
    async ({ history }) => {
      const last = history.at(-1)!;
      assert.equal(last.role, 'tool');
      assert.equal(last.result.reason, 'invalid_references');
      assert.equal(last.result.ok, false);
      assert.deepEqual(last.result.value, {
        committed: [],
        pending: [{ type: 'clue', id: invalid.id }],
        invalidReferences: [
          {
            document: { type: 'clue', id: invalid.id },
            field: 'setupBeatId',
            target: { type: 'beat', id: 'beat-departure' },
          },
        ],
        reason: 'invalid_references',
        error: 'clue/hint-troy-embers：无效引用 beat/beat-departure',
      });
      await assert.rejects(workspace.readDocument(id, { type: 'clue', id: invalid.id }));
      return call('index', 'book_get_context', { index: 'chapters' });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"id":"one"/);
      return call('repair', 'book_apply_changes', {
        operations: [
          {
            ...invalid,
            fields: { ...invalid.fields, setupBeatId: null, setupChapterId: 'one' },
          },
        ],
      });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":true/);
      return text('已修正');
    },
  ]);
  runs.start(
    session.id,
    '修正伏笔',
    async (ctx) => {
      await runAgent(
        ctx,
        provider,
        '',
        [],
        '修正伏笔',
        new NovelTools(workspace, id, provider, catalog).tools(),
      );
    },
    'high',
    trace.report,
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.equal(
    (await workspace.readDocument(id, { type: 'clue', id: invalid.id })).fields.setupChapterId,
    'one',
  );
  assert.equal(
    (await workspace.readDocument(id, { type: 'clue', id: 'legacy' })).fields.setupBeatId,
    'real-departure',
  );
  assert.equal(
    trace.rows.find((row) => row.event === 'tool.finished' && row.fields.tool === 'book_apply_changes')
      ?.fields.reason,
    'invalid_references',
  );
  assert.deepEqual(trace.rejected, []);
  assert.doesNotMatch(JSON.stringify(trace.rows), /hint-troy-embers|beat-departure/);
});

test('story consistency requires the current read set and applies only affected documents', async (t) => {
  const { workspace, id, runs, session, skills, catalog } = await fixture(t);
  const town = await workspace.readDocument(id, { type: 'subject', id: 'town' });
  const provider = new ScriptedProvider([
    () =>
      call('apply-too-soon', 'book_apply_changes', {
        operations: [{ type: 'subject', id: 'key', action: 'update', body: '母亲留下。' }],
      }),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /先用 book_get_context/);
      return call('context1', 'book_get_context', { includeBodies: true });
    },
    ({ history, system }) => {
      const read = JSON.stringify(history.at(-1));
      assert.match(read, /父亲留下/);
      assert.match(read, /钥匙的来历/);
      assert.match(system, /反向检查/);
      return call('apply1', 'book_apply_changes', {
        operations: [
          { type: 'subject', id: 'key', action: 'update', body: '母亲留下。' },
          {
            type: 'outline',
            id: 'outline',
            action: 'update',
            body: '母亲留下 [钥匙](subjects/key.md)。',
          },
          { type: 'clue', id: 'promise', action: 'update', body: '母亲留下钥匙，约定重逢。' },
        ],
      });
    },
    ({ history }) => {
      assert.ok(JSON.stringify(history.at(-1)).includes('committed'));
      return text('已调整三处');
    },
  ]);
  runs.start(session.id, '调整钥匙来历', (ctx) =>
    runAgent(
      ctx,
      provider,
      skills.consistency,
      [],
      '调整钥匙来历',
      new NovelTools(workspace, id, provider, catalog).tools(),
    ).then(() => {}),
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  const after = await workspace.readAll(id);
  assert.match(after.documents.find((d) => d.id === 'key')!.body, /母亲/);
  assert.match(after.documents.find((d) => d.id === 'promise')!.body, /母亲/);
  assert.deepEqual(after.diagnostics, []);
  assert.equal(after.documents.find((d) => d.id === 'town')!.revision, town.revision);
  assert.equal(after.documents.find((d) => d.id === 'two')!.body, '她推开小门。');

  const reverse = new ScriptedProvider([
    () => call('context2', 'book_get_context', { includeBodies: true }),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /母亲留下/);
      return call('apply2', 'book_apply_changes', {
        operations: [
          { type: 'outline', id: 'outline', action: 'update', body: '移走钥匙的回收安排。' },
          {
            type: 'clue',
            id: 'promise',
            action: 'update',
            fields: { payoffChapterId: null },
            body: '母亲留下钥匙，暂不回收。',
          },
        ],
      });
    },
    () => text('大纲和伏笔回收已更新，主体保留。'),
  ]);
  runs.start(session.id, '改大纲', (ctx) =>
    runAgent(
      ctx,
      reverse,
      skills.consistency,
      [],
      '改大纲',
      new NovelTools(workspace, id, reverse, catalog).tools(),
    ).then(() => {}),
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.equal(
    (await workspace.readDocument(id, { type: 'clue', id: 'promise' })).fields.payoffChapterId,
    undefined,
  );
  assert.match((await workspace.readDocument(id, { type: 'subject', id: 'key' })).body, /母亲/);
});

test('an exact in-run commit can be reused, but a subsequent external edit still needs a fresh read', async (t) => {
  const { workspace, id, runs, session, catalog } = await fixture(t);
  const ref = { type: 'subject' as const, id: 'new-cast-id' };
  const mutation = (id: string, action: 'create' | 'update', body: string) =>
    call(id, 'book_apply_changes', {
      operations: [
        {
          ...ref,
          action,
          body,
          ...(action === 'create' && { fields: { name: '归人', kind: 'character' } }),
        },
      ],
    });
  const provider = new ScriptedProvider([
    () => call('read', 'book_get_context', { includeBodies: true }),
    () => mutation('create', 'create', '初稿'),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":true/);
      return mutation('update', 'update', 'Agent 已知修改');
    },
    async ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":true/);
      const doc = await workspace.readDocument(id, ref);
      assert.equal(doc.body, 'Agent 已知修改');
      assert.equal(
        (await workspace.writeDocument(id, { ...doc, body: '作者外部修订' })).error,
        undefined,
      );
      return mutation('stale', 'update', '不能覆盖');
    },
    ({ history }) => {
      const last = history.at(-1)!;
      assert.equal(last.role, 'tool');
      assert.equal(last.result.reason, 'context_required');
      assert.deepEqual(last.result.value, { unread: [ref], remaining: 0 });
      return text('保留作者修订');
    },
  ]);
  runs.start(session.id, '修改资料', async (ctx) => {
    await runAgent(
      ctx,
      provider,
      '',
      [],
      '修改资料',
      new NovelTools(workspace, id, provider, catalog).tools(),
    );
  });
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.equal((await workspace.readDocument(id, ref)).body, '作者外部修订');
});

test('chapter drafting uses prior prose, relevant clues, subject facts, and keeps continuation as an append', async (t) => {
  const { workspace, id, runs, session, skills, catalog } = await fixture(t);
  const provider = new ScriptedProvider([
    ({ history, system, onText }) => {
      const input = JSON.stringify(history);
      assert.match(input, /远处有蓝光/);
      assert.match(input, /钥匙的来历/);
      assert.match(input, /父亲留下/);
      assert.match(input, /小门/);
      assert.match(system, /不复述/);
      onText('看到了潮光。');
      return text('看到了潮光。');
    },
  ]);
  runs.start(session.id, '续写', (ctx) =>
    draftChapter(workspace, ctx, provider, 'two', 'append', '承接上一幕', {
      skill: skills.chapter,
    }).then(() => {}),
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.equal(
    (await workspace.readDocument(id, { type: 'chapter', id: 'two' })).body,
    '她推开小门。\n\n看到了潮光。',
  );
});

test('only a direct current request can overwrite its explicit chapter target', async (t) => {
  const { workspace, id, runs, session, skills, catalog } = await fixture(t);
  const one = await workspace.readDocument(id, { type: 'chapter', id: 'one' });
  const two = await workspace.readDocument(id, { type: 'chapter', id: 'two' });
  for (const [prompt, target] of [
    ['不要重写第二章', 'two'],
    ['请从头重写第二章', 'one'],
    ['请看看第二章', 'two'],
    ['重写第二章？', 'two'],
    ['请从头重写第二章', 'two'],
  ]) {
    const allowed = prompt === '请从头重写第二章' && target === 'two';
    const provider = new ScriptedProvider([
      () =>
        call('replace', 'book_generate_chapter', {
          chapterId: target,
          mode: 'replace',
          direction: '请重写第二章',
        }),
      ...(allowed ? [() => text('现在门后透出灯光。')] : []),
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), allowed ? /"ok":true/ : /rewrite_not_authorized/);
        return text('完成测试');
      },
    ]);
    runs.start(session.id, prompt, async (ctx) => {
      await runAgent(
        ctx,
        provider,
        '',
        [],
        prompt,
        new NovelTools(workspace, id, provider, catalog, { authorPrompt: prompt }).tools(),
      );
    });
    await runs.wait(session.id);
    assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
    assert.equal((await workspace.readDocument(id, one)).revision, one.revision);
    assert.equal(
      (await workspace.readDocument(id, two)).body,
      allowed ? '现在门后透出灯光。' : two.body,
    );
  }
});

for (const reason of ['incomplete_stream', 'output_limit'] as const) {
  test(`chapter tool treats ${reason} as non-committable and bounds retries`, async (t) => {
    const { workspace, id, runs, session, skills, catalog } = await fixture(t);
    const trace = collectDiagnostics();
    const doc = await workspace.readDocument(id, { type: 'chapter', id: 'two' });
    let attempts = 0;
    const fail = ({ onText }: import('../electron/agent/model.js').ModelRequest) => {
      assert.equal(runs.get(session.id).run?.preview, undefined);
      onText(`未完成预览 ${++attempts}`);
      throw new ProviderError('不应提交', 'protocol', reason);
    };
    const toolCall = (callId: string) =>
      call(callId, 'book_generate_chapter', { chapterId: 'two', mode: 'append' });
    const provider = new ScriptedProvider([
      () => toolCall('first'),
      fail,
      ...(reason === 'incomplete_stream' ? [fail] : []),
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), new RegExp(reason));
        return toolCall('replay');
      },
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), new RegExp(reason));
        return text('未保存');
      },
    ]);
    runs.start(
      session.id,
      '继续当前章',
      async (ctx) => {
        await runAgent(
          ctx,
          provider,
          '',
          [],
          '继续当前章',
          new NovelTools(workspace, id, provider, catalog).tools(),
        );
      },
      'high',
      trace.report,
    );
    await runs.wait(session.id);
    assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
    assert.equal(runs.get(session.id).run?.preview, undefined);
    assert.equal((await workspace.readDocument(id, doc)).revision, doc.revision);
    assert.equal(attempts, reason === 'incomplete_stream' ? 2 : 1);
    assert.equal(trace.rows.filter((row) => row.event === 'chapter.retry').length, attempts - 1);
    assert.deepEqual(trace.rejected, []);
  });
}

test('chapter retry will not generate again if the draft base changed after interruption', async (t) => {
  const { workspace, id, runs, session } = await fixture(t);
  const doc = await workspace.readDocument(id, { type: 'chapter', id: 'two' });
  const model = new ScriptedProvider([
    async ({ onText }) => {
      onText('未完成预览');
      assert.equal(
        (await workspace.writeDocument(id, { ...doc, body: '作者刚刚改写的文字' })).error,
        undefined,
      );
      throw new ProviderError('模拟断流', 'protocol', 'incomplete_stream');
    },
  ]);
  runs.start(session.id, '续写', async (ctx) => {
    await draftChapter(workspace, ctx, model, 'two', 'append', '', { retryIncomplete: true });
  });
  await runs.wait(session.id);
  assert.match(runs.get(session.id).run?.error ?? '', /已变化/);
  assert.equal(runs.get(session.id).run?.preview, undefined);
  assert.equal((await workspace.readDocument(id, doc)).body, '作者刚刚改写的文字');
});

test('long chapter context uses real excerpts with source IDs and prioritizes recent prose', () => {
  const make = (id: string, order: number, body: string): Manuscript => ({
    type: 'chapter',
    id,
    body,
    fields: { title: id, order },
    revision: 'r',
  });
  const early = make('early', 1, `较早的真相。\n\n${'中'.repeat(28000)}\n\n较早的结尾。`),
    last = make('latest', 2, '最新发生的具体事情。'),
    target = make('target', 3, '');
  const context = chapterContext([early, last, target], target, 3000);
  assert.equal(context.previous.at(-1)?.text, last.body);
  assert.match(context.previous[0].header, /chapters\/early\.md/);
  assert.match(context.previous[0].text, /开头与结尾摘录/);
  assert.match(context.previous[0].text, /较早的结尾/);
  assert.ok(context.previous[0].text.length < early.body.length);
});

test('long chapter generation can retrieve a missed passage before showing prose', async (t) => {
  const { workspace, id, runs, session, skills, catalog } = await fixture(t);
  const earlier = await workspace.readDocument(id, { type: 'chapter', id: 'one' });
  const fact = '潮汐誓言从不允许携火过桥。';
  const body = `开篇。\n\n${'甲'.repeat(32_000)}\n\n${fact}\n\n${'乙'.repeat(32_000)}\n\n结尾。`;
  assert.equal((await workspace.writeDocument(id, { ...earlier, body })).error, undefined);
  const provider = new ScriptedProvider([
    ({ history, tools, onText }) => {
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['book_read_chapter'],
      );
      assert.match(history[0].role === 'user' ? history[0].text : '', /"chapterId":"one"/);
      assert.ok(!JSON.stringify(history).includes(fact));
      onText('这段取材说明不是正文。');
      return call('lookup', 'book_read_chapter', { chapterId: 'one', query: '潮汐誓言' });
    },
    ({ history, tools, onText }) => {
      assert.deepEqual(tools, []);
      assert.equal(runs.get(session.id).run?.preview, undefined);
      assert.match(JSON.stringify(history), new RegExp(fact));
      assert.ok(!JSON.stringify(history).includes('这段取材说明不是正文'));
      onText('她放下火把才继续过桥。');
      assert.match(runs.get(session.id).run?.preview?.content ?? '', /放下火把/);
      return text('她放下火把才继续过桥。');
    },
  ]);
  runs.start(session.id, '续写', (ctx) =>
    draftChapter(workspace, ctx, provider, 'two', 'append', '核对前文的潮汐誓言', {
      skill: skills.chapter,
    }).then(() => {}),
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  const saved = await workspace.readDocument(id, { type: 'chapter', id: 'two' });
  assert.equal(saved.body, '她推开小门。\n\n她放下火把才继续过桥。');
  assert.equal((await workspace.readDocument(id, earlier)).body, body);
});

test('writing based on a reread passage rejects a later change to that source', async (t) => {
  const { workspace, id, runs, session, skills, catalog } = await fixture(t);
  const original = await workspace.readDocument(id, { type: 'chapter', id: 'one' });
  assert.equal(
    (await workspace.writeDocument(id, { ...original, body: `${'甲'.repeat(60_000)}取材出处` })).error,
    undefined,
  );
  const before = await workspace.readDocument(id, { type: 'chapter', id: 'two' });
  const trace = collectDiagnostics();
  const provider = new ScriptedProvider([
    () => call('lookup', 'book_read_chapter', { chapterId: 'one', offset: 100, length: 100 }),
    async ({ onText }) => {
      onText('不应提交这一稿。');
      const current = await workspace.readDocument(id, original);
      assert.equal(
        (await workspace.writeDocument(id, { ...current, body: '作者修订了前章。' })).error,
        undefined,
      );
      return text('不应提交这一稿。');
    },
  ]);
  runs.start(
    session.id,
    '续写',
    (ctx) =>
      draftChapter(workspace, ctx, provider, 'two', 'append', '核对前章', {
        skill: skills.chapter,
      }).then(() => {}),
    'high',
    trace.report,
  );
  await runs.wait(session.id);
  const run = runs.get(session.id).run;
  assert.equal(run?.status, 'failed');
  assert.match(run?.error ?? '', /chapter\/one 已变化/);
  assert.equal(run?.preview, undefined);
  assert.deepEqual(trace.rejected, []);
  const conflict = trace.rows.find((e) => e.event === 'workspace.conflict')!;
  assert.equal(conflict.fields.step, 'guard');
  assert.notEqual(conflict.fields.expectedRevision, conflict.fields.actualRevision);
  assert.equal(
    trace.rows.find((e) => e.event === 'chapter.generation.finished')?.fields.outcome,
    'conflict',
  );
  assert.deepEqual(
    trace.rows.filter((e) => e.event === 'chapter.preview').map((e) => e.fields.outcome),
    ['started', 'cleared'],
  );
  assert.equal((await workspace.readDocument(id, before)).revision, before.revision);
});

test('stopping a direct chapter draft clears its preview and records no commit', async (t) => {
  const { workspace, id, runs, session, skills, catalog } = await fixture(t);
  const before = await workspace.readDocument(id, { type: 'chapter', id: 'two' });
  const trace = collectDiagnostics();
  let entered!: () => void;
  const previewed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = new ScriptedProvider([
    async ({ signal, onText }) => {
      onText('仅临时预览');
      entered();
      await new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      throw new Error('unexpected');
    },
  ]);
  runs.start(
    session.id,
    '续写',
    async (ctx) => {
      await draftChapter(workspace, ctx, provider, 'two', 'append', 'fixture', {
        skill: skills.chapter,
      });
    },
    'high',
    trace.report,
  );
  await previewed;
  await runs.stop(session.id, trace.report);
  assert.equal(runs.get(session.id).run?.status, 'cancelled');
  assert.equal(runs.get(session.id).run?.preview, undefined);
  assert.equal((await workspace.readDocument(id, before)).revision, before.revision);
  assert.deepEqual(trace.rejected, []);
  assert.deepEqual(
    trace.rows.filter((e) => e.event === 'chapter.preview').map((e) => e.fields.outcome),
    ['started', 'cleared'],
  );
  assert.equal(
    trace.rows.find((e) => e.event === 'chapter.generation.finished')?.fields.outcome,
    'cancelled',
  );
  assert.ok(
    !trace.rows.some(
      (e) => e.event === 'workspace.document.committed' || e.event === 'loop.round.started',
    ),
  );
  assert.doesNotMatch(JSON.stringify(trace.rows), /仅临时预览/);
});
