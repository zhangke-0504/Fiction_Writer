import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { callRef, type ToolReceipt } from '../../electron/agent/tool-receipts.js';
import type {
  BookView,
  DocRef,
  Manuscript,
  ModelProfile,
  RunInfo,
  RuntimeView,
  Session,
  WriteReport,
} from '../../shared/contracts.js';
import { diagnosticText, readDiagnostics } from './diagnostic-files.js';

const whole = '把十章航海故事全部写完，并补齐信使卡。WHOLE_DIRECTION_FIXTURE';
const single = '只补第十一章正文和这一章的大纲，不接手原整书。';
const follow = '继续处理剩下的局部待办。FOLLOWUP_AUTHOR_FIXTURE';
const outline = { type: 'outline' as const, id: 'outline' };
const actor = { type: 'subject' as const, id: 'archivist' };
const clue = { type: 'clue' as const, id: 'bell' };
const chapter = (n: number) => ({ type: 'chapter' as const, id: 'ch-' + n });
const missing = { type: 'subject' as const, id: 'extra' };
const outlineBody = '海雾过去，水手回到港口。';
const oldProse = '水手只听见了远处报时的钟声。';
const fixedProse = '水手听见港口敲响了返航的钟声。';
const chapterTail =
  '\n\n船靠岸后，水手把绳索盘好，顺着木梯爬上栈桥。他把日记捂在衣襟之下，无意扰动守夜人的平静。晨雾退去，他才看得清库房的门牌。';
const oldNote = '原计划在远处鸣钟。CLUE_OLD_FIXTURE';
const fixedNote = '返航的钟声已经在港口响起。CLUE_NEW_FIXTURE';
const generated = '我收紧缆绳，带着航海日记走上了码头。DRAFT_FIXTURE';
const ten = Array.from({ length: 10 }, (_, index) => chapter(index + 1));
const chapterIds = ten.map(({ id }) => id);
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);

type Action = { id: string; name: string; input: object };
const use = (id: string, name: string, input: object = {}): Action => ({ id, name, input });
type Wire = {
  system: string;
  max_tokens: number;
  tools?: { name: string }[];
  messages: { content: { text?: string; content?: string; tool_use_id?: string }[] }[];
};
type FixtureContext = { bookId: string };
type Scenario = (wire: Wire, context: FixtureContext) => string | Action | Promise<string | Action>;

async function harness(
  root: string,
  next: Scenario,
  lastChapterBody = oldProse + chapterTail,
  seed = true,
) {
  const errors: unknown[] = [];
  let context: FixtureContext;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire;
      const response = await next(wire, context);
      const tool = typeof response !== 'string';
      if (tool) expect(wire.tools?.map(({ name }) => name)).toContain(response.name);
      const events = [
        {
          type: 'content_block_start',
          index: 0,
          content_block: tool ? { type: 'tool_use', ...response } : { type: 'text', text: response },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const launch = () =>
    electron.launch({
      args: ['.'],
      env: { ...process.env, FW_E2E: '1', FW_E2E_SHOW_WINDOW: '0', FW_TEST_ROOT: root },
    });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    const { id: profileId } = await rpc<ModelProfile>(page, 'profiles.save', {
      name: 'local-whole-fixture',
      model: 'fixture',
      apiKey: 'fixture',
      protocol: 'messages',
      baseUrl: 'http://127.0.0.1:' + port,
    });
    const book = await rpc<{ id: string }>(page, 'book.create', {
      title: '灯塔日志',
      summary: '水手返航',
    });
    const bookId = book.id;
    const session = await rpc<Session>(page, 'session.create', { bookId });
    const read = (doc: { type: string; id: string }) =>
      rpc<Manuscript>(page, 'book.doc.read', { bookId, doc });
    const change = async (changes: object[]) => {
      const result = await rpc<WriteReport>(page, 'book.changes.write', { bookId, changes });
      expect(result.error).toBeUndefined();
    };
    context = { bookId };
    if (seed) {
      const before = await read(outline);
      await change([
        { ...before, expect: before.revision, body: outlineBody },
        ...ten.map((ref, index) => ({
          ...ref,
          expect: null,
          fields: { title: '航海 ' + (index + 1), order: index + 1 },
          body: index === 9 ? lastChapterBody : '水手保存了航海日记第 ' + (index + 1) + ' 页。',
        })),
        {
          ...actor,
          expect: null,
          fields: { name: '档案员', kind: 'character' },
          body: '## 稳定设定\n档案员保管航海日记。',
        },
        { ...missing, expect: null, fields: { name: '信使', kind: 'character' }, body: '' },
        {
          ...clue,
          expect: null,
          fields: { title: '报时钟', setupChapterId: chapter(2).id, payoffChapterId: chapter(10).id },
          body: '## 可见线索\n' + oldNote + '\n\n## 回收真相\n钝钟令船员辨认了归途。',
        },
      ]);
    }
    // Let a wrongly promoted request visibly exceed the standard budget without a remote probe.
    await app.close();
    const profilePath = join(root, 'state', 'profiles.json');
    const profiles = JSON.parse(await readFile(profilePath, 'utf8'));
    profiles[0].capabilities = {
      source: 'generic-fallback',
      contextWindow: 100_000,
      maxOutputTokens: 24_000,
    };
    await writeFile(profilePath, JSON.stringify(profiles));
    app = await launch();
    page = await app.firstWindow();
    const journal = async () =>
      (await readFile(join(root, 'state', 'sessions', session.id + '.jsonl'), 'utf8'))
        .split(/\r?\n/u)
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { novelTask?: unknown; toolReceipt?: ToolReceipt });
    const start = async (prompt: string) => {
      const { runId } = await rpc<{ runId: string }>(page, 'session.start', {
        id: session.id,
        profileId,
        prompt,
      });
      return runId;
    };
    const currentRun = async () =>
      (await rpc<RuntimeView>(page, 'runtime.snapshot')).sessions.find(
        ({ session: s }) => s.id === session.id,
      )?.run;
    const finish = async (runId: string) => {
      await expect
        .poll(async () =>
          (await readDiagnostics(root, 'backend')).some(
            ({ event, fields }) => event === 'run.finished' && fields.runId === runId,
          ),
        )
        .toBe(true);
      if (errors.length) throw errors[0];
      const run = await currentRun();
      expect(run?.id).toBe(runId);
      return run!;
    };
    const api = {
      session,
      read,
      change,
      journal,
      view: () => rpc<BookView>(page, 'book.read', { bookId }),
      restart: async () => {
        await app!.close();
        app = await launch();
        page = await app.firstWindow();
      },
      openHarness: async (prompt: string) => {
        await page.getByRole('button', { name: '编辑 灯塔日志', exact: true }).click();
        await page.getByRole('button', { name: 'Harness', exact: true }).click();
        const panel = page.getByRole('complementary', { name: 'Harness 面板' });
        await panel.getByRole('button', { name: new RegExp('^' + prompt.slice(0, 16)) }).click();
        return panel;
      },
      start,
      currentRun,
      finish,
      submit: async (prompt: string) => finish(await start(prompt)),
      events: async (run: RunInfo) =>
        (await readDiagnostics(root, 'backend')).filter(({ fields }) => fields.runId === run.id),
      receipts: async (run: RunInfo) =>
        (await journal()).flatMap(({ toolReceipt }) =>
          toolReceipt?.runId === run.id ? [toolReceipt] : [],
        ),
      close: async () => {
        await app?.close().catch(() => {});
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
    return api;
  } catch (error) {
    await app?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    throw error;
  }
}

const register = (bookId: string) => ({
  operation: 'novel.register',
  id: bookId,
  count: 10,
  purpose: '交付十章整书',
});
const enroll = (id: string, ...items: object[]) => use(id, 'book_task_scope', { items });
const guide = () => use('guide', 'skill_load', { name: 'generate-novel' });
const goal = (assetRefs: object[] = []) =>
  use('goal', 'book_get_context', { novelGoal: { action: 'register', chapterIds, assetRefs } });
const targeted = (id: string, doc: { type: string; id: string }) =>
  use(id, 'book_get_context', { type: doc.type, documentId: doc.id });
const blueprint = (...operations: object[]) => use('apply', 'book_apply_changes', { operations });

function turn(wire: Wire) {
  const last = wire.messages.at(-1)?.content.at(-1);
  return {
    id: last?.tool_use_id,
    text: last?.text ?? '',
    result: last?.content ? JSON.parse(last.content) : undefined,
    tool: wire.tools?.length === 1 ? wire.tools[0].name : undefined,
  };
}
function verdict(name: string, allowed = true) {
  return use('verdict', name, { allowed });
}

const key = ({ type, id }: DocRef) => `${type}/${id}`;

function sequenced(
  prompt: string,
  steps: [Action, (wire: Wire) => void | Promise<void>][],
  extra?: Scenario,
) {
  const position = new Map(steps.map(([action], i) => [action.id, i]));
  return async (wire: Wire, context: FixtureContext) => {
    const { id, text, result, tool } = turn(wire);
    if (tool === 'check_book_scope') return verdict(tool);
    if (tool === 'book_read_chapter') return '本次取材够用。';
    if (tool === 'submit_story_descriptions' || !wire.tools?.length) {
      if (!extra) throw new Error(`Unexpected generation request: ${tool ?? 'prose'}`);
      return extra(wire, context);
    }
    if (!id) {
      expect(text).toBe(prompt);
      return steps[0][0];
    }
    const at = position.get(id);
    expect(at, `unexpected fixture result: ${id}`).toBeDefined();
    expect(result?.ok, result?.error).toBe(true);
    await steps[at!][1](wire);
    return steps[at! + 1]?.[0] ?? '按实际回执完成。';
  };
}
const step = (action: Action, check: (wire: Wire) => void | Promise<void> = () => {}) =>
  [action, check] as [Action, (wire: Wire) => void | Promise<void>];
const find = (query: string) => use('discover', 'tool_search', { query });
const scoped = (id: string, operation: string, target: DocRef, purpose: string) =>
  enroll(id, { operation, id: target.id, purpose });
const readContext = (ref: DocRef) => targeted(`read-${ref.type}-${ref.id}`, ref);
const writeOutline = (body: string) => blueprint({ ...outline, action: 'update', body });
const writeChapter = (ref: DocRef, plan: object = {}) =>
  use(`draft-${ref.id}`, 'book_generate_chapter', { chapterId: ref.id, mode: 'draft', ...plan });
const savedDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function expectLocalCommits(
  api: Awaited<ReturnType<typeof harness>>,
  root: string,
  bookId: string,
  run: RunInfo,
  calls: [Action, DocRef[]][],
) {
  expect(run).toMatchObject({
    status: 'completed',
    taskOutcome: 'fulfilled',
    progress: { complete: true },
  });
  const receipts = (await api.receipts(run)).filter(({ commitCount }) => commitCount);
  const events = await api.events(run);
  const commits = events.filter(({ event }) => event === 'workspace.document.committed');
  expect(receipts).toHaveLength(calls.length);
  expect(commits).toHaveLength(calls.reduce((n, [, refs]) => n + refs.length, 0));
  const finished = events.filter(
    ({ event, fields }) =>
      event === 'tool.finished' && commits.some((commit) => commit.fields.callId === fields.callId),
  );
  expect(finished.map(({ fields }) => fields.tool)).toEqual(calls.map(([action]) => action.name));
  expect(events.some(({ event }) => event === 'novel.goal')).toBe(false);
  for (const [[action, refs], i] of calls.map((call, i) => [call, i] as const)) {
    expect(receipts[i]).toMatchObject({ callRef: callRef(action.id), tool: action.name, outcome: 'ok' });
    expect(receipts[i].commits.map(key)).toEqual(refs.map(key));
    expect(commits.filter(({ fields }) => fields.callId === finished[i].fields.callId)).toHaveLength(
      refs.length,
    );
  }
  // Compare the last matching receipt with editor readback and the actual Markdown bytes.
  const latest = new Map(
    receipts.flatMap(({ commits: docs }) => docs.map((doc) => [key(doc), doc] as const)),
  );
  for (const doc of latest.values()) {
    const folder =
      doc.type === 'chapter' ? 'chapters' : doc.type === 'clue' ? 'foreshadowing' : 'subjects';
    const name = doc.type === 'outline' ? 'outline.md' : join(folder, `${doc.id}.md`);
    const bytes = await readFile(join(root, 'library', bookId, name));
    expect(doc.revision).toBe(savedDigest(bytes));
    expect((await api.read(doc)).revision).toBe(doc.revision);
  }
  return events;
}

for (const kind of ['subject', 'clue', 'outline', 'chapter'] as const) {
  test(`independent empty-book ${kind} generation over Harness IPC`, async ({}, info) => {
    const root = info.outputPath('app');
    const ref = { type: kind, id: kind === 'outline' ? 'outline' : `new-${kind}` };
    const prompt = {
      subject: '只新增一个主体：雾港的信使。',
      clue: '只新增一条伏笔，先不排期：信使总在潮汐前出现。',
      outline: '只写一份关于雾港信使的简短大纲。',
      chapter: '只写一个新章节，描写信使在雾港敲门。',
    }[kind];
    const body = {
      subject: '## 稳定设定\n信使熟悉雾港的潮路。',
      clue: '## 可见线索\n信使总在潮汐前出现。\n\n## 回收真相\n信使在为船员传递消息。',
      outline: '# 雾港\n\n信使在潮汐前敲门。',
      chapter: '信使在雾港敲了三下门。',
    }[kind];
    const catalog = blueprint({ ...ref, action: 'create', fields: { title: '雾港来信' } });
    const write =
      kind === 'outline'
        ? writeOutline(body)
        : kind === 'chapter'
          ? writeChapter(ref)
          : use('generate', 'book_generate_assets', {
              kind,
              action: 'create',
              targets: [
                {
                  id: ref.id,
                  fields:
                    kind === 'subject'
                      ? { name: '雾港信使', kind: 'character' }
                      : { title: '潮汐前的信使' },
                },
              ],
            });
    let bookId = '';
    const api = await harness(
      root,
      (wire, context) => {
        bookId = context.bookId;
        return sequenced(
          prompt,
          [
            step(
              find(
                kind === 'chapter'
                  ? 'book_apply_changes book_generate_chapter'
                  : kind === 'outline'
                    ? 'book_get_context book_apply_changes'
                    : write.name,
              ),
            ),
            ...(kind === 'outline' ? [step(readContext(outline))] : []),
            ...(kind === 'chapter'
              ? [step(scoped('catalog-scope', 'chapter.catalog', ref, prompt)), step(catalog)]
              : []),
            step(
              scoped(
                'write-scope',
                kind === 'chapter'
                  ? 'chapter.draft'
                  : kind === 'outline'
                    ? 'outline.write'
                    : `${kind}.create`,
                ref,
                prompt,
              ),
            ),
            step(write),
          ],
          (request) => {
            expect(JSON.stringify(request.messages)).toContain(ref.id);
            return kind === 'chapter'
              ? body
              : use('asset-result', 'submit_story_descriptions', { items: [{ id: ref.id, body }] });
          },
        )(wire, context);
      },
      undefined,
      false,
    );
    try {
      const before = await api.view();
      expect(
        before.documents.filter(({ type }) => ['chapter', 'subject', 'clue'].includes(type)),
      ).toHaveLength(0);
      const run = await api.submit(prompt);
      const calls: [Action, DocRef[]][] =
        kind === 'chapter'
          ? [
              [catalog, [ref]],
              [write, [ref]],
            ]
          : [[write, [ref]]];
      await expectLocalCommits(api, root, bookId, run, calls);
      const saved = await api.read(ref);
      expect(saved.body.trim()).toBe(body);
      if (kind === 'clue') {
        expect(saved.fields.setupChapterId).toBeUndefined();
        expect(saved.fields.payoffChapterId).toBeUndefined();
      }
      expect((await api.view()).documents.filter((doc) => key(doc) !== key(ref))).toEqual(
        before.documents.filter((doc) => key(doc) !== key(ref)),
      );
    } finally {
      await api.close();
    }
  });
}

for (const kind of ['subject', 'clue'] as const) {
  test(`a same-kind ${kind} batch uses each target's source paragraphs`, async ({}, info) => {
    const root = info.outputPath('app');
    const prompt =
      kind === 'subject'
        ? '新增两个主体：雾港船员和潮汐匠人。'
        : '新增两条伏笔：雾港船员和潮汐匠人各一条。';
    const rows = [
      { id: 'mist-sailor', label: '雾港船员', source: actor, marker: 'IPC_KEEPER_ONLY' },
      { id: 'tide-smith', label: '潮汐匠人', source: missing, marker: 'IPC_SMITH_ONLY' },
    ];
    const refs = rows.map(({ id }) => ({ type: kind, id }));
    const write = use('generate-batch', 'book_generate_assets', {
      kind,
      action: 'create',
      targets: rows.map(({ id, label, source }) => ({
        id,
        ...(kind === 'subject'
          ? { fields: { name: label, kind: 'character' }, relatedSubjectIds: [source.id] }
          : { fields: { title: label, subjectIds: [source.id] } }),
      })),
    });
    const body = (label: string, marker: string) =>
      kind === 'subject'
        ? `## 稳定设定\n${label}保管日记。${marker}`
        : `## 可见线索\n${label}收起日记。${marker}\n\n## 回收真相\n日记记录了归航日期。`;
    let revision: string;
    let bookId: string;
    const scenario = sequenced(
      prompt,
      [
        step(find(write.name)),
        step(
          enroll(
            'asset-scope',
            ...refs.map(({ id }) => ({ operation: `${kind}.create`, id, purpose: prompt })),
          ),
        ),
        step(write),
      ],
      ({ messages, system }) => {
        const request = messages.at(-1)?.content.at(-1)?.text ?? '';
        const data = JSON.parse(request.slice(request.indexOf('{'))) as {
          outline: {
            targetId: string;
            text: string;
            source: { id: string; revision: string; range: [number, number] };
          }[];
        };
        expect(system).toContain('按 targetId');
        expect(data.outline).toHaveLength(2);
        for (const row of rows) {
          const selected = data.outline.find(({ targetId }) => targetId === row.id);
          expect(selected?.source).toMatchObject({
            id: outline.id,
            revision,
            range: [expect.any(Number), expect.any(Number)],
          });
          expect(selected?.text).toContain(row.marker);
          expect(selected?.text).not.toContain(rows.find(({ id }) => id !== row.id)!.marker);
        }
        return use('assets-result', 'submit_story_descriptions', {
          items: rows.map(({ id, label, marker }) => ({ id, body: body(label, marker) })),
        });
      },
    );
    const api = await harness(root, (wire, context) => {
      bookId = context.bookId;
      return scenario(wire, context);
    });
    try {
      const old = await api.read(outline);
      await api.change([
        {
          ...old,
          expect: old.revision,
          body: rows
            .map(
              ({ label, source, marker }) => `${label}查看[关联卡](subjects/${source.id}.md)。${marker}`,
            )
            .join('\n\n'),
        },
      ]);
      revision = (await api.read(outline)).revision;
      const before = await api.view();
      const run = await api.submit(prompt);
      await expectLocalCommits(api, root, bookId!, run, [[write, refs]]);
      for (const row of rows) {
        const saved = await api.read({ type: kind, id: row.id });
        expect(saved.body).toContain(body(row.label, row.marker));
        if (kind === 'subject') expect(saved.body).toContain(`subjects/${row.source.id}.md`);
        else expect(saved.fields.subjectIds).toEqual([row.source.id]);
      }
      expect(
        (await api.view()).documents.filter((d) => !refs.some((ref) => key(d) === key(ref))),
      ).toEqual(before.documents);
    } finally {
      await api.close();
    }
  });
}

test('outline composition uses existing subject, clue and prose without guarding an unrelated card', async ({}, info) => {
  const root = info.outputPath('app');
  const prompt = '只更新大纲，参考现有档案员设定、报时钟和第二章。';
  const body =
    '# 新大纲\n\n[档案员](subjects/archivist.md)拿着[报时钟](foreshadowing/bell.md)回到[码头](chapters/ch-2.md)。';
  const write = writeOutline(body);
  let bookId: string;
  let sources: Manuscript[];
  const scenario = sequenced(prompt, [
    step(find('book_get_context book_apply_changes')),
    step(readContext(outline)),
    step(readContext(actor)),
    step(readContext(clue)),
    step(readContext(chapter(2))),
    step(scoped('outline-scope', 'outline.write', outline, prompt), async ({ messages }) => {
      const request = JSON.stringify(messages);
      for (const source of sources) expect(request).toContain(source.revision);
      for (const marker of ['ARCHIVIST_SETTING', 'CLUE_OLD_FIXTURE', 'OUTLINE_PROSE_SOURCE'])
        expect(request).toContain(marker);
      expect(request).not.toContain('UNRELATED_CARD');
      const unrelated = await api.read(missing);
      await api.change([{ ...unrelated, expect: unrelated.revision, body: 'UNRELATED_CARD_CHANGED' }]);
    }),
    step(write),
  ]);
  const api = await harness(root, (wire, context) => {
    bookId = context.bookId;
    return scenario(wire, context);
  });
  try {
    const subject = await api.read(actor);
    const prose = await api.read(chapter(2));
    await api.change([
      {
        ...subject,
        expect: subject.revision,
        body: '## 稳定设定\n档案员保管航海日记。ARCHIVIST_SETTING',
      },
      { ...prose, expect: prose.revision, body: '码头上响起钟声。OUTLINE_PROSE_SOURCE' },
    ]);
    sources = await Promise.all([actor, clue, chapter(2)].map(api.read));
    const run = await api.submit(prompt);
    await expectLocalCommits(api, root, bookId!, run, [[write, [outline]]]);
    expect((await api.read(outline)).body).toBe(body);
    expect((await api.read(missing)).body).toBe('UNRELATED_CARD_CHANGED');
    expect(await Promise.all([actor, clue, chapter(2)].map(api.read))).toEqual(sources);
  } finally {
    await api.close();
  }
});

test('chapter generation uses stage-safe material and the next call reuses committed prose', async ({}, info) => {
  const root = info.outputPath('app');
  const prompt = '只补第十一章和第十二章正文，不改现有资料。';
  const first = chapter(11);
  const second = chapter(12);
  const firstBody = '档案员摸到一只钟，写下编号。FIRST_CHAPTER_COMMITTED';
  const secondBody = '档案员认出了钟里的归航信号。SECOND_CHAPTER_COMMITTED';
  const dormant = { type: 'clue' as const, id: 'unanchored' };
  const distraction = { type: 'subject' as const, id: 'distant-person' };
  const a = writeChapter(first, { subjectIds: [missing.id], clueIds: [clue.id, dormant.id] });
  const b = writeChapter(second);
  let bookId: string;
  let dispatched = 0;
  const scenario = sequenced(
    prompt,
    [
      step(find(a.name)),
      step(
        enroll(
          'draft-scope',
          ...[first, second].map(({ id }) => ({ operation: 'chapter.draft', id, purpose: prompt })),
        ),
      ),
      step(a),
      step(b),
    ],
    async ({ messages, system }) => {
      const request = JSON.stringify(messages);
      expect(system).toContain('没有大纲、主体或伏笔也能');
      expect(request).not.toContain('DISTANT_UNRELATED');
      expect(request).not.toContain('UNSCHEDULED_SECRET');
      if (dispatched++ === 0) {
        expect(request).toContain('CHAPTER_PLAN');
        expect(request).toContain('PRIOR_PROSE');
        expect(request).toContain('CAST_SETTING');
        expect(request).toContain('CLUE_OLD_FIXTURE');
        expect(request).not.toContain('PAYOFF_SECRET');
        expect(request).not.toContain('FIRST_CHAPTER_COMMITTED');
        return firstBody;
      }
      const saved = await api.read(first);
      expect(saved.body).toBe(firstBody);
      expect(request).toContain('FIRST_CHAPTER_COMMITTED');
      expect(request).toContain(saved.revision);
      expect(request).toContain('PAYOFF_SECRET');
      return secondBody;
    },
  );
  const api = await harness(root, (wire, context) => {
    bookId = context.bookId;
    return scenario(wire, context);
  });
  try {
    const oldOutline = await api.read(outline);
    const subject = await api.read(actor);
    const oldClue = await api.read(clue);
    const previous = await api.read(chapter(10));
    await api.change([
      { ...first, expect: null, fields: { title: '第十一章', order: 11 }, body: '' },
      { ...second, expect: null, fields: { title: '第十二章', order: 12 }, body: '' },
      {
        ...oldOutline,
        expect: oldOutline.revision,
        body: '<!-- chapter:ch-11 -->\n\n档案员来到港口。CHAPTER_PLAN',
      },
      { ...subject, expect: subject.revision, body: '## 稳定设定\n档案员保管航海日记。CAST_SETTING' },
      {
        ...oldClue,
        expect: oldClue.revision,
        fields: {
          ...oldClue.fields,
          setupChapterId: first.id,
          payoffChapterId: second.id,
          subjectIds: [actor.id],
        },
        body: `## 可见线索\n${oldNote}\n\n## 回收真相\n归航信号藏在钟里。PAYOFF_SECRET`,
      },
      {
        ...previous,
        expect: previous.revision,
        body: previous.body + '\n\n水手在码头归档。PRIOR_PROSE',
      },
      {
        ...dormant,
        expect: null,
        fields: { title: '未编排的线索' },
        body: '## 可见线索\n码头有纸片。\n\n## 回收真相\n纸片写明来者身份。UNSCHEDULED_SECRET',
      },
      {
        ...distraction,
        expect: null,
        fields: { name: '远处的人', kind: 'character' },
        body: 'DISTANT_UNRELATED',
      },
    ]);
    const before = await api.view();
    const run = await api.submit(prompt);
    const events = await expectLocalCommits(api, root, bookId!, run, [
      [a, [first]],
      [b, [second]],
    ]);
    expect(dispatched).toBe(2);
    expect((await api.read(second)).body).toBe(secondBody);
    expect(
      (await api.view()).documents.filter((doc) => ![first.id, second.id].includes(doc.id)),
    ).toEqual(before.documents.filter((doc) => ![first.id, second.id].includes(doc.id)));
    const skills = events.filter(
      ({ event, fields }) => event === 'skill.applied' && fields.skill === 'write-chapter',
    );
    const writes = events.filter(({ event }) => event === 'workspace.document.committed');
    expect(skills).toHaveLength(2);
    for (let i = 0; i < skills.length; i++) {
      expect(skills[i].fields.callId).toBe(writes[i].fields.callId);
      expect(skills[i].logSeq).toBeLessThan(writes[i].logSeq);
      expect(
        events.some(
          ({ event, fields }) =>
            event === 'model.budget_dispatched' && fields.spanId === skills[i].fields.spanId,
        ),
      ).toBe(true);
    }
    expect(writes[0].logSeq).toBeLessThan(skills[1].logSeq);
  } finally {
    await api.close();
  }
});

for (const wholeRequest of [true, false]) {
  const prompt = wholeRequest ? '生成10章内容' : '只写第十章';
  test(`short writing intent over Harness IPC: ${prompt}`, async ({}, info) => {
    const last = chapter(10);
    const goalReply = Promise.withResolvers<void>();
    const draftScope = { operation: 'chapter.draft', id: last.id, purpose: '写第十章正文' };
    const draft = () => use('draft', 'book_generate_chapter', { chapterId: last.id, mode: 'draft' });
    const api = await harness(
      info.outputPath('app'),
      async (wire, { bookId }) => {
        const { id, text, result, tool } = turn(wire);
        if (tool === 'check_book_scope') {
          const { candidates, currentAuthor } = JSON.parse(text);
          expect(currentAuthor).toBe(prompt);
          expect(wire.system).toContain('「生成10章内容」）是整书交付');
          expect(wire.system).toContain('代替整书目标，拒绝该批候选');
          const isWhole = candidates[0]?.operation === 'novel.register';
          expect(candidates).toMatchObject([isWhole ? register(bookId) : draftScope]);
          return verdict(tool, isWhole === wholeRequest);
        }
        if (!wire.tools?.length) return generated;
        if (!id) {
          expect(text).toBe(prompt);
          expect(wire.system).toContain('「生成10章内容」');
          expect(wire.system).toContain('不要求作者说出「整书」或「完整小说」');
          expect(wire.system).toContain('只写第十章、只补指定的几章');
          return use('find', 'tool_search', { query: 'book_get_context book_generate_chapter' });
        }
        switch (id) {
          case 'find':
            // Replay the mistaken local proposal for the whole request, not a second classifier.
            return enroll('chapter-scope', draftScope);
          case 'chapter-scope':
            if (!wholeRequest) {
              expect(result.ok).toBe(true);
              return draft();
            }
            expect(result).toMatchObject({ ok: false, reason: 'invalid_options' });
            return enroll('whole-scope', register(bookId));
          case 'whole-scope':
            expect(result.value.next).toContain('novelGoal.register');
            return use('find-guide', 'skill_search', { query: prompt });
          case 'find-guide':
            expect(result.value.candidates[0]).toMatchObject({
              name: 'generate-novel',
              description: expect.stringContaining(prompt),
            });
            return guide();
          case 'guide':
            expect(result.value.instructions).toContain('「根据设定生成10章内容」');
            return goal();
          case 'goal':
            expect(result.value).toMatchObject({
              done: 9,
              total: 10,
              chapterIds,
              firstUnwritten: last.id,
            });
            await goalReply.promise;
            return draft();
          case 'draft':
            expect(result.ok, result.error).toBe(true);
            return '第十章已保存。';
          default:
            throw new Error('Unexpected fixture step: ' + id);
        }
      },
      '',
    );
    try {
      const before = (await api.view()).documents.filter(({ id }) => id !== last.id);
      const runId = await api.start(prompt);
      const panel = await api.openHarness(prompt);
      const status = panel.getByRole('status');
      if (wholeRequest) {
        await expect.poll(api.currentRun).toMatchObject({
          id: runId,
          status: 'running',
          progress: { done: 9, total: 10, complete: false },
        });
        await expect(panel.getByText('book_get_context · 已完成', { exact: true })).toHaveCount(1);
        await expect(status).toHaveText(/^运行中/u);
        await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible();
        await expect(panel.locator('.writing-progress')).toHaveCount(0);
      }
      goalReply.resolve();
      const run = await api.finish(runId);
      const final = wholeRequest ? 10 : 1;
      expect(run).toMatchObject({
        status: 'completed',
        taskOutcome: 'fulfilled',
        progress: { done: final, total: final, complete: true },
      });
      await expect(status).toContainText('已完成');
      await expect(status).not.toContainText(/\d+\s*\/\s*\d+/u);
      await expect(panel.locator('.writing-progress')).toHaveCount(0);
      const saved = await api.read(last);
      expect(saved.body).toBe(generated);
      expect((await api.view()).documents.filter(({ id }) => id !== last.id)).toEqual(before);
      expect((await api.receipts(run)).filter(({ commitCount }) => commitCount)).toMatchObject([
        {
          callRef: callRef('draft'),
          commits: [{ ...last, operation: 'write', revision: saved.revision }],
        },
      ]);
      const rows = await api.events(run);
      const commits = rows.filter(({ event }) => event === 'workspace.document.committed');
      const goals = rows.filter(({ event }) => event === 'novel.goal');
      expect(commits).toHaveLength(1);
      expect(
        rows.filter(({ event }) => event === 'writing.task_scope').map(({ fields }) => fields.outcome),
      ).toEqual(wholeRequest ? ['failed', 'ok'] : ['ok']);
      if (wholeRequest) {
        expect(goals).toMatchObject([{ fields: { operation: 'register', outcome: 'ok', total: 10 } }]);
        expect(goals[0].logSeq).toBeLessThan(commits[0].logSeq);
      } else {
        expect(goals).toEqual([]);
        expect(
          rows.some(
            ({ event, fields }) => event === 'skill.applied' && fields.skill === 'generate-novel',
          ),
        ).toBe(false);
      }
    } finally {
      goalReply.resolve();
      await api.close();
    }
  });
}

test('loading a whole-book guide cannot turn adding chapter eleven into a whole-book delivery', async ({}, info) => {
  let local = false;
  const root = info.outputPath('app');
  const api = await harness(root, (wire, { bookId }) => {
    const { id, text, result, tool } = turn(wire);
    if (tool === 'check_book_scope') {
      const { candidates, currentAuthor, savedWholeGoal } = JSON.parse(text);
      const isWhole = candidates.some((item: { operation: string }) =>
        item.operation.startsWith('novel.'),
      );
      if (local && isWhole) {
        expect(wire.system).toContain('只补指定一章');
        expect(currentAuthor).toBe(single);
        if (candidates[0].operation === 'novel.resume') expect(savedWholeGoal.chapterCount).toBe(10);
      }
      return verdict(tool, !local || !isWhole);
    }
    if (!wire.tools?.length) {
      expect(local).toBe(true);
      expect(wire.max_tokens).toBe(8192);
      expect(text).not.toContain('WHOLE_DIRECTION_FIXTURE');
      return generated;
    }
    if (!id)
      return use('find', 'tool_search', {
        query: 'book_get_context book_apply_changes book_generate_chapter',
      });
    switch (id) {
      case 'find':
        return local ? guide() : enroll('whole-scope', register(bookId));
      case 'whole-scope':
        return guide();
      case 'guide':
        expect(result.value.name).toBe('generate-novel');
        expect(wire.max_tokens).toBe(local ? 8192 : 24_000);
        return local ? enroll('wrong-register', { ...register(bookId), count: 11 }) : goal([missing]);
      case 'goal':
        expect(result.value).toMatchObject({
          done: 10,
          total: 10,
          complete: false,
          missingAssetRefs: [missing],
        });
        return '还有一项整书资料缺失。';
      case 'wrong-register':
        expect(result).toMatchObject({ ok: false, reason: 'invalid_options' });
        return enroll('wrong-resume', {
          operation: 'novel.resume',
          id: bookId,
          purpose: '擅自接手旧整书',
        });
      case 'wrong-resume':
        expect(result).toMatchObject({ ok: false, reason: 'invalid_options' });
        return use('wrong-goal', 'book_get_context', { novelGoal: { action: 'resume' } });
      case 'wrong-goal':
        expect(result).toMatchObject({ ok: false, reason: 'invalid_options' });
        return enroll(
          'early-draft-scope',
          { operation: 'chapter.catalog', id: chapter(11).id, purpose: '建立第十一章目录' },
          { operation: 'chapter.draft', id: chapter(11).id, purpose: '过早登记第十一章正文' },
        );
      case 'early-draft-scope':
        expect(result).toMatchObject({
          ok: false,
          reason: 'missing',
          error: expect.stringMatching(/ch-11.*chapter\.catalog.*book_apply_changes.*chapter\.draft/u),
        });
        return use('early-catalog', 'book_apply_changes', {
          operations: [{ ...chapter(11), action: 'create', fields: { title: '第十一章', order: 11 } }],
        });
      case 'early-catalog':
        expect(result).toMatchObject({ ok: false, reason: 'invalid_options' });
        return enroll(
          'local-scope',
          { operation: 'chapter.catalog', id: chapter(11).id, purpose: '建立第十一章目录' },
          { operation: 'outline.write', id: outline.id, purpose: '补充第十一章大纲' },
        );
      case 'local-scope':
        return use('read-assets', 'book_get_context', { includeBodies: true });
      case 'read-assets':
        return blueprint(
          { ...chapter(11), action: 'create', fields: { title: '第十一章', order: 11 } },
          {
            ...outline,
            action: 'update',
            body: outlineBody + '\n\n<!-- chapter:ch-11 -->\n返航后归档日记。',
          },
        );
      case 'apply':
        expect(result.ok, result.error).toBe(true);
        return enroll('draft-scope', {
          operation: 'chapter.draft',
          id: chapter(11).id,
          purpose: '只写第十一章正文',
        });
      case 'draft-scope':
        return use('draft', 'book_generate_chapter', { chapterId: chapter(11).id, mode: 'draft' });
      case 'draft':
        expect(result.ok, result.error).toBe(true);
        return '仅补了第十一章和大纲。';
      default:
        throw new Error('Unexpected fixture step: ' + id);
    }
  });
  try {
    const old = (await api.view()).documents;
    const previous = await api.submit(whole);
    expect(previous).toMatchObject({
      status: 'failed',
      taskOutcome: 'partial',
      progress: { done: 10, total: 10, complete: false },
      error: expect.stringContaining('subject/extra'),
    });
    const goals = async () =>
      (await api.journal()).filter((row) => 'novelTask' in row).map(({ novelTask }) => novelTask);
    const saved = await goals();
    expect(saved).toHaveLength(1);
    local = true;
    const result = await api.submit(single);
    expect(result).toMatchObject({
      status: 'completed',
      taskOutcome: 'fulfilled',
      progress: { done: 3, total: 3, complete: true },
    });
    expect(await goals()).toEqual(saved);
    expect(
      (await api.view()).documents.filter(({ id }) => id !== chapter(11).id && id !== outline.id),
    ).toEqual(old.filter(({ id }) => id !== outline.id));
    expect((await api.read(chapter(11))).body).toBe(generated);
    expect((await api.read(outline)).body).toContain('<!-- chapter:ch-11 -->');
    const allReceipts = await api.receipts(result);
    expect(allReceipts.find((row) => row.callRef === callRef('early-draft-scope'))).toMatchObject({
      reason: 'missing',
      commitCount: 0,
    });
    expect(allReceipts.find((row) => row.callRef === callRef('early-catalog'))).toMatchObject({
      reason: 'invalid_options',
      commitCount: 0,
    });
    const receipts = allReceipts.filter(({ commitCount }) => commitCount);
    expect(receipts.map(({ tool, commitCount }) => [tool, commitCount])).toEqual([
      ['book_apply_changes', 2],
      ['book_generate_chapter', 1],
    ]);
    const events = await api.events(result);
    expect(events.filter(({ event }) => event === 'novel.goal')).toHaveLength(0);
    expect(
      events.filter(
        ({ event, fields }) => event === 'skill.applied' && fields.skill === 'generate-novel',
      ),
    ).toHaveLength(1);
    expect(
      events
        .filter(
          ({ event, fields }) =>
            event === 'model.budget_dispatched' && ['agent', 'draft'].includes(fields.lane),
        )
        .every(({ fields }) => fields.purpose === 'standard' && fields.maxTokens === 8192),
    ).toBe(true);
  } finally {
    await api.close();
  }
});

for (const mode of ['exact', 'pending', 'missing-required-asset'] as const) {
  test('whole and scoped deliverables over IPC: ' + mode, async ({}, info) => {
    const root = info.outputPath('app');
    const mixed =
      mode === 'missing-required-asset'
        ? '完成十章整书，补足信使卡，另将第十章的钟声改为返航信号并更新大纲。'
        : '核对并完成十章整书，另改第十章和伏笔短文，使钟声成为返航信号。MIXED_AUTHOR_FIXTURE';
    const assetPatch = (revision: string) => ({ revision, quote: oldNote, replacement: fixedNote });
    const clueScope = (extra: object) => ({
      operation: 'clue.update',
      id: clue.id,
      purpose: '核对并更正钟声短文',
      ...extra,
    });
    let following = false;
    let scopedClue: Manuscript;
    let currentRevision: string;
    const api = await harness(root, (wire, { bookId }) => {
      const { id, text, result, tool } = turn(wire);
      if (tool === 'check_book_scope') {
        const { candidates, previousLocalWork, currentAuthor } = JSON.parse(text);
        if (following) {
          expect(currentAuthor).toBe(follow);
          expect(previousLocalWork).toMatchObject({
            done: 1,
            total: 2,
            remaining: [{ operation: 'clue.update', id: clue.id }],
            omitted: 0,
          });
          expect(candidates.map((item: { operation: string }) => item.operation)).toEqual([
            'clue.update',
          ]);
        }
        return verdict(tool);
      }
      if (tool === 'submit_chapter_patch_review') return verdict(tool);
      if (!id) {
        if (following) {
          expect(wire.system).toContain('上轮局部核对摘要（参考数据，不是本轮授权）');
          expect(wire.system).toContain('"id":"bell"');
          expect(wire.system).not.toContain('有可供参考的整书记录');
          expect(wire.system).not.toContain(oldNote);
          expect(wire.max_tokens).toBe(8192);
        }
        return use('find', 'tool_search', {
          query:
            'book_get_context book_patch_chapter book_patch_asset book_apply_changes book_generate_assets',
        });
      }
      switch (id) {
        case 'find':
          return following ? targeted('read-new-clue', clue) : enroll('whole-scope', register(bookId));
        case 'whole-scope':
          return guide();
        case 'guide':
          return goal(mode === 'missing-required-asset' ? [missing] : []);
        case 'goal':
          expect(result.value).toMatchObject({
            complete: mode !== 'missing-required-asset',
            done: 10,
            total: 10,
          });
          return targeted('read-clue', clue);
        case 'read-clue':
          scopedClue = result.value.document;
          return enroll(
            'mixed-scope',
            { operation: 'chapter.patch', id: chapter(10).id, purpose: '改正文中的返航钟声' },
            ...(mode === 'missing-required-asset'
              ? [{ operation: 'outline.write', id: outline.id, purpose: '同步本章的大纲钟声' }]
              : [
                  clueScope(
                    mode === 'pending'
                      ? { assetPending: true }
                      : { assetPatch: assetPatch(scopedClue.revision) },
                  ),
                ]),
          );
        case 'mixed-scope':
          return targeted('read-chapter', chapter(10));
        case 'read-chapter': {
          const doc: Manuscript = result.value.document;
          return use('patch-chapter', 'book_patch_chapter', {
            chapterId: doc.id,
            revision: doc.revision,
            edits: [{ quote: oldProse, replacement: fixedProse }],
          });
        }
        case 'patch-chapter':
          expect(result.ok, result.error).toBe(true);
          if (mode === 'missing-required-asset')
            return use('read-assets', 'book_get_context', { includeBodies: true });
          return use('blocked-patch', 'book_patch_asset', {
            kind: 'clue',
            id: clue.id,
            ...assetPatch(scopedClue.revision),
          });
        case 'blocked-patch':
          expect(result).toMatchObject({ ok: false, reason: 'patch_not_authorized' });
          return use('no-full-update', 'book_generate_assets', {
            kind: 'clue',
            action: 'update',
            targets: [{ id: clue.id }],
          });
        case 'no-full-update':
          expect(result).toMatchObject({ ok: false, reason: 'asset_update_route' });
          return use('read-assets', 'book_get_context', { includeBodies: true });
        case 'read-assets':
          return mode === 'missing-required-asset'
            ? blueprint({
                ...outline,
                action: 'update',
                body: outlineBody + '\n港口用钟声迎接归航的船员。',
              })
            : blueprint({ ...clue, action: 'update', fields: { title: '港口钟声' } });
        case 'apply':
          expect(result.ok, result.error).toBe(true);
          return use('check', 'book_get_context', { novelGoal: { action: 'check' } });
        case 'check':
          expect(result.value.complete).toBe(mode !== 'missing-required-asset');
          return '都处理完了。';
        case 'read-new-clue':
          expect(result.value.document.revision).not.toBe(scopedClue.revision);
          currentRevision = result.value.document.revision;
          return enroll('stale-scope', clueScope({ assetPatch: assetPatch(scopedClue.revision) }));
        case 'stale-scope':
          expect(result).toMatchObject({ ok: false, reason: 'conflict' });
          return enroll('current-scope', clueScope({ assetPatch: assetPatch(currentRevision) }));
        case 'current-scope':
          expect(result.ok, result.error).toBe(true);
          return use('follow-patch', 'book_patch_asset', {
            kind: 'clue',
            id: clue.id,
            ...assetPatch(currentRevision),
          });
        case 'follow-patch':
          expect(result.ok, result.error).toBe(true);
          return '只处理了剩余的伏笔短文。';
        default:
          throw new Error('Unexpected fixture step: ' + id);
      }
    });
    try {
      const before = await api.read(clue);
      const result = await api.submit(mixed);
      const savedChapter = await api.read(chapter(10));
      expect(savedChapter.body).toBe(fixedProse + chapterTail);
      const scope = await api.receipts(result);
      expect(scope.find(({ callRef: ref }) => ref === callRef('patch-chapter'))?.commits).toEqual([
        { ...chapter(10), operation: 'write', revision: savedChapter.revision },
      ]);
      const events = await api.events(result);
      const logged = (name: string) =>
        events.filter(({ event }) => event === name).map(({ fields }) => fields);
      const goalStates = (await api.journal()).filter((row) => 'novelTask' in row);
      const panel = await api.openHarness(mixed);
      const status = panel.getByRole('status');
      if (mode === 'missing-required-asset') {
        expect(result).toMatchObject({
          status: 'failed',
          taskOutcome: 'partial',
          error: expect.stringContaining('subject/extra'),
          progress: {
            complete: false,
            whole: {
              complete: false,
              chapters: { done: 10, total: 10 },
              message: expect.stringContaining('subject/extra'),
            },
            local: { done: 2, total: 2, remaining: [] },
          },
        });
        await expect(status).toContainText('失败');
        await expect(status).toContainText('局部事项已满足');
        await expect(status).toContainText('整书未完成');
        await expect(status).toContainText('subject/extra');
        await expect(status).not.toContainText(/\d+\s*\/\s*\d+/u);
        await expect(panel.locator('.writing-progress')).toHaveCount(0);
        await expect(panel.getByLabel('诊断编号')).toHaveText(result.id);
        expect(goalStates.at(-1)?.novelTask).toBeTruthy();
        expect(await api.read(clue)).toEqual(before);
        return;
      }
      const summary = {
        done: 1,
        total: 2,
        remaining: [
          { operation: 'clue.update', id: clue.id, assetMode: mode === 'exact' ? 'patch' : 'pending' },
        ],
        omitted: 0,
      };
      expect(result).toMatchObject({
        status: 'completed',
        taskOutcome: 'partial',
        progress: {
          complete: false,
          whole: { complete: true, chapters: { done: 10, total: 10 } },
          local: summary,
        },
      });
      await expect(status).toContainText('部分完成');
      await expect(status).toContainText('整书已齐');
      await expect(status).toContainText('clue.update/bell');
      await expect(status).not.toContainText(/\d+\s*\/\s*\d+/u);
      await expect(panel.locator('.writing-progress')).toHaveCount(0);
      expect(goalStates.at(-1)?.novelTask).toBeNull();
      expect(scope.find(({ callRef: ref }) => ref === callRef('blocked-patch'))).toMatchObject({
        tool: 'book_patch_asset',
        reason: 'patch_not_authorized',
        commitCount: 0,
        commits: [],
      });
      expect(scope.find(({ callRef: ref }) => ref === callRef('no-full-update'))).toMatchObject({
        reason: 'asset_update_route',
        commitCount: 0,
      });
      const card = await api.read(clue);
      expect(card.body).toBe(before.body);
      expect(card.revision).not.toBe(before.revision);
      expect(scope.find(({ callRef: ref }) => ref === callRef('apply'))?.commits).toEqual([
        { ...clue, operation: 'write', revision: card.revision },
      ]);
      expect(logged('writing.task_result')).toContainEqual(
        expect.objectContaining({ count: 2, done: 1, outcome: 'partial' }),
      );
      const [rejected] = logged('asset.patch.finished');
      const commits = logged('workspace.document.committed');
      expect(rejected).toMatchObject({
        outcome: 'failed',
        reason: 'patch_not_authorized',
        callId: expect.any(String),
      });
      expect(commits).toHaveLength(2);
      expect(commits.some(({ callId }) => callId === rejected.callId)).toBe(false);
      expect(commits[0]).toMatchObject({
        docType: 'chapter',
        callId: logged('chapter.patch.review')[0].callId,
      });
      expect(commits[1]).toMatchObject({
        docType: 'clue',
        callId: logged('tool.finished').find(({ tool }) => tool === 'book_apply_changes')?.callId,
      });
      if (mode === 'pending') return;

      await api.restart();
      following = true;
      const finished = await api.submit(follow);
      expect(finished).toMatchObject({
        status: 'completed',
        taskOutcome: 'fulfilled',
        progress: { done: 1, total: 1, complete: true },
      });
      expect(await api.read(chapter(10))).toEqual(savedChapter);
      const saved = await api.read(clue);
      expect(saved.body).toBe(before.body.replace(oldNote, fixedNote));
      const later = await api.receipts(finished);
      expect(later.find(({ callRef: ref }) => ref === callRef('stale-scope'))).toMatchObject({
        reason: 'conflict',
        commitCount: 0,
      });
      expect(later.filter(({ commitCount }) => commitCount).map(({ commits }) => commits)).toEqual([
        [{ ...clue, operation: 'write', revision: saved.revision }],
      ]);
      const novelRows = (await api.journal()).filter((row) => 'novelTask' in row);
      expect(novelRows.map(({ novelTask }) => novelTask)).toEqual(
        goalStates.map(({ novelTask }) => novelTask),
      );
      expect((await api.events(finished)).filter(({ event }) => event === 'novel.goal')).toHaveLength(0);
      const diagnostics = await diagnosticText(root, 'backend');
      for (const secret of [
        mixed,
        follow,
        oldNote,
        fixedNote,
        oldProse,
        fixedProse,
        'AUTHOR_FIXTURE',
        'CLUE_OLD_FIXTURE',
        'CLUE_NEW_FIXTURE',
      ])
        expect(diagnostics).not.toContain(secret);
      const disk = join(api.session.cwd, 'foreshadowing', 'bell.md');
      expect(
        createHash('sha256')
          .update(await readFile(disk))
          .digest('hex'),
      ).toBe(saved.revision);
    } finally {
      await api.close();
    }
  });
}
