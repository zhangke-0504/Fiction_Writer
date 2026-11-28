import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { callRef, type ToolReceipt } from '../../electron/agent/tool-receipts.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BookView, Manuscript, RuntimeView, WriteReport } from '../../shared/contracts';
import { readDiagnostics } from './diagnostic-files';

const planning =
  '加一个暗线的反派，跟2个以上的人物主体有关联，剧情中期出现该反派的种种迹象，后期剧情抛头露面。你看看要改哪些内容才能把这个反派合理的加到当前小说里';
const confirmed = '嗯，就按这个来改';
const ch = (n: number) => `ch${String(n).padStart(2, '0')}`;
const anchor = (n: number) => `一行水手抬头望向第 ${n} 座灯塔。`;
const hiddenTruth = '铜币原是向黑港交出的赌债押金';
const obsoletePlan = '后期登场：被困的意识原定在船底爬上甲板。';
const retainedPlan = '以后再调查是谁封印了这枚铜币。';
const unrelated = '铜币的保管编号不变。';
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
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

const variants = [
  { label: 'original', request: planning, approval: confirmed },
  {
    label: 'paraphrase',
    request:
      '想个牵涉至少两位现有人物的幕后对手。故事逐渐展开时让读者先发现异常的细节，临近结局才让那人和主角见面。先说明计划，暂时别改稿。',
    approval: '就照刚才列的去修改。',
  },
  {
    label: 'object augmentation without optional new chapter',
    request:
      '请先拟定方案：新增一枚封有新反派意识的铜币，关联至少三位现有人物。前期和中期留下线索，后期实际现身。可以新增章节，但不必。另把第十章望向灯塔的一句改成看见返航信号。先别改稿。',
    approval: '照上面的铜币方案执行，并把第十章望向灯塔的一句改成看见返航信号。',
    object: true,
  },
];
for (const { label, request, approval, object } of variants)
  test(`a natural-language confirmation on the same Writer session commits the displayed multi-chapter plan (${label})`, async ({}, info) => {
    const root = info.outputPath('app');
    const known = object ? ['captain', 'witness', 'helmsman'] : ['captain', 'witness'];
    const actor = object ? 'sealed-coin' : 'notary';
    const clue = 'marked-coin';
    const scenes = object ? [2, 5, 8] : [2, 3, 7]; // Story stages follow the outline, not ordinal thirds.
    const pieces = scenes.map((n) =>
      n === scenes[2]
        ? object
          ? '铜币弹起，一道声音从刻痕中响起，自称黑港的旧主人。'
          : '账房先生登上甲板，举起那枚刻着船名的铜币。'
        : `第 ${n} 座灯塔的门缝里浮出一枚刻着船名的铜币。`,
    );
    const structured = {
      summary: object
        ? '用封印铜币贯穿前中期两处线索，后期让被困意识实际现身。'
        : '用铜币贯穿两处迹象，在后段让账房先生现身。',
      assets: [
        {
          kind: 'subject',
          action: 'create',
          id: actor,
          fields: object ? { name: '封印铜币', kind: 'item' } : { name: '账房先生', kind: 'character' },
          relatedSubjectIds: known,
        },
        {
          kind: 'clue',
          action: 'create',
          id: clue,
          fields: {
            title: '刻痕铜币',
            setupChapterId: ch(scenes[0]),
            payoffChapterId: ch(10),
            subjectIds: [actor, ...known],
          },
        },
      ],
      passages: scenes.map((n) => ({
        id: `change-${n}`,
        chapterId: ch(n),
        stage: n === scenes[2] ? 'reveal' : 'setup',
        note:
          n === scenes[2]
            ? object
              ? '黑港主人的意识实际现身'
              : '账房先生实际出现'
            : '只呈现铜币与刻痕，不揭开来源',
      })),
    };
    const ending = ch(10);
    const newEnding = '水手们看见第十座灯塔闪出返航信号。';
    const pending = '三处增补及资料已保存。只剩第十章灯塔句要改成返航信号。';
    const continuePatch = '继续处理刚才剩下的一句。';
    const patchItem = { operation: 'chapter.patch', id: ending, purpose: '只改第十章灯塔句为返航信号' };
    let following = false;
    const wires: any[] = [];
    let outlineRevision = '';
    const serverErrors: string[] = [];
    let id: string;
    const read = async (relative: string) => readFile(join(root, 'library', id, relative));
    const server = createServer(async (req, res) => {
      let source = '';
      for await (const chunk of req) source += chunk;
      const wire = JSON.parse(source);
      wires.push(wire);
      try {
        const tools = (wire.tools ?? []).map(({ name }: { name: string }) => name);
        const call = (label: string, name: string, input: object) => {
          expect(tools).toContain(name);
          return reply(res, { id: label, name, input });
        };
        const last = wire.messages.at(-1)?.content.at(-1);
        if (tools.length === 1 && tools[0] === 'check_book_scope') {
          if (following) {
            const candidate = JSON.parse(last.text);
            expect(candidate).toMatchObject({
              currentAuthor: continuePatch,
              referencedAssistant: pending,
              candidates: [patchItem],
              previousLocalWork: {
                remaining: [{ operation: 'chapter.patch', id: ending }],
                done: 7,
                total: 8,
              },
            });
          }
          return call('scope-verdict', 'check_book_scope', { allowed: true });
        }
        if (tools.length === 1 && tools[0] === 'submit_chapter_patch_review')
          return call('patch-verdict', tools[0], { allowed: following });
        if (!tools.length && wire.system.includes('指定锚点')) {
          expect(JSON.stringify(wire)).not.toContain(hiddenTruth);
          const n = Number(/"target":\s*\{\s*"id":\s*"ch(\d+)"/u.exec(last.text)?.[1]);
          expect(scenes).toContain(n);
          return reply(res, pieces[scenes.indexOf(n)]);
        }
        if (tools.length === 1 && tools[0] === 'submit_story_descriptions')
          return call('draft-note', 'submit_story_descriptions', {
            items: [
              wire.system.includes('生成主体说明')
                ? {
                    id: actor,
                    body: object
                      ? `## 稳定设定\n船长、瞭望员和舵手都见过封印铜币。黑港的旧主人困在里面。\n\n## 计划\n- ${obsoletePlan}\n- ${retainedPlan}\n\n## 档案\n${unrelated}`
                      : '## 稳定设定\n账房先生认得船长和瞭望员。',
                  }
                : {
                    id: clue,
                    body: `## 可见线索\n铜币刻了船名。\n\n## 回收真相\n揭示事实：${hiddenTruth}。`,
                  },
            ],
          });
        if (tools.length === 1 && tools[0] === 'submit_story_sync') {
          const { asset } = JSON.parse(last.text);
          return call('sync-note', 'submit_story_sync', {
            evidence: scenes.map((n, i) => ({
              source: i + 1,
              status:
                asset.type === 'subject' && n === scenes[2]
                  ? 'appearance'
                  : asset.type === 'clue' && i === 0
                    ? 'setup'
                    : 'trace',
              excerpt: 1,
            })),
            edits: [],
          });
        }
        if (last.type !== 'tool_result') {
          if (last.text === request)
            return call('find-plan', 'tool_search', { query: 'book_propose_edits' });
          if (following) {
            expect(last.text).toBe(continuePatch);
            return call('find-followup', 'tool_search', {
              query: 'book_get_context book_patch_chapter',
            });
          }
          expect(last.text).toBe(approval);
          return call('find-execution', 'tool_search', {
            query: 'book_get_context book_generate_assets book_generate_chapter book_patch_chapter',
          });
        }
        const label = last.tool_use_id;
        const { ok, value, error, reason } = JSON.parse(last.content);
        if (label === 'ending-patch' && !following) {
          expect({ ok, reason }).toEqual({ ok: false, reason: 'patch_scope' });
          return reply(res, pending);
        }
        expect(ok, error).toBe(true);
        const target = (type: string, id: string) => ({ type, documentId: id });
        if (label === 'find-followup')
          return call('followup-scope', 'book_task_scope', { sourceQuote: pending, items: [patchItem] });
        if (label === 'followup-scope' || (object && label === 'sync-clue'))
          return call('ending-read', 'book_get_context', target('chapter', ending));
        if (label === 'ending-read')
          return call('ending-patch', 'book_patch_chapter', {
            chapterId: ending,
            revision: value.document.revision,
            edits: [{ quote: anchor(10), replacement: newEnding }],
          });
        if (label === 'ending-patch') return reply(res, '只补了原先未完成的第十章灯塔句。');
        if (label === 'find-plan') return call('proposal', 'book_propose_edits', structured);
        if (label === 'proposal') return reply(res, '给出方案，等待作者决定。');
        if (label === 'find-execution')
          return call('execute-scope', 'book_task_scope', {
            sourceQuote: structured.summary,
            items: [
              {
                operation: 'subject.create',
                id: actor,
                purpose: object ? '新建关联至少三位既有人物的物品' : '新增账房先生并关联两名已有主体',
                relatedMinimum: known.length,
              },
              { operation: 'clue.create', id: clue, purpose: '刻痕铜币伏笔' },
              ...structured.passages.map((p) => ({
                operation: 'chapter.insert',
                id: p.chapterId,
                purpose: p.note,
                stage: p.stage,
              })),
              ...(object ? [patchItem] : []),
            ],
          });
        if (label === 'execute-scope') {
          const { kind, action, ...asset } = structured.assets[0];
          return call('actor', 'book_generate_assets', { kind, action, targets: [asset] });
        }
        if (label === 'actor') {
          const { kind, action, ...asset } = structured.assets[1];
          return call('clue', 'book_generate_assets', { kind, action, targets: [asset] });
        }
        if (label === 'clue') return call('outline', 'book_get_context', target('outline', 'outline'));
        if (label === 'outline' || label.startsWith('insert-')) {
          outlineRevision = label === 'outline' ? value.document.revision : value.outlineRevision;
          const n =
            label === 'outline' ? scenes[0] : scenes[scenes.indexOf(Number(label.split('-')[1])) + 1];
          if (n) return call(`chapter-${n}`, 'book_get_context', target('chapter', ch(n)));
          return call('sync-scope', 'book_task_scope', {
            sourceQuote: structured.summary,
            items: [
              { operation: 'subject.sync', id: actor, purpose: '按已写定各处事实同步新资料' },
              { operation: 'clue.sync', id: clue, purpose: '同步实际埋设，保留未来回收' },
            ],
          });
        }
        if (label.startsWith('chapter-')) {
          const n = Number(label.split('-')[1]);
          return call(`insert-${n}`, 'book_generate_chapter', {
            chapterId: ch(n),
            mode: 'insert',
            insertion: {
              quote: anchor(n),
              place: 'before',
              revision: value.document.revision,
              outline: { revision: outlineRevision, addition: `仅增补 ${ch(n)} 的铜币情节。` },
            },
            subjectIds: [actor],
            clueIds: [clue],
          });
        }
        if (label === 'sync-scope')
          return call('sync-actor', 'book_generate_assets', {
            kind: 'subject',
            action: 'update',
            targets: [{ id: actor }],
          });
        if (label === 'sync-actor')
          return call('sync-clue', 'book_generate_assets', {
            kind: 'clue',
            action: 'update',
            targets: [{ id: clue }],
          });
        if (label === 'sync-clue') return reply(res, '已提交已确认方案的七项修改。');
        throw new Error(`Unknown fixture stage: ${label}`);
      } catch (error) {
        serverErrors.push(String(error));
        if (!res.headersSent) res.writeHead(500);
        res.end();
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
            body: `水道很窄。\n\n${anchor(i + 1)}\n\n船继续向东航行。${
              object && i === 9
                ? '\n\n舵手把旧海图摊开，沿着岸上的礁石标出一条安全路线。瞭望员收起望远镜。'
                : ''
            }`,
          })),
          ...known.map((id, i) => ({
            type: 'subject',
            id,
            expect: null,
            fields: { name: ['船长', '瞭望员', '舵手'][i], kind: 'character' },
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
      await send(request);
      await expect(panel.getByText(/本次建议的修改范围（尚未写入作品）.*ch10 计划回收/su)).toBeVisible();
      const review = await view();
      expect(review?.run?.status).toBe('completed');
      expect((await rpc<BookView>(page, 'book.read', { bookId: id })).documents).toEqual(book);
      await send(approval);
      await expect
        .poll(async () => {
          const s = await view();
          return s?.run?.id !== review?.run?.id && s?.run?.status;
        })
        .toBe('completed');
      const executed = (await view())!;
      expect(executed.run).toMatchObject({
        taskOutcome: object ? 'partial' : 'fulfilled',
        progress: { done: 7, total: object ? 8 : 7, complete: !object },
      });
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
      expect(now.filter((doc) => doc.type === 'chapter').map(({ id }) => id)).toEqual(
        book.filter((doc) => doc.type === 'chapter').map(({ id }) => id),
      );
      if (object) {
        expect(now.find((doc) => doc.type === 'subject' && doc.id === actor)?.fields.kind).toBe('item');
        expect(subject).toContain(retainedPlan);
        expect(subject).toContain(unrelated);
        expect(subject).not.toContain(obsoletePlan);
      }
      const clueDoc = now.find((d) => d.id === clue && d.type === 'clue')!;
      expect(clueDoc.fields).toMatchObject({
        setupChapterId: ch(scenes[0]),
        payoffChapterId: ch(10),
        subjectIds: [actor, ...known],
      });
      const revised = (await read('outline.md')).toString('utf8');
      for (const n of scenes) expect(revised).toContain(`仅增补 ${ch(n)}`);
      expect(serverErrors).toEqual([]);
      expect(
        wires.filter((wire) => !wire.tools?.length && wire.system.includes('指定锚点')),
      ).toHaveLength(3);
      expect(revised).not.toContain(hiddenTruth);
      const finishedDiagnostics = async (runId: string) => {
        const rows = async () =>
          (await readDiagnostics(root, 'backend')).filter(({ fields }) => fields.runId === runId);
        await expect
          .poll(async () => (await rows()).some(({ event }) => event === 'run.finished'))
          .toBe(true);
        return rows();
      };
      const finished = executed.run!.id;
      const diag = await finishedDiagnostics(finished);
      const firstRequest = diag.find(
        (row) => row.event === 'model.budget_dispatched' && row.fields.lane === 'agent',
      );
      const firstScope = diag.find((row) => row.event === 'writing.task_scope');
      expect(firstRequest).toBeDefined();
      expect(diag.some(({ event }) => event === 'novel.goal')).toBe(false);
      expect(firstScope?.logSeq ?? 0).toBeGreaterThan(firstRequest!.logSeq);
      expect(diag.filter(({ event }) => event === 'workspace.document.committed')).toHaveLength(10);
      if (object) {
        const receipts = async () =>
          (await readFile(join(root, 'state', 'sessions', `${executed.session.id}.jsonl`), 'utf8'))
            .split(/\r?\n/u)
            .filter(Boolean)
            .flatMap((line) => {
              const parsed = JSON.parse(line) as { toolReceipt?: ToolReceipt };
              return parsed.toolReceipt ? [parsed.toolReceipt] : [];
            });
        const failed = diag.find(
          ({ event, fields }) => event === 'chapter.patch.review' && fields.verdict === 'denied',
        );
        expect(failed).toBeDefined();
        expect(diag).toContainEqual(
          expect.objectContaining({
            event: 'run.finished',
            fields: expect.objectContaining({ outcome: 'ok' }),
          }),
        );
        expect(
          diag.some(
            ({ event, fields }) =>
              event === 'workspace.document.committed' && fields.callId === failed!.fields.callId,
          ),
        ).toBe(false);
        expect(
          (await receipts()).find(
            ({ callRef: ref, runId }) => ref === callRef('ending-patch') && runId === finished,
          ),
        ).toMatchObject({
          reason: 'patch_scope',
          commitCount: 0,
        });
        following = true;
        await send(continuePatch);
        await expect
          .poll(async () => {
            const s = await view();
            return s?.run?.id !== finished && s?.run?.status;
          })
          .toBe('completed');
        const follow = (await view())!.run!;
        expect(follow).toMatchObject({
          taskOutcome: 'fulfilled',
          progress: { done: 1, total: 1, complete: true },
        });
        const current = (await rpc<BookView>(page, 'book.read', { bookId: id })).documents;
        expect(current.filter((doc) => doc.id !== ending)).toEqual(
          now.filter((doc) => doc.id !== ending),
        );
        const after = await read(`chapters/${ending}.md`);
        expect(after.toString('utf8')).toContain(newEnding);
        expect(after.toString('utf8')).not.toContain(anchor(10));
        const savedRevision = createHash('sha256').update(after).digest('hex');
        const writeReceipts = (await receipts()).filter(
          ({ runId, commitCount }) => runId === follow.id && commitCount > 0,
        );
        expect(writeReceipts).toMatchObject([
          {
            tool: 'book_patch_chapter',
            callRef: callRef('ending-patch'),
            commits: [{ type: 'chapter', id: ending, operation: 'write', revision: savedRevision }],
          },
        ]);
        const followEvents = await finishedDiagnostics(follow.id);
        const reviewed = followEvents.find(
          ({ event, fields }) => event === 'chapter.patch.review' && fields.verdict === 'approved',
        );
        expect(reviewed).toBeDefined();
        expect(
          followEvents.filter(({ event }) => event === 'workspace.document.committed'),
        ).toMatchObject([{ fields: { callId: reviewed!.fields.callId } }]);
        expect(followEvents.some(({ event }) => event === 'novel.goal')).toBe(false);
        expect(serverErrors).toEqual([]);
      }
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
