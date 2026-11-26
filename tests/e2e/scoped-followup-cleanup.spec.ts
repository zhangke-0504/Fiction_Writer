import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type {
  DocRef,
  Manuscript,
  ModelProfile,
  RuntimeView,
  Session,
  WriteReport,
} from '../../shared/contracts.js';
import type { ToolReceipt } from '../../electron/agent/tool-receipts.js';
import { diagnosticText, readDiagnostics } from './diagnostic-files.js';

const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
const chapter = { type: 'chapter', id: 'late' } as const;
const outline = { type: 'outline', id: 'outline' } as const;
const actor = { type: 'subject', id: 'keeper' } as const;
const ally = { type: 'subject', id: 'pilot' } as const;
const clue = { type: 'clue', id: 'seal' } as const;
const anchor = '号灯照在石阶上，领航人缓慢走过半开的门，把潮水的时刻记在已经湿透的册子上。';
const repeat = '潮钟又响了三下。';
const ending = `${repeat}领航人收好钥匙，绕到渡口另一边等雾散去，没有把岸边的铜船推离泊位。`;
const sceneFact = '守灯人把铜印交回主人手里，指给他看印章底部留下的裂纹。';
const scene = sceneFact + repeat;
const firstBody = `${anchor}\n\n${ending}`;
const planned = 'ASSET_PLAN_FIXTURE：守灯人预计把铜印送回给主人。';
const fulfilled = 'ASSET_FACT_FIXTURE：守灯人已把铜印交还给主人。';
const wrongAnchor = '守灯人从不离开渡口守望范围。';
const actorBody = `## 稳定设定\n\n${wrongAnchor}\n\n关系：[领航人](subjects/pilot.md)\n\n## 铜印状态\n\n${planned}\n`;
const insertPrompt = '在后章的石阶段后增补守灯人交还铜印的场面，同步这一章的大纲。';
const prior =
  '交还铜印的场面和大纲已保存。两项待办：删去新增场景末尾重复的潮钟句；把守灯人资料的归还计划改为已发生，保留其余设定和关系。';
const followPrompt = '把上面两项尚未处理的收尾做完，已写好的别重做。';
const reviewerText = 'REVIEW_EXPLANATION_FIXTURE：正文只删去新段尾的重复。';
const outlineAddition = '守灯人在石阶上把铜印交回，不改原有结尾。';

type Call = { type: 'tool_use'; id: string; name: string; input: object };
type Block =
  Call | { type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string };
type Wire = { tools?: { name: string }[]; messages: { role: string; content: Block[] }[] };
const text = (value: string): Block => ({ type: 'text', text: value });
function reply(res: ServerResponse, ...blocks: Block[]) {
  const events = [
    ...blocks.flatMap((content_block, index) => [
      { type: 'content_block_start', index, content_block },
      { type: 'content_block_stop', index },
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: blocks.some(({ type }) => type === 'tool_use') ? 'tool_use' : 'end_turn' },
    },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

type ReadSlice = { document: { revision: string; body: string } };
const target = (ref: DocRef) => ({ type: ref.type, documentId: ref.id });
const assetScope = (revision: string, quote = planned) => ({ revision, quote, replacement: fulfilled });

for (const mode of ['saved', 'wrong-anchor', 'pending'] as const) {
  test(`same-session scoped follow-up uses actual chapter and asset commits (${mode})`, async ({}, info) => {
    const root = info.outputPath('app');
    const errors: unknown[] = [];
    let phase: 'insert' | 'follow' = 'insert';
    let scopeReviews = 0;
    let patchReviews = 0;
    let draftRequests = 0;
    let chapterRevision = '';
    let assetRevision = '';
    let patchRevision = '';
    let savedAssetRevision: string | undefined;
    const server = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const wire = JSON.parse(raw) as Wire;
        const tools = wire.tools?.map(({ name }) => name) ?? [];
        const last = wire.messages.at(-1)!.content.at(-1)!;
        const call = (id: string, name: string, input: object, ...extras: Block[]) => {
          expect(tools).toContain(name);
          reply(res, ...extras, { type: 'tool_use', id, name, input });
        };
        if (tools.length === 1 && tools[0] === 'check_book_scope') {
          scopeReviews++;
          expect(last.type).toBe('text');
          const registration = JSON.parse((last as Extract<Block, { type: 'text' }>).text);
          if (phase === 'follow') {
            expect(registration.currentAuthor).toBe(followPrompt);
            expect(registration.referencedAssistant).toBe(prior);
            const item = registration.candidates.find(
              ({ operation }: { operation: string }) => operation === 'subject.update',
            );
            if (mode === 'pending') expect(item.assetPending).toBe(true);
            else expect(item.assetPatch).toEqual(assetScope(assetRevision));
          } else expect(registration.currentAuthor).toBe(insertPrompt);
          return call('scope-verdict', tools[0], { allowed: true });
        }
        if (tools.length === 1 && tools[0] === 'book_read_chapter')
          return reply(res, text('无需补读。'));
        if (tools.length === 1 && tools[0] === 'submit_chapter_patch_review') {
          patchReviews++;
          expect(phase).toBe('follow');
          expect(raw).toContain(scene);
          return call('patch-verdict', tools[0], { allowed: true }, text(reviewerText));
        }
        if (tools.length === 0 && phase === 'insert') {
          draftRequests++;
          return reply(res, text(scene));
        }
        if (last.type === 'text') {
          if (phase === 'insert') {
            expect(last.text).toBe(insertPrompt);
            return call('find-insert', 'tool_search', {
              query: 'book_get_context book_generate_chapter',
            });
          }
          expect(last.text).toBe(followPrompt);
          expect(raw).toContain(prior);
          return call('find-follow', 'tool_search', {
            query: 'book_get_context book_patch_chapter book_patch_asset book_apply_changes',
          });
        }
        if (last.type !== 'tool_result') throw new Error('Expected a tool result');
        const step = last.tool_use_id;
        const result = JSON.parse(last.content);
        if (phase === 'insert') {
          expect(result.ok, result.error).toBe(true);
          switch (step) {
            case 'find-insert':
              return call('insert-scope', 'book_task_scope', {
                items: [
                  { operation: 'chapter.insert', id: chapter.id, purpose: '补交还铜印的场景并同步大纲' },
                ],
              });
            case 'insert-scope':
              return call('initial-chapter', 'book_get_context', target(chapter));
            case 'initial-chapter':
              chapterRevision = (result.value as ReadSlice).document.revision;
              return call('initial-outline', 'book_get_context', target(outline));
            case 'initial-outline':
              return call('insert-actual', 'book_generate_chapter', {
                chapterId: chapter.id,
                mode: 'insert',
                subjectIds: [actor.id, ally.id],
                insertion: {
                  revision: chapterRevision,
                  quote: anchor,
                  place: 'after',
                  outline: {
                    revision: (result.value as ReadSlice).document.revision,
                    addition: outlineAddition,
                  },
                },
              });
            case 'insert-actual':
              expect(result.value).toMatchObject({ inserted: true, outlineUpdated: true });
              expect(result.value.insertionRef).toBeTruthy();
              return reply(res, text(prior));
          }
        } else {
          switch (step) {
            case 'find-follow':
              expect(
                result.value.candidates.some(({ id }: { id: string }) => id === 'book_patch_asset'),
              ).toBe(true);
              return call('read-current-chapter', 'book_get_context', target(chapter));
            case 'read-current-chapter': {
              const doc = (result.value as ReadSlice).document;
              expect(doc.body).toContain(scene);
              expect(doc.body).toContain(ending);
              chapterRevision = doc.revision;
              return call('read-current-asset', 'book_get_context', target(actor));
            }
            case 'read-current-asset': {
              const doc = (result.value as ReadSlice).document;
              expect(doc.body).toContain(planned);
              expect(doc.body).toContain(wrongAnchor);
              assetRevision = doc.revision;
              return call('follow-scope', 'book_task_scope', {
                sourceQuote: '两项待办：删去新增场景末尾重复的潮钟句',
                items: [
                  {
                    operation: 'chapter.patch',
                    id: chapter.id,
                    part: 'tail-echo',
                    purpose: '只删新增段的重复潮钟句',
                  },
                  {
                    operation: 'subject.update',
                    id: actor.id,
                    purpose: '把归还计划改成已发生',
                    ...(mode === 'pending'
                      ? { assetPending: true }
                      : { assetPatch: assetScope(assetRevision) }),
                  },
                ],
              });
            }
            case 'follow-scope':
              expect(result.ok, result.error).toBe(true);
              return call('chapter-patch', 'book_patch_chapter', {
                chapterId: chapter.id,
                revision: chapterRevision,
                edits: [{ part: 'tail-echo', quote: scene, replacement: sceneFact }],
              });
            case 'chapter-patch':
              expect(result.ok, result.error).toBe(true);
              expect(raw).not.toContain(reviewerText);
              patchRevision = result.value.revision;
              return call('invalid-generic', 'book_apply_changes', {
                operations: [{ type: 'subject', id: actor.id, action: 'patch' }],
              });
            case 'invalid-generic':
              expect(result.ok).toBe(false);
              return call('generic-route', 'book_apply_changes', {
                operations: [{ type: 'subject', id: actor.id, action: 'update', body: fulfilled }],
              });
            case 'generic-route':
              expect(result).toMatchObject({ ok: false, reason: 'asset_update_route' });
              return call('asset-patch', 'book_patch_asset', {
                kind: 'subject',
                id: actor.id,
                ...assetScope(assetRevision, mode === 'wrong-anchor' ? wrongAnchor : planned),
              });
            case 'asset-patch':
              if (mode === 'saved') {
                expect(result.ok, result.error).toBe(true);
                savedAssetRevision = result.value.revision;
                return reply(res, text('两个收尾均已保存。'));
              }
              expect(result).toMatchObject({ ok: false, reason: 'patch_not_authorized' });
              return reply(res, text('正文已保存，人物资料仍待处理。'));
          }
        }
        throw new Error(`Unexpected request during ${phase}: ${step}`);
      } catch (error) {
        errors.push(error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const app = await electron.launch({
      args: ['.'],
      env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root, FW_E2E_SHOW_WINDOW: '0' },
    });
    try {
      const page = await app.firstWindow();
      const profile = await rpc<ModelProfile>(page, 'profiles.save', {
        name: 'Scoped cleanup fixture',
        model: 'fixture',
        apiKey: 'not-a-real-key',
        protocol: 'messages',
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });
      const { id: bookId } = await rpc<{ id: string }>(page, 'book.create', {
        title: '岸边的铜印',
        summary: '只有夹具文本。',
      });
      const doc = (ref: DocRef) => rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: ref });
      const seed = await rpc<WriteReport>(page, 'book.changes.write', {
        bookId,
        changes: [
          {
            ...chapter,
            expect: null,
            fields: { title: '石阶', order: 1, subjectIds: [actor.id, ally.id] },
            body: firstBody,
          },
          {
            ...outline,
            expect: (await doc(outline)).revision,
            fields: {},
            body: '# 大纲\n\n<!-- chapter:late -->\n\n领航人在渡口等待退潮。',
          },
          { ...actor, expect: null, fields: { name: '守灯人', kind: 'character' }, body: actorBody },
          {
            ...ally,
            expect: null,
            fields: { name: '领航人', kind: 'character' },
            body: '## 稳定设定\n\n领航人掌管港口的船只。',
          },
          {
            ...clue,
            expect: null,
            fields: { title: '铜印裂纹', subjectIds: [actor.id], setupChapterId: chapter.id },
            body: '## 可见线索\n\n铜印的底部刻着纹路。\n\n## 回收真相\n\n裂纹能帮助主人找回铜印。',
          },
        ],
      });
      expect(seed.error).toBeUndefined();
      const session = await rpc<Session>(page, 'session.create', { bookId });
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
        const view = await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId });
        const run = view.sessions.find((row) => row.session.id === session.id)?.run;
        expect(errors).toEqual([]);
        expect(run?.status, run?.error).toBe('completed');
        return { runId, run };
      };
      const initial = await submit(insertPrompt);
      const before = await doc(chapter);
      const beforeAsset = await doc(actor);
      const untouched = await Promise.all([outline, ally, clue].map(doc));
      expect(before.body).toBe(`${anchor}\n\n${scene}\n\n${ending}`);
      expect(untouched[0].body).toContain(outlineAddition);
      expect(beforeAsset.body).toBe(actorBody);
      phase = 'follow';
      const followed = await submit(followPrompt);
      const success = mode === 'saved';
      expect(followed.run?.taskOutcome).toBe(success ? 'fulfilled' : 'partial');
      expect(followed.run?.progress).toMatchObject({
        complete: success,
        total: 2,
        done: success ? 2 : 1,
      });
      if (!success) expect(followed.run?.progress?.message).toContain(actor.id);
      const saved = await doc(chapter);
      const asset = await doc(actor);
      expect(saved.fields).toEqual(before.fields);
      expect(saved.body).toBe(`${anchor}\n\n${sceneFact}\n\n${ending}`);
      expect(saved.revision).toBe(patchRevision);
      expect(asset.fields).toEqual(beforeAsset.fields);
      expect(asset.body).toBe(success ? actorBody.replace(planned, fulfilled) : actorBody);
      expect(asset.revision).toBe(success ? savedAssetRevision : beforeAsset.revision);
      expect(await Promise.all([outline, ally, clue].map(doc))).toEqual(untouched);
      expect(draftRequests).toBe(1);
      expect(scopeReviews).toBe(2);
      expect(patchReviews).toBe(1);
      const bytes = (path: string) => readFile(join(root, 'library', bookId, path));
      expect(
        createHash('sha256')
          .update(await bytes('chapters/late.md'))
          .digest('hex'),
      ).toBe(saved.revision);
      expect(
        createHash('sha256')
          .update(await bytes('subjects/keeper.md'))
          .digest('hex'),
      ).toBe(asset.revision);
      const persisted = await readFile(join(root, 'state', 'sessions', `${session.id}.jsonl`), 'utf8');
      const rows = persisted
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { toolReceipt?: ToolReceipt; line?: { role: string; text: string } },
        );
      expect(rows.some(({ line }) => line?.role === 'assistant' && line.text === prior)).toBe(true);
      const receipts = rows.flatMap(({ toolReceipt }) => (toolReceipt ? [toolReceipt] : []));
      const insert = receipts.find(
        ({ runId, tool }) => runId === initial.runId && tool === 'book_generate_chapter',
      );
      expect(insert?.commitCount).toBe(2);
      expect(insert?.commits).toContainEqual({
        ...chapter,
        operation: 'write',
        revision: before.revision,
      });
      expect(insert?.commits).toContainEqual({
        ...outline,
        operation: 'write',
        revision: untouched[0].revision,
      });
      const writes = receipts.filter(
        ({ runId, commitCount }) => runId === followed.runId && commitCount > 0,
      );
      expect(writes.map(({ tool }) => tool)).toEqual(
        success ? ['book_patch_chapter', 'book_patch_asset'] : ['book_patch_chapter'],
      );
      expect(writes[0].commits).toEqual([{ ...chapter, operation: 'write', revision: saved.revision }]);
      if (success)
        expect(writes[1].commits).toEqual([{ ...actor, operation: 'write', revision: asset.revision }]);
      const trace = (await readDiagnostics(root, 'backend')).filter(
        ({ fields }) => fields.runId === followed.runId,
      );
      const logged = (name: string) =>
        trace.filter(({ event }) => event === name).map(({ fields }) => fields);
      const [registration] = logged('writing.task_scope');
      const [review] = logged('chapter.patch.review');
      const [assetAttempt] = logged('asset.patch.finished');
      const commits = logged('workspace.document.committed');
      expect(registration).toMatchObject({ outcome: 'ok', count: 2, callId: expect.any(String) });
      expect(review).toMatchObject({
        verdict: 'approved',
        hasVisibleText: true,
        callId: expect.any(String),
        spanId: expect.any(String),
      });
      expect(logged('model.finished')).toContainEqual(
        expect.objectContaining({ spanId: review.spanId, callId: review.callId, outcome: 'ok' }),
      );
      expect(logged('tool.rejected')).toContainEqual(
        expect.objectContaining({ tool: 'book_apply_changes', reason: 'invalid_arguments' }),
      );
      expect(logged('tool.finished')).toContainEqual(
        expect.objectContaining({ tool: 'book_apply_changes', reason: 'asset_update_route' }),
      );
      expect(commits).toHaveLength(success ? 2 : 1);
      expect(commits[0]).toMatchObject({
        docType: 'chapter',
        callId: review.callId,
        revision: logged('chapter.patch.finished')[0].revision,
      });
      expect(assetAttempt).toMatchObject({
        outcome: success ? 'ok' : 'failed',
        docType: 'subject',
        callId: expect.any(String),
      });
      if (success)
        expect(commits[1]).toMatchObject({
          docType: 'subject',
          callId: assetAttempt.callId,
          revision: assetAttempt.revision,
        });
      else expect(assetAttempt.reason).toBe('patch_not_authorized');
      expect(logged('writing.task_result')).toContainEqual(
        expect.objectContaining({
          count: 2,
          done: success ? 2 : 1,
          outcome: success ? 'ok' : 'partial',
        }),
      );
      expect(logged('run.finished')).toContainEqual(expect.objectContaining({ outcome: 'ok' }));
      const diagnostics = await diagnosticText(root, 'backend');
      for (const source of [
        insertPrompt,
        followPrompt,
        scene,
        planned,
        fulfilled,
        reviewerText,
        'ASSET_PLAN_FIXTURE',
        'ASSET_FACT_FIXTURE',
        'REVIEW_EXPLANATION_FIXTURE',
      ])
        expect(diagnostics).not.toContain(source);
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test('same-session paragraph spacing commits only the chosen separator', async ({}, info) => {
  const root = info.outputPath('app');
  const leftQuote = '他收好了航海日志。';
  const rightQuote = '雾里的钟声响起。';
  const left = `GAP_LEFT_FIXTURE：他在离开石阶前停了一下。${leftQuote}`;
  const right = `${rightQuote}守灯人走到栏杆边，仍没有看见那艘铜船。GAP_RIGHT_FIXTURE。`;
  const gap = '\n'.repeat(6);
  const rest = `\n\n${anchor}${gap}${ending}`;
  const beforeBody = `${left}${gap}${right}${rest}`;
  const afterBody = `${left}\n\n${right}${rest}`;
  const part = 'logbook-gap';
  const purpose = '只把航海日志段和钟声段之间多余的空行缩为一个空行。';
  const pending = `还有一项待办：${purpose}同章另一处空白保留。`;
  const inspect = '只列出第十章仍待处理的问题，不要改稿。';
  const follow = '按上面那项待办处理，不改其他地方。';
  const errors: unknown[] = [];
  let baseRevision: string;
  let toolRevision: string;
  let reviewCount = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const wire = JSON.parse(raw) as Wire;
      const tools = wire.tools?.map(({ name }) => name) ?? [];
      const last = wire.messages.at(-1)?.content.at(-1);
      const call = (id: string, name: string, input: object) => {
        expect(tools).toContain(name);
        reply(res, { type: 'tool_use', id, name, input });
      };
      if (tools.length === 1 && last?.type === 'text') {
        const [tool] = tools;
        if (tool === 'check_book_scope') {
          expect(JSON.parse(last.text)).toMatchObject({
            currentAuthor: follow,
            referencedAssistant: pending,
            candidates: [{ operation: 'chapter.patch', id: chapter.id, part, purpose }],
          });
          return call('scope-verdict', tool, { allowed: true });
        }
        if (tool === 'submit_chapter_patch_review') {
          reviewCount++;
          expect(JSON.parse(last.text)).toMatchObject({
            chapter: { id: chapter.id },
            edits: [
              {
                quote: leftQuote + gap + rightQuote,
                replacement: `${leftQuote}\n\n${rightQuote}`,
                part,
              },
            ],
            paragraphGap: { beforeLf: 6, afterLf: 2 },
          });
          return call('patch-verdict', tool, { allowed: true });
        }
      }
      if (last?.type === 'text') {
        if (last.text === inspect) return reply(res, text(pending));
        expect(last.text).toBe(follow);
        return call('find-gap-tools', 'tool_search', { query: 'book_get_context book_patch_chapter' });
      }
      if (last?.type !== 'tool_result') throw new Error('Expected a tool result');
      const result = JSON.parse(last.content);
      expect(result.ok, result.error).toBe(true);
      switch (last.tool_use_id) {
        case 'find-gap-tools':
          return call('read-gap', 'book_get_context', target(chapter));
        case 'read-gap': {
          const { document } = result.value as ReadSlice;
          expect(document.body).toBe(beforeBody);
          baseRevision = document.revision;
          return call('gap-scope', 'book_task_scope', {
            sourceQuote: purpose,
            items: [{ operation: 'chapter.patch', id: chapter.id, part, purpose }],
          });
        }
        case 'gap-scope':
          return call('gap-patch', 'book_patch_chapter', {
            chapterId: chapter.id,
            revision: baseRevision,
            edits: [{ paragraphGap: { leftQuote, rightQuote, blankLines: 1 }, part }],
          });
        case 'gap-patch':
          expect(result.value).toMatchObject({ chapterId: chapter.id, patched: 1, parts: [part] });
          toolRevision = result.value.revision;
          return reply(res, text('已只缩短指定的段间空白。'));
      }
      throw new Error('Unexpected tool result: ' + last.tool_use_id);
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root, FW_E2E_SHOW_WINDOW: '0' },
  });
  try {
    const page = await app.firstWindow();
    const profile = await rpc<ModelProfile>(page, 'profiles.save', {
      name: 'Paragraph gap fixture',
      model: 'fixture',
      apiKey: 'not-a-real-key',
      protocol: 'messages',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const { id: bookId } = await rpc<{ id: string }>(page, 'book.create', {
      title: '雾里的钟声',
      summary: '只有回归测试的占位文本。',
    });
    const doc = (ref: DocRef) => rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: ref });
    const other = { type: 'chapter', id: 'other' } as const;
    const seeded = await rpc<WriteReport>(page, 'book.changes.write', {
      bookId,
      changes: [
        { ...chapter, expect: null, fields: { title: '航海日志', order: 10 }, body: beforeBody },
        {
          ...other,
          expect: null,
          fields: { title: '下一章', order: 11 },
          body: `${anchor}${gap}${ending}`,
        },
      ],
    });
    expect(seeded.error).toBeUndefined();
    const session = await rpc<Session>(page, 'session.create', { bookId });
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
      expect(errors).toEqual([]);
      const view = await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId });
      const run = view.sessions.find((row) => row.session.id === session.id)?.run;
      expect(run?.status, run?.error).toBe('completed');
      return { run, runId };
    };
    await submit(inspect);
    const before = await doc(chapter);
    const untouched = await Promise.all([other, outline].map(doc));
    const path = join(root, 'library', bookId, 'chapters', `${chapter.id}.md`);
    const originalFile = await readFile(path, 'utf8');
    await page.evaluate((id) => {
      const changes: unknown[] = [];
      Reflect.set(window, 'paragraphGapChanges', changes);
      window.fw.subscribe((event) => {
        if (event.type === 'book-change' && event.bookId === id) changes.push(event.documents);
      });
    }, bookId);

    const { run, runId } = await submit(follow);
    expect(run?.taskOutcome).toBe('fulfilled');
    expect(run?.progress).toMatchObject({ complete: true, total: 1, done: 1 });
    expect(reviewCount).toBe(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'paragraphGapChanges')))
      .toEqual([[chapter]]);
    const saved = await doc(chapter);
    const savedFile = await readFile(path, 'utf8');
    expect(saved.fields).toEqual(before.fields);
    expect(saved.body).toBe(afterBody);
    expect(originalFile).toContain(beforeBody);
    expect(savedFile).toBe(originalFile.replace(beforeBody, afterBody));
    expect(originalFile.length - savedFile.length).toBe(4);
    expect(saved.revision).not.toBe(before.revision);
    expect(saved.revision).toBe(createHash('sha256').update(savedFile).digest('hex'));
    expect(saved.revision).toBe(toolRevision!);
    expect(await Promise.all([other, outline].map(doc))).toEqual(untouched);

    const receipts = (await readFile(join(root, 'state', 'sessions', `${session.id}.jsonl`), 'utf8'))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((row) => (JSON.parse(row) as { toolReceipt?: ToolReceipt }).toolReceipt)
      .filter((receipt) => receipt?.commitCount);
    expect(receipts).toEqual([
      expect.objectContaining({
        runId,
        tool: 'book_patch_chapter',
        commitCount: 1,
        commits: [{ ...chapter, operation: 'write', revision: saved.revision }],
      }),
    ]);
    const trace = (await readDiagnostics(root, 'backend')).filter(
      ({ fields }) => fields.runId === runId,
    );
    const reviews = trace.filter(({ event }) => event === 'chapter.patch.review');
    const commits = trace.filter(({ event }) => event === 'workspace.document.committed');
    expect(reviews).toHaveLength(1);
    expect(commits).toHaveLength(1);
    expect(reviews[0].fields).toMatchObject({ verdict: 'approved', callId: commits[0].fields.callId });
    expect(commits[0].fields.revision).toBe(
      trace.find(({ event }) => event === 'chapter.patch.finished')?.fields.revision,
    );
    expect(await diagnosticText(root, 'backend')).not.toMatch(/GAP_LEFT_FIXTURE|GAP_RIGHT_FIXTURE/);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
