import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeView } from '../../shared/contracts';
import { diagnosticText, readDiagnostics } from './diagnostic-files';

test('Harness keyboard and button share submission, protect IME and trace a Messages retry without leaking content', async ({}, info) => {
  const root = info.outputPath('app');
  const key = 'COMPOSER_PRIVATE_TEST_KEY';
  const typed = 'COMPOSER_PRIVATE_FIRST\n第二行';
  const broken = 'PRIVATE_UNFINISHED_ARGUMENT';
  const temporary = 'PRIVATE_DISCARDED_VISIBLE_TEXT';
  const bodies: any[] = [];
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const returned = '正常回复';
  const server = createServer(async (req, res) => {
    let source = '';
    for await (const chunk of req) source += chunk;
    bodies.push(JSON.parse(source));
    const attempt = bodies.length;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (attempt === 1) {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: temporary } });
      send({ type: 'content_block_stop', index: 0 });
      send({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'bad', name: 'book_get_context', input: {} },
      });
      send({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"id":"' + broken },
      });
      send({ type: 'content_block_stop', index: 1 });
      send({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    } else {
      if (attempt === 2) await wait;
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: returned } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    }
    send({ type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root, FW_E2E_SHOW_WINDOW: '0' },
  });
  try {
    const page = await app.firstWindow();
    const rpc = <T>(method: string, args?: unknown) =>
      page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
    const book = await rpc<{ id: string }>('book.create', {
      title: '快捷键夹具',
      summary: '受控验收。',
    });
    const panel = page.getByRole('complementary', { name: 'Harness 面板' });
    const field = panel.getByLabel('给 Agent 的消息');
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const open = async () => {
      await button('编辑 快捷键夹具').click();
      await button('Harness').click();
      await panel.getByRole('button', { name: '当前小说会话', exact: true }).click();
      await expect(field).toBeVisible();
    };
    const rows = () => rpc<RuntimeView>('runtime.snapshot');
    const active = async () =>
      (await rows()).sessions.find((s) => s.session.bookId === book.id && s.run);
    const starts = async () =>
      (await readDiagnostics(root, 'frontend')).filter(
        (e) => e.event === 'ui.operation.started' && e.fields.method === 'session.start',
      );
    await open();
    await field.fill('没有模型时保留输入');
    await expect(button('发送')).toBeDisabled();
    await field.press('Enter');
    await expect(field).toHaveValue('没有模型时保留输入');
    expect(await active()).toBeUndefined();
    const profile = await rpc<{ id: string }>('profiles.save', {
      name: '合成 Messages',
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: 'messages',
      apiKey: key,
    });
    await page.reload();
    await open();
    await panel.getByLabel('模型').selectOption(profile.id);
    await panel.getByLabel('思考等级').selectOption('low');
    await field.fill('   ');
    await field.press('Enter');
    expect(await active()).toBeUndefined();
    await field.fill('COMPOSER_PRIVATE_FIRST');
    await field.press('End');
    await field.press('Shift+Enter');
    await page.keyboard.insertText('第二行');
    await expect(field).toHaveValue(typed);
    await field.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(await active()).toBeUndefined();
    expect(bodies).toHaveLength(0);
    await field.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }),
      );
      (el as HTMLTextAreaElement).form!.requestSubmit();
    });
    await expect.poll(() => bodies.length).toBe(2);
    await expect(button('停止')).toBeVisible();
    await field.fill('执行时可以保留下一次草稿');
    await field.press('Enter');
    await expect(field).toHaveValue('执行时可以保留下一次草稿');
    await expect(button('停止')).toBeVisible();
    release();
    await expect.poll(async () => (await active())?.run?.status).toBe('completed');
    await expect(panel.getByText(returned, { exact: true })).toBeVisible();
    await expect(panel.getByText(temporary, { exact: true })).toHaveCount(0);
    expect(bodies[1]).toEqual(bodies[0]);
    expect((await active())!.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
      typed,
    ]);
    await expect.poll(async () => (await starts()).length).toBe(1);
    await field.fill(typed);
    await button('发送').click();
    await expect
      .poll(async () => (await active())?.messages.filter((m) => m.role === 'user').length)
      .toBe(2);
    await expect.poll(async () => (await active())?.run?.status).toBe('completed');
    expect(bodies).toHaveLength(3);
    expect(bodies[2].messages.at(-1)).toEqual(bodies[1].messages.at(-1));
    const attachment = info.outputPath('composer-reference.md');
    await writeFile(attachment, 'TEST_REFERENCE_ONLY', 'utf8');
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, attachment);
    await button('添加参考文件').click();
    await expect(panel.getByText('composer-reference.md', { exact: true })).toBeVisible();
    await unlink(attachment);
    await field.fill('IPC 失败时保留这份草稿');
    await field.press('Enter');
    await expect(panel.getByText(/无法附加文件/)).toBeVisible();
    await expect(field).toHaveValue('IPC 失败时保留这份草稿');
    await expect(panel.getByText('composer-reference.md', { exact: true })).toBeVisible();
    expect(bodies).toHaveLength(3);
    await expect.poll(async () => (await starts()).length).toBe(3);
    await expect
      .poll(
        async () =>
          (await readDiagnostics(root, 'backend')).filter((r) => r.event === 'model.arguments_retry')
            .length,
      )
      .toBe(1);
    for (const lane of ['frontend', 'backend'] as const) {
      const log = await diagnosticText(root, lane);
      for (const secret of [key, typed.split('\n')[0], broken, temporary, 'TEST_REFERENCE_ONLY'])
        expect(log).not.toContain(secret);
    }
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    release();
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
