import { test, expect, _electron as electron } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatLine, RunInfo, RuntimeView, Session } from '../../shared/contracts';

test('Harness reopens legacy tool groups without restoring a progress card', async ({}, info) => {
  const root = info.outputPath('app');
  const launch = () =>
    electron.launch({ args: ['.'], env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root } });
  const prompt = '根据设定检查开篇';
  const narration = '我会核对人物设定。';
  const reply = '目前已找到开篇资料。';
  const failure = '整书未完成（已保存 1/2 章）：读取设定失败';
  const initial = await launch();
  let session: Session;
  try {
    const page = await initial.firstWindow();
    session = await page.evaluate(async () => {
      const book = await window.fw.request<{ id: string }>('book.create', {
        title: '活动折叠',
        summary: '测试小说。',
      });
      return window.fw.request<Session>('session.create', { bookId: book.id });
    });
  } finally {
    await initial.close();
  }

  const firstTools = [
    '运行 book_get_context',
    'book_get_context · 已完成',
    '运行 book_get_context',
    'book_get_context · 未完成',
    '旧版工具提示',
  ];
  const secondTools = ['运行 skill_load', 'tool_search · 已完成'];
  const toolLines = (entries: string[]): ChatLine[] => entries.map((text) => ({ role: 'tool', text }));
  const messages: ChatLine[] = [
    { role: 'user', text: prompt },
    ...toolLines(firstTools),
    { role: 'assistant', text: narration },
    ...toolLines(secondTools),
    { role: 'status', text: '已记录检查结果' },
    { role: 'assistant', text: reply },
  ];
  const run: RunInfo = {
    id: randomUUID(),
    status: 'failed',
    error: failure,
    progress: { step: '核对设定', done: 1, total: 2 },
  };
  const entries = [...messages.map((line) => ({ session, line })), { session, run }];
  await appendFile(
    join(root, 'state', 'sessions', `${session.id}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );

  const app = await launch();
  try {
    const page = await app.firstWindow();
    const restoredRun = await page.evaluate(async (sessionId) => {
      const view = await window.fw.request<RuntimeView>('runtime.snapshot');
      return view.sessions.find(({ session }) => session.id === sessionId)?.run;
    }, session.id);
    expect(restoredRun).toEqual(run);

    await page.getByRole('button', { name: '编辑 活动折叠', exact: true }).click();
    await page.getByRole('button', { name: 'Harness', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Harness 面板' });
    await panel.getByRole('button', { name: new RegExp(`^${prompt}`) }).click();
    const feed = panel.getByLabel('对话消息');
    const groups = feed.locator('details');
    const first = groups.nth(0);
    const second = groups.nth(1);
    const firstSummary = '工具活动 · 2 次调用 · 1 条记录 · 1 项未完成';
    const secondSummary = '工具活动 · 2 次调用 · 1 项无结果';
    await expect(groups).toHaveCount(2);
    await expect(panel.locator('.writing-progress')).toHaveCount(0);
    await expect(panel.getByText('核对设定', { exact: true })).toHaveCount(0);
    await expect(feed.locator(':scope > article > p, details > summary, .run-status')).toHaveText([
      prompt,
      firstSummary,
      narration,
      secondSummary,
      '已记录检查结果',
      reply,
      `失败：${failure}`,
    ]);
    await expect(panel.getByLabel('诊断编号')).toHaveText(run.id);
    await expect(first.getByText(firstTools[0], { exact: true }).first()).toBeHidden();
    await expect(second.getByText(secondTools[0], { exact: true })).toBeHidden();

    await first.locator('summary').press('Enter');
    await expect(first.locator('article p')).toHaveText(firstTools);
    await expect(first.getByText('book_get_context · 未完成', { exact: true })).toBeVisible();
    await expect(second.getByText(secondTools[0], { exact: true })).toBeHidden();
    await first.locator('summary').press('Space');
    await expect(first.getByText('book_get_context · 未完成', { exact: true })).toBeHidden();
    await second.locator('summary').click();
    await expect(second.locator('article p')).toHaveText(secondTools);
    await expect(second.getByText(secondTools[0], { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
