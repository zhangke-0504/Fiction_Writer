import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type {
  BookSummary,
  LibraryView,
  ModelProfile,
  RuntimeView,
  WriteReport,
} from '../../shared/contracts';

const marker = '灰珍珠的三道裂纹拼成渡港图';
const rule = '所有回忆使用现在时';
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);

test('new editor sessions recall only the bound same-name book and its saved author convention', async ({}, info) => {
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    received.push(body);
    const send = (delta: object, finish_reason: string) =>
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: [DONE]\n\n`,
      );
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const current = body.messages.at(-1);
    if (current.role === 'user' && current.content.startsWith('请记住：'))
      return send(
        {
          tool_calls: [
            {
              index: 0,
              id: 'remember',
              function: { name: 'book_memory_remember', arguments: JSON.stringify({ text: rule }) },
            },
          ],
        },
        'tool_calls',
      );
    return send({ content: '已检查该书的记忆。' }, 'stop');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: info.outputPath('app') },
  });
  try {
    const page = await app.firstWindow();
    await rpc<ModelProfile>(page, 'profiles.save', {
      name: '本地记忆夹具',
      model: 'fixture',
      apiKey: 'not-a-real-key',
      protocol: 'chat',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const a = await rpc<BookSummary>(page, 'book.create', { title: '潮岛', summary: '旧卷测试' });
    const b = await rpc<BookSummary>(page, 'book.create', {
      title: '潮岛',
      summary: '独立故事，不共用任何船只',
    });
    expect(
      (
        await rpc<WriteReport>(page, 'book.changes.write', {
          bookId: a.id,
          changes: [
            {
              type: 'chapter',
              id: 'chapter-2',
              expect: null,
              fields: { title: '暗号', order: 2 },
              body: `远处传来低语：${marker}。`,
            },
            {
              type: 'chapter',
              id: 'chapter-25',
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
      const buttons = page.getByRole('button', { name: '编辑 潮岛', exact: true });
      await expect(buttons).toHaveCount(2);
      await buttons.nth(books.findIndex((book) => book.id === id)).click();
      await page.keyboard.press('Control+Alt+i');
      await expect(panel).toBeVisible();
    };
    const send = async (id: string, text: string) => {
      await panel.getByRole('button', { name: '新建会话', exact: true }).click();
      await panel.getByLabel('给 Agent 的消息').fill(text);
      await panel.getByRole('button', { name: '发送', exact: true }).click();
      await expect
        .poll(
          async () =>
            (await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId: id })).sessions.find(
              (s) => s.messages[0]?.text === text,
            )?.run?.status,
        )
        .toBe('completed');
    };
    await open(a.id);
    await send(a.id, `请记住：${rule}。`);
    const query = '第25章里的灰珍珠和裂纹此前怎么写的？';
    await send(a.id, query);
    expect(received).toHaveLength(3);
    const contextA = received[2].messages.find((m: any) => m.role === 'system').content;
    expect(contextA).toContain(marker);
    expect(contextA).toContain(rule);
    expect(contextA).toContain('chapter-2');
    expect(received[2].messages.filter((m: any) => m.role !== 'system')).toEqual([
      { role: 'user', content: query },
    ]);
    await page.getByRole('button', { name: '返回书库' }).click();
    await open(b.id);
    await expect(panel.getByText(`请记住：${rule}。`, { exact: true })).toHaveCount(0);
    await expect(panel.getByText('这本小说还没有会话。')).toBeVisible();
    await send(b.id, query);
    expect(received).toHaveLength(4);
    const contextB = received[3].messages.find((m: any) => m.role === 'system').content;
    expect(contextB).not.toContain(marker);
    expect(contextB).not.toContain(rule);
    expect(contextB).not.toContain('chapter-2');
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
