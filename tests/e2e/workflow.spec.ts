import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { readDiagnostics, diagnosticText } from './diagnostic-files';
import type { BookView, LibraryView, Manuscript, RuntimeView } from '../../shared/contracts';

test('generate a novel from the panel and continue chapter two after an application restart', async ({}, info) => {
  const root = info.outputPath('app'),
    env = { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root };
  const steps: string[] = [];
  const resumedRequests: string[] = [];
  const originalDirection = '写两章短篇，全书使用第一人称';
  const readbackMarker = 'ONLY_IN_PRIOR_CHAPTER_FIXTURE',
    missingMarker = 'NO_SUCH_PASSAGE_FIXTURE';
  let selectedReadbacks = 0;
  let allowSecond = false;
  const server = createServer(async (req, res) => {
    let source = '';
    for await (const bytes of req) source += bytes;
    const body = JSON.parse(source),
      user = body.messages.at(-1).content;
    if (
      body.tools?.some(
        (tool: { function: { name: string } }) => tool.function.name === 'book_read_chapter',
      )
    ) {
      selectedReadbacks++;
      const tool_calls = [readbackMarker, missingMarker].map((query, index) => ({
        id: `read_${index}`,
        index,
        function: {
          name: 'book_read_chapter',
          arguments: JSON.stringify({ chapterId: 'one', query, length: 80 }),
        },
      }));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
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
      text = '第一章正文。她坐船离开。' + '海'.repeat(22_000) + readbackMarker + '浪'.repeat(22_000);
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
    expect(resumedRequests[0]).toContain(readbackMarker);
    expect(selectedReadbacks).toBe(2);
    expect((await read('one')).revision).toBe(first.revision);
    expect((await read('two')).body).toContain('她看到了灯');
    expect((await rpc<RuntimeView>('runtime.snapshot')).sessions[0].workflow?.complete).toBe(true);
    await button('归航').click();
    await expect(page.getByLabel('Markdown 编辑器')).toContainText('她看到了灯');
    await page.screenshot({ path: info.outputPath('workspace.png') });
    // From local diaries alone: same checkpoint slot, different boot and Run, only chapter two reruns.
    await expect
      .poll(async () =>
        (await readDiagnostics(root, 'backend'))
          .filter((e) => e.event === 'workflow.finished')
          .map((e) => e.fields.outcome),
      )
      .toEqual(['failed', 'ok']);
    const rows = await readDiagnostics(root, 'backend');
    const terminal = rows.filter((e) => e.event === 'workflow.finished');
    expect(terminal[0].bootId).not.toBe(terminal[1].bootId);
    expect(terminal[0].fields.jobRef).toBeDefined();
    expect(terminal[0].fields.jobRef).toBe(terminal[1].fields.jobRef);
    const beforeRestart = rows.filter((e) => e.fields.runId === terminal[0].fields.runId),
      resumed = rows.filter((e) => e.fields.runId === terminal[1].fields.runId);
    expect(
      beforeRestart.some(
        (e) =>
          e.event === 'workflow.stage.finished' &&
          e.fields.chapterIndex === 1 &&
          e.fields.outcome === 'ok',
      ),
    ).toBe(true);
    expect(
      beforeRestart.some(
        (e) =>
          e.event === 'workflow.stage.finished' &&
          e.fields.chapterIndex === 2 &&
          e.fields.outcome === 'failed',
      ),
    ).toBe(true);
    expect(
      resumed.some(
        (e) =>
          e.event === 'workflow.checkpoint' &&
          e.fields.operation === 'open' &&
          e.fields.reason === 'resume' &&
          e.fields.done === 5,
      ),
    ).toBe(true);
    expect(
      resumed.some(
        (e) =>
          e.event === 'workflow.checkpoint' &&
          e.fields.operation === 'verify' &&
          e.fields.outcome === 'ok',
      ),
    ).toBe(true);
    expect(resumed.find((e) => e.event === 'workflow.chapter.skipped')?.fields).toMatchObject({
      reason: 'already_completed',
      chapterIndex: 1,
    });
    expect(
      resumed.filter((e) => e.event === 'chapter.generation.started').map((e) => e.fields.chapterIndex),
    ).toEqual([2]);
    expect(resumed.filter((e) => e.event === 'model.started').map((e) => e.fields.lane)).toEqual([
      'readback',
      'draft',
    ]);
    expect(resumed.find((e) => e.event === 'chapter.readback.finished')?.fields).toMatchObject({
      hits: 1,
      missing: 1,
      requested: 2,
    });
    expect(resumed.filter((e) => e.event === 'chapter.preview').map((e) => e.fields.outcome)).toEqual([
      'started',
      'cleared',
    ]);
    const requestId = resumed.find((e) => e.event === 'run.started')!.fields.requestId;
    const loaded = rows.filter((e) => e.event === 'skill.loaded' && e.fields.requestId === requestId);
    expect(loaded.map((e) => e.fields.skill).sort()).toEqual([
      'generate-novel',
      'story-consistency',
      'write-chapter',
    ]);
    const applied = resumed.filter((e) => e.event === 'skill.applied');
    expect(applied.map((e) => e.fields.skill)).toEqual(['write-chapter']);
    expect(applied[0].fields.fingerprint).toBe(
      loaded.find((e) => e.fields.skill === 'write-chapter')!.fields.fingerprint,
    );
    expect(
      beforeRestart
        .filter((e) => e.event === 'skill.applied' && e.fields.skill === 'generate-novel')
        .map((e) => e.fields.phase),
    ).toEqual(['outline', 'subjects', 'clues', 'catalog']);
    for (const stream of ['frontend', 'backend'] as const) {
      const text = await diagnosticText(root, stream);
      for (const secret of [readbackMarker, missingMarker, originalDirection, '玻璃灯塔', '她看到了灯'])
        expect(text).not.toContain(secret);
    }
  } finally {
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
