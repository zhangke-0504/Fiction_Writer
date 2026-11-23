import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { diagnosticText, readDiagnostics } from './diagnostic-files';
import type { BookView, Manuscript, RuntimeView, WriteReport } from '../../shared/contracts';

const odyssey = '将希腊神话故事奥德赛写成小说，大概写10章左右。记得生成主体，伏笔和大纲和章节正文';
const discussion = '先聊聊怎么把《奥德赛》改编成十章小说，别写文件';
const faultPrompt = '写4章完整小说，包括大纲、主体、伏笔和正文。保留第一人称航海日记的形式。';
const apiKey = 'synthetic-writing-key-only';
const searchQuery = '整本小说 伏笔 SEARCH_QUERY_FIXTURE';
const unfinished = '未完成流，内容仅用于预览，不能进入磁盘正文 UNFINISHED_PROSE_FIXTURE。';
const title = (order: number) => `航程 ${order}`;
const id = (order: number) => `odyssey-fixture-${order}`;
const chapterBody = (order: number) =>
  `我从海上认出了故乡的群山。这是第 ${order} 章完整正文的测试句，记录了这一段旅程。`;
type Fault = 'incomplete_stream' | 'output_limit';
type RequestBody = {
  system: string;
  tools?: { name: string }[];
  messages: {
    role: string;
    content: { type: string; text?: string; content?: string; tool_use_id?: string }[];
  }[];
};
function startStream(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  return (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function terminal(send: ReturnType<typeof startStream>, res: ServerResponse, reason: string) {
  send({ type: 'message_delta', delta: { stop_reason: reason } });
  send({ type: 'message_stop' });
  res.end();
}
async function fixture(mode: 'full' | 'single' | Fault) {
  const count = mode === 'full' ? 10 : mode === 'single' ? 3 : 4;
  const chapterIds = Array.from({ length: count }, (_, i) => id(i + 1));
  const calls: string[] = [],
    drafts: number[] = [],
    errors: string[] = [];
  let resumed = false,
    hold = mode !== 'full';
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const clue = {
    type: 'clue',
    action: 'create',
    id: 'hint-troy-embers',
    fields: {
      title: '航途暗号',
      subjectIds: ['hero-fixture'],
      setupChapterId: id(1),
      payoffChapterId: id(count),
    },
    body: '用灰烬留下暗号，最终辨认出回家的航道。',
  };
  const server = createServer(async (req, res) => {
    try {
      const raw: Buffer[] = [];
      for await (const chunk of req) raw.push(chunk);
      const body = JSON.parse(Buffer.concat(raw).toString()) as RequestBody;
      expect(req.url).toBe('/v1/messages');
      expect(req.headers['x-api-key']).toBe(apiKey);
      const reply = (value: string) => {
        const send = startStream(res);
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: value } });
        send({ type: 'content_block_stop', index: 0 });
        terminal(send, res, 'end_turn');
      };
      const use = (name: string, marker: string, input: object) => {
        expect(body.tools?.map((tool) => tool.name)).toContain(name);
        calls.push(`${name}:${marker}`);
        const send = startStream(res);
        send({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: marker, name, input: {} },
        });
        const args = JSON.stringify(input);
        const split = Math.floor(args.length / 2);
        for (const partial_json of [args.slice(0, split), args.slice(split)])
          send({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json },
          });
        send({ type: 'content_block_stop', index: 0 });
        terminal(send, res, 'tool_use');
      };
      const generate = (order: number, marker = `draft-${order}`) =>
        use('book_generate_chapter', marker, {
          chapterId: id(order),
          mode: 'draft',
          direction: `完成航程 ${order}。`,
        });
      const last = body.messages.at(-1)?.content.at(-1);
      if (!body.tools?.length) {
        const order = Number(
          /"target":\s*\{\s*"id":\s*"odyssey-fixture-(\d+)"/.exec(last?.text ?? '')?.[1],
        );
        expect(order).toBeGreaterThan(0);
        expect(body.system).toContain('中文 Markdown 正文');
        drafts.push(order);
        if (resumed && mode !== 'single') expect(last?.text).toContain(faultPrompt);
        if (order === 3 && !resumed && mode !== 'full') {
          const send = startStream(res);
          send({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: unfinished },
          });
          if (hold) await gate;
          if (res.destroyed) return;
          send({ type: 'content_block_stop', index: 0 });
          if (mode === 'output_limit') terminal(send, res, 'max_tokens');
          else res.end();
          return;
        }
        return reply(chapterBody(order));
      }
      if (last?.type !== 'tool_result') {
        if (last?.text === discussion) return reply('先构思归乡与身份的冲突，不写文件。');
        if (mode === 'single') {
          expect(last?.text).toBe('只写第三章');
          return generate(3);
        }
        expect(last?.text).toBe(resumed ? '接着写完' : mode === 'full' ? odyssey : faultPrompt);
        expect(body.system).toContain('skill_search');
        if (resumed) expect(body.system).toContain('有可供作者明确续接的整书记录');
        return use('skill_search', 'search', { query: searchQuery });
      }
      const result = JSON.parse(last.content!);
      const marker = last.tool_use_id!;
      if (marker === 'search') {
        expect(result.value.candidates[0].name).toBe('generate-novel');
        expect(result.value.candidates[0].instructions).toBeUndefined();
        return use('skill_load', 'load', { name: 'generate-novel' });
      }
      if (marker === 'load') {
        expect(result.value.instructions).toContain('交付目标');
        return resumed
          ? use('book_get_context', 'resume', { novelGoal: { action: 'resume' } })
          : use('book_get_context', 'initial-read', {});
      }
      if (marker === 'resume') {
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
          originalDirection: faultPrompt,
          done: 2,
          firstUnwritten: id(3),
          lastFailedChapterId: id(3),
        });
        return generate(3);
      }
      if (marker === 'initial-read') {
        expect(result.value.documents.filter((doc: Manuscript) => doc.type === 'chapter')).toHaveLength(
          0,
        );
        return use('book_get_context', 'register', { novelGoal: { action: 'register', chapterIds } });
      }
      if (marker === 'register') {
        expect(result.value).toMatchObject({ chapterIds, done: 0, complete: false });
        return use('book_apply_changes', 'foundation', {
          operations: [
            {
              type: 'outline',
              action: 'update',
              id: 'outline',
              body: '归乡者用暗号辨认航道。\n\n<!-- beat:actual-departure -->',
            },
            {
              type: 'subject',
              action: 'create',
              id: 'hero-fixture',
              fields: { name: '归乡者', kind: 'character' },
              body: '从远方返乡。',
            },
            ...chapterIds.map((id, i) => ({
              type: 'chapter',
              action: 'create',
              id,
              fields: { title: title(i + 1), order: i + 1 },
            })),
          ],
        });
      }
      if (marker === 'foundation') {
        expect(result.ok).toBe(true);
        return use('book_get_context', 'read-foundation', {});
      }
      if (marker === 'read-foundation') {
        expect(result.value.documents.filter((doc: Manuscript) => doc.type === 'chapter')).toHaveLength(
          count,
        );
        if (mode !== 'full') return use('book_apply_changes', 'clue', { operations: [clue] });
        return use('book_apply_changes', 'invalid-beat', {
          operations: [
            {
              ...clue,
              fields: {
                ...clue.fields,
                setupChapterId: null,
                setupBeatId: 'beat-departure',
              },
            },
          ],
        });
      }
      if (marker === 'invalid-beat') {
        expect(result).toMatchObject({
          ok: false,
          reason: 'invalid_references',
          value: {
            committed: [],
            pending: [{ type: 'clue', id: 'hint-troy-embers' }],
            invalidReferences: [
              { field: 'setupBeatId', target: { type: 'beat', id: 'beat-departure' } },
            ],
          },
        });
        return use('book_get_context', 'chapter-ids', { index: 'chapters' });
      }
      if (marker === 'chapter-ids') {
        expect(result.value.rows.map((row: { id: string }) => row.id)).toEqual(chapterIds);
        return use('book_apply_changes', 'clue', { operations: [clue] });
      }
      if (marker === 'clue') {
        expect(result.ok).toBe(true);
        return generate(1);
      }
      if (marker === 'cannot-skip') {
        expect(result).toMatchObject({ ok: false, reason: 'novel_goal_conflict' });
        return reply('第三章未保存，后续还没写。');
      }
      if (marker.startsWith('draft-')) {
        const order = Number(marker.slice(6));
        if (mode === 'single') {
          expect(result.ok).toBe(true);
          return reply('只保存了第三章。');
        }
        if (order === 3 && !resumed && mode !== 'full') {
          expect(result).toMatchObject({ ok: false, reason: mode });
          return generate(4, 'cannot-skip');
        }
        expect(result.ok).toBe(true);
        if (order < count) return generate(order + 1);
        return use('book_get_context', 'check', { novelGoal: { action: 'check' } });
      }
      if (marker === 'check') {
        expect(result.value).toMatchObject({ done: count, total: count, complete: true });
        return reply('全书正文与资料已保存。');
      }
      throw new Error(`Unexpected synthetic tool result: ${marker}`);
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    chapterIds,
    calls,
    drafts,
    errors,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    unblock() {
      hold = false;
      unblock();
    },
    resume() {
      resumed = true;
      hold = false;
      unblock();
    },
    async close() {
      unblock();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Harness 面板' });
const launch = (root: string) =>
  electron.launch({ args: ['.'], env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root } });
async function setup(page: Page, baseUrl: string) {
  await rpc(page, 'profiles.save', {
    name: '合成夹具',
    apiKey,
    baseUrl,
    model: 'fixture',
    protocol: 'messages',
  });
  const book = await rpc<{ id: string }>(page, 'book.create', {
    title: '奥德赛',
    summary: '改编希腊神话。',
  });
  return book.id;
}
async function openBook(page: Page) {
  await button(page, '编辑 奥德赛').click();
}
async function openComposer(page: Page, resume = false) {
  await button(page, 'Harness').click();
  if (resume)
    await panel(page)
      .getByRole('button', { name: /奥德赛/ })
      .filter({ hasText: '奥德赛' })
      .first()
      .click();
  else await panel(page).getByRole('button', { name: '当前小说会话', exact: true }).click();
  await expect(panel(page).getByLabel('写作动作')).toHaveCount(0);
}
async function send(page: Page, text: string) {
  await panel(page).getByLabel('给 Agent 的消息').fill(text);
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
}
const read = (page: Page, bookId: string, chapterId: string) =>
  rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: { type: 'chapter', id: chapterId } });
const status = async (page: Page, bookId: string) =>
  (await rpc<RuntimeView>(page, 'runtime.snapshot')).sessions.find(
    (item) => item.session.bookId === bookId,
  )?.run;
const files = (page: Page, bookId: string) => rpc<BookView>(page, 'book.read', { bookId });

async function safeDiaries(root: string) {
  for (const lane of ['frontend', 'backend'] as const) {
    const text = await diagnosticText(root, lane);
    for (const hidden of [
      apiKey,
      originalPromptMarker,
      searchQuery,
      unfinished,
      'hint-troy-embers',
      'beat-departure',
      id(3),
      chapterBody(1),
    ])
      expect(text).not.toContain(hidden);
  }
}
const originalPromptMarker = '第一人称航海日记';

test('one natural-language send finds the whole novel skill and saves the Odyssey in ten chapters', async ({}, info) => {
  const root = info.outputPath('app');
  const mock = await fixture('full');
  let app: ElectronApplication | undefined;
  try {
    app = await launch(root);
    const page = await app.firstWindow();
    const bookId = await setup(page, mock.baseUrl);
    await openBook(page);
    await openComposer(page);
    await send(page, odyssey);
    await expect.poll(async () => (await status(page, bookId))?.status).toBe('completed');
    expect(await status(page, bookId)).toMatchObject({
      progress: { done: 10, total: 10, complete: true },
    });
    const view = await files(page, bookId);
    expect(view.diagnostics).toEqual([]);
    expect(view.documents.filter((doc) => doc.type === 'chapter').map((doc) => doc.id)).toEqual(
      mock.chapterIds,
    );
    expect(view.documents.some((doc) => doc.type === 'subject')).toBe(true);
    const readDoc = (type: 'outline' | 'clue', id: string) =>
      rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: { type, id } });
    expect((await readDoc('outline', 'outline')).body.trim()).toContain('归乡者');
    expect((await readDoc('clue', 'hint-troy-embers')).fields).toMatchObject({
      setupChapterId: id(1),
      payoffChapterId: id(10),
    });
    for (const [index, chapterId] of mock.chapterIds.entries())
      expect((await read(page, bookId, chapterId)).body).toBe(chapterBody(index + 1));
    expect(mock.calls.slice(0, 2)).toEqual(['skill_search:search', 'skill_load:load']);
    expect(mock.drafts).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    const calls = [...mock.calls];
    const prior = (await status(page, bookId))!.id;
    await send(page, discussion);
    await expect(
      panel(page).getByText('先构思归乡与身份的冲突，不写文件。', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const run = await status(page, bookId);
        return run?.id !== prior && run?.status;
      })
      .toBe('completed');
    expect(await files(page, bookId)).toEqual(view);
    expect(mock.calls).toEqual(calls);
    expect(mock.errors).toEqual([]);
    await expect
      .poll(
        async () =>
          (await readDiagnostics(root, 'backend')).filter((e) => e.event === 'run.finished').length,
      )
      .toBe(2);
    const events = (await readDiagnostics(root, 'backend')).filter((e) => e.fields.runId === prior);
    expect(events.some((e) => e.event === 'skill.search' && e.fields.candidates > 0)).toBe(true);
    expect(
      events.some((e) => e.event === 'tool.finished' && e.fields.reason === 'invalid_references'),
    ).toBe(true);
    expect(
      events.filter((e) => e.event === 'skill.applied' && e.fields.skill === 'generate-novel'),
    ).toHaveLength(1);
    expect(
      events.filter((e) => e.event === 'chapter.generation.finished' && e.fields.outcome === 'ok'),
    ).toHaveLength(10);
    await safeDiaries(root);
  } finally {
    await app?.close().catch(() => {});
    await mock.close();
  }
});

for (const fault of ['incomplete_stream', 'output_limit'] as const) {
  test(`chapter three ${fault} does not commit; the same natural-language session resumes it`, async ({}, info) => {
    const root = info.outputPath('app');
    const mock = await fixture(fault);
    let app: ElectronApplication | undefined;
    try {
      app = await launch(root);
      let page = await app.firstWindow();
      const bookId = await setup(page, mock.baseUrl);
      await openBook(page);
      await openComposer(page);
      await send(page, faultPrompt);
      await expect.poll(async () => (await status(page, bookId))?.preview?.chapterId).toBe(id(3));
      await button(page, title(3)).click();
      await expect(page.getByLabel('Markdown 编辑器')).toContainText('UNFINISHED_PROSE_FIXTURE');
      expect((await read(page, bookId, id(3))).body).toBe('');
      if (fault === 'incomplete_stream') {
        await button(page, '返回书库').click();
        await openBook(page);
        await button(page, title(3)).click();
        await expect(page.getByLabel('Markdown 编辑器')).toContainText('UNFINISHED_PROSE_FIXTURE');
      }
      mock.unblock();
      await expect.poll(async () => (await status(page, bookId))?.status).toBe('failed');
      const failed = (await status(page, bookId))!;
      expect(failed.error).toMatch(fault === 'output_limit' ? /长度上限/ : /输出中断/);
      expect(failed.progress).toMatchObject({ done: 2, total: 4, complete: false });
      expect(failed.preview).toBeUndefined();
      expect(mock.drafts).toEqual(fault === 'output_limit' ? [1, 2, 3] : [1, 2, 3, 3]);
      expect((await read(page, bookId, id(3))).body).toBe('');
      expect((await read(page, bookId, id(4))).body).toBe('');
      const revisions = await Promise.all(
        [1, 2].map(async (order) => (await read(page, bookId, id(order))).revision),
      );
      const before = [...mock.drafts];
      await app.close();
      mock.resume();
      app = await launch(root);
      page = await app.firstWindow();
      expect((await status(page, bookId))?.id).toBe(failed.id);
      expect(mock.drafts).toEqual(before);
      await openBook(page);
      await openComposer(page, true);
      await send(page, '接着写完');
      await expect.poll(async () => (await status(page, bookId))?.status).toBe('completed');
      const finished = (await status(page, bookId))!;
      expect(finished.progress).toMatchObject({ done: 4, total: 4, complete: true });
      expect(mock.drafts.slice(before.length)).toEqual([3, 4]);
      expect(
        await Promise.all([1, 2].map(async (order) => (await read(page, bookId, id(order))).revision)),
      ).toEqual(revisions);
      expect(
        (await files(page, bookId)).documents
          .filter((doc) => doc.type === 'chapter')
          .map((doc) => doc.id),
      ).toEqual(mock.chapterIds);
      expect((await read(page, bookId, id(3))).body).toBe(chapterBody(3));
      expect(mock.errors).toEqual([]);
      await expect
        .poll(
          async () =>
            (await readDiagnostics(root, 'backend')).filter((e) => e.event === 'run.finished').length,
        )
        .toBe(2);
      const rows = await readDiagnostics(root, 'backend');
      expect(
        rows.find((e) => e.event === 'run.finished' && e.fields.runId === failed.id)?.fields.reason,
      ).toBe(fault);
      expect(
        rows.filter((e) => e.event === 'chapter.retry' && e.fields.runId === failed.id),
      ).toHaveLength(fault === 'incomplete_stream' ? 1 : 0);
      const resumed = rows.filter((e) => e.fields.runId === finished.id);
      expect(
        resumed.filter((e) => e.event === 'novel.chapter.reused').map((e) => e.fields.chapterIndex),
      ).toEqual([1, 2]);
      expect(
        resumed.find((e) => e.event === 'novel.goal' && e.fields.operation === 'resume')?.fields.done,
      ).toBe(2);
      await safeDiaries(root);
    } finally {
      await app?.close().catch(() => {});
      await mock.close();
    }
  });
}

test('single-chapter request uses the same composer, can be stopped, and never starts a whole book', async ({}, info) => {
  const root = info.outputPath('app');
  const mock = await fixture('single');
  let app: ElectronApplication | undefined;
  try {
    app = await launch(root);
    const page = await app.firstWindow();
    const bookId = await setup(page, mock.baseUrl);
    const report = await rpc<WriteReport>(page, 'book.changes.write', {
      bookId,
      changes: mock.chapterIds.map((id, i) => ({
        type: 'chapter',
        id,
        expect: null,
        fields: { title: title(i + 1), order: i + 1 },
        body: '',
      })),
    });
    expect(report.error).toBeUndefined();
    await openBook(page);
    await openComposer(page);
    await send(page, '只写第三章');
    await expect.poll(async () => (await status(page, bookId))?.preview?.chapterId).toBe(id(3));
    await panel(page).getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(async () => (await status(page, bookId))?.status).toBe('cancelled');
    expect((await status(page, bookId))?.preview).toBeUndefined();
    expect((await read(page, bookId, id(3))).body).toBe('');
    mock.resume();
    await send(page, '只写第三章');
    await expect.poll(async () => (await status(page, bookId))?.status).toBe('completed');
    expect((await read(page, bookId, id(3))).body).toBe(chapterBody(3));
    expect((await read(page, bookId, id(1))).body).toBe('');
    expect((await read(page, bookId, id(2))).body).toBe('');
    expect((await files(page, bookId)).documents.map((doc) => doc.type).sort()).toEqual([
      'book',
      'chapter',
      'chapter',
      'chapter',
      'outline',
    ]);
    expect(mock.calls).toEqual(['book_generate_chapter:draft-3', 'book_generate_chapter:draft-3']);
    expect(mock.drafts).toEqual([3, 3]);
    expect(mock.errors).toEqual([]);
  } finally {
    await app?.close().catch(() => {});
    await mock.close();
  }
});
