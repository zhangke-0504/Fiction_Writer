import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import type { BookView, LibraryView, Manuscript, RuntimeView } from '../../shared/contracts';

test('generate a novel from the panel and continue chapter two after an application restart', async ({}, info) => {
  const root = info.outputPath('app'),
    env = { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root };
  const steps: string[] = [];
  const resumedRequests: string[] = [];
  const originalDirection = '写两章短篇，全书使用第一人称';
  let allowSecond = false;
  const server = createServer(async (req, res) => {
    let source = '';
    for await (const bytes of req) source += bytes;
    const body = JSON.parse(source),
      user = body.messages.at(-1).content;
    const match = (pattern: string) => user.includes(pattern);
    let text: string;
    if (match('当前步骤：确定全书大纲')) {
      steps.push('outline');
      text =
        '<!-- beat:gate -->\n\n# 出发\n她带着钥匙离岸。\n\n<!-- beat:light -->\n\n# 归航\n她在灯光里返回。';
    } else if (match('当前步骤：生成主体')) {
      steps.push('subjects');
      text = JSON.stringify({
        subjects: [{ id: 'key', name: '玻璃钥匙', kind: 'item', body: '能打开灯塔。' }],
      });
    } else if (match('当前步骤：生成伏笔')) {
      steps.push('clues');
      text = JSON.stringify({
        clues: [
          {
            id: 'hint',
            title: '玻璃闪光',
            subjectIds: ['key'],
            setupBeatId: 'gate',
            payoffBeatId: 'light',
            body: '暗示钥匙用途。',
          },
        ],
      });
    } else if (match('当前步骤：生成章节目录')) {
      steps.push('catalog');
      text = JSON.stringify({
        chapters: [
          { id: 'one', title: '出发', beatIds: ['gate'] },
          { id: 'two', title: '归航', beatIds: ['light'] },
        ],
      });
    } else if (match('"id": "one"')) {
      steps.push('one');
      text = '第一章正文。她坐船离开。';
    } else {
      steps.push('two');
      if (!allowSecond) {
        res.writeHead(503);
        res.end();
        return;
      }
      resumedRequests.push(user);
      text = '第二章正文。她看到了灯。';
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let app = await electron.launch({ args: ['.'], env });
  let page = await app.firstWindow();
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const rpc = <T>(method: string, args?: unknown) =>
    page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
  let bookId: string;
  const read = (id: string) =>
    rpc<Manuscript>('book.doc.read', { bookId, doc: { type: 'chapter', id } });
  try {
    await button('新建小说').click();
    await page.getByLabel('小说名').fill('玻璃灯塔');
    await page.getByLabel('简介').fill('灯塔引人归来。');
    await button('创建小说').click();
    await button('编辑 玻璃灯塔').click();
    bookId = (await rpc<LibraryView>('library.list')).books[0].id;
    const port = (server.address() as import('node:net').AddressInfo).port;
    await rpc('profiles.save', {
      name: '合成夹具',
      apiKey: 'workflow-test-only-key',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'fixture',
      protocol: 'chat',
    });
    await button('Harness').click();
    let panel = page.getByRole('complementary', { name: 'Harness 面板' });
    await panel.getByRole('button', { name: '当前小说会话' }).click();
    await panel.getByLabel('写作动作').selectOption('novel');
    await panel.getByLabel('给 Agent 的消息').fill(originalDirection);
    await panel.getByRole('button', { name: '开始生成全书' }).click();
    await expect(panel.getByRole('status', { name: '' }).filter({ hasText: /失败/ })).toBeVisible();
    expect(steps).toEqual(['outline', 'subjects', 'clues', 'catalog', 'one', 'two']);
    const first = await read('one');
    expect(first.body).toContain('她坐船离开');
    expect((await read('two')).body).toBe('');
    expect(
      (await rpc<BookView>('book.read', { bookId })).documents.find((d) => d.type === 'clue')?.fields
        .payoffChapterId,
    ).toBe('two');
    await app.close();
    allowSecond = true;
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await button('编辑 玻璃灯塔').click();
    await button('Harness').click();
    panel = page.getByRole('complementary', { name: 'Harness 面板' });
    await panel
      .getByRole('button', { name: /玻璃灯塔/ })
      .filter({ hasText: '玻璃灯塔' })
      .first()
      .click();
    await panel.getByLabel('写作动作').selectOption('novel');
    await panel.getByRole('button', { name: '继续生成全书' }).click();
    await expect(
      panel.getByText('全书生成完成。已经写过的章节保持原样。', { exact: true }),
    ).toBeVisible();
    expect(steps).toEqual(['outline', 'subjects', 'clues', 'catalog', 'one', 'two', 'two']);
    expect(resumedRequests).toHaveLength(1);
    expect(resumedRequests[0]).toContain(originalDirection);
    expect((await read('one')).revision).toBe(first.revision);
    expect((await read('two')).body).toContain('她看到了灯');
    expect((await rpc<RuntimeView>('runtime.snapshot')).sessions[0].workflow?.complete).toBe(true);
    await button('归航').click();
    await expect(page.getByLabel('Markdown 编辑器')).toContainText('她看到了灯');
    await page.screenshot({ path: info.outputPath('workspace.png') });
  } finally {
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
