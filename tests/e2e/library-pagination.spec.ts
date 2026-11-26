import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryView } from '../../shared/contracts';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function expectRowsToFit(page: Page) {
  const fits = await page.locator('.library-list').evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return (
      list.scrollTop === 0 &&
      Array.from(list.querySelectorAll('.book-row'), (row) => row.getBoundingClientRect()).every(
        (row) => row.top >= bounds.top && row.bottom <= bounds.bottom - 1,
      )
    );
  });
  expect(fits).toBe(true);
  const root = await page.evaluate(() => {
    const documentRoot = document.scrollingElement!;
    return [documentRoot.scrollHeight - documentRoot.clientHeight, documentRoot.scrollTop];
  });
  expect(root).toEqual([0, 0]);
}

test('library pages fit the window and preserve search and navigation through data changes', async ({}, info) => {
  test.setTimeout(100_000);
  const root = info.outputPath('app');
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root, FW_E2E_SHOW_WINDOW: '0' },
  });
  try {
    const page = await app.firstWindow();
    const win = await app.browserWindow(page);
    const resize = async (width: number, height: number) => {
      await win.evaluate((window, size) => window.setSize(...size), [width, height] as const);
      const contentSize = await win.evaluate((window) => window.getContentSize());
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(contentSize);
    };
    const longTitle = `Paged Zeta ${'特别长的书名'.repeat(40)}`;
    const seededTitles = Array.from(
      { length: 13 },
      (_, index) => `Paged ${String(index + 1).padStart(2, '0')}`,
    );
    seededTitles.push(longTitle);
    const library = await page.evaluate(async (titles) => {
      for (const title of titles) {
        await window.fw.request('book.create', {
          title,
          summary: '分页测试简介。',
          genre: '仅出现在题材',
        });
      }
      return window.fw.request<LibraryView>('library.list');
    }, seededTitles);
    const expected = library.books.map((book) => book.title);
    await mkdir(join(root, 'library', 'broken-pagination-book'));
    await page.reload();

    const titles = page.locator('.book-title');
    const pagination = page.getByRole('navigation', { name: '书库分页' });
    const previous = button(page, '上一页');
    const next = button(page, '下一页');
    const query = page.getByRole('textbox', { name: '搜索书库' });
    const currentTitles = () => titles.allTextContents();

    await resize(1320, 900);
    await expect(next).toBeEnabled();
    const tallCount = await titles.count();
    await next.click();
    const anchor = (await currentTitles())[0];
    await resize(760, 540);
    await expect.poll(() => titles.count()).toBeLessThan(tallCount);
    await expect(page.getByRole('button', { name: anchor, exact: true })).toBeInViewport({ ratio: 1 });
    await expect(pagination).toBeInViewport({ ratio: 1 });

    const diagnostic = page.getByRole('button', { name: /^书库读取提示/ });
    await diagnostic.click();
    const dialog = page.getByRole('dialog', { name: '书库读取提示' });
    await expect(dialog).toContainText('broken-pagination-book');
    await dialog.getByRole('button', { name: '关闭' }).click();

    await query.fill('Paged');
    await expect(previous).toBeDisabled();
    const pages: string[][] = [];
    while (true) {
      await expectRowsToFit(page);
      await expect(pagination).toBeInViewport({ ratio: 1 });
      pages.push(await currentTitles());
      if (await next.isDisabled()) break;
      await next.click();
      await expect(titles.first()).not.toHaveText(pages.at(-1)![0]);
    }
    expect(pages.flat()).toEqual(expected);
    expect(pages.length).toBeGreaterThan(1);
    await expect(button(page, `编辑 ${longTitle}`)).toBeInViewport({ ratio: 1 });

    const pageNumber = pagination.locator('[aria-live]');
    const lastPage = await pageNumber.innerText();
    await button(page, `编辑 ${longTitle}`).click();
    await button(page, '返回书库').click();
    await expect(query).toHaveValue('Paged');
    await expect(pageNumber).toHaveText(lastPage);
    await expect(button(page, `编辑 ${longTitle}`)).toBeInViewport({ ratio: 1 });

    await query.fill('Paged 01');
    await expect(titles).toHaveText(['Paged 01']);
    await expect(pagination).toHaveCount(0);
    await query.fill('仅出现在题材');
    await expect(titles).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '没有匹配的小说' })).toBeVisible();

    const createdTitle = 'Paged ZZ 新书定位';
    await button(page, '新建小说').click();
    await page.getByLabel('小说名').fill(createdTitle);
    await page.getByLabel('简介').fill('定位到新作品的页面。');
    await button(page, '创建小说').click();
    await expect(query).toHaveValue('');
    await expect(button(page, `编辑 ${createdTitle}`)).toBeInViewport({ ratio: 1 });

    await expect(next).toBeDisabled();
    const lastPageTitles = await currentTitles();
    const previousFirstTitle = expected[expected.length + 1 - lastPageTitles.length - pages[0].length];
    for (const title of lastPageTitles) {
      const remove = button(page, `删除 ${title}`);
      await remove.click();
      await expect(remove).toHaveCount(0);
    }
    await expect(next).toBeDisabled();
    await expect(titles.first()).toHaveText(previousFirstTitle);
    await expectRowsToFit(page);
  } finally {
    await app.close();
  }
});
