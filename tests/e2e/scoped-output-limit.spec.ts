import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Manuscript,
  ModelProfile,
  RuntimeView,
  Session,
  WriteReport,
} from '../../shared/contracts.js';
import { readDiagnostics } from './diagnostic-files.js';

const first = '指出正文已经发生但资料还没同步的事项，不改稿。';
const prior = '维萨已经在灯塔现身，墨客已交回铜币。还需同步两个人物资料，并增设第二章目录。';
const follow = '解决未清理的问题';
const truncated = 'TRUNCATED_SCOPE_ATTEMPT_MUST_NOT_REENTER_CONTEXT';
const chapter = { type: 'chapter' as const, id: 'landing' };
const added = { type: 'chapter' as const, id: 'epilogue' };
const actor = { type: 'subject' as const, id: 'visa' };
const witness = { type: 'subject' as const, id: 'writer' };
const content = {
  visa: '## 稳定设定\n维萨一直在守护旧灯塔。',
  writer: '## 稳定设定\n墨客以旧港的铜币辨认航线。',
};
const facts = { visa: '维萨已经在灯塔现身。', writer: '墨客已交回铜币。' };
const revised = (id: keyof typeof content) => `${content[id]}\n\n## 已发生事件\n${facts[id]}`;
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);

type ToolUse = { id: string; name: string; input: object };
type Wire = {
  max_tokens: number;
  system: string | unknown[];
  tools?: { name: string }[];
  messages: {
    role: string;
    content: { type: string; text?: string; tool_use_id?: string; content?: string }[];
  }[];
};
function respond(res: ServerResponse, value: string | ToolUse, limit = false) {
  const block =
    typeof value === 'string' ? { type: 'text', text: value } : { type: 'tool_use', ...value };
  const blocks = limit ? [{ type: 'text', text: truncated }, block] : [block];
  const events = [
    ...blocks.flatMap((content_block, index) => [
      { type: 'content_block_start', index, content_block },
      { type: 'content_block_stop', index },
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: limit ? 'max_tokens' : typeof value === 'string' ? 'end_turn' : 'tool_use' },
    },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

for (const mode of [
  'ready',
  'read-first',
  'no-candidate',
  'repeat-limit',
  'cancel',
  'conflict',
  'overscoped',
] as const) {
  test(`the official Harness resumes a scoped Messages output limit (${mode})`, async ({}, info) => {
    const root = info.outputPath('app');
    const failures: string[] = [];
    const narrowed: Wire[] = [];
    let original: Wire | undefined;
    let activeAsset: keyof typeof content | undefined;
    let beforeActor: Manuscript;
    let oldChapter: Manuscript;
    let page: Page;
    let bookId = '';
    let session: Session;
    const read = (doc: object) => rpc<Manuscript>(page, 'book.doc.read', { bookId, doc });
    const externallyEdit = async () => {
      const result = await rpc<WriteReport>(page, 'book.changes.write', {
        bookId,
        changes: [
          {
            ...actor,
            expect: beforeActor.revision,
            fields: beforeActor.fields,
            body: `${content.visa}\n\n作者修改。`,
          },
        ],
      });
      expect(result.error).toBeUndefined();
      expect(result.committed).toEqual([actor]);
    };
    const server = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const wire = JSON.parse(raw) as Wire;
        const tools = wire.tools?.map(({ name }) => name) ?? [];
        const send = (id: string, name: string, input: object, limit = false) => {
          expect(tools).toContain(name);
          return respond(res, { id, name, input }, limit);
        };
        if (tools.length === 1 && tools[0] === 'check_book_scope') {
          expect(raw).toContain(prior);
          expect(raw).toContain(follow);
          return send('scope-review', 'check_book_scope', { allowed: true });
        }
        if (tools.length === 1 && tools[0] === 'submit_story_descriptions') {
          if (!activeAsset) throw new Error('Unexpected asset generation');
          return send('candidate', tools[0], {
            items: [{ id: activeAsset, body: revised(activeAsset) }],
          });
        }
        if (tools.length === 1 && tools[0] === 'check_asset_update_scope') {
          if (mode === 'conflict') await externallyEdit();
          return send('asset-review', tools[0], { allowed: true });
        }
        const last = wire.messages.at(-1)!.content[0];
        const targeted = (id: keyof typeof content) =>
          send(`read-${id}`, 'book_get_context', { type: 'subject', documentId: id });
        const update = (id: keyof typeof content) => {
          activeAsset = id;
          return send(`update-${id}`, 'book_generate_assets', {
            kind: 'subject',
            action: 'update',
            targets: [{ id }, ...(mode === 'overscoped' ? [{ id: witness.id }] : [])],
          });
        };
        const changes = [{ ...added, action: 'create', fields: { title: '尾声', order: 2 } }];
        const truncate = () => {
          expect(original).toBeUndefined();
          original = wire;
          return send('truncated-write', 'book_apply_changes', { operations: changes }, true);
        };
        if (JSON.stringify(wire.system).includes('输出触限后的逐项续接')) {
          expect(raw).not.toContain(truncated);
          expect(raw).not.toContain('truncated-write');
          expect(wire.max_tokens).toBe(original?.max_tokens);
          expect(wire.max_tokens).toBe(8192);
          narrowed.push(wire);
          if (narrowed.length === 1) {
            if (mode === 'repeat-limit')
              return send('second-truncation', 'book_apply_changes', { operations: changes }, true);
            if (mode === 'cancel') {
              await rpc(page, 'session.stop', { id: session.id });
              // A late valid action must not be executed after stop.
              return update('visa');
            }
            return mode === 'read-first' ? targeted('visa') : update('visa');
          }
          const result = JSON.parse(last.content!);
          expect(result.ok).toBe(true);
          if (last.tool_use_id === 'read-visa') return update('visa');
          if (last.tool_use_id === 'update-visa') return targeted('writer');
          if (last.tool_use_id === 'read-writer') return update('writer');
          if (last.tool_use_id === 'update-writer') return respond(res, '两项资料已同步，目录已保存。');
          throw new Error('Unexpected narrowed request');
        }
        if (last.type !== 'tool_result') {
          if (last.text === first) return respond(res, prior);
          expect(last.text).toBe(follow);
          return send('discover', 'tool_search', {
            query: mode === 'read-first' ? 'book_apply_changes' : 'book_apply_changes book_get_context',
          });
        }
        expect(JSON.parse(last.content!).ok).toBe(true);
        if (last.tool_use_id === 'discover') {
          return send('scope', 'book_task_scope', {
            sourceQuote: prior,
            items: [
              { operation: 'chapter.catalog', id: added.id, purpose: '增设第二章目录' },
              {
                operation: 'subject.update',
                id: actor.id,
                purpose: '同步维萨在灯塔现身的事实',
                ...(mode === 'no-candidate' && {
                  currentEvidence: { revision: beforeActor.revision, quote: '维萨一直在守护旧灯塔' },
                }),
              },
              ...(mode === 'no-candidate'
                ? []
                : [{ operation: 'subject.update', id: witness.id, purpose: '同步墨客交回铜币' }]),
            ],
          });
        }
        if (last.tool_use_id === 'scope')
          return send('catalog', 'book_apply_changes', { operations: changes });
        if (last.tool_use_id === 'catalog') {
          if (mode === 'no-candidate') await externallyEdit();
          return mode === 'read-first' || mode === 'no-candidate' ? truncate() : targeted('visa');
        }
        if (last.tool_use_id === 'read-visa') return truncate();
        throw new Error('Unexpected fixture request');
      } catch (error) {
        failures.push(String(error));
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
      page = await app.firstWindow();
      const profile = await rpc<ModelProfile>(page, 'profiles.save', {
        name: 'fixture',
        model: 'fixture',
        apiKey: 'fixture-key',
        protocol: 'messages',
        baseUrl: `http://127.0.0.1:${port}`,
      });
      ({ id: bookId } = await rpc<{ id: string }>(page, 'book.create', {
        title: '黄灯侠受控复验',
        summary: '灯塔的线索。',
      }));
      const outline = await read({ type: 'outline', id: 'outline' });
      const seeded = await rpc<WriteReport>(page, 'book.changes.write', {
        bookId,
        changes: [
          { ...outline, expect: outline.revision, body: '维萨现身，墨客交还铜币。' },
          {
            ...chapter,
            expect: null,
            fields: { title: '现身', order: 1 },
            body: `${facts.visa}\n\n${facts.writer}`,
          },
          { ...actor, expect: null, fields: { name: '维萨', kind: 'character' }, body: content.visa },
          {
            ...witness,
            expect: null,
            fields: { name: '墨客', kind: 'character' },
            body: content.writer,
          },
        ],
      });
      expect(seeded.error).toBeUndefined();
      beforeActor = await read(actor);
      oldChapter = await read(chapter);
      session = await rpc<Session>(page, 'session.create', { bookId });
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
        )!;
      };
      expect((await submit(first)).run?.status).toBe('completed');
      const view = await submit(follow);
      expect(failures).toEqual([]);
      const success = mode === 'ready' || mode === 'read-first';
      expect(view.run?.status, view.run?.error).toBe(
        success ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed',
      );
      if (success) expect(view.run?.taskOutcome).toBe('fulfilled');
      else if (mode !== 'cancel') expect(view.run?.taskOutcome).toBe('partial');
      expect((await read(chapter)).revision).toBe(oldChapter.revision);
      expect((await read(added)).fields.title).toBe('尾声');
      expect((await read(actor)).body.trim()).toBe(
        success
          ? revised('visa')
          : mode === 'conflict' || mode === 'no-candidate'
            ? `${content.visa}\n\n作者修改。`
            : content.visa,
      );
      expect((await read(witness)).body.trim()).toBe(success ? revised('writer') : content.writer);
      const events = (await readDiagnostics(root, 'backend')).filter(
        ({ fields }) => fields.runId === view.run!.id,
      );
      const limit = events.find(
        ({ event, fields }) => event === 'tool.rejected' && fields.reason === 'output_limit',
      );
      expect(limit?.fields.tool).toBe('book_apply_changes');
      expect(
        events.filter(
          ({ event, fields }) => event === 'tool.started' && fields.tool === 'book_apply_changes',
        ),
      ).toHaveLength(1);
      const decisions = events.filter(({ event }) => event === 'model.output_limit_recovery');
      const dispatched = decisions.filter(({ fields }) => fields.recovery === 'dispatched');
      expect(dispatched).toHaveLength(mode === 'no-candidate' ? 0 : 1);
      if (dispatched.length) {
        const retry = dispatched[0].fields;
        expect(retry.originalSpanId).toBe(limit?.fields.spanId);
        const requests = events.filter(
          ({ event, fields }) =>
            event === 'model.budget_dispatched' && fields.turn === retry.turn && fields.lane === 'agent',
        );
        expect(requests.map(({ fields }) => fields.maxTokens)).toEqual([8192, 8192]);
        expect(requests.map(({ fields }) => fields.spanId)).toEqual([
          retry.originalSpanId,
          retry.spanId,
        ]);
      }
      if (success) expect(narrowed).toHaveLength(mode === 'read-first' ? 5 : 4);
      else expect(narrowed).toHaveLength(mode === 'no-candidate' ? 0 : 1);
      if (mode === 'no-candidate')
        expect(decisions.map(({ fields }) => fields.recovery)).toEqual(['no_safe_step']);
      if (mode === 'repeat-limit')
        expect(decisions.some(({ fields }) => fields.recovery === 'repeat_limit')).toBe(true);
      if (mode === 'overscoped')
        expect(decisions.some(({ fields }) => fields.recovery === 'invalid_step')).toBe(true);
      if (mode === 'conflict') expect(view.run?.error).toContain('没有取得新的可核对结果');
      const persisted = await readFile(join(root, 'state', 'sessions', `${session.id}.jsonl`), 'utf8');
      expect(persisted).not.toContain(truncated);
      const receipts = persisted
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line).toolReceipt)
        .filter((receipt) => receipt?.commits?.length);
      const committed = receipts
        .flatMap(({ commits }) => commits)
        .map(({ id, revision }) => [id, revision]);
      const confirmed = await Promise.all((success ? [added, actor, witness] : [added]).map(read));
      expect(committed).toEqual(confirmed.map(({ id, revision }) => [id, revision]));
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
