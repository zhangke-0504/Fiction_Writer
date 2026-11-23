import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BookView,
  LibraryView,
  Manuscript,
  RuntimeView,
  WriteReport,
} from '../../shared/contracts';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
async function create(page: Page, title: string, summary = '故事简介', genre = '') {
  await button(page, '新建小说').click();
  await page.getByLabel('小说名').fill(title);
  await page.getByLabel('简介').fill(summary);
  if (genre) await page.getByLabel('题材').fill(genre);
  await button(page, '创建小说').click();
  await expect(button(page, `编辑 ${title}`)).toBeVisible();
}
async function chapter(page: Page, title: string) {
  await button(page, '新建章节').click();
  await page.getByLabel('章节名').fill(title);
  await button(page, '创建').click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

test('offline library search, metadata edits, three subject groups, linked clues and chapters', async ({}, info) => {
  const root = info.outputPath('app');
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root },
  });
  try {
    const page = await app.firstWindow();
    await create(page, '灯塔笔记');
    await create(page, '海上清晨');
    await create(page, '另一本', '另一部作品', '灯塔类');
    const books = (await rpc<LibraryView>(page, 'library.list')).books,
      id = books.find((b) => b.title === '灯塔笔记')!.id,
      author = books.find((b) => b.title === '海上清晨')!;
    const doc = await rpc<Manuscript>(page, 'book.doc.read', {
      bookId: author.id,
      doc: { type: 'book', id: author.id },
    });
    expect(
      (
        await rpc<WriteReport>(page, 'book.doc.write', {
          bookId: author.id,
          doc: { ...doc, fields: { ...doc.fields, author: '望灯塔' } },
        })
      ).error,
    ).toBeUndefined();
    await page.getByLabel('搜索书库').fill('灯塔');
    await expect(button(page, '编辑 灯塔笔记')).toBeVisible();
    await expect(button(page, '编辑 海上清晨')).toBeVisible();
    await expect(button(page, '编辑 另一本')).toHaveCount(0);
    await button(page, '编辑 灯塔笔记').click();
    await page.getByLabel('小说名').fill('雾中灯塔');
    await page.getByLabel('文风').fill('克制');
    await button(page, '保存基本信息').click();
    await expect(page.locator('.workspace-brand')).toContainText('雾中灯塔');
    await chapter(page, '归航');
    await chapter(page, '点灯');
    await button(page, '上移章节').click();
    await expect(page.locator('.chapter-row').first()).toContainText('点灯');
    await button(page, '重命名章节').click();
    await page.getByLabel('章节名').fill('燃灯');
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: '燃灯', exact: true })).toBeVisible();
    await page.getByLabel('查找章节').fill('燃');
    await expect(button(page, '归航')).toHaveCount(0);
    await page.getByLabel('查找章节').fill('');
    await button(page, '主体').click();
    for (const [kind, name] of [
      ['character', '守塔人'],
      ['item', '旧灯'],
      ['scene', '海岬'],
    ]) {
      await button(page, '新建主体').click();
      await page.getByLabel('名称').fill(name);
      await page.getByLabel('主体类型').selectOption(kind);
      await page.getByLabel('说明').fill(`${name}的说明`);
      await button(page, '创建').click();
      await expect(button(page, name)).toBeVisible();
    }
    await button(page, '旧灯').click();
    await button(page, '编辑资料').click();
    await page.getByLabel('说明').fill('午夜点亮');
    await button(page, '保存').click();
    await expect(page.getByText('午夜点亮', { exact: true })).toBeVisible();
    await button(page, '伏笔').click();
    await button(page, '新建伏笔').click();
    await page.getByLabel('名称').fill('灯光约定');
    await page.getByLabel('说明').fill('光芒将引导归航');
    await page.getByLabel('旧灯', { exact: true }).check();
    await page.getByLabel('埋设章节').selectOption({ label: '燃灯' });
    await page.getByLabel('回收章节').selectOption({ label: '归航' });
    await button(page, '创建').click();
    await page.getByRole('button', { name: /灯光约定/ }).click();
    await expect(page.locator('.references')).toContainText('旧灯');
    await button(page, '大纲').click();
    const editor = page.getByLabel('Markdown 编辑器');
    await editor.fill('# 第一幕');
    await button(page, '保存').click();
    await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    await button(page, '归航').click();
    await button(page, '删除章节').click();
    await expect(button(page, '归航')).toHaveCount(0);
    await button(page, '伏笔').click();
    await page.getByRole('button', { name: /灯光约定/ }).click();
    await expect(page.locator('.references')).toContainText('未设置');
    await page.reload();
    await button(page, '编辑 雾中灯塔').click();
    await button(page, '大纲').click();
    await expect(editor).toHaveText('# 第一幕');
    await button(page, '返回书库').click();
    await button(page, '删除 雾中灯塔').click();
    await expect(button(page, '编辑 雾中灯塔')).toHaveCount(0);
    await expect(access(join(root, 'library', id))).rejects.toThrow();
  } finally {
    await app.close();
  }
});

test('external file writes refresh a selected chapter; deleting a live book retains read-only history', async ({}, info) => {
  const root = info.outputPath('app'),
    app = await electron.launch({
      args: ['.'],
      env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root },
    });
  try {
    const page = await app.firstWindow();
    await create(page, '实验作品');
    await button(page, '编辑 实验作品').click();
    await chapter(page, '潮声');
    const bookId = (await rpc<LibraryView>(page, 'library.list')).books[0].id;
    const chapterId = (await rpc<BookView>(page, 'book.read', { bookId })).documents.find(
      (d) => d.type === 'chapter',
    )!.id;
    const file = join(root, 'library', bookId, 'chapters', chapterId + '.md');
    const editor = page.getByLabel('Markdown 编辑器');
    await expect(editor).toBeVisible();
    await writeFile(file, (await readFile(file, 'utf8')) + '外部磁盘文本。', 'utf8');
    await expect(editor).toHaveText('外部磁盘文本。');
    const run = await rpc<{ sessionId: string }>(page, 'test.start', { bookId, chapterId });
    await expect(page.getByText('生成中 · 未保存')).toBeVisible();
    await button(page, '返回书库').click();
    await button(page, '删除 实验作品').click();
    await expect(button(page, '编辑 实验作品')).toHaveCount(0);
    const snap = await rpc<RuntimeView>(page, 'runtime.snapshot');
    const history = snap.sessions.find((s) => s.session.id === run.sessionId);
    expect(history?.run?.status).toBe('cancelled');
    expect(history?.session.missing).toBe(true);
    await expect(access(join(root, 'library', bookId))).rejects.toThrow();
  } finally {
    await app.close();
  }
});

test('basic information keeps an unsaved form when a new file revision arrives', async ({}, info) => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: info.outputPath('app') },
  });
  try {
    const page = await app.firstWindow();
    await create(page, '灯塔', '磁盘原简介');
    await button(page, '编辑 灯塔').click();
    const id = (await rpc<LibraryView>(page, 'library.list')).books[0].id;
    const read = () => rpc<Manuscript>(page, 'book.doc.read', { bookId: id, doc: { type: 'book', id } });
    const save = button(page, '保存基本信息');
    await page.getByLabel('小说名').fill('未保存的书名');
    await page.getByLabel('简介').fill('未保存的简介');
    await button(page, '主体').click();
    await button(page, '基本信息').click();
    await expect(page.getByLabel('小说名')).toHaveValue('未保存的书名');
    const original = await read();
    expect(original.body).toBe('磁盘原简介');
    const background = await rpc<WriteReport>(page, 'book.doc.write', {
      bookId: id,
      doc: { ...original, fields: { ...original.fields, style: '后台修改的文风' } },
    });
    expect(background.error).toBeUndefined();
    await expect(page.getByText(/磁盘上的文档已变化/)).toBeVisible();
    await expect(page.getByLabel('小说名')).toHaveValue('未保存的书名');
    await expect(page.getByLabel('简介')).toHaveValue('未保存的简介');
    await expect(save).toBeDisabled();
    await button(page, '返回书库').click();
    await button(page, '编辑 灯塔').click();
    await expect(page.getByLabel('简介')).toHaveValue('未保存的简介');
    await expect(save).toBeDisabled();
    expect((await read()).fields.style).toBe('后台修改的文风');
    await button(page, '重载文件').click();
    await expect(page.getByLabel('小说名')).toHaveValue('灯塔');
    await expect(page.getByLabel('文风')).toHaveValue('后台修改的文风');
    await page.getByLabel('简介').fill('确认后的简介');
    await save.click();
    await expect.poll(async () => (await read()).body).toBe('确认后的简介');
    await expect(page.getByText(/磁盘上的文档已变化/)).toHaveCount(0);
    expect((await read()).fields.style).toBe('后台修改的文风');
  } finally {
    await app.close();
  }
});

test('a missed book-change event is recovered from the next runtime sequence gap without focusing the window', async ({}, info) => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: info.outputPath('app') },
  });
  try {
    const page = await app.firstWindow();
    await create(page, '缺帧补读');
    await button(page, '编辑 缺帧补读').click();
    await chapter(page, '海边');
    const bookId = (await rpc<LibraryView>(page, 'library.list')).books[0].id;
    const chapterId = (await rpc<BookView>(page, 'book.read', { bookId })).documents.find(
      (d) => d.type === 'chapter',
    )!.id;
    await button(page, '主体').click();
    await expect(page.getByText('尚无物品资料')).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents);
      contents.send = (channel, ...args) => {
        if (channel === 'fw:push' && ['book-change', 'focus'].includes(args[0]?.type)) return;
        send(channel, ...args);
      };
    });
    await rpc(page, 'test.start', { bookId, chapterId });
    await expect
      .poll(
        async () =>
          (await rpc<RuntimeView>(page, 'runtime.snapshot')).sessions[0]?.run?.preview?.chapterId,
      )
      .toBe(chapterId);
    await expect(button(page, '潮汐钥匙')).toBeVisible();
  } finally {
    await app.close();
  }
});
