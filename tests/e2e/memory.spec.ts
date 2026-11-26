import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type {
  BookSummary,
  LibraryView,
  Manuscript,
  ModelProfile,
  RuntimeView,
  Session,
  WriteReport,
} from '../../shared/contracts';
import type { BookRecall } from '../../electron/agent/book-memory';
import { diagnosticText, readDiagnostics, type Log } from './diagnostic-files';

const bookTitle = '潮岛';
const early = 'private-earlier-chapter';
const target = 'private-target-chapter';
const chapterTitle = '暗号 PRIVATE_EARLY_TITLE';
const marker = '灰珍珠的三道裂纹拼成渡港图';
const rule = '所有回忆使用现在时';
const rememberPrompt = '以后每章回想旧事都像正发生一样写。';
const privateQuery = '灰珍珠 PRIVATE_EXPLICIT_SEARCH';
const explicitPrompt = '只查询本书记忆，不写。';
const draftingPrompt = '续写第25章，让灰珍珠的裂纹再次出现。';
const draftText = '他循着灰珍珠的裂纹找到渡口。';
const apiKey = 'not-a-real-key-memory-fixture';
const recallEvent = 'memory.recall.finished';
const dispatchEvent = 'memory.context.dispatched';
const sourceEvent = 'memory.context.source';
const recallPrompt = '第25章里的灰珍珠和裂纹此前怎么写的？';
const overviewPrompt = '只查本书记忆里的作品约定。';
const proseContext = '作品资料（数据）：\n';

type Wire = { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
const system = (wire: Wire) => wire.messages.find((message) => message.role === 'system')!.content;
const readContext = (text: string, heading: string) => {
  expect(text).toContain(heading);
  return JSON.parse(text.slice(text.indexOf(heading) + heading.length));
};
const counts = (memory: BookRecall) => ({
  storyCount: memory.earlierStory.length,
  planCount: memory.plans.length,
  referenceCount: memory.reference.length,
  conventionCount: memory.conventions.length,
});

test('new editor sessions isolate book memory and diagnostics match actual requests and retry spans', async ({}, info) => {
  const received: Wire[] = [];
  let draftAttempts = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw) as Wire;
    received.push(body);
    const frame = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const send = (delta: object, reason: string) => res.end(`${frame(delta, reason)}data: [DONE]\n\n`);
    const use = (name: string, args: object) =>
      send(
        {
          tool_calls: [
            {
              index: 0,
              id: `fixture-${name}`,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        'tool_calls',
      );
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const current = body.messages.at(-1)!;
    if (body.tools?.some(({ function: tool }) => tool.name === 'book_read_chapter'))
      return send({ content: '无需回读' }, 'stop');
    if (!body.tools?.length && current.content.includes(proseContext)) {
      if (++draftAttempts === 1) return res.end(frame({ content: '合成断流不入稿' }, null));
      return send({ content: draftText }, 'stop');
    }
    const names = body.tools?.map(({ function: tool }) => tool.name) ?? [];
    if (names.length === 1 && names[0] === 'check_book_scope')
      return use('check_book_scope', { allowed: true });
    const author = body.messages.findLast(({ role }) => role === 'user')?.content;
    const wanted =
      author === rememberPrompt
        ? 'book_memory_remember'
        : author === explicitPrompt || author === recallPrompt || author === overviewPrompt
          ? 'book_memory_recall'
          : author === draftingPrompt
            ? 'book_generate_chapter'
            : undefined;
    if (wanted && current.role === 'user') return use('tool_search', { query: wanted });
    if (wanted && current.role === 'tool') {
      const result = JSON.parse(current.content);
      if (result.value?.candidates) {
        expect(names).toContain(wanted);
        if (wanted === 'book_memory_remember') return use(wanted, { text: rule });
        if (wanted === 'book_memory_recall')
          return use(wanted, {
            query: privateQuery,
            ...(author !== overviewPrompt && { chapterId: target }),
          });
        return use('book_task_scope', {
          items: [{ operation: 'chapter.draft', id: target, purpose: '为第25章的空白稿写出灰珍珠情节' }],
        });
      }
      if (wanted === 'book_generate_chapter' && result.value?.targets)
        return use(wanted, { chapterId: target, mode: 'draft' });
    }
    return send({ content: '已检查该书的记忆。' }, 'stop');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const root = info.outputPath('app');
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root },
  });
  try {
    const page = await app.firstWindow();
    const profile = await rpc<ModelProfile>(page, 'profiles.save', {
      name: '本地记忆夹具',
      model: 'fixture',
      apiKey,
      protocol: 'chat',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const a = await rpc<BookSummary>(page, 'book.create', { title: bookTitle, summary: '旧卷测试' });
    const b = await rpc<BookSummary>(page, 'book.create', {
      title: bookTitle,
      summary: '独立故事，不共用任何船只',
    });
    const padding = 'Early paragraph with no matching clue.\n\n'.repeat(780);
    expect(
      (
        await rpc<WriteReport>(page, 'book.changes.write', {
          bookId: a.id,
          changes: [
            {
              type: 'chapter',
              id: early,
              expect: null,
              fields: { title: chapterTitle, order: 2 },
              body: `${padding}${marker}。\n\n${padding}`,
            },
            {
              type: 'chapter',
              id: target,
              expect: null,
              fields: { title: '渡港', order: 25 },
              body: '',
            },
          ],
        })
      ).error,
    ).toBeUndefined();
    const { books } = await rpc<LibraryView>(page, 'library.list');
    const panel = page.getByRole('complementary', { name: 'Harness 面板' });
    const open = async (id: string) => {
      const buttons = page.getByRole('button', { name: `编辑 ${bookTitle}`, exact: true });
      await expect(buttons).toHaveCount(2);
      await buttons.nth(books.findIndex((book) => book.id === id)).click();
      await page.keyboard.press('Control+Alt+i');
      await expect(panel).toBeVisible();
    };
    const sessionRun = async (bookId: string, text: string) =>
      (await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId })).sessions.find(
        (s) => s.messages[0]?.text === text,
      )?.run;
    const send = async (id: string, text: string) => {
      await panel.getByRole('button', { name: '新建会话', exact: true }).click();
      await panel.getByLabel('给 Agent 的消息').fill(text);
      await panel.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(async () => (await sessionRun(id, text))?.status).toBe('completed');
      return (await sessionRun(id, text))!.id;
    };
    await open(a.id);
    await send(a.id, rememberPrompt);
    const firstRecallWire = received.length;
    const aRecall = await send(a.id, recallPrompt);
    const requestA = received[firstRecallWire];
    for (const value of [marker, rule, early]) expect(system(requestA)).not.toContain(value);
    expect(requestA.messages.filter((m) => m.role !== 'system')).toEqual([
      { role: 'user', content: recallPrompt },
    ]);
    const aMem = JSON.parse(received.at(-1)!.messages.at(-1)!.content).value as BookRecall;
    expect(JSON.stringify(aMem.earlierStory)).toContain(marker);
    expect(aMem.conventions[0]?.text).toBe(rule);

    await page.getByRole('button', { name: '返回书库' }).click();
    await open(b.id);
    await expect(panel.getByText(rememberPrompt, { exact: true })).toHaveCount(0);
    await expect(panel.getByText('这本小说还没有会话。')).toBeVisible();
    const bRecall = await send(b.id, overviewPrompt);
    const bResult = JSON.parse(received.at(-1)!.messages.at(-1)!.content).value as BookRecall;
    expect(bResult).toEqual({ conventions: [], earlierStory: [], plans: [], reference: [] });

    await page.getByRole('button', { name: '返回书库' }).click();
    await open(a.id);
    const toolRun = await send(a.id, explicitPrompt);
    const toolOutput = JSON.parse(received.at(-1)!.messages.at(-1)!.content);
    expect(toolOutput.ok).toBe(true);
    expect(toolOutput.value.earlierStory).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: early })]),
    );
    expect(toolOutput.value).not.toHaveProperty('recallId');

    const priorWires = received.length;
    const proseRun = await send(a.id, draftingPrompt);
    expect(draftAttempts).toBe(2);
    const wires = received.slice(priorWires);
    const actualDrafts = wires.filter((wire) => !wire.tools?.length);
    expect(actualDrafts).toHaveLength(2);
    expect(
      wires.filter((wire) =>
        wire.tools?.some(({ function: tool }) => tool.name === 'book_read_chapter'),
      ),
    ).toHaveLength(1);
    const drafts = actualDrafts.map((wire) => readContext(wire.messages.at(-1)!.content, proseContext));
    for (const draft of drafts) {
      expect(JSON.stringify(draft.previous)).not.toContain(marker);
      expect(draft.memory.earlierStory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: early,
            excerpt: expect.stringContaining(marker),
            chapterOrder: 2,
          }),
        ]),
      );
      expect(draft.memory.conventions[0].text).toBe(rule);
    }
    expect(
      (
        await rpc<Manuscript>(page, 'book.doc.read', {
          bookId: a.id,
          doc: { type: 'chapter', id: target },
        })
      ).body,
    ).toBe(draftText);

    // Recall still runs before the Agent notices the request exceeds its budget.
    const references = ['private-source-a.txt', 'private-source-b.txt'].map((name) => join(root, name));
    await Promise.all(
      references.map((path) => writeFile(path, 'PRIVATE_ATTACHMENT_TEXT'.repeat(1250), 'utf8')),
    );
    const oversizedPrompt = `第25章里的灰珍珠。PRIVATE_BUDGET_INPUT${'字'.repeat(22000)}`;
    const before = received.length;
    const session = await rpc<Session>(page, 'session.create', { bookId: a.id });
    const { runId: blockedRun } = await rpc<{ runId: string }>(page, 'session.start', {
      id: session.id,
      profileId: profile.id,
      prompt: oversizedPrompt,
      attachments: references,
    });
    await expect.poll(async () => (await sessionRun(a.id, oversizedPrompt))?.status).toBe('failed');
    expect(received).toHaveLength(before);

    const runIds = [aRecall, bRecall, toolRun, proseRun, blockedRun];
    await expect
      .poll(
        async () =>
          (await readDiagnostics(root, 'backend')).filter(
            (row) => row.event === 'run.finished' && runIds.includes(row.fields.runId),
          ).length,
      )
      .toBe(runIds.length);
    const rows = await readDiagnostics(root, 'backend');
    const events = (runId: string, event: string) =>
      rows.filter((row) => row.fields.runId === runId && row.event === event);
    const verifySpan = (runId: string, dispatch: Log, actual: BookRecall, trigger: 'tool' | 'draft') => {
      expect(dispatch.fields).toMatchObject({
        ...counts(actual),
        trigger,
        sourceCount: 1,
        omittedSources: 0,
      });
      const { spanId, recallId, workspaceRef } = dispatch.fields;
      expect(events(runId, 'model.http')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fields: expect.objectContaining({
              spanId,
              lane: trigger === 'tool' ? 'agent' : 'draft',
              httpStatus: 200,
            }),
          }),
        ]),
      );
      expect(events(runId, recallEvent)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fields: expect.objectContaining({ ...counts(actual), recallId, trigger }),
          }),
        ]),
      );
      const [source] = events(runId, sourceEvent).filter((row) => row.fields.spanId === spanId);
      expect(source.fields).toMatchObject({
        recallId,
        workspaceRef,
        docType: 'chapter',
        sourceType: 'story',
        sourceChapterOrder: 2,
      });
      const earlyCommit = rows.find(
        (row) =>
          row.event === 'workspace.document.committed' &&
          row.fields.workspaceRef === workspaceRef &&
          row.fields.docType === 'chapter' &&
          !row.fields.runId,
      );
      expect(source.fields.documentRef).toBe(earlyCommit?.fields.documentRef);
      expect(source.fields.revision).toBe(earlyCommit?.fields.revision);
      expect(source.fields.revision).toMatch(/^[a-f0-9]{16}$/);
    };
    expect(events(aRecall, dispatchEvent)).toHaveLength(1);
    verifySpan(aRecall, events(aRecall, dispatchEvent)[0], aMem, 'tool');
    expect(events(aRecall, recallEvent)[0].logSeq).toBeGreaterThan(
      events(aRecall, 'model.started')[0].logSeq,
    );
    expect(events(bRecall, recallEvent)[0].fields).toMatchObject({
      outcome: 'ok',
      storyCount: 0,
      planCount: 0,
      referenceCount: 0,
      conventionCount: 0,
    });
    expect(events(bRecall, recallEvent)[0].fields.workspaceRef).not.toBe(
      events(aRecall, recallEvent)[0].fields.workspaceRef,
    );
    expect(events(bRecall, dispatchEvent)).toHaveLength(0);
    expect(events(bRecall, sourceEvent)).toHaveLength(0);

    const explicit = events(toolRun, recallEvent).find((row) => row.fields.trigger === 'tool');
    expect(explicit?.fields).toMatchObject({ ...counts(toolOutput.value), outcome: 'ok' });
    expect(explicit?.fields.callId).toEqual(
      events(toolRun, 'tool.started').find((row) => row.fields.tool === 'book_memory_recall')?.fields
        .callId,
    );
    const explicitDispatch = events(toolRun, dispatchEvent)[0];
    expect(explicitDispatch.fields.recallId).toBe(explicit?.fields.recallId);
    verifySpan(toolRun, explicitDispatch, toolOutput.value, 'tool');

    const proseDispatches = events(proseRun, dispatchEvent).filter(
      (row) => row.fields.trigger === 'draft',
    );
    expect(proseDispatches).toHaveLength(2);
    expect(new Set(proseDispatches.map((row) => row.fields.spanId)).size).toBe(2);
    expect(new Set(proseDispatches.map((row) => row.fields.recallId)).size).toBe(1);
    expect(events(proseRun, 'chapter.retry')).toHaveLength(1);
    const committed = events(proseRun, 'workspace.document.committed').find(
      (row) => row.fields.docType === 'chapter',
    );
    for (const [i, dispatch] of proseDispatches.entries()) {
      verifySpan(proseRun, dispatch, drafts[i].memory, 'draft');
      expect(dispatch.fields.documentRef).toBe(committed?.fields.documentRef);
    }
    expect(events(proseRun, recallEvent).every(({ fields }) => fields.trigger === 'draft')).toBe(true);
    expect(
      wires
        .filter((wire) => wire.tools?.some(({ function: tool }) => tool.name === 'tool_search'))
        .every((wire) => !system(wire).includes(marker)),
    ).toBe(true);
    const readback = events(proseRun, 'model.started').find((row) => row.fields.lane === 'readback');
    expect(readback).toBeDefined();
    expect(
      events(proseRun, dispatchEvent).some((row) => row.fields.spanId === readback?.fields.spanId),
    ).toBe(false);
    expect(events(blockedRun, recallEvent)).toHaveLength(0);
    expect(events(blockedRun, 'run.finished')[0].fields.reason).toBe('context_limit');
    expect(events(blockedRun, dispatchEvent)).toHaveLength(0);
    expect(events(blockedRun, 'model.started')).toHaveLength(0);

    for (const stream of ['frontend', 'backend'] as const) {
      const text = await diagnosticText(root, stream);
      for (const sensitive of [
        marker,
        rule,
        privateQuery,
        explicitPrompt,
        draftingPrompt,
        chapterTitle,
        bookTitle,
        early,
        target,
        a.id,
        b.id,
        apiKey,
        '合成断流不入稿',
        draftText,
        'private-source-a.txt',
        'PRIVATE_ATTACHMENT_TEXT',
        'PRIVATE_BUDGET_INPUT',
      ])
        expect(text).not.toContain(sensitive);
    }
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
