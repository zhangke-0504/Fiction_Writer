import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DocRef, Manuscript } from '../shared/contracts.js';
import { chapterPlacementFingerprint, digest, docKey } from '../electron/documents.js';
import { WorkspaceService } from '../electron/workspace.js';
import {
  insertionAnchor,
  insertPassage,
  type ChapterInsertion,
} from '../electron/agent/chapter-insertion.js';
import { readEditCommit, targetRevisions, type EditCommit } from '../electron/agent/edit-proposal.js';
import { ConfirmedBookEdit } from '../electron/agent/book-edit.js';
import { NovelTools } from '../electron/agent/novel-tools.js';
import { sceneText, syncStoryNote, type NoteSyncTarget } from '../electron/agent/story-sync.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { ScriptedProvider } from '../electron/agent/scripted.js';
import type { RunContext } from '../electron/agent/runs.js';
import { collectDiagnostics } from './diagnostic-fixture.js';

const prompt = '在第一章插入一段陌生人登场的正文';
const first = '雨声打在盲窗上。';
const anchorText = '守夜人低头看手。掌心还留着火星溅过的热意。他记得账簿在那道暗门后头。';
const ending = '船长没有听见那一刻的钟声。';
const copied = '守夜人低头看手。掌心还留着火星溅过的热意';
const newAction = '他把手翻过来，发现掌心压着一页墨蓝色的纸。';
const event = '陌生人把清单递给船长，一句话也没说。';
const restricted = '。不要同步主体';
const dirty = copied + '，' + newAction + '\n\n' + event;
const original = [first, anchorText, ending].join('\r\n\r\n');
const ref = { type: 'chapter', id: 'ch1' } as const;
const outlineRef = { type: 'outline', id: 'outline' } as const;
const assetRef = { type: 'subject', id: 'stranger' } as const;
const chapterKey = docKey(ref),
  assetKey = docKey(assetRef);

// The production checker now blocks this prose. Exercise the fallback by reproducing a
// missed validation on a real workspace commit, then use the same internal receipt issuer.
type Internals = {
  issueInsertionRef(
    ctx: RunContext,
    chapterId: string,
    revision: string,
    insertion: ChapterInsertion,
    commit: EditCommit,
  ): string | undefined;
  directPassages: Map<string, { chapterId: string; stage: 'addition'; assets: string[] }>;
  directCommits: EditCommit[];
  createdHere: Set<string>;
  syncTargets(docs: Manuscript[]): NoteSyncTarget[];
};
async function fixture(t: TestContext, author = prompt, draft?: string) {
  const folder = await mkdtemp(join(tmpdir(), 'fw-echo-clean-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const ws = new WorkspaceService({ libraryRoot: folder });
  await ws.init();
  const { id } = await ws.createBook({ title: '夜航杂记', summary: '一个守夜人听到一声钟。' });
  const outline = await ws.readDocument(id, outlineRef);
  assert.equal(
    (
      await ws.writeChanges(id, [
        {
          ...outlineRef,
          expect: outline.revision,
          fields: outline.fields,
          body: '<!-- chapter:ch1 -->\n\n已有安排。',
        },
        { ...ref, expect: null, fields: { order: 1, title: '夜航' }, body: original },
      ])
    ).error,
    undefined,
  );
  const trace = collectDiagnostics();
  const controller = new AbortController();
  const runId = randomUUID();
  const ctx = {
    id: runId,
    session: { bookId: id, id: randomUUID(), cwd: ws.bookRoot(id), label: 'test', updated: '' },
    signal: controller.signal,
    diagnostic: (event, fields) => trace.report(event, { runId, ...fields }),
    authorLine: 0,
    preview() {},
    progress() {},
    text() {},
    async line() {},
    async saveNovelTask() {},
  } satisfies RunContext;
  const provider = new ScriptedProvider(
    draft ? [() => ({ text: draft, role: 'assistant', calls: [] })] : [],
  );
  const services = new NovelTools(
    ws,
    id,
    provider,
    new SkillCatalog(fileURLToPath(new URL('../skills', import.meta.url))),
    { authorPrompt: author },
  );
  services.prepareEdit(ctx, (await ws.readAll(id)).documents);
  const internal = services as unknown as Internals;
  const call = (name: string, params: object, scope: RunContext = ctx) =>
    services
      .tools()
      .find((tool) => tool.name === name)!
      .execute(params, scope);
  const load = () => ws.readDocument(id, ref);
  const insertWith = async (
    text: string,
    config: { position?: string; attachOutline?: boolean; partial?: boolean; assets?: boolean } = {},
  ) => {
    const old = await load();
    const outline = await ws.readDocument(id, outlineRef);
    const insertion: ChapterInsertion = {
      revision: old.revision,
      quote: config.position ?? anchorText,
      place: 'after',
      ...(config.attachOutline && {
        outline: { revision: outline.revision, addition: '本章写短暂相遇。' },
      }),
    };
    const anchor = insertionAnchor(old, insertion);
    const body = insertPassage(old.body, anchor.offset, text);
    const size = body.length - old.body.length;
    const revisions: Record<string, string> = {};
    const diagnostic: RunContext['diagnostic'] = (event, fields) => {
      if (event === 'workspace.document.committed' && typeof fields?.revision === 'string')
        revisions[String(fields.documentRef)] = fields.revision;
    };
    const saved = await ws.writeChanges(
      id,
      [
        { ...ref, expect: old.revision, fields: old.fields, body },
        ...(config.attachOutline && !config.partial
          ? [
              {
                ...outlineRef,
                expect: outline.revision,
                fields: outline.fields,
                body: outline.body + '\n\n本章写短暂相遇。',
              },
            ]
          : []),
      ],
      undefined,
      [],
      diagnostic,
    );
    assert.equal(saved.error, undefined);
    const commit: EditCommit = {
      anchor: anchor.key,
      target: 'passage/' + anchor.key,
      revisions,
      scene: {
        offset: anchor.offset,
        size,
        fragmentOffset: body.slice(anchor.offset, anchor.offset + size).indexOf(text),
        length: text.length,
        digest: digest(text),
        assets: config.assets ? [assetKey] : [],
      },
    };
    internal.directCommits.push(commit);
    if (config.assets)
      internal.directPassages.set(commit.target, {
        chapterId: ref.id,
        stage: 'addition',
        assets: [assetKey],
      });
    const doc = await load();
    return {
      commit,
      doc,
      insertion,
      insertionRef: internal.issueInsertionRef(ctx, ref.id, doc.revision, insertion, commit),
    };
  };
  return { ws, id, ctx, load, call, insertWith, internal, controller, trace, services };
}

test('a normal no-outline insert returns an actual cleanup reference, but new prose is never deleted', async (t) => {
  const f = await fixture(t, prompt, event);
  const old = await f.load();
  const result = (await f.call('book_generate_chapter', {
    chapterId: ref.id,
    mode: 'insert',
    insertion: {
      revision: old.revision,
      quote: anchorText,
      place: 'after',
    },
  })) as { revision: string; insertionRef: string };
  assert.match(result.insertionRef, /^[a-f0-9-]{36}$/u);
  assert.equal(result.revision, (await f.load()).revision);
  await assert.rejects(f.call('book_clean_insert_echo', { chapterId: ref.id, ...result }), {
    diagnosticReason: 'insert_cleanup_unsafe',
  });
  assert.equal(
    (await f.load()).body,
    insertPassage(original, original.indexOf(anchorText) + anchorText.length, event),
  );
  assert.deepEqual(f.trace.rejected, []);
});

test('a valid same-run receipt removes only the duplicate head, with no chapter or outline replay', async (t) => {
  const f = await fixture(t);
  const earlier = await f.insertWith('他听到窗外一只鸟突然振翅。', { position: ending });
  const inserted = await f.insertWith(dirty, { attachOutline: true });
  const prior = await f.ws.readAll(f.id);
  const args = {
    chapterId: ref.id,
    revision: inserted.doc.revision,
    insertionRef: inserted.insertionRef!,
  };
  const result = (await f.call('book_clean_insert_echo', args)) as {
    cleaned: boolean;
    revision: string;
    pendingSync: unknown[];
  };
  assert.ok(result.cleaned);
  assert.equal(result.revision, (await f.load()).revision);
  assert.deepEqual(result.pendingSync, []);
  const now = await f.ws.readAll(f.id);
  assert.deepEqual(
    now.documents.filter((d) => d.type !== 'chapter'),
    prior.documents.filter((d) => d.type !== 'chapter'),
  );
  const doc = await f.load();
  assert.deepEqual(doc.fields, inserted.doc.fields);
  assert.equal(doc.body, inserted.doc.body.replace(dirty, newAction + '\n\n' + event));
  assert.equal(sceneText(earlier.commit, f.internal.directCommits, doc), '他听到窗外一只鸟突然振翅。');
  assert.equal(sceneText(inserted.commit, f.internal.directCommits, doc), newAction + '\n\n' + event);
  await assert.rejects(f.call('book_clean_insert_echo', args), {
    diagnosticReason: 'insert_cleanup_receipt',
  });
  assert.deepEqual(f.trace.rejected, []);
  const trace = JSON.stringify(f.trace.rows);
  assert.match(trace, new RegExp(inserted.insertionRef!));
  assert.ok(
    !trace.includes(copied) &&
      !trace.includes(digest(dirty)) &&
      !trace.includes(digest(newAction + '\n\n' + event)),
  );
  const stored = f.internal.directCommits.at(-1)!;
  const plan = {
    summary: '改这一处。',
    assets: [],
    passages: [{ id: 'green', stage: 'addition' as const, chapterId: ref.id, note: '相遇。' }],
  };
  const firstRecord = readEditCommit({ ...inserted.commit, target: 'passage/green' }, plan)!;
  const cleaned = readEditCommit({ ...stored, target: 'passage/green' }, plan)!;
  assert.ok(cleaned?.cleanup);
  assert.equal(
    targetRevisions({ proposal: { plan } as never, commits: [firstRecord, cleaned] }, 'passage/green')[
      chapterKey
    ],
    doc.revision,
  );
});

for (const change of [
  'forged',
  'different-run',
  'different-session',
  'new-revision',
  'partial',
  'unsafe',
  'prohibited',
  'narrowed',
  'cancel',
] as const) {
  test('zero writes on rejected cleanup: ' + change, async (t) => {
    const author = prompt + (change === 'prohibited' ? '。禁止删除。' : '');
    const f = await fixture(t, author);
    const inserted = await f.insertWith(
      change === 'unsafe' ? '**' + copied + '**，' + newAction : dirty,
      { attachOutline: change === 'partial', partial: change === 'partial' },
    );
    if (change === 'partial') assert.equal(inserted.insertionRef, undefined);
    if (change === 'new-revision')
      assert.equal(
        (
          await f.ws.writeChanges(f.id, [
            {
              ...ref,
              expect: inserted.doc.revision,
              fields: inserted.doc.fields,
              body: inserted.doc.body + '\n\n作者新加的话。',
            },
          ])
        ).error,
        undefined,
      );
    if (change === 'cancel') f.controller.abort();
    const expected = await f.load();
    const scope = {
      ...f.ctx,
      ...(change === 'different-run' && { id: randomUUID() }),
      ...(change === 'different-session' && { session: { ...f.ctx.session, id: randomUUID() } }),
      ...(change === 'narrowed' && { narrowedWriting: true }),
    };
    const result =
      change === 'new-revision'
        ? 'conflict'
        : change === 'unsafe'
          ? 'insert_cleanup_unsafe'
          : ['prohibited', 'narrowed'].includes(change)
            ? 'insert_cleanup_scope'
            : 'insert_cleanup_receipt';
    const token = change === 'forged' ? randomUUID() : (inserted.insertionRef ?? randomUUID());
    const attempt = f.call(
      'book_clean_insert_echo',
      { chapterId: ref.id, revision: expected.revision, insertionRef: token },
      scope,
    );
    if (change === 'cancel') await assert.rejects(attempt, { name: 'AbortError' });
    else await assert.rejects(attempt, { diagnosticReason: result });
    assert.deepEqual(await f.load(), expected);
    assert.deepEqual(f.trace.rejected, []);
    if (change === 'forged') assert.ok(!JSON.stringify(f.trace.rows).includes(token));
  });
}

for (const sync of ['not-yet', 'keep', 'needs-resync', 'not-allowed'] as const) {
  test('cleanup does not misreport sync: ' + sync, async (t) => {
    const f = await fixture(t, prompt + (sync === 'not-allowed' ? restricted : ''));
    const note = '## 稳定设定\n\n陌生人守着一份清单。';
    assert.equal(
      (
        await f.ws.writeChanges(f.id, [
          { ...assetRef, expect: null, fields: { kind: 'character', name: '陌生人' }, body: note },
        ])
      ).error,
      undefined,
    );
    const originalAsset = await f.ws.readDocument(f.id, assetRef);
    f.internal.createdHere.add(assetKey);
    f.internal.directCommits.push({
      target: assetKey,
      revisions: { [assetKey]: originalAsset.revision },
    });
    const inserted = await f.insertWith(dirty, { assets: true });
    if (sync !== 'not-yet') {
      const quote = sync === 'keep' ? event : copied + '，' + newAction;
      assert.equal(
        (
          await f.ws.writeChanges(f.id, [
            {
              ...assetRef,
              expect: originalAsset.revision,
              fields: originalAsset.fields,
              body: note + '\n\n## 已发生变化\n\n<!-- chapter:ch1 -->\n\n- 迹象\n  原文：' + quote,
            },
          ])
        ).error,
        undefined,
      );
      const asset = await f.ws.readDocument(f.id, assetRef);
      f.internal.directCommits.push({
        target: assetKey,
        revisions: { [assetKey]: asset.revision },
        synced: { [inserted.commit.target]: inserted.doc.revision },
      });
    }
    const savedAsset = await f.ws.readDocument(f.id, assetRef);
    const cleanup = f.call('book_clean_insert_echo', {
      chapterId: ref.id,
      revision: inserted.doc.revision,
      insertionRef: inserted.insertionRef!,
    });
    if (sync === 'not-allowed') {
      await assert.rejects(cleanup, { diagnosticReason: 'insert_cleanup_sync' });
      assert.deepEqual(await f.load(), inserted.doc);
    } else {
      const result = (await cleanup) as { pendingSync: unknown[]; revision: string };
      const target = f.internal.syncTargets((await f.ws.readAll(f.id)).documents)[0];
      assert.equal(target.synced, sync === 'keep');
      assert.equal(target.ready, true);
      assert.equal(target.revisions[inserted.commit.target], result.revision);
      assert.equal(result.pendingSync.length, sync === 'keep' ? 0 : 1);
    }
    assert.deepEqual(await f.ws.readDocument(f.id, assetRef), savedAsset);
    if (sync === 'needs-resync') {
      const target = f.internal.syncTargets((await f.ws.readAll(f.id)).documents)[0];
      assert.deepEqual(target.recheckChapters, [ref.id]);
      const model = new ScriptedProvider([
        ({ history }) => {
          const payload = JSON.parse((history[0] as { text: string }).text);
          const pos =
            payload.sources[0].excerpts.findIndex(({ text }: { text: string }) => text === event) + 1;
          assert.ok(pos > 0);
          return {
            role: 'assistant',
            text: '',
            calls: [
              {
                id: 'sync',
                name: 'submit_story_sync',
                args: JSON.stringify({
                  evidence: [{ source: 1, status: 'trace', excerpt: pos }],
                  edits: [],
                }),
              },
            ],
          };
        },
      ]);
      const refreshed = await syncStoryNote(f.ws, f.id, f.ctx, model, target);
      const note = await f.ws.readDocument(f.id, assetRef);
      assert.equal(note.revision, refreshed.revision);
      assert.ok(note.body.includes(event));
      assert.ok(!note.body.includes(copied));
      f.internal.directCommits.push({
        target: assetKey,
        revisions: { [assetKey]: refreshed.revision },
        synced: target.revisions,
      });
      assert.ok(f.internal.syncTargets((await f.ws.readAll(f.id)).documents)[0].synced);
    }
    assert.deepEqual(f.trace.rejected, []);
  });
}

test('confirmed cleanup appends a version update without reopening or counting the passage twice', async (t) => {
  const f = await fixture(t, '按这个方案执行');
  const saved = await f.insertWith(dirty, { attachOutline: true });
  const oldCommit = { ...saved.commit, target: 'passage/scope' };
  const plan = {
    summary: '只在这里增补。',
    assets: [],
    passages: [{ id: 'scope', stage: 'addition' as const, chapterId: ref.id, note: '本章短暂相遇。' }],
  };
  const docs = (await f.ws.readAll(f.id)).documents;
  const recorded: EditCommit[] = [oldCommit];
  const proposal = {
    id: randomUUID(),
    sessionId: f.ctx.session.id,
    bookId: f.id,
    authorLine: 0,
    proposalLine: 1,
    plan,
    basis: { placement: chapterPlacementFingerprint(docs), existingAssets: {} },
  };
  const ctx = {
    ...f.ctx,
    bookEdit: { proposal, commits: [oldCommit] },
    async recordEditCommit(id: string, commit: EditCommit) {
      assert.equal(id, proposal.id);
      const roundTrip = readEditCommit(JSON.parse(JSON.stringify(commit)), plan);
      assert.ok(roundTrip);
      recorded.push(roundTrip);
    },
  };
  f.services.prepareEdit(ctx, docs);
  const insertionRef = f.internal.issueInsertionRef(
    ctx,
    ref.id,
    saved.doc.revision,
    { ...saved.insertion, targetId: 'scope' },
    oldCommit,
  );
  assert.ok(insertionRef);
  await f.call(
    'book_clean_insert_echo',
    { chapterId: ref.id, revision: saved.doc.revision, insertionRef },
    ctx,
  );
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].revisions[chapterKey], saved.doc.revision);
  const current = (await f.ws.readAll(f.id)).documents;
  const recovered = new ConfirmedBookEdit(
    { proposal, commits: recorded, replies: ['按这个方案执行'] },
    current,
  );
  assert.equal(recovered.total, 1);
  assert.deepEqual(recovered.remaining(current), []);
  assert.equal(sceneText(recorded[0], recorded, await f.load()), newAction + '\n\n' + event);
  assert.deepEqual(f.trace.rejected, []);
});
