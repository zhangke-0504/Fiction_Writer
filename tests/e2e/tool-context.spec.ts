import { _electron as electron, expect, test, type Page, type TestInfo } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BookView,
  DocRef,
  Manuscript,
  ModelProfile,
  Protocol,
  RuntimeView,
  Session,
  WriteReport,
} from '../../shared/contracts.js';
import { readDiagnostics } from './diagnostic-files.js';
import { taskMetrics } from './task-metrics.js';
import type { TaskWaitResult } from '../../electron/agent/task-result.js';
import { isOfficialDeepSeek } from '../../electron/agent/provider-capabilities.js';

const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
const chapters = Array.from(
  { length: 10 },
  (_, i) => ({ type: 'chapter', id: `chapter-${i + 1}` }) as const,
);
const mid = chapters[4],
  late = chapters[8];
const clue = { type: 'clue', id: 'seal' } as const;
const outline = { type: 'outline', id: 'outline' } as const;
const villain = { type: 'subject', id: 'warden' } as const;
const names = [
  ['sailor', '闻舟'],
  ['keeper', '顾灯'],
  ['scribe', '林简'],
];
const clueBody =
  '## 可见线索\n铜印在旧港出现，色泽不变。\n\n## 回收真相\n铜印属于多年未现身的守门者。\n';
const nextClue = `${clueBody}\n第九章守门者首次现身，铜印与真人身份互相印证。\n`;
const midOld = '门前的雾气始终没有散去。';
const lateOld = '众人推门步入阴影之中。';
const midNew = '门前的雾气未散，一枚刻有守门者记号的铜印浮出水面。';
const lateNew = '众人推门步入阴影，守门者第一次从暗处现身。';
const first = `增加反派守门者，关联闻舟和顾灯。定点改第五章「${midOld}」埋线索、第九章「${lateOld}」首次登场，并同步大纲。不改原伏笔卡，直接改，不用确认。`;
const prior =
  '守门者资料、第五章线索、第九章登场和大纲已处理；原伏笔卡 seal 尚未同步第九章登场，其他内容保留。';
const follow = '解决未清理的问题';
const baseOutline = chapters.map(({ id }, i) => `## 第${i + 1}章\n${id}：沿海岸推进故事。`).join('\n\n');
const nextOutline = baseOutline
  .replace('chapter-5：沿海岸推进故事。', `chapter-5：${midNew}`)
  .replace('chapter-9：沿海岸推进故事。', `chapter-9：${lateNew}`);
const chapterBody = (i: number) =>
  `${i === 4 ? midOld : i === 8 ? lateOld : `沿岸故事第${i + 1}章。`}\n\n${Array.from({ length: 36 }, (_, j) => `雾线${i + 1}-${j + 1}：闻舟沿着潮线往回走，帮顾灯捡起笼罩着薄雾的石块。海风吹过灯塔，灯芯摇晃，林简在远处观望。回到码头时，旧船安静地靠在木桩边，木纹上还带着昨日风雨的气味。`).join('\n\n')}`;

type Call = { type: 'tool_use'; id: string; name: string; input: object };
type Block =
  Call | { type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string };
type Wire = {
  system?: string;
  max_tokens: number;
  tools?: { name: string; input_schema: { properties: Record<string, unknown> } }[];
  messages: { role: string; content: Block[] }[];
};

async function seedBook(page: Page) {
  const { id: bookId } = await rpc<{ id: string }>(page, 'book.create', {
    title: '黄灯侠长稿夹具',
    summary: '只在测试中使用。',
  });
  const doc = (ref: DocRef) => rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: ref });
  const seed = await rpc<WriteReport>(page, 'book.changes.write', {
    bookId,
    changes: [
      { ...outline, expect: (await doc(outline)).revision, fields: {}, body: baseOutline },
      ...chapters.map((ref, i) => ({
        ...ref,
        expect: null,
        fields: { title: `第${i + 1}章`, order: i + 1 },
        body: chapterBody(i),
      })),
      ...names.map(([id, name]) => ({
        type: 'subject',
        id,
        expect: null,
        fields: { name, kind: 'character' },
        body: `${name}来自港口。`,
      })),
      {
        ...clue,
        expect: null,
        fields: { title: '铜印', setupChapterId: mid.id, payoffChapterId: late.id },
        body: clueBody,
      },
    ],
  });
  expect(seed.error).toBeUndefined();
  const refs = [...chapters, outline, clue, ...names.map(([id]) => ({ type: 'subject', id }) as const)];
  const original = new Map((await Promise.all(refs.map(doc))).map((d) => [d.id, d]));
  return { bookId, doc, refs, original };
}

function reply(res: ServerResponse, blocks: Block[]) {
  const events = [
    ...blocks.flatMap((content_block, index) => [
      { type: 'content_block_start', index, content_block },
      { type: 'content_block_stop', index },
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: blocks.some(({ type }) => type === 'tool_use') ? 'tool_use' : 'end_turn' },
    },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

async function verifyLongRun(mode: 'main' | 'single' | 'parallel', info: TestInfo) {
  const root = info.outputPath('app');
  const baseline = process.env.FW_TOOL_CONTEXT_BASELINE === '1';
  test.skip(baseline && mode !== 'main', 'the historical baseline lacks delegation');
  let phase: 'edit' | 'follow' = 'edit';
  const failures: string[] = [];
  const main: {
    phase: string;
    readEstimate: number;
    beforeScope: boolean;
    last: string;
    maxTokens: number;
  }[] = [];
  const revisions = new Map<string, string>();
  const updates = new Map<string, string>();
  let registered = false;
  let waits = 0;
  const delegated = new Map<string, DocRef[]>();
  const firstChilds: (() => void)[] = [];
  const call = (id: string, name: string, input: object): Call => ({
    type: 'tool_use',
    id,
    name,
    input,
  });
  const read = (ref: DocRef) =>
    call(`read-${ref.id}`, 'book_get_context', { type: ref.type, documentId: ref.id });
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const wire = JSON.parse(raw) as Wire;
      const tools = wire.tools?.map(({ name }) => name) ?? [];
      const send = (...calls: Call[]) => {
        for (const { name } of calls) expect(tools).toContain(name);
        reply(res, calls);
      };
      const text = (value: string) => reply(res, [{ type: 'text', text: value }]);
      if (
        tools.length === 1 &&
        ['check_book_scope', 'check_asset_update_scope', 'submit_chapter_patch_review'].includes(
          tools[0],
        )
      ) {
        if (tools[0] === 'check_book_scope' && phase === 'follow') expect(raw).toContain(prior);
        return send(call('review', tools[0], { allowed: true }));
      }
      if (tools.length === 1 && tools[0] === 'submit_story_descriptions')
        return send(
          call('describe', tools[0], {
            items: [
              {
                id: phase === 'edit' ? villain.id : clue.id,
                body:
                  phase === 'edit'
                    ? '## 稳定设定\n守门者截断闻舟的旧航线，曾与顾灯共守港口。'
                    : nextClue,
              },
            ],
          }),
        );
      const results = wire.messages
        .flatMap(({ content }) => content)
        .filter((b): b is Extract<Block, { type: 'tool_result' }> => b.type === 'tool_result');
      const readEstimate = results
        .filter(({ tool_use_id }) => /^(read-|catalog)/.test(tool_use_id))
        .reduce((sum, row) => sum + Math.ceil(Buffer.byteLength(row.content) / 2), 0);
      const last = wire.messages.at(-1)!.content.at(-1)!;
      const step = last.type === 'tool_result' ? last.tool_use_id : 'start';
      if (wire.system?.includes('只读子任务')) {
        const initial = wire.messages[0].content[0];
        const brief = JSON.parse(initial.type === 'text' ? initial.text : '{}').brief;
        expect(raw).not.toContain(first);
        const crew = brief === 'crew';
        const plot = brief === 'plot';
        if (step === 'start') {
          const discover = () =>
            send(call('child-discover', 'tool_search', { query: 'book_get_context book_search_text' }));
          if (mode !== 'parallel') return discover();
          firstChilds.push(discover);
          if (firstChilds.length === 2) firstChilds.forEach((resume) => resume());
          return;
        }
        if (step === 'child-discover')
          return send(
            ...[
              ...(!plot
                ? [
                    ['crew', 'subject', '闻舟'],
                    ['keeper', 'subject', '顾灯'],
                  ]
                : []),
              ...(!crew
                ? [
                    ['mid', 'chapter', midOld],
                    ['late', 'chapter', lateOld],
                  ]
                : []),
            ].map(([tag, type, query]) =>
              call(`child-find-${tag}`, 'book_search_text', { type, query }),
            ),
          );
        if (step.startsWith('child-find-')) {
          return send(
            ...results
              .filter(({ tool_use_id }) => tool_use_id.startsWith('child-find-'))
              .map((entry) => {
                const hit = JSON.parse(entry.content).value.matches[0];
                expect(hit).toBeTruthy();
                return call(`child-read-${hit.id}`, 'book_get_context', {
                  type: hit.type,
                  documentId: hit.id,
                  revision: hit.revision,
                  offset: hit.range[0],
                  length: 80,
                });
              }),
          );
        }
        const references = results
          .filter(({ tool_use_id }) => tool_use_id.startsWith('child-read-'))
          .map((entry) => {
            const { document, range } = JSON.parse(entry.content).value;
            expect(document.body).toBeTruthy();
            return { type: document.type, id: document.id, revision: document.revision, range };
          });
        expect(references).toHaveLength(mode === 'parallel' ? 2 : 4);
        return send(
          call('child-report', 'task_report', {
            status: 'completed',
            summary: '已定位人物关联和／或剧情位置，按引用核对。',
            unresolved: [],
            references,
          }),
        );
      }
      expect(raw).not.toContain('child-find-');
      expect(raw).not.toContain('child-read-');
      main.push({
        phase,
        readEstimate,
        beforeScope: !registered,
        last: step,
        maxTokens: wire.max_tokens,
      });
      if (step === 'start') {
        expect(results).toHaveLength(0);
        expect(raw).not.toContain('雾线1-1');
        return send(
          call('discover', 'tool_search', {
            query: 'book_get_context book_apply_changes book_patch_chapter book_generate_assets',
          }),
        );
      }
      for (const result of wire.messages.at(-1)!.content) {
        if (result.type !== 'tool_result') continue;
        const envelope = JSON.parse(result.content);
        expect(envelope.ok, `${step}: ${envelope.error ?? envelope.reason ?? 'tool'}`).toBe(true);
        if (result.tool_use_id.startsWith('read-') && envelope.value.document?.revision)
          revisions.set(envelope.value.document.id, envelope.value.document.revision);
      }
      const scope = (items: object[], sourceQuote?: string) => {
        registered = true;
        return send(call('scope', 'book_task_scope', { items, ...(sourceQuote && { sourceQuote }) }));
      };
      if (phase === 'edit') {
        if (step === 'discover') {
          const supportsBodies = wire.tools?.find(({ name }) => name === 'book_get_context')
            ?.input_schema.properties.includeBodies;
          return send(
            call('catalog', 'book_get_context', supportsBodies ? { includeBodies: true } : {}),
          );
        }
        if (step === 'catalog') {
          if (mode === 'main') return send(...chapters.slice(0, 4).map(read));
          return send(call('delegate-discover', 'tool_search', { query: 'start_task wait_tasks' }));
        }
        if (step === 'delegate-discover')
          return send(
            ...(mode === 'parallel' ? ['crew', 'plot'] : ['both']).map((brief) =>
              call(`launch-${brief}`, 'start_task', {
                brief,
                deliverable: '定位人物关联和／或剧情位置，交付可回读出处。',
              }),
            ),
          );
        if (step.startsWith('launch-') || step.startsWith('collect-')) {
          const ids = results
            .filter(({ tool_use_id }) => tool_use_id.startsWith('launch-'))
            .map(({ content }) => JSON.parse(content).value.taskId as string);
          if (step.startsWith('collect-')) {
            const value: TaskWaitResult = JSON.parse(results.at(-1)!.content).value;
            for (const row of value.tasks) {
              if (row.status === 'running') continue;
              expect(row.status).toBe('completed');
              if (row.report)
                delegated.set(
                  row.taskId,
                  row.report.references.filter(
                    (ref): ref is Extract<typeof ref, DocRef> => 'type' in ref,
                  ),
                );
            }
          }
          if (delegated.size < ids.length)
            return send(call(`collect-${++waits}`, 'wait_tasks', { taskIds: ids }));
          const refs = [...delegated.values()].flat().filter(({ type }) => type === 'chapter');
          expect(refs.map(({ id }) => id)).toEqual([mid.id, late.id]);
          return send(...refs.map(read));
        }
        if (step === 'read-chapter-4') return send(...[mid, chapters[6], late, chapters[9]].map(read));
        if (step === (mode === 'main' ? 'read-chapter-10' : 'read-chapter-9'))
          return scope([
            { operation: 'chapter.patch', id: mid.id, purpose: '第五章定点加入铜印线索' },
            { operation: 'chapter.patch', id: late.id, purpose: '第九章定点写成首次登场' },
            { operation: 'outline.write', id: outline.id, purpose: '同步第五章、第九章大纲' },
            {
              operation: 'subject.create',
              id: villain.id,
              purpose: '新增守门者，关联闻舟和顾灯',
              relatedMinimum: 2,
            },
          ]);
        const patch = (id: string, ref: DocRef, quote: string, replacement: string) =>
          send(
            call(id, 'book_patch_chapter', {
              chapterId: ref.id,
              revision: revisions.get(ref.id),
              edits: [{ quote, replacement }],
            }),
          );
        if (step === 'scope') return patch('mid', mid, midOld, midNew);
        if (step === 'mid') return patch('late', late, lateOld, lateNew);
        if (step === 'late')
          return send(
            call('outline', 'book_apply_changes', {
              operations: [{ ...outline, action: 'update', body: nextOutline }],
            }),
          );
        if (step === 'outline')
          return send(
            call('create', 'book_generate_assets', {
              kind: 'subject',
              action: 'create',
              targets: [
                {
                  id: villain.id,
                  fields: { name: '守门者', kind: 'character' },
                  relatedSubjectIds: ['sailor', 'keeper'],
                },
              ],
            }),
          );
        if (step === 'create') return text(prior);
      } else {
        if (step === 'discover') return send(read(clue), read(late));
        if (step === 'read-chapter-9')
          return scope(
            [{ operation: 'clue.update', id: clue.id, purpose: '同步已经发生的第九章登场，只补事实' }],
            prior,
          );
        if (step === 'scope')
          return send(
            call('sync', 'book_generate_assets', {
              kind: 'clue',
              action: 'update',
              targets: [{ id: clue.id }],
            }),
          );
        if (step === 'sync') return text('已同步原伏笔卡，仅此项写入。');
      }
      throw new Error(`Unexpected request: ${phase}/${step}`);
    } catch (error) {
      failures.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      FW_E2E: '1',
      FW_TEST_ROOT: root,
      FW_E2E_SHOW_WINDOW: '0',
      FW_TEST_DISABLE_DELEGATION: mode === 'main' ? '1' : '',
    },
  });
  try {
    const page = await app.firstWindow();
    const profile = await rpc<ModelProfile>(page, 'profiles.save', {
      name: 'local fixture',
      model: 'fixture',
      apiKey: 'fixture-key',
      protocol: 'messages',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    const { bookId, doc, refs, original } = await seedBook(page);
    const session = await rpc<Session>(page, 'session.create', { bookId });
    const submit = async (prompt: string) => {
      registered = false;
      const { runId } = await rpc<{ runId: string }>(page, 'session.start', {
        id: session.id,
        profileId: profile.id,
        prompt,
      });
      await expect
        .poll(async () =>
          (await readDiagnostics(root, 'backend')).some(
            ({ event, fields }) => event === 'run.finished' && fields.runId === runId,
          ),
        )
        .toBe(true);
      const current = (await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId })).sessions.find(
        (row) => row.session.id === session.id,
      )!;
      expect(failures).toEqual([]);
      expect(current.run?.status, current.run?.error).toBe('completed');
      expect(current.run?.taskOutcome).toBe('fulfilled');
      return runId;
    };
    const editId = await submit(first);
    expect((await doc(clue)).revision).toBe(original.get(clue.id)?.revision);
    phase = 'follow';
    const followId = await submit(follow);
    for (const ref of refs) {
      const saved = await doc(ref);
      const old = original.get(ref.id)!;
      const expected =
        ref.id === mid.id
          ? old.body.replace(midOld, midNew)
          : ref.id === late.id
            ? old.body.replace(lateOld, lateNew)
            : ref.id === outline.id
              ? nextOutline
              : ref.id === clue.id
                ? nextClue
                : old.body;
      expect(saved.body).toBe(expected);
      expect(saved.fields).toEqual(old.fields);
      if (expected === old.body) expect(saved.revision).toBe(old.revision);
      else updates.set(`${ref.type}/${ref.id}`, saved.revision);
    }
    const savedVillain = await doc(villain);
    expect(savedVillain.body).toContain('闻舟');
    expect(savedVillain.body).toContain('顾灯');
    expect(savedVillain.body).toContain('(subjects/sailor.md)');
    expect(savedVillain.body).toContain('(subjects/keeper.md)');
    updates.set(`${villain.type}/${villain.id}`, savedVillain.revision);
    const events = await readDiagnostics(root, 'backend');
    const commits = events.filter(
      ({ event, fields }) =>
        event === 'workspace.document.committed' && [editId, followId].includes(fields.runId),
    );
    expect(commits).toHaveLength(updates.size);
    const persisted = await readFile(join(root, 'state', 'sessions', `${session.id}.jsonl`), 'utf8');
    const receipts = persisted
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => JSON.parse(line).toolReceipt?.commits ?? []);
    expect(receipts).toHaveLength(updates.size);
    for (const { type, id, revision } of receipts) expect(revision).toBe(updates.get(`${type}/${id}`));
    const report = [editId, followId].map((runId, i) => {
      const lane = main.filter((row) => row.phase === (i ? 'follow' : 'edit'));
      const budget = events.filter(
        ({ event, fields }) =>
          event === 'model.budget_dispatched' && fields.runId === runId && fields.lane === 'agent',
      );
      expect(new Set(lane.map((row) => row.maxTokens))).toEqual(new Set([8192]));
      return {
        ...taskMetrics(events, runId),
        rounds: lane.length,
        preScope: lane.filter((row) => row.beforeScope).length,
        peakRead: Math.max(...lane.map((row) => row.readEstimate)),
        peakInput: Math.max(...budget.map(({ fields }) => fields.estimatedInput)),
        catalogRounds: lane.filter((row) => row.last === 'catalog').length,
      };
    });
    if (!baseline) expect(report[0].peakRead).toBeLessThan(20_000);
    const taskCount = mode === 'main' ? 0 : mode === 'single' ? 1 : 2;
    expect(report[0].tasks).toBe(taskCount);
    expect(report[0].taskOverlap).toBe(taskCount);
    expect(report[0].taskOutputLimits).toEqual(taskCount ? [8192] : []);
    expect(report[1].tasks).toBe(0);
    console.log(`TOOL_CONTEXT ${baseline ? 'HISTORICAL' : mode} ${JSON.stringify(report)}`);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const mode of ['main', 'single', 'parallel'] as const)
  test(`official Harness bounds a long read batch and preserves scoped edits and follow-up (${mode})`, async ({}, info) => {
    await verifyLongRun(mode, info);
  });

test('real-provider Yellow Lantern: opt-in same-manuscript delegation comparison', async ({}, info) => {
  test.skip(process.env.FW_LIVE_DELEGATION !== '1', 'requires explicit opt-in and may incur charges');
  const { FW_LIVE_API_KEY: apiKey, ...env } = process.env;
  const baseUrl = env.FW_LIVE_BASE_URL;
  const model = env.FW_LIVE_MODEL;
  const protocol = env.FW_LIVE_PROTOCOL as Protocol | undefined;
  test.skip(
    !apiKey || !baseUrl || !model || !protocol || !['messages', 'chat', 'responses'].includes(protocol),
    'supply a live key, base URL, model, and supported protocol',
  );
  const waitMs = 20 * 60_000;
  test.setTimeout(6 * waitMs + 60_000);
  let mainOutputLimits: number[] | undefined;
  let snapshot: string[] | undefined;
  const samples: object[] = [];
  for (const trial of ['main', 'available-1', 'available-2']) {
    const root = info.outputPath(trial);
    const app = await electron.launch({
      args: ['.'],
      env: {
        ...env,
        FW_E2E: '1',
        FW_TEST_ROOT: root,
        FW_E2E_SHOW_WINDOW: '0',
        FW_TEST_TASK_TIMEOUT_MS: '',
        FW_TEST_DISABLE_DELEGATION: trial === 'main' ? '1' : '',
      },
    });
    try {
      const page = await app.firstWindow();
      const profile = await rpc<ModelProfile>(page, 'profiles.save', {
        name: 'delegation live',
        apiKey,
        baseUrl,
        model,
        protocol,
        providerId: isOfficialDeepSeek({ baseUrl: baseUrl!, protocol: protocol! })
          ? 'deepseek'
          : 'custom',
      });
      const { bookId, doc, original } = await seedBook(page);
      const revisions = [...original.values()].map(({ revision }) => revision);
      if (snapshot) expect(revisions).toEqual(snapshot);
      else snapshot = revisions;
      const session = await rpc<Session>(page, 'session.create', { bookId });
      const submit = async (prompt: string) => {
        const { runId } = await rpc<{ runId: string }>(page, 'session.start', {
          id: session.id,
          profileId: profile.id,
          prompt,
          effort: 'high',
        });
        await expect
          .poll(
            async () =>
              (await readDiagnostics(root, 'backend')).some(
                ({ event, fields }) => event === 'run.finished' && fields.runId === runId,
              ),
            { timeout: waitMs, intervals: [300, 1200, 2200] },
          )
          .toBe(true);
        const run = (await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId })).sessions.find(
          (entry) => entry.session.id === session.id,
        )!.run!;
        const metrics = taskMetrics(await readDiagnostics(root, 'backend'), runId);
        return { runId, metrics, taskOutcome: run.taskOutcome };
      };
      const edit = await submit(
        '增加一个跟至少两名既有角色有关联的反派。在剧情中期留下这个人的线索，后期此人才第一次实际登场。根据现稿选择位置并同步有关设定，想好就直接改，不用确认。',
      );
      if (mainOutputLimits) expect(edit.metrics.mainOutputLimits).toEqual(mainOutputLimits);
      else mainOutputLimits = edit.metrics.mainOutputLimits;
      const continued = edit.taskOutcome === 'partial' ? await submit(follow) : undefined;
      const usageGroup =
        edit.metrics.tasks === 0
          ? 'no-task'
          : edit.metrics.tasks === 1
            ? 'one-task'
            : edit.metrics.taskOverlap >= 2
              ? 'overlapping-tasks'
              : 'sequential-tasks';
      const index = await rpc<BookView>(page, 'book.read', { bookId });
      const changed = index.documents.filter(
        ({ id, revision, type }) => type !== 'book' && original.get(id)?.revision !== revision,
      );
      const history = await readFile(join(root, 'state', 'sessions', `${session.id}.jsonl`), 'utf8');
      const completed = new Map<string, string>();
      for (const line of history.trim().split(/\r?\n/u))
        for (const { type, id, revision } of JSON.parse(line).toolReceipt?.commits ?? [])
          if (revision) completed.set(`${type}/${id}`, revision);
      for (const ref of changed)
        expect((await doc(ref)).revision === completed.get(`${ref.type}/${ref.id}`)).toBe(true);
      samples.push({
        trial,
        usageGroup,
        edit: edit.metrics,
        editTaskOutcome: edit.taskOutcome,
        continued: continued?.metrics,
        continuedTaskOutcome: continued?.taskOutcome,
        changed: changed.length,
      });
    } finally {
      await app.close();
    }
  }
  // Only safe counts and estimates; quality still needs review of the isolated manuscripts.
  console.log(`TASK_DELEGATION_LIVE ${JSON.stringify(samples)}`);
});
