import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ChatLine, ModelProfile, RuntimeView } from '../../shared/contracts';

test('Harness formats a streaming reply and saves the original Markdown once', async ({}, info) => {
  const title = '开篇核对';
  const emphasis = '线索待核对';
  const firstChunk = `## ${title}\n\n**${emphasis}`;
  const secondChunk = '**。\n\n- 复核人物动机';
  const complete = firstChunk + secondChunk;
  const closeEmphasis = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end();
      return;
    }
    for await (const _ of request) {
      /* Consume the request before sending the fixture response. */
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: object) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: firstChunk } });
    await closeEmphasis.promise;
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: secondChunk } });
    await finish.promise;
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    send({ type: 'message_stop' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const root = info.outputPath('app');
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: ['.'],
      env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root },
    });
    const page = await app.firstWindow();
    const { bookId, profileId } = await page.evaluate(async (port) => {
      const book = await window.fw.request<{ id: string }>('book.create', {
        title: '流式排版',
        summary: '测试小说。',
      });
      const profile = await window.fw.request<ModelProfile>('profiles.save', {
        name: '流式排版模型',
        model: 'fixture',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        protocol: 'messages',
        apiKey: 'fixture-key',
      });
      return { bookId: book.id, profileId: profile.id };
    }, port);
    const active = () =>
      page.evaluate(async (bookId) => {
        const view = await window.fw.request<RuntimeView>('runtime.snapshot', { bookId });
        return view.sessions.find(({ run }) => run);
      }, bookId);

    await page.getByRole('button', { name: '编辑 流式排版', exact: true }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'AI 面板' });
    await panel.getByLabel('模型').selectOption(profileId);
    await panel.getByLabel('给 Agent 的消息').fill('讨论开篇写法');
    await panel.getByRole('button', { name: '发送', exact: true }).click();

    const reply = panel.getByLabel('对话消息').locator('.chat-line.assistant');
    const heading = reply.getByRole('heading', { level: 2, name: title });
    const bold = reply.locator('.chat-markdown strong');
    await expect(heading).toBeVisible();
    await expect(bold).toHaveCount(0);
    closeEmphasis.resolve();

    await expect(bold).toHaveText(emphasis);
    await expect(reply.getByRole('listitem')).toHaveText('复核人物动机');
    expect(await active()).toMatchObject({ streaming: complete, run: { status: 'running' } });
    finish.resolve();

    await expect.poll(async () => (await active())?.run?.status).toBe('completed');
    await expect(panel.getByRole('status')).toHaveText(/^已完成/);
    await expect(reply).toHaveCount(1);
    await expect(heading).toBeVisible();
    await expect(bold).toHaveText(emphasis);
    const { session, streaming } = (await active())!;
    expect(streaming).toBe('');
    const history = await readFile(join(root, 'state', 'sessions', `${session.id}.jsonl`), 'utf8');
    const savedReplies = history
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((entry) => (JSON.parse(entry) as { line?: ChatLine }).line)
      .filter((line) => line?.role === 'assistant');
    expect(savedReplies).toEqual([{ role: 'assistant', text: complete }]);
  } finally {
    closeEmphasis.resolve();
    finish.resolve();
    try {
      await app?.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
