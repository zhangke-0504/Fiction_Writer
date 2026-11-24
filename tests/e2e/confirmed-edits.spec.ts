import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BookView, Manuscript, RuntimeView, WriteReport } from '../../shared/contracts';
import { readDiagnostics } from './diagnostic-files';

const planning =
  '加一个暗线的反派，跟2个以上的人物主体有关联，剧情中期出现该反派的种种迹象，后期剧情抛头露面。你看看要改哪些内容才能把这个反派合理的加到当前小说里';
const confirmed = '嗯，就按这个来改';
const known = ['captain', 'witness'];
const actor = 'notary';
const clue = 'marked-coin';
const ch = (n: number) => `ch${String(n).padStart(2, '0')}`;
const anchor = (n: number) => `一行水手抬头望向第 ${n} 座灯塔。`;
const scenes = [4, 6, 9];
const pieces = scenes.map((n) =>
  n === 9
    ? '账房先生登上甲板，举起那枚刻着船名的铜币。'
    : `第 ${n} 座灯塔的门缝里浮出一枚刻着船名的铜币。`,
);
const hiddenTruth = '铜币原是向黑港交出的赌债押金';
const structured = {
  summary: '用铜币贯穿两处迹象，在后段让账房先生现身。',
  assets: [
    {
      kind: 'subject',
      action: 'create',
      id: actor,
      fields: { name: '账房先生', kind: 'character' },
      relatedSubjectIds: known,
    },
    {
      kind: 'clue',
      action: 'create',
      id: clue,
      fields: {
        title: '刻痕铜币',
        setupChapterId: ch(4),
        payoffChapterId: ch(10),
        subjectIds: [actor, ...known],
      },
    },
  ],
  passages: scenes.map((n) => ({
    id: `change-${n}`,
    chapterId: ch(n),
    stage: n === 9 ? 'reveal' : 'setup',
    note: n === 9 ? '账房先生实际出现' : '只呈现铜币与刻痕，不揭开来源',
  })),
};
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
const digest = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');
function reply(res: ServerResponse, spec: string | { id: string; name: string; input: object }) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const text = typeof spec === 'string';
  const events = [
    {
      type: 'content_block_start',
      index: 0,
      content_block: text ? { type: 'text', text: spec } : { type: 'tool_use', ...spec },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: text ? 'end_turn' : 'tool_use' } },
    { type: 'message_stop' },
  ];
  res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
}

test('a natural-language confirmation on the same Writer session commits the displayed multi-chapter plan', async ({}, info) => {
  const root = info.outputPath('app');
  const wires: any[] = [];
  const call = (name: string, input: object) => ({ id: `call-${wires.length}`, name, input });
  let id: string;
  const read = async (relative: string) => readFile(join(root, 'library', id, relative));
  const server = createServer(async (req, res) => {
    let source = '';
    for await (const chunk of req) source += chunk;
    const wire = JSON.parse(source);
    wires.push(wire);
    switch (wires.length) {
      case 1:
        return reply(res, call('book_propose_edits', structured));
      case 2:
        return reply(res, '给出方案，等待作者决定。');
      case 3:
        return reply(
          res,
          call('book_generate_assets', { kind: 'subject', action: 'create', targets: [{ id: actor }] }),
        );
      case 4:
        return reply(
          res,
          call('submit_story_descriptions', {
            items: [{ id: actor, body: '## 稳定设定\n账房先生认得船长和瞭望员。' }],
          }),
        );
      case 5:
        return reply(
          res,
          call('book_generate_assets', { kind: 'clue', action: 'create', targets: [{ id: clue }] }),
        );
      case 6:
        return reply(
          res,
          call('submit_story_descriptions', {
            items: [
              {
                id: clue,
                body: `## 可见线索\n铜币刻了船名。\n\n## 回收真相\n揭示事实：${hiddenTruth}。`,
              },
            ],
          }),
        );
      case 7:
      case 9:
      case 11: {
        const n = scenes[(wires.length - 7) / 2];
        return reply(
          res,
          call('book_generate_chapter', {
            chapterId: ch(n),
            mode: 'insert',
            insertion: {
              targetId: `change-${n}`,
              quote: anchor(n),
              place: 'before',
              revision: digest(await read(`chapters/${ch(n)}.md`)),
              outline: {
                revision: digest(await read('outline.md')),
                addition: `仅增补 ${ch(n)} 的铜币情节。`,
              },
            },
          }),
        );
      }
      case 8:
      case 10:
      case 12:
        return reply(res, pieces[(wires.length - 8) / 2]);
      case 13:
      case 15:
        return reply(
          res,
          call('book_generate_assets', {
            kind: wires.length === 13 ? 'subject' : 'clue',
            action: 'update',
            targets: [{ id: wires.length === 13 ? actor : clue }],
          }),
        );
      case 14:
      case 16:
        return reply(
          res,
          call('submit_story_sync', {
            evidence: scenes.map((n, i) => ({
              source: i + 1,
              status:
                wires.length === 14 && n === 9
                  ? 'appearance'
                  : wires.length === 16 && i === 0
                    ? 'setup'
                    : 'trace',
              excerpt: 1,
            })),
            edits: [],
          }),
        );
      default:
        return reply(res, '已提交已确认方案的七项修改。');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root, FW_E2E_SHOW_WINDOW: '0' },
  });
  try {
    const page = await app.firstWindow();
    await rpc(page, 'profiles.save', {
      name: '夹具',
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${port}`,
      protocol: 'messages',
      apiKey: 'test-only-scope-key',
    });
    ({ id } = await rpc<{ id: string }>(page, 'book.create', {
      title: '暗线确认',
      summary: '完整的十章已经就位。',
    }));
    const outline = await rpc<Manuscript>(page, 'book.doc.read', {
      bookId: id,
      doc: { type: 'outline', id: 'outline' },
    });
    const edited = await rpc<WriteReport>(page, 'book.changes.write', {
      bookId: id,
      changes: [
        ...Array.from({ length: 10 }, (_, i) => ({
          type: 'chapter',
          id: ch(i + 1),
          expect: null,
          fields: { title: `航程 ${i + 1}`, order: i + 1 },
          body: `水道很窄。\n\n${anchor(i + 1)}\n\n船继续向东航行。`,
        })),
        ...known.map((id, i) => ({
          type: 'subject',
          id,
          expect: null,
          fields: { name: ['船长', '瞭望员'][i], kind: 'character' },
          body: '## 稳定设定\n长久以来在海上航行。',
        })),
        {
          ...outline,
          expect: outline.revision,
          body: Array.from(
            { length: 10 },
            (_, i) => `<!-- chapter:${ch(i + 1)} -->\n\n船向东航行。`,
          ).join('\n\n'),
        },
      ],
    });
    expect(edited.error).toBeUndefined();
    const book = (await rpc<BookView>(page, 'book.read', { bookId: id })).documents;
    const files = await Promise.all(scenes.map((n) => read(`chapters/${ch(n)}.md`)));
    await page.reload();
    await page.getByRole('button', { name: '编辑 暗线确认', exact: true }).click();
    await page.getByRole('button', { name: 'Harness', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Harness 面板' });
    await panel.getByRole('button', { name: '当前小说会话', exact: true }).click();
    const send = async (s: string) => {
      const field = panel.getByLabel('给 Agent 的消息');
      await field.fill(s);
      await field.press('Enter');
    };
    const view = async () =>
      (await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId: id })).sessions.find((s) => s.run);
    await send(planning);
    await expect(panel.getByText(/本次建议的修改范围（尚未写入作品）.*ch10 计划回收/su)).toBeVisible();
    const review = await view();
    expect(review?.run?.status).toBe('completed');
    expect((await rpc<BookView>(page, 'book.read', { bookId: id })).documents).toEqual(book);
    await send(confirmed);
    await expect
      .poll(async () => {
        const s = await view();
        return s?.run?.id !== review?.run?.id && s?.run?.status;
      })
      .toBe('completed');
    expect((await view())?.run?.progress).toMatchObject({ done: 7, total: 7, complete: true });
    const now = (await rpc<BookView>(page, 'book.read', { bookId: id })).documents;
    for (const before of book) {
      if (
        before.type === 'outline' ||
        scenes.some((n) => before.type === 'chapter' && before.id === ch(n))
      )
        continue;
      expect(now.find((d) => d.type === before.type && d.id === before.id)).toEqual(before);
    }
    for (const [i, n] of scenes.entries()) {
      const body = (await read(`chapters/${ch(n)}.md`)).toString('utf8');
      expect(body).toContain(pieces[i]);
      expect(body.replace(`${pieces[i]}\n\n`, '')).toBe(files[i].toString('utf8'));
    }
    const subject = (await read(`subjects/${actor}.md`)).toString('utf8');
    expect(subject).toContain(`原文：${pieces[2]}`);
    for (const id of known) expect(subject).toContain(`subjects/${id}.md`);
    const clueDoc = now.find((d) => d.id === clue && d.type === 'clue')!;
    expect(clueDoc.fields).toMatchObject({
      setupChapterId: ch(4),
      payoffChapterId: ch(10),
      subjectIds: [actor, ...known],
    });
    const revised = (await read('outline.md')).toString('utf8');
    for (const n of scenes) expect(revised).toContain(`仅增补 ${ch(n)}`);
    expect(wires).toHaveLength(17);
    expect(JSON.stringify(wires[7])).not.toContain(hiddenTruth);
    expect(JSON.stringify(wires[9])).not.toContain(hiddenTruth);
    expect(JSON.stringify(wires[11])).not.toContain(hiddenTruth);
    expect(revised).not.toContain(hiddenTruth);
    const finished = (await view())!.run!.id;
    await expect
      .poll(
        async () =>
          (await readDiagnostics(root, 'backend')).filter(
            (e) => e.fields.runId === finished && e.event === 'workspace.document.committed',
          ).length,
      )
      .toBe(10);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
