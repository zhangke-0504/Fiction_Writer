import { test, expect, _electron as electron } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatLine, RunInfo, RuntimeView, Session } from '../../shared/contracts';

test('Harness reopens Markdown replies and legacy tool groups without a progress card', async ({}, info) => {
  const root = info.outputPath('app');
  const launch = () =>
    electron.launch({ args: ['.'], env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root } });
  const prompt = '根据设定检查开篇';
  const authorMessage = `${prompt}，逐字显示 **星号**。`;
  const planIntro = '本次建议的修改范围（尚未写入作品）：';
  const planSummary = '核对开篇人物和时间线。';
  const planItem = '第一章：补充人物登场信息。';
  const plan = [planIntro, planSummary, `- ${planItem}`].join('\n');
  const replyTitle = '开篇资料';
  const reply = [
    `## ${replyTitle}`,
    '> 核对人物出场顺序。',
    '| 章节 | 资料 |\n| --- | --- |\n| 第一章 | 人物设定 |',
    '核对 `chapter-1`，保留 <kbd>待核对</kbd> 字样。',
    '[资料来源](https://example.com/source) 与 [开篇章节](chapters/chapter-1.md)。',
    '![人物关系图](https://example.com/cast.png)',
  ].join('\n\n');
  const status = '**已记录检查结果**';
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
    '旧版工具提示 `原始字符`',
  ];
  const secondTools = ['运行 skill_load', 'tool_search · 已完成'];
  const toolLines = (entries: string[]): ChatLine[] => entries.map((text) => ({ role: 'tool', text }));
  const messages: ChatLine[] = [
    { role: 'user', text: authorMessage },
    ...toolLines(firstTools),
    { role: 'assistant', text: plan },
    ...toolLines(secondTools),
    { role: 'status', text: status },
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
    const restored = await page.evaluate(async (sessionId) => {
      const view = await window.fw.request<RuntimeView>('runtime.snapshot');
      return view.sessions.find(({ session }) => session.id === sessionId);
    }, session.id);
    expect(restored?.run).toEqual(run);
    expect(restored?.messages).toEqual(messages);

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
    await expect(
      feed.locator(':scope > article > .chat-body, details > summary, .run-status'),
    ).toHaveText([
      authorMessage,
      firstSummary,
      new RegExp(`^${planIntro}`),
      secondSummary,
      status,
      new RegExp(`^${replyTitle}`),
      `失败：${failure}`,
    ]);
    const assistant = feed.locator(':scope > .chat-line.assistant > .chat-body');
    const planBody = assistant.nth(0);
    const planParagraph = planBody.locator('p').first();
    await expect(planParagraph).toContainText(planSummary);
    await expect(planParagraph.locator('br')).toHaveCount(1);
    await expect(planBody.getByRole('listitem')).toHaveText(planItem);
    const replyBody = assistant.nth(1);
    await expect(replyBody.getByRole('heading', { name: replyTitle, level: 2 })).toBeVisible();
    await expect(replyBody.locator('blockquote')).toHaveText('核对人物出场顺序。');
    await expect(replyBody.getByRole('table').getByRole('cell')).toHaveText(['第一章', '人物设定']);
    await expect(replyBody.locator('code')).toHaveText('chapter-1');
    await expect(replyBody.getByText('核对 chapter-1，保留 <kbd>待核对</kbd> 字样。')).toBeVisible();
    await expect(replyBody.locator('kbd')).toHaveCount(0);
    await expect(
      replyBody.getByText('资料来源 (https://example.com/source)', { exact: false }),
    ).toBeVisible();
    await expect(
      replyBody.getByText('开篇章节 (chapters/chapter-1.md)', { exact: false }),
    ).toBeVisible();
    await expect(replyBody.getByText('人物关系图', { exact: true })).toBeVisible();
    await expect(replyBody.getByRole('link')).toHaveCount(0);
    await expect(replyBody.getByRole('img')).toHaveCount(0);
    await expect(panel.getByLabel('诊断编号')).toHaveText(run.id);
    await expect(first.getByText(firstTools[0], { exact: true }).first()).toBeHidden();
    await expect(second.getByText(secondTools[0], { exact: true })).toBeHidden();

    await first.locator('summary').press('Enter');
    await expect(first.locator('article > .chat-body')).toHaveText(firstTools);
    await expect(first.getByText('book_get_context · 未完成', { exact: true })).toBeVisible();
    await expect(second.getByText(secondTools[0], { exact: true })).toBeHidden();
    await first.locator('summary').press('Space');
    await expect(first.getByText('book_get_context · 未完成', { exact: true })).toBeHidden();
    await second.locator('summary').click();
    await expect(second.locator('article > .chat-body')).toHaveText(secondTools);
    await expect(second.getByText(secondTools[0], { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
