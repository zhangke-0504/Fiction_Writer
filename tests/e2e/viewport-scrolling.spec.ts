import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  BookSummary,
  BookView,
  Change,
  Manuscript,
  ModelProfile,
  RuntimeView,
  Session,
  WriteReport,
} from '../../shared/contracts';

const title = '窗口滚动验收';
const subjectName = '界面创建的长主体';
const clueName = '界面创建的长伏笔';
const longBody = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行测试正文`).join('\n');
const windowSizes = [
  [1320, 900],
  [760, 540],
] as const;

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
const launch = (root: string) =>
  electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root, FW_E2E_SHOW_WINDOW: '0' },
  });

async function resize(app: ElectronApplication, page: Page, size: readonly [number, number]) {
  const win = await app.browserWindow(page);
  await win.evaluate((window, [width, height]) => window.setSize(width, height), size);
  // Windows can round window bounds when converting between DIP and physical pixels.
  await expect
    .poll(async () => {
      const [width, height] = await win.evaluate((window) => window.getSize());
      return Math.max(Math.abs(width - size[0]), Math.abs(height - size[1]));
    })
    .toBeLessThanOrEqual(3);
  const contentSize = await win.evaluate((window) => window.getContentSize());
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(contentSize);
}

async function seedBook(page: Page) {
  const { id: bookId } = await rpc<BookSummary>(page, 'book.create', {
    title,
    summary: '窗口验收数据。',
  });
  const outline = { type: 'outline', id: 'outline' } as const;
  const doc = await rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: outline });
  const changes: Change[] = [{ ...outline, expect: doc.revision, fields: doc.fields, body: longBody }];
  for (let index = 1; index <= 28; index++) {
    changes.push(
      {
        type: 'chapter',
        id: `chapter-${index}`,
        expect: null,
        fields: { title: `测试章节 ${index}`, order: index },
        body: longBody,
      },
      {
        type: 'subject',
        id: `subject-${index}`,
        expect: null,
        fields: { name: `测试人物 ${index}`, kind: 'character' },
        body: longBody,
      },
      {
        type: 'clue',
        id: `clue-${index}`,
        expect: null,
        fields: { title: `测试伏笔 ${index}` },
        body: longBody,
      },
    );
  }
  const result = await rpc<WriteReport>(page, 'book.changes.write', { bookId, changes });
  expect(result.error).toBeUndefined();
  expect(result.committed).toHaveLength(changes.length);
  await button(page, `编辑 ${title}`).click();
  return bookId;
}

async function expectRootFixed(page: Page) {
  const root = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    return {
      extraHeight: doc.scrollHeight - doc.clientHeight,
      extraWidth: doc.scrollWidth - doc.clientWidth,
      scrollTop: doc.scrollTop,
      scrollLeft: doc.scrollLeft,
    };
  });
  expect(root).toEqual({ extraHeight: 0, extraWidth: 0, scrollTop: 0, scrollLeft: 0 });
}

const scrollTop = (region: Locator) => region.evaluate((el) => el.scrollTop);
const distanceToBottom = (region: Locator) =>
  region.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
// Chromium reports integer dimensions and fractional positions at non-integer display scaling.
const scrollEdgeTolerance = 2;

async function wheel(page: Page, region: Locator, delta: number, position?: { x: number; y: number }) {
  const target = await region.boundingBox();
  expect(target).not.toBeNull();
  const { x, y, width, height } = target!;
  await page.mouse.move(x + (position?.x ?? width / 2), y + (position?.y ?? height / 2));
  await page.mouse.wheel(0, delta);
}

async function checkWheel(
  page: Page,
  region: Locator,
  neighbor?: Locator,
  position?: { x: number; y: number },
) {
  await region.evaluate((el) => (el.scrollTop = 0));
  const neighborTop = neighbor && (await scrollTop(neighbor));
  expect(await distanceToBottom(region)).toBeGreaterThan(0);
  await wheel(page, region, 100_000, position);
  await expect.poll(() => distanceToBottom(region)).toBeLessThanOrEqual(scrollEdgeTolerance);
  expect(await scrollTop(region)).toBeGreaterThan(0);
  await page.mouse.wheel(0, 600);
  // At a boundary there is no scroll event to await, and hidden windows can throttle animation frames.
  await delay(75);
  await expectRootFixed(page);
  if (neighbor) expect(await scrollTop(neighbor)).toBe(neighborTop);
}

async function checkThumb(page: Page, region: Locator, neighbor: Locator, startAtCenter = false) {
  const { x, y, travel, barWidth } = await region.evaluate((el, startAtCenter) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const left = Number.parseFloat(style.borderLeftWidth);
    const right = Number.parseFloat(style.borderRightWidth);
    const barWidth = (el as HTMLElement).offsetWidth - el.clientWidth - left - right;
    el.scrollTop = startAtCenter ? (el.scrollHeight - el.clientHeight) / 2 : 0;
    return {
      x: box.right - right - barWidth / 2,
      y: startAtCenter
        ? (box.top + box.bottom) / 2
        : box.top +
          barWidth +
          ((el.clientHeight - 2 * barWidth) * (el.clientHeight / el.scrollHeight)) / 2,
      travel: box.height * 0.2,
      barWidth,
    };
  }, startAtCenter);
  expect(barWidth).toBeGreaterThan(0);
  const before = await scrollTop(region);
  const neighborTop = await scrollTop(neighbor);
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    expect(Math.abs((await scrollTop(region)) - before)).toBeLessThanOrEqual(scrollEdgeTolerance);
    await page.mouse.move(x, y + travel, { steps: 6 });
    await expect.poll(() => scrollTop(region)).toBeGreaterThan(before + scrollEdgeTolerance);
  } finally {
    await page.mouse.up();
  }
  await expectRootFixed(page);
  expect(await scrollTop(neighbor)).toBe(neighborTop);
}

test('long chapter, subject, clue and outline regions scroll independently within the window', async ({}, info) => {
  test.setTimeout(300_000);
  const app = await launch(info.outputPath('app'));
  try {
    const page = await app.firstWindow();
    const bookId = await seedBook(page);
    const heading = (name: string) => page.getByRole('heading', { name, exact: true });
    const chapters = page.locator('.chapter-list');
    const content = page.locator('.workspace-content');
    const editor = page.locator('.cm-scroller');
    const dialog = page.getByRole('dialog');

    await resize(app, page, windowSizes[1]);
    await button(page, '主体').click();
    await button(page, '新建主体').click();
    await dialog.getByLabel('名称').fill(subjectName);
    await dialog.getByLabel('主体类型').selectOption('scene');
    await dialog.getByLabel('说明').fill(longBody);
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(dialog).toBeHidden();

    await button(page, '伏笔').click();
    await button(page, '新建伏笔').click();
    await dialog.getByLabel('名称').fill(clueName);
    await dialog.getByLabel('说明').fill(longBody);
    await checkWheel(page, dialog, chapters, { x: 8, y: 20 });
    await dialog.getByLabel(subjectName, { exact: true }).check();
    await dialog.getByLabel('埋设章节').selectOption('chapter-1');
    await dialog.getByLabel('回收章节').selectOption('chapter-28');
    await expect(dialog.getByRole('button', { name: '创建', exact: true })).toBeInViewport({ ratio: 1 });
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(dialog).toBeHidden();

    for (const size of windowSizes) {
      await resize(app, page, size);
      await button(page, '主体').click();
      await checkWheel(page, chapters, content);
      await expect(button(page, '测试章节 28')).toBeInViewport();
      await expect(page.getByLabel('查找章节')).toBeInViewport({ ratio: 1 });
      await expect(button(page, '新建章节')).toBeInViewport({ ratio: 1 });
      if (size === windowSizes[0]) await checkThumb(page, chapters, content);

      for (const [section, name] of [
        ['主体', subjectName],
        ['伏笔', clueName],
      ] as const) {
        await button(page, section).click();
        await checkWheel(page, content, chapters);
        await expect(heading(section)).toBeInViewport({ ratio: 1 });
        await expect(button(page, `新建${section}`)).toBeInViewport({ ratio: 1 });
        if (section === '主体') {
          await content.evaluate((el) => (el.scrollTop = 0));
          await content.press('PageDown');
          await expect.poll(() => scrollTop(content)).toBeGreaterThan(0);
        }

        const asset = content.getByRole('button', { name: new RegExp(`^${name}`) });
        await asset.scrollIntoViewIfNeeded();
        const listTop = await scrollTop(content);
        await asset.click();
        await expect(heading(name)).toBeVisible();
        expect(await scrollTop(content)).toBe(0);
        if (section === '主体' && size === windowSizes[0]) await checkThumb(page, content, chapters);
        await checkWheel(page, content, chapters);
        await expect(content.locator('.asset-body')).toContainText('第 60 行测试正文');
        if (section === '伏笔') {
          const links = content.locator('.references');
          await expect(links).toBeInViewport();
          await expect(links).toContainText(subjectName);
          await expect(links).toContainText('测试章节 1');
          await expect(links).toContainText('测试章节 28');
        }
        const back = button(page, `返回${section}列表`);
        await expect(back).toBeInViewport({ ratio: 1 });
        await expect(button(page, '编辑资料')).toBeInViewport({ ratio: 1 });
        await back.click();
        await expect.poll(() => scrollTop(content)).toBe(listTop);
      }

      await button(page, 'Harness').click();
      for (const name of ['大纲', '测试章节 28']) {
        await button(page, name).click();
        await expect(heading(name)).toBeVisible();
        await checkWheel(page, editor, chapters);
        await expect(button(page, '保存')).toBeInViewport({ ratio: 1 });
      }
      await button(page, '关闭 Harness').click();
    }

    await button(page, '主体').click();
    await button(page, subjectName).click();
    await expect(heading(subjectName)).toBeVisible();
    await wheel(page, content, 160);
    await expect.poll(() => scrollTop(content)).toBeGreaterThan(0);
    const readingTop = await scrollTop(content);
    const book = await rpc<BookView>(page, 'book.read', { bookId });
    const subject = book.documents.find((doc) => doc.fields.name === subjectName)!;
    const result = await rpc<WriteReport>(page, 'book.doc.write', {
      bookId,
      doc: { ...subject, body: `${longBody}\n后台补充资料` },
    });
    expect(result.error).toBeUndefined();
    await expect(content.locator('.asset-body')).toContainText('后台补充资料');
    expect(await scrollTop(content)).toBe(readingTop);

    await button(page, '基本信息').click();
    await button(page, '保存基本信息').scrollIntoViewIfNeeded();
    await expect(button(page, '保存基本信息')).toBeInViewport({ ratio: 1 });
    await expectRootFixed(page);
  } finally {
    await app.close();
  }
});

test('Harness keeps its scroll regions and composer accessible in a short window', async ({}, info) => {
  test.setTimeout(180_000);
  const columns = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 栏`);
  const longCodeLine = 'chapters/example-scene/'.repeat(20);
  const wideMarkdown = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    `| ${columns.map(() => '章节资料').join(' | ')} |`,
    '',
    '```text',
    longCodeLine,
    '```',
  ].join('\n');
  let replies = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    for await (const _ of request) {
      /* Consume the request before sending the fixture response. */
    }
    const index = ++replies;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: `## 对话回复 ${index}\n\n${wideMarkdown}\n\n${longBody}` },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ])
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let app: ElectronApplication | undefined;
  try {
    app = await launch(info.outputPath('app'));
    const page = await app.firstWindow();
    const bookId = await seedBook(page);
    const profile = await rpc<ModelProfile>(page, 'profiles.save', {
      name: '滚动验收模型',
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: 'messages',
      apiKey: 'fixture-key',
    });
    for (let index = 0; index < 25; index++) await rpc<Session>(page, 'session.create', { bookId });
    await button(page, '主体').click();
    await button(page, 'Harness').click();
    const panel = page.getByRole('complementary', { name: 'Harness 面板' });
    const list = panel.locator('.session-list');
    const content = page.locator('.workspace-content');
    const field = panel.getByLabel('给 Agent 的消息');
    const feed = panel.getByLabel('对话消息');
    const send = button(page, '发送');

    await checkWheel(page, list, content);
    await expect(panel.locator('.session-row').last()).toBeInViewport();
    await expect(button(page, '新建会话')).toBeInViewport({ ratio: 1 });
    await button(page, '新建会话').click();
    await panel.getByLabel('模型').selectOption(profile.id);
    await field.fill('用本地夹具准备长对话');
    await send.click();
    await expect(feed.locator('article.assistant').last()).toContainText('对话回复 1');
    await expect.poll(() => distanceToBottom(feed)).toBeLessThanOrEqual(scrollEdgeTolerance);

    const sessions = await rpc<RuntimeView>(page, 'runtime.snapshot');
    const active = sessions.sessions.find((session) => session.messages.length > 0)!;
    const runStatus = async () =>
      (await rpc<RuntimeView>(page, 'runtime.snapshot')).sessions.find(
        (session) => session.session.id === active.session.id,
      )?.run?.status;
    await expect.poll(runStatus).toBe('completed');
    const requestReply = async (index: number) => {
      await rpc(page, 'session.start', {
        id: active.session.id,
        profileId: profile.id,
        effort: 'low',
        prompt: `追加夹具消息 ${index}`,
      });
      await expect(feed.locator('article.assistant').last()).toContainText(`对话回复 ${index}`);
      await expect.poll(runStatus).toBe('completed');
    };

    await resize(app, page, windowSizes[1]);
    await wheel(page, feed, -100_000);
    await expect.poll(() => scrollTop(feed)).toBe(0);
    const firstReply = feed.locator('article.assistant').first();
    await expect(firstReply.getByRole('heading', { name: '对话回复 1' })).toBeVisible();
    await expect(firstReply.getByRole('columnheader')).toHaveCount(columns.length);
    await expect(firstReply.locator('pre > code')).toHaveText(longCodeLine);
    const feedWidth = await feed.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(feedWidth).toBeLessThanOrEqual(scrollEdgeTolerance);
    for (const block of [firstReply.locator('.chat-table-scroll'), firstReply.locator('pre')]) {
      const { overflowX, scrollLeft } = await block.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
        return { overflowX: getComputedStyle(el).overflowX, scrollLeft: el.scrollLeft };
      });
      expect(overflowX).toMatch(/^(auto|scroll)$/);
      expect(scrollLeft).toBeGreaterThan(scrollEdgeTolerance);
    }
    expect(await scrollTop(feed)).toBe(0);
    await expectRootFixed(page);
    await requestReply(2);
    expect(await scrollTop(feed)).toBe(0);
    await checkThumb(page, feed, content, true);
    await checkWheel(page, feed, content);
    await requestReply(3);
    await expect.poll(() => distanceToBottom(feed)).toBeLessThanOrEqual(scrollEdgeTolerance);

    const attachments = Array.from({ length: 18 }, (_, index) =>
      info.outputPath(`viewport-reference-${index}.md`),
    );
    await Promise.all(attachments.map((path) => writeFile(path, '合成参考资料', 'utf8')));
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
    }, attachments);
    await button(page, '添加参考文件').click();
    await expect(panel.locator('.attachment')).toHaveCount(attachments.length);
    await field.fill('多附件时保留输入和发送');
    await expect(field).toBeInViewport({ ratio: 1 });
    await expect(send).toBeInViewport({ ratio: 1 });
    await expect(send).toBeEnabled();
    await checkWheel(page, feed, content);
    await button(page, 'Session 历史').click();
    await checkWheel(page, list, content);
    await expect(panel.locator('.session-row').last()).toBeInViewport();

    await button(page, '设置').click();
    await button(page, '新建配置').click();
    await page.getByRole('button', { name: /自定义配置/ }).click();
    await page.getByText('高级选项', { exact: true }).click();
    await button(page, '保存配置').scrollIntoViewIfNeeded();
    await expect(button(page, '保存配置')).toBeInViewport({ ratio: 1 });
    await expectRootFixed(page);
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
