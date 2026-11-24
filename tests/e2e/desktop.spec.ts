import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';

test('renderer reload keeps the same backend', async ({}, testInfo) => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: testInfo.outputPath('app') },
  });
  try {
    const page = await app.firstWindow();
    const getPid = () =>
      page.evaluate(async () => (await window.fw.request<{ pid: number }>('ping')).pid);
    await expect(page.getByRole('heading', { name: '书库', exact: true })).toBeVisible();
    const pid = await getPid();
    await page.reload();
    await expect(page.getByRole('heading', { name: '书库', exact: true })).toBeVisible();
    expect(await getPid()).toBe(pid);
  } finally {
    await app.close();
  }
});

test('create, edit and reopen a novel without configuring a model', async ({}, testInfo) => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: testInfo.outputPath('app') },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '新建小说' }).click();
    await page.getByLabel('小说名').fill('潮汐之后');
    await page.getByLabel('简介').fill('一个发生在潮间带的故事。');
    await page.getByRole('button', { name: '创建小说' }).click();
    await page.getByRole('button', { name: '编辑 潮汐之后' }).click();
    await expect(page.getByLabel('简介')).toHaveValue('一个发生在潮间带的故事。');
    await page.getByRole('button', { name: '新建章节' }).click();
    await page.getByLabel('章节名').fill('涨潮');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    const editor = page.getByLabel('Markdown 编辑器');
    await editor.fill('## 海水上涨');
    await page.getByRole('button', { name: '返回书库' }).click();
    await page.getByRole('button', { name: '编辑 潮汐之后' }).click();
    await page.getByRole('button', { name: '涨潮', exact: true }).click();
    await expect(editor).toHaveText('## 海水上涨');
    await editor.press('Control+s');
    await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '编辑 潮汐之后' }).click();
    await page.getByRole('button', { name: '涨潮', exact: true }).click();
    await expect(editor).toHaveText('## 海水上涨');
  } finally {
    await app.close();
  }
});
async function createNovel(page: import('playwright').Page, title: string) {
  await page.getByRole('button', { name: '新建小说' }).click();
  await page.getByLabel('小说名').fill(title);
  await page.getByLabel('简介').fill('潮间带的故事');
  await page.getByRole('button', { name: '创建小说' }).click();
  await expect(page.getByRole('button', { name: `编辑 ${title}` })).toBeVisible();
}

test('the same run stays live across books and a page reload; buffers stay separate', async ({}, testInfo) => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: testInfo.outputPath('app') },
  });
  try {
    const page = await app.firstWindow();
    const call = <T>(method: string, args?: unknown) =>
      page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
    await createNovel(page, '小说 A');
    await page.getByRole('button', { name: '编辑 小说 A' }).click();
    await page.getByRole('button', { name: '新建章节' }).click();
    await page.getByLabel('章节名').fill('归潮');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    const editor = page.getByLabel('Markdown 编辑器');
    await expect(editor).toBeVisible();
    const bookId = (await call<import('../../shared/contracts').LibraryView>('library.list')).books[0]
      .id;
    const chapterId = (
      await call<import('../../shared/contracts').BookView>('book.read', { bookId })
    ).documents.find((d) => d.type === 'chapter')!.id;
    const read = () =>
      call<import('../../shared/contracts').Manuscript>('book.doc.read', {
        bookId,
        doc: { id: chapterId, type: 'chapter' },
      });
    const start = (addSubject: boolean, fail?: boolean) =>
      call<{ sessionId: string; runId: string }>('test.start', { bookId, chapterId, addSubject, fail });
    const release = (sessionId: string, step: string) => call('test.release', { sessionId, step });
    const snapshot = () => call<import('../../shared/contracts').RuntimeView>('runtime.snapshot');
    await editor.fill('开头。');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    const { sessionId, runId } = await start(true);
    await expect(editor).toContainText('海面亮了。');
    await expect(page.getByText('生成中 · 未保存')).toBeVisible();
    expect((await read()).body).toBe('开头。');
    await page.getByRole('button', { name: '主体', exact: true }).click();
    await expect(page.getByRole('button', { name: '潮汐钥匙' })).toBeVisible();
    await page.getByRole('button', { name: '返回书库' }).click();
    await createNovel(page, '小说 B');
    await release(sessionId, 'next');
    await page.reload();
    await page.getByRole('button', { name: '编辑 小说 A' }).click();
    await page.getByRole('button', { name: '归潮', exact: true }).click();
    await expect(editor).toContainText('潮水开始退却。');
    expect((await snapshot()).sessions.find((s) => s.session.id === sessionId)?.run?.id).toBe(runId);
    expect((await read()).body).toBe('开头。');
    await release(sessionId, 'finish');
    await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    expect((await read()).body).toBe('开头。\n\n海面亮了。潮水开始退却。');
    await expect(editor).toContainText('潮水开始退却。');

    await editor.fill('我的未保存文本');
    const second = await start(false);
    await expect
      .poll(
        async () =>
          (await snapshot()).sessions.find((s) => s.session.id === second.sessionId)?.run?.preview
            ?.content,
      )
      .toContain('海面亮了。');
    await expect(editor).toHaveText('我的未保存文本');
    await release(second.sessionId, 'next');
    await release(second.sessionId, 'finish');
    await expect(page.getByText('存在编辑冲突')).toBeVisible();
    await expect(editor).toHaveText('我的未保存文本');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重载文件' }).click();
    await expect(editor).toContainText('潮水开始退却。');

    const third = await start(false);
    const before = await read();
    await expect(page.getByText('生成中 · 未保存')).toBeVisible();
    const report = await call<import('../../shared/contracts').WriteReport>('book.doc.write', {
      bookId,
      doc: { ...before, body: '外部已经提交的新正文' },
    });
    expect(report.error).toBeUndefined();
    await release(third.sessionId, 'next');
    await release(third.sessionId, 'finish');
    await expect
      .poll(
        async () =>
          (await snapshot()).sessions.find((s) => s.session.id === third.sessionId)?.run?.status,
      )
      .toBe('failed');
    await expect(editor).toHaveText('外部已经提交的新正文');
    const fourth = await start(false);
    await expect(page.getByText('生成中 · 未保存')).toBeVisible();
    await call('session.stop', { id: fourth.sessionId });
    await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    expect((await read()).body).toBe('外部已经提交的新正文');
  } finally {
    await app.close();
  }
});
test('only the editor opens Harness, and navigating resets its panel selection', async ({}, testInfo) => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: testInfo.outputPath('app') },
  });
  try {
    const page = await app.firstWindow();
    const toggle = page.getByRole('button', { name: 'Harness', exact: true });
    const panel = page.getByRole('complementary', { name: 'Harness 面板' });
    const outsideEditor = async () => {
      await page.keyboard.press('Control+Alt+i');
      await expect(toggle).toHaveCount(0);
      await expect(panel).toHaveCount(0);
    };
    await outsideEditor();
    await createNovel(page, '会话作品');
    await page.getByRole('button', { name: '编辑 会话作品' }).click();
    await page.keyboard.press('Control+Alt+i');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '当前小说会话' }).click();
    await expect(panel.getByRole('textbox', { name: '给 Agent 的消息' })).toBeVisible();
    await expect(panel.getByLabel('思考等级')).toHaveValue('high');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await outsideEditor();
    await page.getByRole('button', { name: '书库', exact: true }).click();
    await outsideEditor();
    await page.getByRole('button', { name: '编辑 会话作品' }).click();
    await expect(panel).toBeHidden();
    await toggle.click();
    await panel.getByLabel('查找会话').fill('新会话');
    const remove = panel.getByRole('button', { name: '删除会话 新会话', exact: true });
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(remove).toHaveCount(0);
  } finally {
    await app.close();
  }
});
