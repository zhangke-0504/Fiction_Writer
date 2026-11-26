import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Manuscript,
  ModelProfile,
  RuntimeView,
  Session,
  WriteReport,
} from '../../shared/contracts.js';
import { readDiagnostics } from './diagnostic-files.js';

const request = '写完三章灯塔故事，使用第一人称航海日记。';
const continuity = '已有前两章，第三章仍需完成。';
const inspect = '只查看哪里没写完，不要改稿。';
const ids = ['first', 'second', 'third'];
const ref = (id: string) => ({ type: 'chapter' as const, id });
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);

type Wire = {
  max_tokens: number;
  tools?: { name: string }[];
  messages: { content: { type: string; text?: string; content?: string; tool_use_id?: string }[] }[];
};

for (const mode of ['missing-goal', 'resume-record', 'rebuild-goal', 'single'] as const) {
  test(`whole-book goal handoff over Harness IPC (${mode})`, async ({}, info) => {
    const root = info.outputPath('app');
    const drafts: number[] = [];
    const errors: string[] = [];
    let bookId = '';
    const continuation = mode === 'resume-record' || mode === 'rebuild-goal';
    let resumed = false;
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const wire = JSON.parse(Buffer.concat(chunks).toString()) as Wire;
        const tools = wire.tools?.map(({ name }) => name) ?? [];
        const last = wire.messages.at(-1)?.content.at(-1);
        const send = (block: object, reason: string) => {
          const sse = [
            { type: 'content_block_start', index: 0, content_block: block },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: reason } },
            { type: 'message_stop' },
          ];
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(sse.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
        };
        const reply = (text: string) => send({ type: 'text', text }, 'end_turn');
        const use = (name: string, id: string, input: object) => {
          expect(tools).toContain(name);
          return send({ type: 'tool_use', name, id, input }, 'tool_use');
        };
        const draft = (id = 'draft') =>
          use('book_generate_chapter', id, { mode: 'draft', chapterId: 'third' });
        const scope = (
          operation: string,
          id: string,
          options?: { count?: number; sourceQuote?: string },
        ) =>
          use('book_task_scope', id, {
            sourceQuote: options?.sourceQuote,
            items: [
              {
                operation,
                id: operation.startsWith('novel.') ? bookId : 'third',
                count: options?.count,
                purpose: operation.startsWith('novel.') ? '完成原三章目标' : '只写第三章',
              },
            ],
          });
        if (tools[0] === 'check_book_scope' && tools.length === 1) {
          const input = JSON.parse(last!.text!);
          if (resumed && mode === 'rebuild-goal') expect(input.originalWholeRequest).toBe(request);
          if (resumed && mode === 'resume-record')
            expect(input.savedWholeGoal).toEqual({ originalRequest: request, chapterCount: 3 });
          return use('check_book_scope', 'verdict', { allowed: true });
        }
        if (!tools.length) {
          drafts.push(wire.max_tokens);
          expect(wire.max_tokens).toBe(mode === 'single' ? 8192 : 24_000);
          if (continuation) expect(last?.text).toContain(request);
          return reply('我循着前两章取得的航线返航，在灯塔下记下这次航行。');
        }
        if (last?.type !== 'tool_result') {
          if (last?.text === inspect)
            return use('tool_search', 'find-read', { query: 'book_get_context' });
          if (!resumed && mode === 'rebuild-goal') return reply(continuity);
          return use('tool_search', 'find', { query: 'book_get_context book_generate_chapter' });
        }
        const result = JSON.parse(last.content!);
        switch (last.tool_use_id) {
          case 'find-read':
            return use('book_get_context', 'read-only', { index: 'chapters' });
          case 'read-only':
            expect(result.ok).toBe(true);
            return reply(continuity);
          case 'find':
            return use('skill_search', 'skill', { query: 'generate-novel' });
          case 'skill':
            if (mode === 'single') return scope('chapter.draft', 'scoped-single');
            return use('skill_load', 'load', { name: 'generate-novel' });
          case 'load':
            if (mode === 'missing-goal') return scope('chapter.draft', 'scoped-single');
            if (resumed && mode === 'resume-record') return scope('novel.resume', 'scoped-resume');
            return scope('novel.register', 'scoped-whole', {
              count: 3,
              ...(mode === 'rebuild-goal' && { sourceQuote: request }),
            });
          case 'scoped-single':
            expect(result.ok).toBe(true);
            return draft(mode === 'single' ? 'draft' : 'before-goal');
          case 'before-goal':
            expect(result).toMatchObject({ ok: false, reason: 'novel_goal_required' });
            expect(result.error).toContain('novel.register');
            expect(drafts).toEqual([]);
            return scope('novel.register', 'scoped-whole', { count: 3 });
          case 'scoped-whole':
            expect(result.ok).toBe(true);
            return use('book_get_context', 'goal', {
              novelGoal: { action: 'register', chapterIds: ids },
            });
          case 'scoped-resume':
            expect(result.ok).toBe(true);
            return use('book_get_context', 'goal', { novelGoal: { action: 'resume' } });
          case 'goal':
            expect(result.value).toMatchObject({
              done: 2,
              total: 3,
              firstUnwritten: 'third',
              chapterIds: ids,
            });
            return !resumed && mode === 'resume-record' ? reply(continuity) : draft();
          case 'draft':
            expect(result.ok).toBe(true);
            return mode === 'single'
              ? reply('只写了第三章。')
              : use('book_get_context', 'check', { novelGoal: { action: 'check' } });
          case 'check':
            expect(result.value).toMatchObject({ done: 3, total: 3, complete: true });
            return reply('原三章目标已完成。');
          default:
            throw new Error(`Unexpected request: ${last.tool_use_id}`);
        }
      } catch (error) {
        errors.push(String(error));
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const launch = () =>
      electron.launch({
        args: ['.'],
        env: { ...process.env, FW_E2E: '1', FW_E2E_SHOW_WINDOW: '0', FW_TEST_ROOT: root },
      });
    let app;
    try {
      app = await launch();
      let page = await app.firstWindow();
      const profile = await rpc<ModelProfile>(page, 'profiles.save', {
        name: 'whole-handoff',
        model: 'fixture',
        apiKey: 'fixture',
        protocol: 'messages',
        baseUrl: `http://127.0.0.1:${port}`,
      });
      ({ id: bookId } = await rpc<{ id: string }>(page, 'book.create', {
        title: '灯塔',
        summary: '航海故事',
      }));
      const session = await rpc<Session>(page, 'session.create', { bookId });
      const read = (doc: { type: string; id: string }) =>
        rpc<Manuscript>(page, 'book.doc.read', { bookId, doc });
      const outline = await read({ type: 'outline', id: 'outline' });
      const seeded = await rpc<WriteReport>(page, 'book.changes.write', {
        bookId,
        changes: [
          { ...outline, expect: outline.revision, body: '发现灯塔，找到归路，记录航程。' },
          ...ids.map((id, n) => ({
            ...ref(id),
            expect: null,
            fields: { title: `航程 ${n + 1}`, order: n + 1 },
            body: n < 2 ? `我在灯塔下记下第 ${n + 1} 段航程。` : '',
          })),
          {
            type: 'subject',
            id: 'sailor',
            expect: null,
            fields: { name: '水手', kind: 'character' },
            body: '## 稳定设定\n水手通过灯塔分辨归路。',
          },
          {
            type: 'clue',
            id: 'lantern',
            expect: null,
            fields: {
              title: '灯塔信号',
              setupChapterId: 'first',
              payoffChapterId: 'third',
              subjectIds: ['sailor'],
            },
            body: '## 可见线索\n灯塔规律闪烁。\n\n## 回收真相\n它标明归途。',
          },
        ],
      });
      expect(seeded.error).toBeUndefined();
      const old = await Promise.all(ids.slice(0, 2).map((id) => read(ref(id))));
      await app.close();
      const profilePath = join(root, 'state', 'profiles.json');
      const profiles = JSON.parse(await readFile(profilePath, 'utf8'));
      // This is an isolated synthetic capability record, not remote capability discovery.
      profiles[0].capabilities = {
        source: 'generic-fallback',
        contextWindow: 100_000,
        maxOutputTokens: 24_000,
      };
      await writeFile(profilePath, JSON.stringify(profiles));
      app = await launch();
      page = await app.firstWindow();
      const submit = async (prompt: string) => {
        const { runId } = await rpc<{ runId: string }>(page, 'session.start', {
          id: session.id,
          profileId: profile.id,
          prompt,
        });
        await expect
          .poll(async () =>
            (await readDiagnostics(root, 'backend')).some(
              ({ event, fields }) => event === 'run.finished' && fields.runId === runId,
            ),
          )
          .toBe(true);
        return (await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId })).sessions.find(
          ({ session: found }) => found.id === session.id,
        )!.run!;
      };
      let result = await submit(mode === 'single' ? '只写第三章' : request);
      if (continuation) {
        expect(result.status).toBe(mode === 'resume-record' ? 'failed' : 'completed');
        expect(drafts).toEqual([]);
        expect((await read(ref('third'))).body).toBe('');
        // Reopening the application exercises persisted history and, where available, the saved goal.
        await app.close();
        app = await launch();
        page = await app.firstWindow();
        resumed = true;
        if (mode === 'resume-record') {
          const readOnly = await submit(inspect);
          expect(readOnly.status).toBe('completed');
          expect(readOnly.taskOutcome).toBeUndefined();
          expect(drafts).toEqual([]);
          expect((await read(ref('third'))).body).toBe('');
          const rows = (await readDiagnostics(root, 'backend')).filter(
            ({ fields }) => fields.runId === readOnly.id,
          );
          expect(
            rows.some(({ event }) => event === 'novel.goal' || event === 'workspace.document.committed'),
          ).toBe(false);
          const budgets = rows.filter(({ event }) => event === 'model.budget_dispatched');
          expect(budgets.length).toBeGreaterThan(0);
          expect(
            budgets.every(({ fields }) => fields.lane === 'agent' && fields.purpose === 'standard'),
          ).toBe(true);
        }
        result = await submit(mode === 'rebuild-goal' ? '把剩下的写完吧' : '继续');
      }
      expect(errors).toEqual([]);
      expect(result.status, result.error).toBe('completed');
      expect(result.taskOutcome).toBe('fulfilled');
      expect(drafts).toEqual([mode === 'single' ? 8192 : 24_000]);
      expect((await read(ref('third'))).body).toContain('我循着前两章');
      expect(
        await Promise.all(ids.slice(0, 2).map(async (id) => (await read(ref(id))).revision)),
      ).toEqual(old.map(({ revision }) => revision));
      const events = (await readDiagnostics(root, 'backend')).filter(
        ({ fields }) => fields.runId === result.id,
      );
      const writes = events.filter(
        ({ event, fields }) => event === 'model.budget_dispatched' && fields.lane === 'draft',
      );
      expect(writes.map(({ fields }) => [fields.purpose, fields.maxTokens])).toEqual([
        [mode === 'single' ? 'standard' : 'long-writing', drafts[0]],
      ]);
      if (mode !== 'single') {
        const goals = events.filter(
          ({ event, fields }) =>
            event === 'novel.goal' &&
            fields.operation === (mode === 'resume-record' ? 'resume' : 'register'),
        );
        expect(goals).toHaveLength(1);
        expect(goals[0].logSeq).toBeLessThan(writes[0].logSeq);
      }
    } finally {
      await app?.close().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}
