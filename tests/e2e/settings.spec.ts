import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelProfile, RuntimeView, Session } from '../../shared/contracts';

test('encrypted profiles, routing selection, effort fallback and attachment snapshot', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const requests: { url?: string; body: any }[] = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const key = 'test-config-secret-not-real';
  const server = createServer(async (req, res) => {
    let source = '';
    for await (const bytes of req) source += bytes;
    const body = JSON.parse(source);
    requests.push({ url: req.url, body });
    if (req.headers.authorization !== `Bearer ${key}` && req.headers['x-api-key'] !== key) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (req.url?.endsWith('chat/completions')) {
      send({
        choices: [
          {
            index: 0,
            delta: { reasoning_content: 'native state not persisted', content: '第一段' },
            finish_reason: null,
          },
        ],
      });
      await wait;
      send({ choices: [{ index: 0, delta: { content: '已完成' }, finish_reason: 'stop' }] });
    } else {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第二模型' } });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
      send({ type: 'message_stop' });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const root = testInfo.outputPath('app'),
    dir = testInfo.outputPath('code');
  await mkdir(dir, { recursive: true });
  const text = join(dir, 'info.md');
  await writeFile(text, '最初版本', 'utf8');
  const launch = () =>
    electron.launch({
      args: ['.'],
      env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const request = <T>(method: string, args?: unknown) =>
      page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '选择供应商' })).toBeVisible();
    await page.getByRole('button', { name: /DeepSeek/ }).click();
    await expect(page.getByLabel('API 请求地址')).toHaveValue('https://api.deepseek.com/anthropic');
    await expect(page.getByLabel('模型 ID')).toHaveValue('');
    await page.getByRole('button', { name: '返回供应商列表' }).click();
    await page.getByRole('button', { name: /自定义配置/ }).click();
    await page.getByLabel('名称').fill('测试供应商 A');
    await page.getByLabel('模型 ID').fill('test-a');
    await page.getByLabel('API Key').fill(key);
    await page.getByLabel('API 请求地址').fill(`http://127.0.0.1:${port}/one/v1`);
    await page.getByRole('button', { name: '保存配置' }).click();
    await expect(page.getByText('配置已保存', { exact: true })).toBeVisible();
    await expect(page.getByLabel('API Key')).toHaveValue('');
    await page.getByRole('button', { name: '新建配置' }).click();
    await page.getByRole('button', { name: /DeepSeek/ }).click();
    await page.getByLabel('名称').fill('测试供应商 B');
    await page.getByLabel('模型 ID').fill('test-b');
    await page.getByLabel('API Key').fill(key);
    await page.getByLabel('API 请求地址').fill(`http://127.0.0.1:${port}/two/v1`);
    await page.getByText('高级选项', { exact: true }).click();
    await page.getByLabel('上游协议').selectOption('messages');
    await page.getByRole('button', { name: '保存配置' }).click();
    await expect(page.getByText('配置已保存', { exact: true })).toBeVisible();
    let profiles = await request<ModelProfile[]>('profiles.list');
    const a = profiles.find((p) => p.model === 'test-a')!,
      b = profiles.find((p) => p.model === 'test-b')!;
    await expect(page.getByText('额度未识别，使用通用兜底值')).toBeVisible();
    expect(a.providerId).toBe('custom');
    expect(b.providerId).toBe('deepseek');
    expect(b.capabilities).toMatchObject({
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      source: 'generic-fallback',
    });
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(profiles)).not.toContain(key);
    expect(await readFile(join(root, 'state', 'profiles.json'), 'utf8')).not.toContain(key);
    await page.reload();
    profiles = await request('profiles.list');
    expect(profiles).toHaveLength(2);
    const first = await request<{ id: string }>('book.create', {
      title: '配置信息 A',
      summary: '书 A',
    });
    const second = await request<{ id: string }>('book.create', {
      title: '配置信息 B',
      summary: '书 B',
    });
    const unrelated = await request<Session>('session.create', { cwd: dir });
    const enter = async (title: string) => {
      await page.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
      await page.getByRole('button', { name: 'Harness', exact: true }).click();
      return page.getByRole('complementary', { name: 'Harness 面板' });
    };
    const panel = await enter('配置信息 A');
    await panel.getByRole('button', { name: '当前小说会话' }).click();
    await expect(panel.getByLabel('模型')).toBeVisible();
    const id = (await request<RuntimeView>('runtime.snapshot', { bookId: first.id })).sessions[0].session
      .id;
    expect(id).not.toBe(unrelated.id);
    await expect(
      request('session.start', {
        id,
        profileId: a.id,
        prompt: 'fixture',
        attachments: [join(dir, 'missing.md')],
      }),
    ).rejects.toThrow('无法附加文件');
    expect(requests).toHaveLength(0);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, text);
    await panel.getByRole('button', { name: '添加参考文件' }).click();
    await expect(panel.getByText('info.md', { exact: true })).toBeVisible();
    await panel.getByLabel('模型').selectOption(a.id);
    await panel.getByLabel('思考等级').selectOption('high');
    await panel.getByLabel('给 Agent 的消息').fill('使用我的参考文件');
    await panel.getByRole('button', { name: '发送' }).click();
    await expect(panel.getByText('第一段', { exact: true })).toBeVisible();
    await panel.getByLabel('模型').selectOption(b.id);
    await panel.getByLabel('思考等级').selectOption('low');
    await writeFile(text, '已变更', 'utf8');
    release();
    await expect(panel.getByText('第一段已完成', { exact: true })).toBeVisible();
    expect(requests[0].url).toBe('/one/v1/chat/completions');
    expect(
      requests[0].body.tools.map((tool: { function: { name: string } }) => tool.function.name),
    ).toContain('tool_search');
    expect(JSON.stringify(requests[0].body.tools)).not.toContain('read_file');
    expect(JSON.stringify(requests[0].body.tools)).toMatch(/skill_search|skill_load|book_get_context/);
    await expect(panel.getByLabel('写作动作')).toHaveCount(0);
    expect(
      requests[0].body.messages.find((message: { role: string }) => message.role === 'system')?.content,
    ).toContain('最初版本');
    expect(requests[0].body.messages.at(-1).content).toBe('使用我的参考文件');
    expect(requests[0].body.reasoning_effort).toBeUndefined();
    await expect(panel.getByText(/使用模型默认思考设置/)).toBeVisible();
    await panel.getByLabel('给 Agent 的消息').fill('下一轮');
    await panel.getByRole('button', { name: '发送' }).click();
    await expect(panel.getByText('第二模型', { exact: true })).toBeVisible();
    expect(requests[1].url).toBe('/two/v1/messages');
    const wire = JSON.stringify(requests[1].body);
    expect(wire).toContain('第一段已完成');
    expect(wire).not.toContain('native state');
    expect(wire).not.toContain('info.md');
    const disk = await readFile(join(root, 'state', 'sessions', `${id}.jsonl`), 'utf8');
    expect(disk).not.toContain('native state');
    expect(disk).not.toContain(key);
    const expectComplete = (bookId: string, count: number) =>
      expect
        .poll(async () => {
          const session = (await request<RuntimeView>('runtime.snapshot', { bookId })).sessions[0];
          return (
            session && [session.run?.status, session.messages.filter((m) => m.role === 'user').length]
          );
        })
        .toEqual(['completed', count]);
    await expectComplete(first.id, 2);
    await page.getByRole('button', { name: '返回书库' }).click();
    const secondPanel = await enter('配置信息 B');
    await expect(secondPanel.getByText('使用我的参考文件', { exact: true })).toHaveCount(0);
    await expect(secondPanel.getByText(unrelated.label, { exact: true })).toHaveCount(0);
    await secondPanel.getByRole('button', { name: '当前小说会话' }).click();
    await secondPanel.getByLabel('模型').selectOption(a.id);
    await secondPanel.getByLabel('给 Agent 的消息').fill('用同一配置处理另一本书');
    await secondPanel.getByRole('button', { name: '发送' }).click();
    await expectComplete(second.id, 1);
    expect(requests[2].url).toBe('/one/v1/chat/completions');
    expect(JSON.stringify(requests[2].body)).not.toContain('最初版本');
    expect(JSON.stringify(requests[2].body)).not.toContain('使用我的参考文件');

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    const reopened = await enter('配置信息 A');
    await reopened.getByRole('button', { name: /^使用我的参考文件/ }).click();
    await expect(reopened.getByRole('button', { name: '删除会话 使用我的参考文件' })).toBeVisible();
    await reopened.getByLabel('模型').selectOption(a.id);
    await reopened.getByLabel('给 Agent 的消息').fill('重启后仍使用同一个密钥');
    await reopened.getByRole('button', { name: '发送' }).click();
    await expectComplete(first.id, 3);
    expect(requests[3].url).toBe('/one/v1/chat/completions');
    expect(requests.map(({ body }) => body.max_tokens)).toEqual([8_192, 8_192, 8_192, 8_192]);
    const reopenedProfiles = await request<ModelProfile[]>('profiles.list');
    expect(reopenedProfiles.find((p) => p.id === a.id)?.capabilities).toEqual(a.capabilities);
    expect(reopenedProfiles.find((p) => p.id === b.id)?.capabilities).toEqual(b.capabilities);
    expect(JSON.stringify(reopenedProfiles)).not.toContain(key);
    for (const book of [first, second]) {
      const memory = join(root, 'library', book.id, '.fiction-writer', 'memory.json');
      await expect(readFile(memory, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' }); // No memory tool was called.
    }
  } finally {
    release();
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
