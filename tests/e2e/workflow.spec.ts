import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { diagnosticText, readDiagnostics } from './diagnostic-files';
import type { BookView, Manuscript, RuntimeView, WriteReport } from '../../shared/contracts';

const odyssey = '基于神话故事奥德赛来写10章内容';
const antagonistRequest = '增加一个跟2个以上已有主体有关联的反派及他的伏笔，在故事中期登场';
const antagonist = { id: 'gray-keeper', fields: { name: '灰冠守夜人', kind: 'character' } };
const newClueId = 'gray-triple-cut';
const insertionProse = '灰冠守夜人夺走古弓，以为掌柜不敢作人证，却在船沿留下三道灰痕。';
const newOutlineBeat =
  '灰冠守夜人盗弓并埋下三道灰痕。 [灰冠守夜人](subjects/gray-keeper.md) [三道灰痕](foreshadowing/gray-triple-cut.md)';
const publicRule = '归乡者只用星位确认航向';
const discussion = '先聊聊怎么把《奥德赛》改编成十章小说，别写文件';
const faultPrompt = '写4章完整小说，包括大纲、主体、伏笔和正文。保留第一人称航海日记的形式。';
const subjectDescription = `## 稳定设定\n${publicRule}。他需要人证。SUBJECT_NAVIGATION_RULE`;
const retainedSubjects = [
  {
    target: { id: 'landlord', fields: { name: '掌柜', kind: 'character' } },
    body: '## 稳定设定\n掌柜能帮水手辨认港口的船。KEEPER_RULE',
  },
  {
    target: { id: 'old-bow', fields: { name: '古弓', kind: 'item' } },
    body: '## 稳定设定\n古弓背面刻有北斗。BOW_RULE',
  },
];
const clueSurface = '## 可见线索\n人证在船沿留下灰烬印记。VISIBLE_ASH_MARK';
const clueReveal = `## 回收真相\n回收时归乡者问起「人证」。${publicRule}。\n揭示事实：印记会指出北方的归路 SECRET_NORTH_PASSAGE。`;
const repairPrompt = '写完10章作品，保留已写章节，务必补齐索引员的主体说明。';
const apiKey = 'synthetic-writing-key-only';
const searchQuery = '整本小说 伏笔 SEARCH_QUERY_FIXTURE';
const unfinished = '未完成流，内容仅用于预览，不能进入磁盘正文 UNFINISHED_PROSE_FIXTURE。';
const title = (order: number) => `航程 ${order}`;
const id = (order: number) => `odyssey-fixture-${order}`;
const chapterBody = (order: number) =>
  `我从海上认出了故乡的群山。这是第 ${order} 章完整正文的测试句，记录了这一段旅程。`;
type Fault = 'incomplete_stream' | 'output_limit';
type RequestBody = {
  system: string;
  tools?: { name: string }[];
  messages: {
    role: string;
    content: { type: string; text?: string; content?: string; tool_use_id?: string }[];
  }[];
};
function startStream(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  return (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function terminal(send: ReturnType<typeof startStream>, res: ServerResponse, reason: string) {
  send({ type: 'message_delta', delta: { stop_reason: reason } });
  send({ type: 'message_stop' });
  res.end();
}
async function fixture(mode: 'full' | 'single' | 'repair' | Fault) {
  const count = mode === 'full' || mode === 'repair' ? 10 : mode === 'single' ? 3 : 4;
  const chapterIds = Array.from({ length: count }, (_, i) => id(i + 1));
  const calls: string[] = [],
    drafts: number[] = [],
    errors: string[] = [];
  let resumed = false,
    hold = mode !== 'full';
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const clue = {
    id: 'hint-troy-embers',
    fields: {
      title: '航途暗号',
      subjectIds: ['hero-fixture'],
      setupChapterId: id(1),
      payoffChapterId: id(count),
    },
  };
  const hero = { id: 'hero-fixture', fields: { name: '归乡者', kind: 'character' } };
  const repairId = 'indexer';
  const allSubjects = mode === 'full' ? [hero, ...retainedSubjects.map(({ target }) => target)] : [hero];
  const chapterForEntry = 5;
  let outlineRevision = '';
  const extraClue = {
    id: newClueId,
    fields: {
      title: '三道灰痕',
      subjectIds: [antagonist.id, hero.id],
      setupChapterId: id(chapterForEntry),
      payoffChapterId: id(8),
    },
  };
  const server = createServer(async (req, res) => {
    try {
      const raw: Buffer[] = [];
      for await (const chunk of req) raw.push(chunk);
      const body = JSON.parse(Buffer.concat(raw).toString()) as RequestBody;
      expect(req.url).toBe('/v1/messages');
      expect(req.headers['x-api-key']).toBe(apiKey);
      const reply = (value: string) => {
        const send = startStream(res);
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: value } });
        send({ type: 'content_block_stop', index: 0 });
        terminal(send, res, 'end_turn');
      };
      const use = (name: string, marker: string, input: object) => {
        expect(body.tools?.map((tool) => tool.name)).toContain(name);
        calls.push(`${name}:${marker}`);
        const send = startStream(res);
        send({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: marker, name, input: {} },
        });
        const args = JSON.stringify(input);
        const split = Math.floor(args.length / 2);
        for (const partial_json of [args.slice(0, split), args.slice(split)])
          send({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json },
          });
        send({ type: 'content_block_stop', index: 0 });
        terminal(send, res, 'tool_use');
      };
      const generate = (order: number, marker = `draft-${order}`) =>
        use('book_generate_chapter', marker, {
          chapterId: id(order),
          mode: 'draft',
          direction: `完成航程 ${order}。`,
          ...(mode !== 'single' && { subjectIds: [hero.id], clueIds: [clue.id] }),
        });
      const last = body.messages.at(-1)?.content.at(-1);
      if (body.tools?.length === 1 && body.tools[0].name === 'check_book_scope')
        return use('check_book_scope', 'scope-verdict', { allowed: true });
      if (body.tools?.length === 1 && body.tools[0].name === 'submit_story_sync') {
        const { asset, sources } = JSON.parse(last!.text!);
        expect(sources).toHaveLength(1);
        return use('submit_story_sync', `sync-${asset.id}`, {
          evidence: [
            {
              source: 1,
              status: asset.type === 'subject' ? 'appearance' : 'setup',
              excerpt: 1,
            },
          ],
          edits: [],
        });
      }
      if (body.tools?.length === 1 && body.tools[0].name === 'submit_story_descriptions') {
        expect(body.messages).toHaveLength(1);
        const input = last?.text ?? '';
        expect(body.system).not.toContain('skill_search');
        if (input.includes(antagonistRequest) && body.system.includes('生成伏笔说明')) {
          expect(input).toContain('灰冠守夜人');
          return use('submit_story_descriptions', 'entry-clue-result', {
            items: [
              {
                id: newClueId,
                body: '## 可见线索\n陌生人在船沿留下三道灰痕。\n\n## 回收真相\n揭示事实：灰帽是内应的密徽 FUTURE_GRAY_SIGIL。',
              },
            ],
          });
        }
        if (input.includes(antagonistRequest)) {
          for (const marker of ['SUBJECT_NAVIGATION_RULE', 'KEEPER_RULE', 'BOW_RULE'])
            expect(input).toContain(marker);
          return use('submit_story_descriptions', 'entry-subject-result', {
            items: [
              {
                id: antagonist.id,
                body: '## 稳定设定\n灰冠守夜人要夺取归乡者的古弓，打算让掌柜不敢作证。',
              },
            ],
          });
        }
        if (body.system.includes('生成伏笔说明')) {
          expect(input).toContain('SUBJECT_NAVIGATION_RULE');
          return use('submit_story_descriptions', 'clue-result', {
            items: [{ id: clue.id, body: clueSurface + '\n\n' + clueReveal }],
          });
        }
        expect(body.system).toContain('生成主体说明');
        return use('submit_story_descriptions', 'subject-result', {
          items: [
            { id: mode === 'repair' ? repairId : hero.id, body: subjectDescription },
            ...(mode === 'full'
              ? retainedSubjects.map(({ target, body }) => ({ id: target.id, body }))
              : []),
          ],
        });
      }
      if (!body.tools?.length) {
        const order = Number(
          /"target":\s*\{\s*"id":\s*"odyssey-fixture-(\d+)"/.exec(last?.text ?? '')?.[1],
        );
        expect(order).toBeGreaterThan(0);
        expect(body.system).toContain('中文 Markdown 正文');
        if (body.system.includes('指定锚点')) {
          expect(order).toBe(chapterForEntry);
          expect(last?.text).toContain(antagonistRequest);
          expect(last?.text).toContain(chapterBody(order));
          for (const datum of [
            '灰冠守夜人',
            '三道灰痕',
            'SUBJECT_NAVIGATION_RULE',
            'KEEPER_RULE',
            'BOW_RULE',
          ])
            expect(last?.text).toContain(datum);
          expect(last?.text).not.toContain('FUTURE_GRAY_SIGIL');
          return reply(insertionProse);
        }
        if (mode !== 'single') {
          expect(body.system).toContain('1200');
          expect(last?.text).toContain('SUBJECT_NAVIGATION_RULE');
          if (order < count) expect(last?.text).not.toContain('SECRET_NORTH_PASSAGE');
          else expect(last?.text).toContain('SECRET_NORTH_PASSAGE');
        } else expect(body.system).not.toContain('1200');
        drafts.push(order);
        if (resumed && mode !== 'single') expect(last?.text).toContain(faultPrompt);
        if (order === 3 && !resumed && mode !== 'full') {
          const send = startStream(res);
          send({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: unfinished },
          });
          if (hold) await gate;
          if (res.destroyed) return;
          send({ type: 'content_block_stop', index: 0 });
          if (mode === 'output_limit') terminal(send, res, 'max_tokens');
          else res.end();
          return;
        }
        return reply(chapterBody(order));
      }
      if (last?.type !== 'tool_result') {
        if (last?.text === discussion) return reply('先构思归乡与身份的冲突，不写文件。');
        if (last?.text === antagonistRequest)
          return use('tool_search', 'entry-discover', {
            query: 'book_get_context book_generate_assets book_generate_chapter',
          });
        if (mode === 'single') {
          expect(last?.text).toBe('只写第三章');
          return use('tool_search', 'single-discover', { query: 'book_generate_chapter' });
        }
        expect(last?.text).toBe(
          resumed
            ? '接着写完'
            : mode === 'full'
              ? odyssey
              : mode === 'repair'
                ? repairPrompt
                : faultPrompt,
        );
        expect(body.system).toContain('skill_search');
        if (resumed) expect(body.system).toContain('有可续接的整书记录');
        return use('tool_search', 'whole-discover', {
          query: 'book_get_context book_apply_changes book_generate_assets book_generate_chapter',
        });
      }
      const result = JSON.parse(last.content!);
      const marker = last.tool_use_id!;
      if (marker === 'whole-discover') {
        const bookId = /当前绑定小说 ID：([a-z0-9-]+)/u.exec(body.system)?.[1];
        expect(bookId).toBeTruthy();
        return use('book_task_scope', 'whole-scope', {
          items: [
            {
              operation: resumed ? 'novel.resume' : 'novel.register',
              id: bookId,
              purpose: resumed ? '承接当前未完成整书目标' : '完成请求章数和配套资料',
              ...(!resumed && { count }),
            },
          ],
        });
      }
      if (marker === 'whole-scope') {
        expect(result.ok).toBe(true);
        return use('skill_search', 'search', { query: searchQuery });
      }
      if (marker === 'single-discover')
        return use('book_task_scope', 'single-scope', {
          items: [{ operation: 'chapter.draft', id: id(3), purpose: '只写第三章' }],
        });
      if (marker === 'single-scope') {
        expect(result.ok).toBe(true);
        return generate(3);
      }
      if (marker === 'entry-discover') return use('book_get_context', 'entry-context', {});
      if (marker === 'entry-context') {
        expect(result.ok).toBe(true);
        expect(result.value.documents.filter((d: Manuscript) => d.type === 'subject')).toHaveLength(3);
        outlineRevision = result.value.documents.find((d: Manuscript) => d.type === 'outline').revision;
        return use('book_task_scope', 'entry-scope', {
          items: [
            {
              operation: 'subject.create',
              id: antagonist.id,
              purpose: '新增与多个既有主体关联的反派',
              relatedMinimum: 2,
            },
            { operation: 'clue.create', id: newClueId, purpose: '新增关联反派的三道灰痕伏笔' },
            {
              operation: 'chapter.insert',
              id: id(chapterForEntry),
              purpose: '让灰冠守夜人在中期实际登场并埋设灰痕',
              stage: 'reveal',
            },
          ],
        });
      }
      if (marker === 'entry-scope') {
        expect(result.ok).toBe(true);
        return use('book_generate_assets', 'entry-subject', {
          kind: 'subject',
          action: 'create',
          targets: [{ ...antagonist, relatedSubjectIds: allSubjects.map(({ id }) => id) }],
        });
      }
      if (marker === 'entry-subject') {
        expect(result.value.assets).toMatchObject([{ type: 'subject', id: antagonist.id }]);
        return use('book_generate_assets', 'entry-unbound', {
          kind: 'clue',
          action: 'create',
          targets: [
            { ...extraClue, fields: { ...extraClue.fields, payoffChapterId: 'missing-payoff' } },
          ],
        });
      }
      if (marker === 'entry-unbound') {
        expect(result).toMatchObject({ ok: false, reason: 'invalid_references' });
        return use('book_generate_assets', 'entry-clue', {
          kind: 'clue',
          action: 'create',
          targets: [extraClue],
        });
      }
      if (marker === 'entry-clue') {
        expect(result.value.assets).toMatchObject([{ type: 'clue', id: newClueId }]);
        return use('book_get_context', 'entry-chapter', {
          type: 'chapter',
          documentId: id(chapterForEntry),
        });
      }
      if (marker === 'entry-chapter') {
        expect(result.value.document.body).toContain(chapterBody(chapterForEntry));
        return use('book_generate_chapter', 'entry-insert', {
          chapterId: id(chapterForEntry),
          mode: 'insert',
          insertion: {
            quote: chapterBody(chapterForEntry),
            place: 'before',
            revision: result.value.document.revision,
            outline: { revision: outlineRevision, addition: newOutlineBeat },
          },
          subjectIds: [antagonist.id],
          clueIds: [newClueId],
        });
      }
      if (marker === 'entry-insert') {
        expect(result.value).toMatchObject({
          inserted: true,
          outlineUpdated: true,
          chapterId: id(chapterForEntry),
        });
        return use('book_task_scope', 'entry-sync-scope', {
          items: [
            { operation: 'subject.update', id: antagonist.id, purpose: '按实际登场同步新建反派资料' },
            { operation: 'clue.update', id: newClueId, purpose: '按实际埋设同步新建伏笔，不冒称回收' },
          ],
        });
      }
      if (marker === 'entry-sync-scope') {
        expect(result.ok).toBe(true);
        return use('book_generate_assets', 'entry-sync-actor', {
          kind: 'subject',
          action: 'update',
          targets: [{ id: antagonist.id }],
        });
      }
      if (marker === 'entry-sync-actor') {
        expect(result.ok).toBe(true);
        return use('book_generate_assets', 'entry-sync-clue', {
          kind: 'clue',
          action: 'update',
          targets: [{ id: newClueId }],
        });
      }
      if (marker === 'entry-sync-clue') {
        expect(result.ok).toBe(true);
        return reply('已保存主体、伏笔、大纲和登场。');
      }
      if (marker === 'search') {
        expect(result.value.candidates[0].name).toBe('generate-novel');
        expect(result.value.candidates[0].instructions).toBeUndefined();
        return use('skill_load', 'load', { name: 'generate-novel' });
      }
      if (marker === 'load') {
        expect(result.value.instructions).toContain('交付目标');
        return resumed
          ? use('book_get_context', 'resume', { novelGoal: { action: 'resume' } })
          : mode === 'repair'
            ? use('book_get_context', 'repair-register', {
                novelGoal: {
                  action: 'register',
                  chapterIds,
                  assetRefs: [{ type: 'subject', id: repairId }],
                },
              })
            : use('book_get_context', 'initial-read', {});
      }
      if (marker === 'repair-register') {
        expect(result.value).toMatchObject({
          done: 10,
          total: 10,
          complete: false,
          missingAssetRefs: [{ type: 'subject', id: repairId }],
        });
        return reply('模型错误地声称都完成了。');
      }
      if (marker === 'resume') {
        expect(result.ok).toBe(true);
        if (mode === 'repair') {
          expect(result.value).toMatchObject({
            done: 10,
            total: 10,
            complete: false,
            missingAssetRefs: [{ type: 'subject', id: repairId }],
          });
          return use('book_generate_assets', 'repair-fill', {
            kind: 'subject',
            action: 'fill',
            targets: [{ id: repairId }],
          });
        }
        expect(result.value).toMatchObject({
          originalDirection: faultPrompt,
          done: 2,
          firstUnwritten: id(3),
          lastFailedChapterId: id(3),
        });
        return generate(3);
      }
      if (marker === 'initial-read') {
        expect(result.value.documents.filter((doc: Manuscript) => doc.type === 'chapter')).toHaveLength(
          0,
        );
        return use('book_get_context', 'register', { novelGoal: { action: 'register', chapterIds } });
      }
      if (marker === 'register') {
        expect(result.value).toMatchObject({ chapterIds, done: 0, complete: false });
        return use('book_apply_changes', 'foundation', {
          operations: [
            {
              type: 'outline',
              action: 'update',
              id: 'outline',
              body: '归乡者用暗号辨认航道。\n\n<!-- beat:actual-departure -->',
            },
            ...chapterIds.map((id, i) => ({
              type: 'chapter',
              action: 'create',
              id,
              fields: { title: title(i + 1), order: i + 1 },
            })),
          ],
        });
      }
      if (marker === 'foundation') {
        expect(result.ok).toBe(true);
        if (mode === 'full')
          return use('book_apply_changes', 'blank-card-bypass', {
            operations: [{ ...hero, type: 'subject', action: 'create' }],
          });
        return use('book_generate_assets', 'subject', {
          kind: 'subject',
          action: 'create',
          targets: allSubjects,
        });
      }
      if (marker === 'blank-card-bypass') {
        expect(result).toMatchObject({ ok: false, reason: 'invalid_options' });
        return use('book_generate_assets', 'subject', {
          kind: 'subject',
          action: 'create',
          targets: allSubjects,
        });
      }
      if (marker === 'subject') {
        expect(result.value.assets).toMatchObject(
          allSubjects.map(({ id }) => ({ type: 'subject', id })),
        );
        expect(last.content).not.toContain('SUBJECT_NAVIGATION_RULE');
        if (mode !== 'full')
          return use('book_generate_assets', 'clue', {
            kind: 'clue',
            action: 'create',
            targets: [clue],
          });
        return use('book_generate_assets', 'invalid-anchor', {
          kind: 'clue',
          action: 'create',
          targets: [{ ...clue, fields: { ...clue.fields, setupChapterId: 'missing-departure' } }],
        });
      }
      if (marker === 'invalid-anchor') {
        expect(result).toMatchObject({
          ok: false,
          reason: 'invalid_references',
          value: {
            invalidReferences: [
              { field: 'setupChapterId', target: { type: 'chapter', id: 'missing-departure' } },
            ],
          },
        });
        return use('book_get_context', 'chapter-ids', { index: 'chapters' });
      }
      if (marker === 'chapter-ids') {
        expect(result.value.rows.map((row: { id: string }) => row.id)).toEqual(chapterIds);
        return use('book_generate_assets', 'clue', { kind: 'clue', action: 'create', targets: [clue] });
      }
      if (marker === 'clue') {
        expect(result.value.assets).toMatchObject([{ type: 'clue', id: clue.id }]);
        return generate(1);
      }
      if (marker === 'repair-fill') {
        expect(result.value.assets).toMatchObject([{ type: 'subject', id: repairId }]);
        return use('book_get_context', 'check', { novelGoal: { action: 'check' } });
      }
      if (marker === 'cannot-skip') {
        expect(result).toMatchObject({ ok: false, reason: 'novel_goal_conflict' });
        return reply('第三章未保存，后续还没写。');
      }
      if (marker.startsWith('draft-')) {
        const order = Number(marker.slice(6));
        if (mode === 'single') {
          expect(result.ok).toBe(true);
          return reply('只保存了第三章。');
        }
        if (order === 3 && !resumed && mode !== 'full') {
          expect(result).toMatchObject({ ok: false, reason: mode });
          return generate(4, 'cannot-skip');
        }
        expect(result.ok).toBe(true);
        if (order < count) return generate(order + 1);
        return use('book_get_context', 'check', { novelGoal: { action: 'check' } });
      }
      if (marker === 'check') {
        expect(result.value).toMatchObject({ done: count, total: count, complete: true });
        return reply('全书正文与资料已保存。');
      }
      throw new Error(`Unexpected synthetic tool result: ${marker}`);
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    chapterIds,
    calls,
    drafts,
    errors,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    unblock() {
      hold = false;
      unblock();
    },
    resume() {
      resumed = true;
      hold = false;
      unblock();
    },
    async close() {
      unblock();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Harness 面板' });
const launch = (root: string) =>
  electron.launch({ args: ['.'], env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root } });
async function setup(page: Page, baseUrl: string) {
  await rpc(page, 'profiles.save', {
    name: '合成夹具',
    apiKey,
    baseUrl,
    model: 'fixture',
    protocol: 'messages',
  });
  const book = await rpc<{ id: string }>(page, 'book.create', {
    title: '奥德赛',
    summary: '改编希腊神话。',
  });
  return book.id;
}
async function openBook(page: Page) {
  await button(page, '编辑 奥德赛').click();
}
async function openComposer(page: Page, resume: boolean | string = false) {
  await button(page, 'Harness').click();
  if (resume)
    await panel(page)
      .getByRole('button', {
        name: new RegExp(`^${(typeof resume === 'string' ? resume : faultPrompt).slice(0, 20)}`),
      })
      .click();
  else await panel(page).getByRole('button', { name: '当前小说会话', exact: true }).click();
  await expect(panel(page).getByLabel('写作动作')).toHaveCount(0);
}
async function send(page: Page, text: string) {
  await panel(page).getByLabel('给 Agent 的消息').fill(text);
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
}
const read = (page: Page, bookId: string, chapterId: string) =>
  rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: { type: 'chapter', id: chapterId } });
const status = async (page: Page, bookId: string) =>
  (await rpc<RuntimeView>(page, 'runtime.snapshot')).sessions.find(
    (item) => item.session.bookId === bookId,
  )?.run;
const files = (page: Page, bookId: string) => rpc<BookView>(page, 'book.read', { bookId });

async function safeDiaries(root: string) {
  for (const lane of ['frontend', 'backend'] as const) {
    const text = await diagnosticText(root, lane);
    for (const hidden of [
      apiKey,
      originalPromptMarker,
      searchQuery,
      unfinished,
      'hint-troy-embers',
      'missing-departure',
      'SUBJECT_NAVIGATION_RULE',
      'SECRET_NORTH_PASSAGE',
      id(3),
      chapterBody(1),
    ])
      expect(text).not.toContain(hidden);
  }
}
const originalPromptMarker = '第一人称航海日记';

test('two natural-language sends complete the Odyssey and insert a related antagonist in its middle', async ({}, info) => {
  const root = info.outputPath('app');
  const mock = await fixture('full');
  let app: ElectronApplication | undefined;
  try {
    app = await launch(root);
    const page = await app.firstWindow();
    const bookId = await setup(page, mock.baseUrl);
    await openBook(page);
    await openComposer(page);
    await send(page, odyssey);
    await expect.poll(async () => (await status(page, bookId))?.status).toBe('completed');
    expect(await status(page, bookId)).toMatchObject({
      progress: { done: 10, total: 10, complete: true },
    });
    const view = await files(page, bookId);
    expect(view.diagnostics).toEqual([]);
    expect(view.documents.filter((doc) => doc.type === 'chapter').map((doc) => doc.id)).toEqual(
      mock.chapterIds,
    );
    expect(view.documents.some((doc) => doc.type === 'subject')).toBe(true);
    const readDoc = (type: 'outline' | 'clue' | 'subject', id: string) =>
      rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: { type, id } });
    expect((await readDoc('outline', 'outline')).body.trim()).toContain('归乡者');
    expect((await readDoc('subject', 'hero-fixture')).body.trim()).toBe(subjectDescription);
    expect((await readDoc('clue', 'hint-troy-embers')).fields).toMatchObject({
      setupChapterId: id(1),
      payoffChapterId: id(10),
    });
    for (const [index, chapterId] of mock.chapterIds.entries())
      expect((await read(page, bookId, chapterId)).body).toBe(chapterBody(index + 1));
    expect(mock.calls.filter((call) => call.startsWith('skill_'))).toEqual([
      'skill_search:search',
      'skill_load:load',
    ]);
    expect(mock.calls).toContain('tool_search:whole-discover');
    expect(mock.drafts).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    const prior = (await status(page, bookId))!.id;
    const originalOutline = await readDoc('outline', 'outline');
    await send(page, antagonistRequest);
    await expect
      .poll(async () => {
        const r = await status(page, bookId);
        return r?.id !== prior && r?.status;
      })
      .toBe('completed');
    const entryId = (await status(page, bookId))!.id;
    const connected = await files(page, bookId);
    expect(connected.diagnostics).toEqual([]);
    expect(connected.documents.filter((d) => d.type === 'chapter').map(({ id }) => id)).toEqual(
      mock.chapterIds,
    );
    for (const old of view.documents.filter((d) => d.type === 'subject' || d.type === 'clue'))
      expect(connected.documents.find((d) => d.type === old.type && d.id === old.id)?.revision).toBe(
        old.revision,
      );
    const actor = await readDoc('subject', antagonist.id);
    for (const ref of ['hero-fixture', 'landlord', 'old-bow'])
      expect(actor.body).toContain(`subjects/${ref}.md`);
    expect((await readDoc('clue', newClueId)).fields).toMatchObject({
      setupChapterId: id(5),
      payoffChapterId: id(8),
      subjectIds: [antagonist.id, 'hero-fixture'],
    });
    const newOutline = await readDoc('outline', 'outline');
    expect(newOutline.body).toContain('<!-- chapter:odyssey-fixture-5 -->');
    expect(newOutline.body).toContain(newOutlineBeat);
    expect(newOutline.body.startsWith(originalOutline.body)).toBe(true);
    for (const [index, chapterId] of mock.chapterIds.entries()) {
      const order = index + 1;
      expect((await read(page, bookId, chapterId)).body).toBe(
        order === 5 ? insertionProse + '\n\n' + chapterBody(order) : chapterBody(order),
      );
    }
    const calls = [...mock.calls];
    await send(page, discussion);
    await expect(
      panel(page).getByText('先构思归乡与身份的冲突，不写文件。', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const run = await status(page, bookId);
        return run?.id !== entryId && run?.status;
      })
      .toBe('completed');
    expect(await files(page, bookId)).toEqual(connected);
    expect(mock.calls).toEqual(calls);
    expect(mock.errors).toEqual([]);
    await expect
      .poll(
        async () =>
          (await readDiagnostics(root, 'backend')).filter((e) => e.event === 'run.finished').length,
      )
      .toBe(3);
    const events = (await readDiagnostics(root, 'backend')).filter((e) => e.fields.runId === prior);
    expect(events.some((e) => e.event === 'skill.search' && e.fields.candidates > 0)).toBe(true);
    expect(
      events.some((e) => e.event === 'tool.finished' && e.fields.reason === 'invalid_references'),
    ).toBe(true);
    expect(
      events.filter((e) => e.event === 'skill.applied' && e.fields.skill === 'generate-novel'),
    ).toHaveLength(1);
    expect(
      events.filter((e) => e.event === 'chapter.generation.finished' && e.fields.outcome === 'ok'),
    ).toHaveLength(10);
    const requests = events.filter(({ event }) => event === 'writing.context.dispatched');
    expect(requests.filter(({ fields }) => fields.template === 'write-chapter')).toHaveLength(10);
    expect(
      requests
        .filter(({ fields }) => fields.template !== 'write-chapter')
        .map(({ fields }) => fields.template),
    ).toEqual(['write-subject', 'write-clue']);
    expect(requests.every(({ fields }) => fields.includedRequired > 0)).toBe(true);
    expect(events.some((e) => e.event === 'writing.context.blocked')).toBe(false);
    const entryEvents = (await readDiagnostics(root, 'backend')).filter(
      (e) => e.fields.runId === entryId,
    );
    expect(
      entryEvents.filter(
        (e) => e.event === 'writing.context.dispatched' && e.fields.writingAction === 'insert',
      ),
    ).toHaveLength(1);
    expect(
      entryEvents.some((e) => e.event === 'writing.context.blocked' || e.event === 'novel.goal'),
    ).toBe(false);
    await safeDiaries(root);
  } finally {
    await app?.close().catch(() => {});
    await mock.close();
  }
});

for (const fault of ['incomplete_stream', 'output_limit'] as const) {
  test(`chapter three ${fault} does not commit; the same natural-language session resumes it`, async ({}, info) => {
    const root = info.outputPath('app');
    const mock = await fixture(fault);
    let app: ElectronApplication | undefined;
    try {
      app = await launch(root);
      let page = await app.firstWindow();
      const bookId = await setup(page, mock.baseUrl);
      await openBook(page);
      await openComposer(page);
      await send(page, faultPrompt);
      await expect.poll(async () => (await status(page, bookId))?.preview?.chapterId).toBe(id(3));
      await button(page, title(3)).click();
      await expect(page.getByLabel('Markdown 编辑器')).toContainText('UNFINISHED_PROSE_FIXTURE');
      expect((await read(page, bookId, id(3))).body).toBe('');
      if (fault === 'incomplete_stream') {
        await button(page, '返回书库').click();
        await openBook(page);
        await button(page, title(3)).click();
        await expect(page.getByLabel('Markdown 编辑器')).toContainText('UNFINISHED_PROSE_FIXTURE');
      }
      mock.unblock();
      await expect.poll(async () => (await status(page, bookId))?.status).toBe('failed');
      const failed = (await status(page, bookId))!;
      expect(failed.error).toMatch(fault === 'output_limit' ? /长度上限/ : /输出中断/);
      expect(failed.progress).toMatchObject({ done: 2, total: 4, complete: false });
      expect(failed.preview).toBeUndefined();
      expect(mock.drafts).toEqual(fault === 'output_limit' ? [1, 2, 3] : [1, 2, 3, 3]);
      expect((await read(page, bookId, id(3))).body).toBe('');
      expect((await read(page, bookId, id(4))).body).toBe('');
      const revisions = await Promise.all(
        [1, 2].map(async (order) => (await read(page, bookId, id(order))).revision),
      );
      const before = [...mock.drafts];
      await app.close();
      mock.resume();
      app = await launch(root);
      page = await app.firstWindow();
      expect((await status(page, bookId))?.id).toBe(failed.id);
      expect(mock.drafts).toEqual(before);
      await openBook(page);
      await openComposer(page, true);
      await send(page, '接着写完');
      await expect.poll(async () => (await status(page, bookId))?.status).toBe('completed');
      const finished = (await status(page, bookId))!;
      expect(finished.progress).toMatchObject({ done: 4, total: 4, complete: true });
      expect(mock.drafts.slice(before.length)).toEqual([3, 4]);
      expect(
        await Promise.all([1, 2].map(async (order) => (await read(page, bookId, id(order))).revision)),
      ).toEqual(revisions);
      expect(
        (await files(page, bookId)).documents
          .filter((doc) => doc.type === 'chapter')
          .map((doc) => doc.id),
      ).toEqual(mock.chapterIds);
      expect((await read(page, bookId, id(3))).body).toBe(chapterBody(3));
      expect(mock.errors).toEqual([]);
      await expect
        .poll(
          async () =>
            (await readDiagnostics(root, 'backend')).filter((e) => e.event === 'run.finished').length,
        )
        .toBe(2);
      const rows = await readDiagnostics(root, 'backend');
      expect(
        rows.find((e) => e.event === 'run.finished' && e.fields.runId === failed.id)?.fields.reason,
      ).toBe(fault);
      expect(
        rows.filter((e) => e.event === 'chapter.retry' && e.fields.runId === failed.id),
      ).toHaveLength(fault === 'incomplete_stream' ? 1 : 0);
      const resumed = rows.filter((e) => e.fields.runId === finished.id);
      expect(
        resumed.filter((e) => e.event === 'novel.chapter.reused').map((e) => e.fields.chapterIndex),
      ).toEqual([1, 2]);
      expect(
        resumed.find((e) => e.event === 'novel.goal' && e.fields.operation === 'resume')?.fields.done,
      ).toBe(2);
      await safeDiaries(root);
    } finally {
      await app?.close().catch(() => {});
      await mock.close();
    }
  });
}

test('single-chapter request uses the same composer, can be stopped, and never starts a whole book', async ({}, info) => {
  const root = info.outputPath('app');
  const mock = await fixture('single');
  let app: ElectronApplication | undefined;
  try {
    app = await launch(root);
    const page = await app.firstWindow();
    const bookId = await setup(page, mock.baseUrl);
    const report = await rpc<WriteReport>(page, 'book.changes.write', {
      bookId,
      changes: mock.chapterIds.map((id, i) => ({
        type: 'chapter',
        id,
        expect: null,
        fields: { title: title(i + 1), order: i + 1 },
        body: '',
      })),
    });
    expect(report.error).toBeUndefined();
    await openBook(page);
    await openComposer(page);
    await send(page, '只写第三章');
    await expect.poll(async () => (await status(page, bookId))?.preview?.chapterId).toBe(id(3));
    await panel(page).getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(async () => (await status(page, bookId))?.status).toBe('cancelled');
    expect((await status(page, bookId))?.preview).toBeUndefined();
    expect((await read(page, bookId, id(3))).body).toBe('');
    mock.resume();
    await send(page, '只写第三章');
    await expect.poll(async () => (await status(page, bookId))?.status).toBe('completed');
    expect((await read(page, bookId, id(3))).body).toBe(chapterBody(3));
    expect((await read(page, bookId, id(1))).body).toBe('');
    expect((await read(page, bookId, id(2))).body).toBe('');
    expect((await files(page, bookId)).documents.map((doc) => doc.type).sort()).toEqual([
      'book',
      'chapter',
      'chapter',
      'chapter',
      'outline',
    ]);
    expect(mock.calls.filter((call) => call.startsWith('book_generate_chapter:'))).toEqual([
      'book_generate_chapter:draft-3',
      'book_generate_chapter:draft-3',
    ]);
    expect(mock.calls.some((call) => call.startsWith('skill_') || call.includes('whole-'))).toBe(false);
    expect(mock.drafts).toEqual([3, 3]);
    expect(mock.errors).toEqual([]);
  } finally {
    await app?.close().catch(() => {});
    await mock.close();
  }
});

test('a saved ten-chapter catalog cannot hide a missing required description, and resumes without redrafting', async ({}, info) => {
  const root = info.outputPath('app');
  const mock = await fixture('repair');
  let app: ElectronApplication | undefined;
  try {
    app = await launch(root);
    let page = await app.firstWindow();
    const bookId = await setup(page, mock.baseUrl);
    const outline = await rpc<Manuscript>(page, 'book.doc.read', {
      bookId,
      doc: { type: 'outline', id: 'outline' },
    });
    const write = await rpc<WriteReport>(page, 'book.changes.write', {
      bookId,
      changes: [
        { ...outline, expect: outline.revision, body: '归乡大纲。' },
        {
          type: 'subject',
          id: 'hero-fixture',
          expect: null,
          fields: { name: '归乡者', kind: 'character' },
          body: subjectDescription,
        },
        {
          type: 'subject',
          id: 'indexer',
          expect: null,
          fields: { name: '索引员', kind: 'character' },
          body: '',
        },
        {
          type: 'subject',
          id: 'unrelated',
          expect: null,
          fields: { name: '与任务无关的占位', kind: 'scene' },
          body: '',
        },
        {
          type: 'clue',
          id: 'hint-troy-embers',
          expect: null,
          fields: {
            title: '航途暗号',
            subjectIds: ['hero-fixture'],
            setupChapterId: id(1),
            payoffChapterId: id(10),
          },
          body: clueSurface + '\n\n' + clueReveal,
        },
        ...mock.chapterIds.map((chapterId, i) => ({
          type: 'chapter',
          id: chapterId,
          expect: null,
          fields: { title: title(i + 1), order: i + 1 },
          body: chapterBody(i + 1),
        })),
      ],
    });
    expect(write.error).toBeUndefined();
    const revisions = await Promise.all(
      mock.chapterIds.map(async (chapterId) => (await read(page, bookId, chapterId)).revision),
    );
    await openBook(page);
    await openComposer(page);
    await send(page, repairPrompt);
    await expect.poll(async () => (await status(page, bookId))?.status).toBe('failed');
    expect(await status(page, bookId)).toMatchObject({
      progress: { done: 10, total: 10, complete: false },
      error: expect.stringContaining('subject/indexer'),
    });
    await app.close();
    mock.resume();
    app = await launch(root);
    page = await app.firstWindow();
    await openBook(page);
    await openComposer(page, repairPrompt);
    await send(page, '接着写完');
    await expect.poll(async () => (await status(page, bookId))?.status).toBe('completed');
    expect(await status(page, bookId)).toMatchObject({
      progress: { done: 10, total: 10, complete: true },
    });
    expect(
      await Promise.all(
        mock.chapterIds.map(async (chapterId) => (await read(page, bookId, chapterId)).revision),
      ),
    ).toEqual(revisions);
    const subject = (id: string) =>
      rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: { type: 'subject', id } });
    expect((await subject('indexer')).body.trim()).toBe(subjectDescription);
    expect((await subject('unrelated')).body).toBe('');
    expect(mock.drafts).toEqual([]);
    expect(mock.errors).toEqual([]);
  } finally {
    await app?.close().catch(() => {});
    await mock.close();
  }
});
