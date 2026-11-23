import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceError, WorkspaceService } from '../electron/workspace.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fiction-writer-'));
  const service = new WorkspaceService({ libraryRoot: join(root, 'library') });
  await service.init();
  return { root, service };
}
test('creates and rebuilds a Markdown book without a database', async () => {
  const { root, service } = await setup();
  const created = await service.createBook({ title: '潮汐之后', summary: '一段简介', genre: '科幻' });
  const view = await service.readBook(created.id);
  assert.equal(view.documents.find((d) => d.type === 'book')?.fields.title, '潮汐之后');
  assert.equal(view.documents.find((d) => d.type === 'outline')?.id, 'outline');
  const restarted = new WorkspaceService({ libraryRoot: join(root, 'library') });
  const library = await restarted.listBooks();
  assert.equal(library.books[0]?.title, '潮汐之后');
  assert.match(await readFile(join(root, 'library', created.id, 'book.md'), 'utf8'), /title: 潮汐之后/);
});
test('stable ids survive edits and revision conflicts refuse writes', async () => {
  const { service } = await setup();
  const { id } = await service.createBook({ title: 'A', summary: 'S' });
  const subject = {
    type: 'subject' as const,
    id: 'hero',
    fields: { name: '主角', kind: 'character' as const },
    body: '说明',
    revision: '',
  };
  const result = await service.writeDocument(id, subject);
  assert.deepEqual(result.committed, [{ type: 'subject', id: 'hero' }]);
  const current = await service.readDocument(id, subject);
  const rename = await service.writeDocument(id, {
    ...current,
    fields: { ...current.fields, name: '新主角' },
  });
  assert.equal(rename.committed.length, 1);
  assert.equal((await service.readDocument(id, subject)).id, 'hero');
  const conflict = await service.writeChanges(id, [
    {
      type: 'subject',
      id: 'hero',
      expect: current.revision,
      fields: { name: '覆盖' },
      body: '不应写入',
    },
  ]);
  assert.equal(conflict.committed.length, 0);
  assert.match(conflict.error ?? '', /已变化/);
  assert.equal((await service.readDocument(id, subject)).fields.name, '新主角');
});
test('deleting a chapter clears explicit references but keeps the clue', async () => {
  const { service } = await setup();
  const { id } = await service.createBook({ title: 'A', summary: 'S' });
  await service.writeChanges(id, [
    {
      type: 'subject',
      id: 'key',
      expect: null,
      fields: { name: '钥匙', kind: 'item' },
      body: '用于开门',
    },
  ]);
  const chapter = {
    type: 'chapter' as const,
    id: 'c1',
    fields: { title: '第一章', order: 1 },
    body: '[钥匙](../subjects/key.md)',
    revision: '',
  };
  await service.writeDocument(id, chapter);
  const clue = {
    type: 'clue' as const,
    id: 'clue1',
    fields: { title: '钥匙伏笔', subjectIds: ['key'], setupChapterId: 'c1' },
    body: '[第一章](chapters/c1.md)',
    revision: '',
  };
  await service.writeDocument(id, clue);
  const report = await service.deleteDocument(id, chapter);
  assert.deepEqual(report.pending, []);
  const after = await service.readDocument(id, clue);
  assert.equal(after.fields.setupChapterId, undefined);
  assert.equal(after.body, '第一章');
  await assert.rejects(service.readDocument(id, chapter));
});
test('malformed metadata is diagnosed locally', async () => {
  const { root, service } = await setup();
  const { id } = await service.createBook({ title: 'A', summary: 'S' });
  await mkdir(join(root, 'library', id, 'subjects'), { recursive: true });
  await writeFile(join(root, 'library', id, 'subjects', 'bad.md'), '---\nname: [\n---\nbody');
  const view = await service.readBook(id);
  assert.ok(view.diagnostics.some((d) => d.includes('bad')));
  assert.ok(view.documents.some((d) => d.type === 'book'));
});
test('rejects invalid required fields', async () => {
  const { service } = await setup();
  await assert.rejects(service.createBook({ title: ' ', summary: 'x' }), WorkspaceError);
  await assert.rejects(service.createBook({ title: 'x', summary: '' }), WorkspaceError);
});

test('reference validation detects new invalid targets without changing the original', async () => {
  const { service } = await setup();
  const { id } = await service.createBook({ title: 'A', summary: 'S' });
  const invalid = await service.writeChanges(id, [
    {
      type: 'clue',
      id: 'c',
      expect: null,
      fields: { title: '债务', payoffChapterId: 'missing' },
      body: '回收',
    },
  ]);
  assert.match(invalid.error ?? '', /无效引用/);
  assert.equal(invalid.committed.length, 0);
  const view = await service.readBook(id);
  assert.equal(
    view.documents.some((d) => d.type === 'clue'),
    false,
  );
});

test('related cleanup keeps prose and inline code untouched, and does not delete the clue', async () => {
  const { service } = await setup();
  const { id } = await service.createBook({ title: 'A', summary: 'S' });
  const writes = await service.writeChanges(id, [
    { type: 'chapter', id: 'ch1', expect: null, fields: { title: '第一章', order: 1 }, body: '' },
    { type: 'chapter', id: 'ch2', expect: null, fields: { title: '第二章', order: 2 }, body: '' },
    {
      type: 'clue',
      id: 'hint',
      expect: null,
      fields: { title: '灯塔', setupChapterId: 'ch1', payoffChapterId: 'ch2' },
      body: '保留',
    },
  ]);
  assert.equal(writes.error, undefined);
  const outline = await service.readDocument(id, { type: 'outline', id: 'outline' });
  await service.writeDocument(id, {
    ...outline,
    body: '[第二章](chapters/ch2.md) 回收。名称第二章。`[示例](chapters/ch2.md)`',
  });
  assert.equal((await service.deleteDocument(id, { type: 'chapter', id: 'ch2' })).error, undefined);
  const clue = await service.readDocument(id, { type: 'clue', id: 'hint' });
  assert.equal(clue.fields.setupChapterId, 'ch1');
  assert.equal(clue.fields.payoffChapterId, undefined);
  assert.equal(
    (await service.readDocument(id, outline)).body,
    '第二章 回收。名称第二章。`[示例](chapters/ch2.md)`',
  );
});

test('mid-batch failure preserves the old bytes of uncommitted files and reports exact outcomes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fw-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let inject = false;
  const events: string[][] = [];
  const service = new WorkspaceService({
    libraryRoot: root,
    onChange: (_id, refs) => events.push(refs.map((r) => r.id)),
    beforeReplace(path) {
      if (inject && path.endsWith('b.md')) throw new Error('injected sharing violation');
    },
  });
  await service.init();
  const { id } = await service.createBook({ title: 'A', summary: 'S' });
  await service.writeChanges(
    id,
    ['a', 'b'].map((key, i) => ({
      type: 'chapter',
      id: key,
      expect: null,
      fields: { title: key, order: i + 1 },
      body: `${key} old`,
    })),
  );
  const before = (await service.readAll(id)).documents.filter((d) => d.type === 'chapter');
  inject = true;
  const report = await service.writeChanges(
    id,
    before.map((doc) => ({ ...doc, expect: doc.revision, body: 'new text' })),
  );
  assert.deepEqual(report.committed, [{ type: 'chapter', id: 'a' }]);
  assert.deepEqual(report.pending, [{ type: 'chapter', id: 'b' }]);
  assert.match(report.error ?? '', /sharing violation/);
  assert.deepEqual(events.at(-1), ['a']);
  assert.equal((await service.readDocument(id, before[0])).body, 'new text');
  assert.equal((await service.readDocument(id, before[1])).revision, before[1].revision);
});
