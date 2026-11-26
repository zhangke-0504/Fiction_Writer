import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  BookView,
  Change,
  Manuscript,
  ModelProfile,
  RuntimeView,
  Session,
  WriteReport,
} from '../../shared/contracts';
import { readDiagnostics } from './diagnostic-files';

const firstPrompt = '十章都写好了，检查上面的大纲安排与现稿的差异。';
const prior = '第九章大纲已有娜塔莎与伊琳娜对决，但正文缺少这一场。可选保留悬念，或补上对决。';
const prefix = '娜塔莎推开镜厅的门。';
const suffix = '旧设施塌下前，卡佳带着名单撤离。';
const scene =
  '伊琳娜从镜后的暗门走出，出手如同维也纳留下的那次袭击。娜塔莎认出了手法，截住伊琳娜挥来的手，两人在镜厅短暂交手。';
const ch09 = { type: 'chapter' as const, id: 'ch-09' };
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);

type ChatMessage = { role: string; content: string | null; tool_call_id?: string };

for (const mode of ['original', 'paraphrase', 'missing', 'stale-after-catalog'] as const) {
  test(`the Black Widow continuation uses saved story assets (${mode})`, async ({}, info) => {
    const prompt = mode === 'paraphrase' ? '按后一个选项把她们交手那段补进去。' : '补上对决';
    const root = info.outputPath('app');
    const errors: string[] = [];
    let draftRequests = 0;
    let bookId = '';
    let revision = '';
    const server = createServer(async (req, res) => {
      try {
        let source = '';
        for await (const chunk of req) source += chunk;
        const wire = JSON.parse(source) as {
          messages: ChatMessage[];
          tools?: { function: { name: string } }[];
        };
        const tools = wire.tools?.map((tool) => tool.function.name) ?? [];
        const last = wire.messages.at(-1)!;
        const send = (delta: object, finish_reason: string) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: [DONE]\n\n`,
          );
        };
        const text = (content: string) => send({ content }, 'stop');
        const use = (id: string, name: string, args: object) => {
          expect(tools).toContain(name);
          send(
            { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] },
            'tool_calls',
          );
        };
        if (tools.length === 1 && tools[0] === 'check_book_scope') {
          const input = JSON.parse(last.content!);
          expect(input.currentAuthor).toBe(prompt);
          expect(input.referencedAssistant).toBe(prior);
          return use('verdict', 'check_book_scope', { allowed: true });
        }
        if (tools.length === 1 && tools[0] === 'book_read_chapter') return text('无需补读。');
        if (!tools.length && last.content?.includes('作品资料（数据）')) {
          draftRequests++;
          expect(last.content).toContain('伊琳娜');
          expect(last.content).toContain('毒针');
          return text(scene);
        }
        const insert = () =>
          use('insert-duel', 'book_generate_chapter', {
            chapterId: ch09.id,
            mode: 'insert',
            subjectIds: ['natasha', mode === 'missing' ? 'absent-person' : 'irina'],
            clueIds: ['clue-kiss'],
            insertion: { revision, quote: prefix, place: 'after' },
          });
        if (last.role === 'user') {
          if (last.content === firstPrompt) return text(prior);
          expect(last.content).toBe(prompt);
          return use('find-tools', 'tool_search', {
            query: 'book_get_context book_generate_chapter book_apply_changes',
          });
        }
        const result = JSON.parse(last.content!);
        if (last.tool_call_id === 'find-tools')
          return use('scope-duel', 'book_task_scope', {
            sourceQuote: '第九章大纲已有娜塔莎与伊琳娜对决',
            items: [
              {
                operation: 'chapter.insert',
                id: ch09.id,
                purpose: '在镜厅段补上两名既有人物的对决并体现毒针线索',
                stage: 'reveal',
              },
              ...(mode === 'stale-after-catalog'
                ? [{ operation: 'chapter.catalog', id: ch09.id, purpose: '登记目录人物关系' }]
                : []),
            ],
          });
        if (last.tool_call_id === 'scope-duel') {
          expect(result.ok, result.error).toBe(true);
          return use('read-setup', 'book_get_context', {});
        }
        if (last.tool_call_id === 'read-setup')
          return use('read-ninth', 'book_get_context', { type: 'chapter', documentId: ch09.id });
        if (last.tool_call_id === 'read-ninth') {
          expect(result.ok, result.error).toBe(true);
          revision = result.value.document.revision;
          if (mode === 'stale-after-catalog')
            return use('catalog', 'book_apply_changes', {
              operations: [
                {
                  type: 'chapter',
                  action: 'update',
                  id: ch09.id,
                  fields: { subjectIds: ['natasha', 'irina'] },
                },
              ],
            });
          return insert();
        }
        if (last.tool_call_id === 'catalog') {
          expect(result.ok, result.error).toBe(true);
          return insert(); // Deliberately reuse the version from before the catalog write.
        }
        if (last.tool_call_id === 'insert-duel') {
          if (mode === 'missing') {
            expect(result).toMatchObject({
              ok: false,
              reason: 'invalid_references',
              value: { missing: [{ type: 'subject', id: 'absent-person' }] },
            });
            return text('指定引用不存在，未写入。');
          }
          if (mode === 'stale-after-catalog') {
            expect(result).toMatchObject({ ok: false, reason: 'conflict' });
            return text('目录变更已保存，对决正文没有保存。');
          }
          expect(result).toMatchObject({ ok: true, value: { inserted: true, outlineUpdated: false } });
          return text('第九章的对决已落盘。');
        }
        throw new Error('Unexpected fixture request');
      } catch (error) {
        errors.push(String(error));
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const app = await electron.launch({
      args: ['.'],
      env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root, FW_E2E_SHOW_WINDOW: '0' },
    });
    try {
      const page = await app.firstWindow();
      const profile = await rpc<ModelProfile>(page, 'profiles.save', {
        name: 'fixture',
        model: 'fixture',
        apiKey: 'not-a-real-key',
        protocol: 'chat',
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });
      ({ id: bookId } = await rpc<{ id: string }>(page, 'book.create', {
        title: '黑寡妇',
        summary: '基于漫威漫画《黑寡妇》来编写的故事',
      }));
      const outline = await rpc<Manuscript>(page, 'book.doc.read', {
        bookId,
        doc: { type: 'outline', id: 'outline' },
      });
      const changes: Change[] = [
        {
          ...outline,
          expect: outline.revision,
          body: '# 大纲\n\n<!-- chapter:ch-09 -->\n\n娜塔莎在镜厅与伊琳娜对决，认出维也纳的毒针手法。',
        },
        {
          type: 'subject',
          id: 'natasha',
          expect: null,
          fields: { name: '娜塔莎', kind: 'character' },
          body: '## 稳定设定\n娜塔莎追查维也纳事件。',
        },
        {
          type: 'subject',
          id: 'irina',
          expect: null,
          fields: { name: '伊琳娜', kind: 'character' },
          body: '## 稳定设定\n伊琳娜熟悉旧设施。',
        },
        {
          type: 'clue',
          id: 'clue-kiss',
          expect: null,
          fields: {
            title: '毒针手法',
            setupChapterId: 'ch-01',
            payoffChapterId: ch09.id,
            subjectIds: ['natasha', 'irina'],
          },
          body: '## 可见线索\n维也纳事件留下独特的毒针痕迹。\n\n## 回收真相\n娜塔莎在镜厅认出同一手法。',
        },
        ...Array.from({ length: 10 }, (_, i): Change => ({
          type: 'chapter',
          id: `ch-${String(i + 1).padStart(2, '0')}`,
          expect: null,
          fields: { title: i === 8 ? '血与天鹅' : `章节 ${i + 1}`, order: i + 1 },
          body: i === 8 ? `${prefix}\n\n${suffix}` : `第 ${i + 1} 章已经保存的正文。`,
        })),
      ];
      expect(
        (await rpc<WriteReport>(page, 'book.changes.write', { bookId, changes })).error,
      ).toBeUndefined();
      const docs = async () => (await rpc<BookView>(page, 'book.read', { bookId })).documents;
      const original = await docs();
      const session = await rpc<Session>(page, 'session.create', { bookId });
      const runView = async () =>
        (await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId })).sessions.find(
          (row) => row.session.id === session.id,
        );
      const submit = async (text: string) => {
        const { runId } = await rpc<{ runId: string }>(page, 'session.start', {
          id: session.id,
          profileId: profile.id,
          prompt: text,
          effort: 'high',
        });
        await expect
          .poll(
            async () =>
              (await readDiagnostics(root, 'backend')).find(
                ({ event, fields }) => event === 'run.finished' && fields.runId === runId,
              )?.fields.outcome,
          )
          .toBe('ok');
        const run = (await runView())!.run!;
        expect(run).toMatchObject({ id: runId, status: 'completed' });
        return run;
      };
      await submit(firstPrompt);
      expect((await runView())?.messages.at(-1)?.text).toBe(prior);
      const run = await submit(prompt);
      expect(errors).toEqual([]);
      const result = await docs();
      expect(result.filter((d) => d.id !== ch09.id)).toEqual(original.filter((d) => d.id !== ch09.id));
      const success = mode === 'original' || mode === 'paraphrase';
      expect(run.taskOutcome).toBe(success ? 'fulfilled' : 'incomplete');
      expect(run.progress).toMatchObject({ done: success ? 1 : 0, total: 1, complete: success });
      expect(draftRequests).toBe(success ? 1 : 0);
      const chapter = await rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: ch09 });
      expect(chapter.body.trim()).toBe(
        success ? `${prefix}\n\n${scene}\n\n${suffix}` : `${prefix}\n\n${suffix}`,
      );
      if (mode !== 'stale-after-catalog')
        expect(chapter.fields).toEqual(original.find((d) => d.id === ch09.id)?.fields);
      const path = join(root, 'state', 'sessions', `${session.id}.jsonl`);
      const receipts = (await readFile(path, 'utf8'))
        .trim()
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line).toolReceipt)
        .filter((receipt) => receipt?.runId === run.id && receipt.commitCount > 0);
      const committedTools = success
        ? ['book_generate_chapter']
        : mode === 'stale-after-catalog'
          ? ['book_apply_changes']
          : [];
      expect(receipts.map((receipt) => receipt.tool)).toEqual(committedTools);
      if (receipts.length) {
        const bytes = await readFile(join(root, 'library', bookId, 'chapters', 'ch-09.md'));
        const hash = createHash('sha256').update(bytes).digest('hex');
        expect(receipts[0].commits).toMatchObject([{ ...ch09, operation: 'write', revision: hash }]);
      }
      const trace = (await readDiagnostics(root, 'backend')).filter(
        ({ fields }) => fields.runId === run.id,
      );
      const firstAgent = trace.find(
        ({ event, fields }) => event === 'model.budget_dispatched' && fields.lane === 'agent',
      );
      expect(firstAgent).toBeDefined();
      expect(trace.find(({ event }) => event === 'tool.discovery')?.logSeq ?? 0).toBeGreaterThan(
        firstAgent!.logSeq,
      );
      expect(trace.some(({ event }) => event === 'memory.recall.finished' && !success)).toBe(false);
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
