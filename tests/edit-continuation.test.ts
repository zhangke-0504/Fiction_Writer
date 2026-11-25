import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { WorkspaceService } from '../electron/workspace.js';
import { RunManager } from '../electron/agent/runs.js';
import { Journal } from '../electron/journal.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import { checkBookEditPlan } from '../electron/agent/book-edit.js';
import { proposalOnly, readEditPlan } from '../electron/agent/edit-proposal.js';
import { runAgent } from '../electron/agent/loop.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { captureWritingRequests, isolatedRequest } from './writing-request-fixture.js';
import type { ModelProvider } from '../electron/agent/model.js';
import { messagesRecoveryFixture } from './messages-recovery-fixture.js';
import { ScriptedProvider, type Script } from '../electron/agent/scripted.js';
import { collectDiagnostics } from './diagnostic-fixture.js';

const planPrompt =
  '加一个暗线的反派，跟2个以上的人物主体有关联，剧情中期出现该反派的种种迹象，后期剧情抛头露面。你看看要改哪些内容才能把这个反派合理的加到当前小说里';
const directPrompt =
  '新增一个跟2个以上人物主体有关联的反派吧，然后剧情中期增加一些该反派的线索，到了后期才抛头露面。你看看要怎么改，想好之后直接改就行，不需要找我确认';
const correction = '我不是说了你直接改就行了嘛？直接改吧，没啥问题';
const agree = '嗯，就按这个来改';
const allowAll = '我允许你所有操作';
const chapter = (n: number) => ({ type: 'chapter' as const, id: `ch${String(n).padStart(2, '0')}` });
const anchor = (n: number) => `船只经过航标 ${n}，甲板仍旧平静。`;
const body = (n: number) => `清晨记录了第 ${n} 个航标。\r\n\r\n${anchor(n)}\r\n\r\n众人继续向东航行。`;
const oldSubjects = ['captain', 'witness'];
const subject = {
  kind: 'subject',
  action: 'create',
  targets: [
    {
      id: 'agent-villain',
      fields: { name: '灰衣人', kind: 'character' },
      relatedSubjectIds: oldSubjects,
    },
  ],
};
const clue = {
  kind: 'clue',
  action: 'create',
  targets: [
    {
      id: 'marked-chart',
      fields: {
        title: '船图缺角',
        subjectIds: ['agent-villain', ...oldSubjects],
        setupChapterId: 'ch04',
        payoffChapterId: 'ch09',
      },
    },
  ],
};
const text = (value: string) => ({ role: 'assistant' as const, text: value, calls: [] });
const use = (name: string, args: unknown, id = name) => ({
  ...text(''),
  calls: [{ id: `call-${id}`, name, args: JSON.stringify(args) }],
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'fw-edit-proposal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceService({ libraryRoot: join(root, 'library') });
  await workspace.init();
  const { id } = await workspace.createBook({
    title: '海贼王式航路',
    summary: '船队沿着群岛找被盗的船图。',
  });
  const outline = await workspace.readDocument(id, { type: 'outline', id: 'outline' });
  const init = await workspace.writeChanges(id, [
    {
      ...outline,
      expect: outline.revision,
      body: Array.from(
        { length: 10 },
        (_, i) => `<!-- chapter:${chapter(i + 1).id} -->\n\n船经过第 ${i + 1} 处航标。`,
      ).join('\n\n'),
    },
    ...oldSubjects.map((id, i) => ({
      type: 'subject' as const,
      id,
      expect: null,
      fields: { name: ['船长', '瞭望员'][i], kind: 'character' as const },
      body: '## 稳定设定\n保留旧角色的航行经验。',
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      ...chapter(i + 1),
      expect: null,
      fields: { title: `航程 ${i + 1}`, order: i + 1 },
      body: body(i + 1),
    })),
  ]);
  assert.equal(init.error, undefined);
  const state = join(root, 'state');
  const newManager = async () => {
    const r = new RunManager(state, new Journal(() => {}));
    await r.init();
    return r;
  };
  let runs = await newManager();
  const session = await runs.create({ cwd: workspace.bookRoot(id), bookId: id }, '验收');
  const catalog = new SkillCatalog(fileURLToPath(new URL('../skills', import.meta.url)));
  const start = (
    prompt: string,
    script: Script[],
    sessionId = session.id,
    transport?: ModelProvider,
  ) => {
    const captured = captureWritingRequests(script);
    const { requests } = captured;
    const provider = transport ?? captured.provider;
    const trace = collectDiagnostics();
    const novel = new NovelTools(workspace, id, provider, catalog, { authorPrompt: prompt });
    runs.start(
      sessionId,
      prompt,
      async (ctx) => {
        const scope = novel.prepareEdit(ctx, (await workspace.readAll(id)).documents);
        await runAgent(ctx, provider, 'OUTER_ONLY_FIXTURE' + scope, [], prompt, novel.tools(), novel);
        await novel.assertFinished(ctx);
      },
      'high',
      trace.report,
    );
    return {
      requests,
      trace,
      wait: async () => {
        await runs.wait(sessionId);
        return runs.get(sessionId).run!;
      },
    };
  };
  return {
    workspace,
    id,
    session,
    start,
    view: () => runs.get(session.id),
    read: () => workspace.readAll(id),
    bytes: (n: number) => readFile(join(workspace.bookRoot(id), 'chapters', `${chapter(n).id}.md`)),
    restart: async () => {
      runs = await newManager();
    },
    anotherSession: () => runs.create({ cwd: workspace.bookRoot(id), bookId: id }, '另一会话'),
  };
}

test('an old prose-only plan and unscoped agreement do not become write authority', async (t) => {
  const f = await fixture(t);
  const initial = await f.read();
  await f
    .start(planPrompt, [() => text('建议先新建反派和伏笔，第 4、6 章埋迹象，第 9 章实际登场。')])
    .wait();
  for (const confirmation of [agree, allowAll, correction]) {
    const attempt = f.start(confirmation, [
      () => use('book_generate_assets', subject),
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), /授权|确认方案|执行范围/);
        return text('没有写入。');
      },
    ]);
    await attempt.wait();
    assert.deepEqual(
      attempt.requests.map((r) => r.lane),
      ['agent', 'agent'],
    );
    assert.ok(!attempt.trace.rows.some((r) => r.event === 'workspace.document.committed'));
    assert.deepEqual(await f.read(), initial);
  }
});

const plot = {
  summary: '灰衣人与船长和瞭望员的旧事，引出船图缺角的来历。',
  assets: [
    { kind: 'subject', action: 'create', ...subject.targets[0] },
    { kind: 'clue', action: 'create', ...clue.targets[0] },
  ],
  passages: [
    { id: 'first-trace', chapterId: 'ch04', stage: 'setup', note: '初见缺角的船图。' },
    { id: 'second-trace', chapterId: 'ch06', stage: 'setup', note: '瞭望员又看到同样缺角。' },
    { id: 'late-arrival', chapterId: 'ch09', stage: 'reveal', note: '灰衣人上船，揭开缺角的用意。' },
  ],
};
test('a separate payoff anchor can be planned without a reveal insertion in that chapter', async (t) => {
  const f = await fixture(t);
  const { documents } = await f.read();
  const plan = readEditPlan(plot)!;
  const foreshadowing = plan.assets.find((a) => a.kind === 'clue')!.fields!;
  foreshadowing.payoffChapterId = 'ch10';
  assert.doesNotThrow(() => checkBookEditPlan(plan, documents, planPrompt));
  assert.throws(
    () =>
      checkBookEditPlan(
        { ...plan, passages: [plan.passages[0], plan.passages[2]] },
        documents,
        planPrompt,
      ),
    /至少两个不同的中期章/u,
  );
  assert.throws(
    () => checkBookEditPlan({ ...plan, passages: plan.passages.slice(0, 2) }, documents, planPrompt),
    /后期章登记 reveal/u,
  );
  foreshadowing.setupChapterId = 'ch05';
  assert.throws(() => checkBookEditPlan(plan, documents, planPrompt), /对应到埋设这条伏笔/u);
  foreshadowing.payoffChapterId = 'ch01';
  assert.throws(() => checkBookEditPlan(plan, documents, planPrompt), /顺序正确的埋设、回收章/u);
});

const visible = '灰衣人把船图撕去一个角，此后船队又遇到相似的缺角。';
const revelation = '缺角正好是故意抹去归航水道的记号';
const descriptions = (id: string, body: string) =>
  use('submit_story_descriptions', { items: [{ id, body }] });
const fragments: Record<number, string> = {
  4: '船长发现那张船图缺了一个角。他用指尖量了量撕痕，收好没有声张。',
  6: '瞭望员拾到另一片薄纸。图角同样被沿着旧折痕撕走，他把发现告诉船长。',
  9: '灰衣人登上甲板。他在两片船图之间放下缺失的一角：原来有人故意抹去了归航水道。',
};
const propose = async (f: Awaited<ReturnType<typeof fixture>>, edits = plot) => {
  const run = f.start(planPrompt, [
    ({ tools }) => {
      assert.ok(tools.some((tool) => tool.name === 'book_propose_edits'));
      return use('book_propose_edits', edits);
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"staged":true/);
      return text('这个方案会在中期留迹象，后期实际登场。');
    },
  ]);
  assert.equal((await run.wait()).status, 'completed');
  assert.match(f.view().messages.at(-1)!.text, /尚未写入作品.*ch04.*ch06.*ch09/s);
  return run;
};
const saveActor: Script[] = [
  () => use('book_generate_assets', { ...subject, targets: [{ id: 'agent-villain' }] }),
  (request) => {
    isolatedRequest(request, 'OUTER_ONLY_FIXTURE');
    assert.match(JSON.stringify(request.history), /已确认的本次局部安排/);
    return descriptions('agent-villain', '## 稳定设定\n灰衣人是懂船图的画匠，旧识船长和瞭望员。');
  },
];
const saveClue: Script[] = [
  () => use('book_generate_assets', { ...clue, targets: [{ id: 'marked-chart' }] }),
  (request) => {
    isolatedRequest(request, 'OUTER_ONLY_FIXTURE');
    return descriptions(
      'marked-chart',
      `## 可见线索\n${visible}\n\n## 回收真相\n揭示事实：${revelation}。`,
    );
  },
];
function insertion(
  f: Awaited<ReturnType<typeof fixture>>,
  n: number,
  options?: { stale?: boolean; id?: string },
) {
  return async () => {
    const doc = await f.workspace.readDocument(f.id, chapter(n));
    const outline = await f.workspace.readDocument(f.id, { type: 'outline', id: 'outline' });
    return use(
      'book_generate_chapter',
      {
        chapterId: doc.id,
        mode: 'insert',
        insertion: {
          targetId: options?.id ?? plot.passages.find((p) => p.chapterId === doc.id)?.id,
          revision: options?.stale ? 'f'.repeat(64) : doc.revision,
          quote: anchor(n),
          place: 'before',
          outline: { revision: outline.revision, addition: `此处实际增补 ${n} 章关联情节。` },
        },
      },
      `insert-${n}-${options?.stale ? 'stale' : (options?.id ?? 'valid')}`,
    );
  };
}
function draft(n: number): Script {
  return (request) => {
    isolatedRequest(request, 'OUTER_ONLY_FIXTURE');
    const source = JSON.stringify(request.history);
    assert.match(source, /船图缺角/);
    assert.ok(!source.includes('ch09：登场'), 'does not include the visible full proposal');
    if (n < 9) assert.ok(!source.includes(revelation), 'no early reveal');
    else assert.ok(source.includes(revelation), 'receives needed reveal at payoff');
    return text(fragments[n]);
  };
}

const syncRequest = (kind: 'subject' | 'clue', id?: string) =>
  use(
    'book_generate_assets',
    {
      kind,
      action: 'update',
      targets: [{ id: id ?? (kind === 'subject' ? 'agent-villain' : 'marked-chart') }],
    },
    `sync-${kind}-${id ?? 'new'}`,
  );
function syncCandidate(kind: 'subject' | 'clue', edits: object[] = [], corrupt = false): Script {
  return (req) => {
    isolatedRequest(req, 'OUTER_ONLY_FIXTURE');
    const data = JSON.parse(req.history[0].text!);
    const evidence = data.sources.map(
      ({ source, chapterId, stage }: { source: number; chapterId: string; stage: string }) => ({
        source,
        status:
          kind === 'subject' && stage === 'reveal'
            ? 'appearance'
            : kind === 'clue' && (data.asset.fields.setupChapterId === chapterId || stage === 'setup')
              ? 'setup'
              : 'trace',
        excerpt: corrupt ? 99999 : 1,
      }),
    );
    return use('submit_story_sync', {
      evidence,
      edits: edits.map((edit: any) => ({
        line: data.editable.find(
          (line: any) => line.section === edit.section && line.text === edit.before,
        )?.line,
        after: edit.after,
      })),
    });
  };
}
const syncAll: Script[] = [
  () => syncRequest('subject'),
  syncCandidate('subject'),
  () => syncRequest('clue'),
  syncCandidate('clue'),
];

test('the displayed plan is read-only until approved, and the same session resumes it after restart', async (t) => {
  const f = await fixture(t);
  const original = await f.read();
  const before = await Promise.all([4, 6, 9].map((n) => f.bytes(n)));
  await propose(f);
  assert.deepEqual(await f.read(), original);
  await f.restart();
  const run = f.start(agree, [
    ...saveActor,
    ...saveClue,
    insertion(f, 4),
    draft(4),
    insertion(f, 6),
    draft(6),
    insertion(f, 9),
    draft(9),
    insertion(f, 4),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"reused":true/);
      return syncRequest('subject');
    },
    ...syncAll.slice(1),
    () => text('已提交三处正文、相关大纲和资产。'),
  ]);
  const result = await run.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.progress, {
    step: '执行已确认方案',
    total: 7,
    done: 7,
    complete: true,
    message: undefined,
  });
  assert.deepEqual(
    run.requests.filter((r) => r.lane !== 'agent').map((r) => r.lane),
    ['asset', 'asset', 'draft', 'draft', 'draft', 'asset', 'asset'],
  );
  const now = await f.read();
  for (const row of original.documents.filter(
    (d) => d.type !== 'outline' && ![4, 6, 9].some((n) => chapter(n).id === d.id),
  ))
    assert.deepEqual(
      now.documents.find((d) => d.id === row.id && d.type === row.type),
      row,
    );
  for (const [i, n] of [4, 6, 9].entries()) {
    const raw = (await f.bytes(n)).toString('utf8');
    assert.equal(raw.replace(`${fragments[n]}\r\n\r\n`, ''), before[i].toString('utf8'));
    assert.match(
      now.documents.find((d) => d.type === 'outline')!.body,
      new RegExp(
        `chapter:${chapter(n).id} -->[^]*?实际增补 ${n} 章[^]*?subjects/agent-villain\\.md[^]*?foreshadowing/marked-chart\\.md`,
      ),
    );
  }
  const villain = now.documents.find((d) => d.id === 'agent-villain')!;
  for (const id of oldSubjects) assert.match(villain.body, new RegExp(`subjects/${id}\\.md`));
  const foreshadowing = now.documents.find((d) => d.id === 'marked-chart')!;
  assert.equal(foreshadowing.fields.setupChapterId, 'ch04');
  assert.equal(foreshadowing.fields.payoffChapterId, 'ch09');
  assert.ok(foreshadowing.fields.subjectIds?.includes(villain.id));
});

for (const repeat of [false, true]) {
  test(
    'confirmed cross-chapter work preserves earlier writes after an output limit (repeat=' +
      repeat +
      ')',
    async (t) => {
      const f = await fixture(t);
      await propose(f);
      const lastChapterBefore = await f.bytes(9);
      const inner = new ScriptedProvider([
        saveActor[1],
        saveClue[1],
        draft(4),
        draft(6),
        ...(repeat ? [] : [draft(9), syncCandidate('subject'), syncCandidate('clue')]),
      ]);
      const { provider, scripted, wires } = messagesRecoveryFixture(
        t,
        (req) => req.system.startsWith('OUTER_ONLY_FIXTURE'),
        inner,
      );
      let before: Buffer | undefined;
      const rejected = async () => ({
        ...(await insertion(f, 4)()),
        text: 'TRUNCATED_PRIVATE_EDIT',
        native: 'truncated-fixture',
      });
      scripted.push(
        () => use('book_generate_assets', { ...subject, targets: [{ id: 'agent-villain' }] }),
        () => use('book_generate_assets', { ...clue, targets: [{ id: 'marked-chart' }] }),
        insertion(f, 4),
        async () => {
          before = await f.bytes(4);
          return rejected();
        },
        insertion(f, 6),
        ...(repeat
          ? [rejected]
          : [
              insertion(f, 9),
              () => syncRequest('subject'),
              () => syncRequest('clue'),
              () => text('已完成实际修改。'),
            ]),
      );
      const run = f.start(agree, [], f.session.id, provider);
      const result = await run.wait();
      assert.equal(result.status, repeat ? 'failed' : 'completed', result.error);
      if (repeat) {
        assert.match(result.error ?? '', /再次达到输出上限.*late-arrival.*已保存/s);
        assert.deepEqual(await f.bytes(9), lastChapterBefore);
      } else assert.equal(result.progress?.done, 7);
      assert.equal(wires.length, repeat ? 6 : 9);
      assert.equal(scripted.length, 0);
      assert.deepEqual(await f.bytes(4), before);
      for (const n of repeat ? [4, 6] : [4, 6, 9]) {
        const body = (await f.bytes(n)).toString('utf8');
        assert.equal(body.split(fragments[n]).length, 2);
        assert.ok(body.includes(anchor(n)));
      }
      assert.ok(wires.slice(4).every((w) => w.system.includes('逐项续接') && w.max_tokens === 8192));
      assert.doesNotMatch(
        JSON.stringify([wires, f.view().messages, run.trace.rows]),
        /TRUNCATED_PRIVATE_EDIT/,
      );
      assert.equal(
        run.trace.rows.filter(
          (r) => r.event === 'model.output_limit_recovery' && r.fields.recovery === 'dispatched',
        ).length,
        1,
      );
      assert.deepEqual(run.trace.rejected, []);
    },
  );
}

test('another session, merely discussing, or a narrower approval cannot write chapters', async (t) => {
  const f = await fixture(t);
  const initial = await f.read();
  const planning = f.start(planPrompt, [
    () => use('book_generate_assets', subject),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /仅讨论/);
      return use('book_propose_edits', plot);
    },
    () => text('建议暂未执行。'),
  ]);
  await planning.wait();
  assert.deepEqual(await f.read(), initial);
  const other = await f.anotherSession();
  await f
    .start(
      allowAll,
      [
        () => use('book_generate_assets', subject),
        ({ history }) => {
          assert.match(JSON.stringify(history.at(-1)), /没有明确可承接/);
          return text('没有可执行的方案。');
        },
      ],
      other.id,
    )
    .wait();
  const confirm = f.start(allowAll + '，但先只生成资料，不改正文', [
    insertion(f, 4),
    (request) => {
      assert.match(JSON.stringify(request.history.at(-1)), /不在本轮确认范围/);
      return saveActor[0](request);
    },
    saveActor[1],
    ...saveClue,
    () => text('只更新了资料。'),
  ]);
  const narrowed = await confirm.wait();
  assert.equal(narrowed.status, 'completed', narrowed.error);
  assert.deepEqual(
    (await f.read()).documents.filter((d) => ['chapter', 'outline'].includes(d.type)),
    initial.documents.filter((d) => ['chapter', 'outline'].includes(d.type)),
  );
});

test('partial approved edits keep committed parts and continue with fresh anchors, without duplicating them', async (t) => {
  const f = await fixture(t);
  await propose(f);
  const first = f.start(agree, [
    ...saveActor,
    ...saveClue,
    insertion(f, 4),
    draft(4),
    ...syncAll,
    insertion(f, 6, { stale: true }),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /版本已变化/);
      return text('后续位置尚未提交。');
    },
  ]);
  const partial = await first.wait();
  assert.equal(partial.status, 'failed');
  assert.match(partial.error ?? '', /5\/7.*second-trace.*late-arrival/);
  const beforeResume = await f.bytes(4);
  await f.restart();
  const resumed = f.start('继续', [
    () => use('book_generate_assets', subject),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"reused":true/);
      return insertion(f, 6)();
    },
    draft(6),
    insertion(f, 9),
    draft(9),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /pendingSync.*subject\/agent-villain/u);
      return syncRequest('subject');
    },
    ...syncAll.slice(1),
    () => text('余下两处已保存。'),
  ]);
  const result = await resumed.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(await f.bytes(4), beforeResume);
  assert.equal(resumed.requests.filter((r) => r.lane === 'asset').length, 2);
  assert.equal(resumed.requests.filter((r) => r.lane === 'draft').length, 2);
});

test('explicitly read-only limits still win over planning and execution language', () => {
  assert.equal(proposalOnly(directPrompt), false);
  assert.equal(proposalOnly(directPrompt + '。不要改稿。'), true);
  assert.equal(proposalOnly('只看方案，不改稿。想好之后直接改就行。'), true);
  assert.equal(proposalOnly(planPrompt), true);
});

test('the author can correct an unnecessary confirmation using the displayed scope', async (t) => {
  const f = await fixture(t);
  await propose(f);
  const run = f.start(correction, [...saveActor, () => text('仅主体已经写入。')]);
  assert.match((await run.wait()).error ?? '', /1\/5/u);
  assert.match(
    (await f.workspace.readDocument(f.id, { type: 'subject', id: 'agent-villain' })).body,
    /subjects\/captain.md/u,
  );
});

test('the original direct request saves linked mid-story clues and late appearance without a proposal', async (t) => {
  const f = await fixture(t);
  const initial = (await f.read()).documents;
  const before = await Promise.all([4, 6, 9].map((n) => f.bytes(n)));
  const futureClue = {
    ...clue,
    targets: clue.targets.map((c) => ({ ...c, fields: { ...c.fields, payoffChapterId: 'ch10' } })),
  };
  const short = directPrompt + '。每处只补约30个字，大纲每处一句。';
  const run = f.start(short, [
    ({ tools, system }) => {
      assert.ok(!tools.some((tool) => tool.name === 'book_propose_edits'));
      assert.match(system, /作者已直接要求改稿/u);
      return use('book_apply_changes', {
        operations: [{ type: 'subject', action: 'create', id: 'bypass' }],
      });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /不授权通用工具/u);
      return use('book_generate_assets', {
        ...subject,
        targets: [{ ...subject.targets[0], relatedSubjectIds: ['captain'] }],
      });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /至少 2 个不同/u);
      return use('book_generate_assets', subject);
    },
    () => descriptions('agent-villain', '## 稳定设定\n灰衣人是懂船图的画匠，旧识船长和瞭望员。'),
    () => use('book_generate_assets', futureClue),
    () =>
      descriptions('marked-chart', `## 可见线索\n${visible}\n\n## 回收真相\n揭示事实：${revelation}。`),
    insertion(f, 9),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /先保存至少两个不同中期章/u);
      return insertion(f, 2)();
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /本轮须明确要求在此章/u);
      return insertion(f, 4)();
    },
    ...[4, 6, 9].flatMap<Script>((n, i) => [
      ...(i ? [insertion(f, n)] : []),
      (req) => {
        isolatedRequest(req, 'OUTER_ONLY_FIXTURE');
        const source = JSON.stringify(req.history);
        assert.ok(!source.includes(revelation), 'payoff is ch10, not the ch09 appearance');
        assert.match(source, /船图缺角/u);
        assert.match(source, n === 9 ? /本人实际登场/u : /只在正文留下可观察的迹象/u);
        assert.match(source, /约30个字/u);
        return text(n === 9 ? '灰衣人登上甲板，按住那张残缺的船图。' : fragments[n]);
      },
    ]),
    insertion(f, 9),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /已经提交/u);
      return syncRequest('subject');
    },
    ...syncAll.slice(1),
    () => text('相关资料及三处正文和大纲已保存。'),
  ]);
  const result = await run.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.progress?.complete, true);
  assert.equal(result.progress?.done, 7);
  const { documents } = await f.read();
  const actor = documents.find((doc) => doc.id === 'agent-villain')!;
  const foreshadowing = documents.find((doc) => doc.id === 'marked-chart')!;
  for (const id of oldSubjects) assert.ok(actor.body.includes(`subjects/${id}.md`));
  assert.deepEqual(foreshadowing.fields.subjectIds, [actor.id, ...oldSubjects]);
  assert.equal(foreshadowing.fields.payoffChapterId, 'ch10');
  for (const [i, n] of [4, 6, 9].entries()) {
    const raw = (await f.bytes(n)).toString('utf8');
    const fragment = n === 9 ? '灰衣人登上甲板，按住那张残缺的船图。' : fragments[n];
    assert.equal(raw.replace(`${fragment}\r\n\r\n`, ''), before[i].toString('utf8'));
    assert.match(
      documents.find((d) => d.type === 'outline')!.body,
      new RegExp(`实际增补 ${n} 章.*subjects/agent-villain.md.*foreshadowing/marked-chart.md`),
    );
  }
  for (const doc of initial.filter(
    (doc) => doc.type !== 'outline' && ![4, 6, 9].some((n) => doc.id === chapter(n).id),
  ))
    assert.deepEqual(
      documents.find((after) => after.type === doc.type && after.id === doc.id),
      doc,
    );
});

test('a direct staged edit cannot report completion without chapter and outline commits', async (t) => {
  const f = await fixture(t);
  const run = f.start(directPrompt, [() => text('已完成。')]);
  const result = await run.wait();
  assert.match(result.error ?? '', /未全部提交.*中期迹象.*后期登场/u);
  assert.equal(result.progress?.complete, false);
  assert.equal(result.progress?.done, 0);
});

test('a staged edit must reconcile the new notes with the saved scenes before reporting completion', async (t) => {
  const f = await fixture(t);
  const actor = { type: 'subject' as const, id: 'agent-villain' };
  const cliff = { ...clue.targets[0], fields: { ...clue.targets[0].fields, payoffChapterId: 'ch10' } };
  const forecast = '## 已发生变化\n尚未登场。\n\n## 计划\n灰衣人将在码头远观，暂不接触船员。';
  const run = f.start(directPrompt, [
    () => use('book_generate_assets', subject),
    () => descriptions(actor.id, `## 稳定设定\n灰衣人是画匠。\n\n${forecast}`),
    () => use('book_generate_assets', { ...clue, targets: [cliff] }),
    () => descriptions(cliff.id, `## 可见线索\n${visible}\n\n## 回收真相\n${revelation}。`),
    insertion(f, 4),
    () => text(fragments[4]),
    insertion(f, 6),
    () => text(fragments[6]),
    insertion(f, 9),
    () => text('灰衣人登上甲板，向船长递出一只木盒。'),
    () =>
      use('book_generate_assets', { kind: 'subject', action: 'update', targets: [{ id: 'captain' }] }),
    () => text('已保存关联章节。'),
  ]);
  const result = await run.wait();
  assert.match((await f.workspace.readDocument(f.id, actor)).body, /尚未登场/u);
  assert.match((await f.workspace.readDocument(f.id, chapter(9))).body, /登上甲板/u);
  assert.equal(result.status, 'failed', 'saved scenes with pending notes must not appear complete');
  assert.equal(result.progress?.complete, false);
  assert.match(result.error ?? '', /待同步.*subject\/agent-villain/u);
});

test('sync replaces the obsolete plan using saved prose and reuses its receipt', async (t) => {
  const f = await fixture(t);
  const old = '灰衣人将在码头远观，暂不接触船员。';
  const edited = '木盒的来历留作以后揭晓。';
  const futureClue = {
    ...clue.targets[0],
    fields: { ...clue.targets[0].fields, payoffChapterId: 'ch10' },
  };
  const run = f.start(directPrompt, [
    () => use('book_generate_assets', subject),
    () =>
      descriptions(
        'agent-villain',
        `## 稳定设定\n灰衣人是画匠。\n\n## 已发生变化\n尚未登场。\n\n## 计划\n${old}\n\n保留下一卷的其他计划。`,
      ),
    () => use('book_generate_assets', { ...clue, targets: [futureClue] }),
    () => descriptions(futureClue.id, `## 可见线索\n${visible}\n\n## 回收真相\n${revelation}。`),
    insertion(f, 4),
    () => text(fragments[4]),
    insertion(f, 6),
    () => text(fragments[6]),
    insertion(f, 9),
    () => text('灰衣人登上甲板，向船长递出一只木盒。'),
    ({ history }) => {
      assert.match(
        JSON.stringify(history.at(-1)),
        /pendingSync.*subject\/agent-villain.*clue\/marked-chart/u,
      );
      return syncRequest('subject');
    },
    syncCandidate('subject', [
      { section: '已发生变化', before: '尚未登场。', after: '' },
      { section: '计划', before: old, after: edited },
    ]),
    () => syncRequest('subject'),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"reused":true/u);
      return syncRequest('clue');
    },
    syncCandidate('clue'),
    () => text('相关说明已同步。'),
  ]);
  const result = await run.wait();
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.progress?.done, 7);
  const notes = (await f.read()).documents;
  const actor = notes.find((d) => d.id === 'agent-villain')!;
  assert.match(actor.body, /## 稳定设定\n灰衣人是画匠。/u);
  assert.match(actor.body, /<!-- chapter:ch09 -->\s*- 登场\s*原文：灰衣人登上甲板/u);
  assert.match(actor.body, /木盒的来历留作以后揭晓。\s*保留下一卷的其他计划。/u);
  assert.doesNotMatch(actor.body, /尚未登场|码头远观|旧船票|等在码头/u);
  const lead = notes.find((d) => d.id === 'marked-chart')!;
  assert.match(lead.body, /<!-- chapter:ch04 -->\s*- 埋设/u);
  assert.doesNotMatch(lead.body, /- 回收/u);
  assert.equal(lead.fields.payoffChapterId, 'ch10');
  const syncEvents = run.trace.rows.filter(({ event }) => event === 'writing.edit.sync');
  assert.deepEqual(
    syncEvents.map(({ fields }) => fields.outcome),
    ['ok', 'reused', 'ok'],
  );
  assert.ok(!JSON.stringify(syncEvents).includes(edited));
});

for (const sourceChanged of [false, true]) {
  test(`sync refuses a ${sourceChanged ? 'source chapter' : 'target note'} revision changed during generation`, async (t) => {
    const f = await fixture(t);
    await propose(f);
    const target = { type: 'subject' as const, id: 'agent-villain' };
    const run = f.start(agree, [
      ...saveActor,
      ...saveClue,
      insertion(f, 4),
      draft(4),
      insertion(f, 6),
      draft(6),
      insertion(f, 9),
      draft(9),
      () => syncRequest('subject'),
      async (req) => {
        const ref = sourceChanged ? chapter(4) : target;
        const doc = await f.workspace.readDocument(f.id, ref);
        const report = await f.workspace.writeChanges(f.id, [
          { ...doc, expect: doc.revision, body: doc.body + '\n\n作者并发修改。' },
        ]);
        assert.equal(report.error, undefined);
        return syncCandidate('subject')(req);
      },
      ({ history }) => {
        assert.match(JSON.stringify(history.at(-1)), /conflict/u);
        return text('同步等待核对。');
      },
    ]);
    const result = await run.wait();
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /待同步 subject\/agent-villain/u);
    const doc = await f.workspace.readDocument(f.id, target);
    assert.doesNotMatch(doc.body, /原文：/u);
    assert.match((await f.workspace.readDocument(f.id, chapter(9))).body, /灰衣人登上甲板/u);
    assert.equal(doc.body.includes('作者并发修改'), !sourceChanged);
  });
}

test('a later author restriction blocks synchronization of the new subject after restart', async (t) => {
  const f = await fixture(t);
  await propose(f);
  const first = f.start(agree, [
    ...saveActor,
    ...saveClue,
    insertion(f, 4),
    draft(4),
    () => text('第一处已经保存。'),
  ]);
  assert.equal((await first.wait()).status, 'failed');
  const original = await f.workspace.readDocument(f.id, { type: 'subject', id: 'agent-villain' });
  await f.restart();
  const second = f.start('继续，别更新本次新建的主体', [
    () => syncRequest('subject'),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /限制更新这类资料/u);
      return text('遵守更新限制。');
    },
  ]);
  await second.wait();
  assert.deepEqual(await f.workspace.readDocument(f.id, original), original);
  assert.equal(second.requests.filter((r) => r.lane === 'asset').length, 0);
});
