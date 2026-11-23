import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import {
  DailyDiagnosticWriter,
  localDay,
  dateIndex,
  type DiagnosticDisk,
} from '../electron/diagnostics/daily.js';
import { validateDiagnostic } from '../electron/diagnostics/contract.js';

async function fixture(t: import('node:test').TestContext) {
  const base = await realpath(tmpdir()),
    root = await mkdtemp(join(base, 'fw-diagnostics-'));
  t.after(async () => {
    const actual = await realpath(root);
    if (actual === root && dirname(actual) === base) await rm(actual, { recursive: true, force: true });
  });
  return root;
}
const parse = (text: string) =>
  text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const stamp = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h, 0, 0);

test('diagnostic contract rejects forged sources, arbitrary text, unknown fields and invalid IDs', () => {
  const salt = Buffer.from('unit-fixture');
  assert.equal(
    validateDiagnostic('renderer', { event: 'worker.ready', fields: {} }, salt, true),
    undefined,
  );
  assert.equal(
    validateDiagnostic('renderer', { event: 'ui.ready', source: 'main' }, salt, true),
    undefined,
  );
  assert.equal(
    validateDiagnostic('renderer', { event: 'ui.ready', fields: { runId: randomUUID() } }, salt, true),
    undefined,
  );
  assert.equal(
    validateDiagnostic(
      'renderer',
      { event: 'ui.operation.started', fields: { method: 'session.start' } },
      salt,
      true,
    ),
    undefined,
  );
  assert.equal(
    validateDiagnostic(
      'renderer',
      { event: 'ui.error', fields: { reason: 'exception', message: 'prompt' } },
      salt,
      true,
    ),
    undefined,
  );
  assert.equal(
    validateDiagnostic(
      'renderer',
      { event: 'ui.error', fields: { reason: 'token'.repeat(800) } },
      salt,
      true,
    ),
    undefined,
  );
  assert.equal(
    validateDiagnostic(
      'main',
      { event: 'ipc.started', fields: { method: 'book.read', requestId: 'not-a-uuid' } },
      salt,
    ),
    undefined,
  );
  const viaUi = validateDiagnostic(
    'renderer',
    {
      event: 'ui.revision_applied',
      fields: { workspaceRef: 'book', documentRef: 'chapter/untrusted-name', revision: '01234567' },
    },
    salt,
    true,
  );
  const viaWorker = validateDiagnostic(
    'worker',
    {
      event: 'workspace.document.committed',
      fields: { workspaceRef: 'book', documentRef: 'chapter/untrusted-name', revision: '01234567' },
    },
    salt,
  );
  assert.ok(viaUi && viaWorker);
  assert.equal(viaUi.fields.documentRef, viaWorker.fields.documentRef);
  assert.doesNotMatch(JSON.stringify(viaUi), /untrusted-name/);
});

test('two boots append both streams without overwriting and a missing final newline is repaired', async (t) => {
  const root = await fixture(t),
    now = () => stamp(2026, 11, 23);
  const backend = join(root, 'backend-2026-11-23.jsonl'),
    frontend = join(root, 'frontend-2026-11-23.jsonl');
  await writeFile(backend, '{"torn":');
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const writer = new DailyDiagnosticWriter(root, { now, maintenanceMs: 0 });
    ids.push(writer.bootId);
    writer.accept('main', { event: 'app.started', fields: { version: '0.1.0' } });
    writer.accept('renderer', { event: 'ui.ready' }, true);
    assert.equal(await writer.close(), true);
  }
  const back = (await readFile(backend, 'utf8')).split('\n');
  assert.equal(back.shift(), '{"torn":');
  assert.deepEqual(
    parse(back.join('\n')).map((r) => r.bootId),
    ids,
  );
  assert.deepEqual(
    parse(await readFile(frontend, 'utf8')).map((r) => r.bootId),
    ids,
  );
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual((await readdir(root)).sort(), [
    'backend-2026-11-23.jsonl',
    'frontend-2026-11-23.jsonl',
  ]);
});

test('queued events keep their local day instead of the flush day or UTC date', async (t) => {
  const root = await fixture(t);
  const before = new Date('2026-11-24T06:59:59Z');
  // Explicitly model a local zone offset even on test machines running in UTC.
  const asArizona = (date: Date) =>
    Object.assign(new Date(date), {
      getFullYear: () => new Date(date.getTime() - 7 * 3_600_000).getUTCFullYear(),
      getMonth: () => new Date(date.getTime() - 7 * 3_600_000).getUTCMonth(),
      getDate: () => new Date(date.getTime() - 7 * 3_600_000).getUTCDate(),
    });
  let current = asArizona(before);
  const writer = new DailyDiagnosticWriter(root, { now: () => current, maintenanceMs: 0 });
  writer.accept('main', { event: 'app.started' });
  current = asArizona(new Date(before.getTime() + 1000));
  writer.maintain();
  writer.accept('main', { event: 'app.stopping', fields: { reason: 'application_exit' } });
  await writer.close();
  const line = parse(await readFile(join(root, 'backend-2026-11-23.jsonl'), 'utf8'))[0];
  assert.equal(line.day, '2026-11-23');
  assert.match(line.time, /^2026-11-24/);
  assert.equal(
    parse(await readFile(join(root, 'backend-2026-11-24.jsonl'), 'utf8'))[0].event,
    'app.stopping',
  );
});

test('retention prunes only valid regular files and handles midnight and late buffers', async (t) => {
  const root = await fixture(t);
  const keep = [
    'backend-2026-11-23.jsonl',
    'frontend-2026-10-25.jsonl',
    'backend-2026-02-31.jsonl',
    'unrelated-2000-01-01.jsonl',
    'frontend-2026-12-24.jsonl',
    'target.txt',
  ];
  const old = ['backend-2026-10-24.jsonl', 'frontend-2026-10-24.jsonl'];
  for (const name of [...keep, ...old]) await writeFile(join(root, name), 'safe\n');
  try {
    if (process.platform !== 'win32')
      await symlink(join(root, 'target.txt'), join(root, 'backend-2000-01-01.jsonl'), 'file');
    if (process.platform !== 'win32') keep.push('backend-2000-01-01.jsonl');
  } catch {
    /* Windows may not grant symlink creation; injected check below. */
  }
  let current = stamp(2026, 11, 23);
  const writer = new DailyDiagnosticWriter(root, { now: () => current, maintenanceMs: 0 });
  await writer.flush();
  assert.deepEqual((await readdir(root)).sort(), keep.sort());
  current = stamp(2026, 10, 25);
  writer.accept('renderer', { event: 'ui.ready' }, true);
  current = stamp(2026, 11, 24);
  writer.maintain();
  await writer.close();
  assert.ok(!(await readdir(root)).includes('frontend-2026-10-25.jsonl'));
  assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), 'safe\n');
  assert.equal(dateIndex('2026-02-31'), undefined);
  assert.equal(localDay(stamp(2026, 11, 24)), '2026-11-24');
  const removed: string[] = [];
  const entries = [
    { name: 'backend-2025-01-01.jsonl', regular: false },
    { name: 'frontend-2025-01-01.jsonl', regular: true },
  ];
  const injected = new DailyDiagnosticWriter(root, {
    maintenanceMs: 0,
    now: () => current,
    disk: {
      list: async () => entries,
      remove: async (name) => {
        removed.push(name);
      },
      append: async () => {},
    },
  });
  await injected.close();
  assert.deepEqual(removed, ['frontend-2025-01-01.jsonl']);
});

test('a stalled/full queue and a write failure do not block producers or wait forever on close', async (t) => {
  const root = await fixture(t),
    saved: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mode: 'stall' | 'deny' | 'ok' = 'stall';
  const disk: DiagnosticDisk = {
    list: async () => [],
    remove: async () => {},
    append: async (_name, text) => {
      if (mode === 'stall') await barrier;
      if (mode === 'deny') throw new Error('sensitive-shared-path');
      saved.push(text);
    },
  };
  const writer = new DailyDiagnosticWriter(root, {
    maintenanceMs: 0,
    maxEntries: 4,
    batchDelayMs: 0,
    disk,
  });
  writer.accept('main', { event: 'app.started' });
  await delay(10);
  for (let i = 0; i < 100; i++) writer.accept('main', { event: 'window.started' });
  writer.accept('worker', { event: 'run.finished', fields: { outcome: 'failed' } });
  assert.ok(writer.buffered.entries <= 4);
  assert.equal(await writer.flush(15), false);
  mode = 'deny';
  release();
  await writer.flush();
  mode = 'ok';
  writer.accept('main', { event: 'app.stopped', fields: { outcome: 'ok' } });
  assert.equal(await writer.close(), true);
  const events = parse(saved.join(''));
  assert.deepEqual(
    events.map((e) => e.event),
    ['app.stopped', 'diagnostics.loss'],
  );
  assert.ok(events[1].fields.io > 0 && events[1].fields.overflow > 0);
  assert.doesNotMatch(saved.join(''), /sensitive-shared-path/);
});

test('the renderer contract requires receipt IDs and a positive journal sequence', () => {
  const salt = Buffer.from('unit-fixture'),
    event = 'ui.book_change_received';
  const fields = { journalSeq: 1, workerId: randomUUID(), changeId: randomUUID() };
  assert.ok(validateDiagnostic('renderer', { event, fields }, salt, true));
  for (const incomplete of [
    {},
    { ...fields, workerId: undefined },
    { ...fields, changeId: undefined },
    { ...fields, journalSeq: undefined },
    { ...fields, journalSeq: 0 },
    { ...fields, journalSeq: '1' },
  ])
    assert.equal(validateDiagnostic('renderer', { event, fields: incomplete }, salt, true), undefined);
  assert.equal(
    validateDiagnostic(
      'renderer',
      { event: 'ui.reload.finished', fields: { area: 'document', outcome: 'ok' } },
      salt,
      true,
    ),
    undefined,
  );
});

test('a rejected daily file does not discard healthy batches or lose the loss summary', async () => {
  const saved: string[] = [],
    attempted: string[] = [];
  let blocked = 'frontend-';
  const writer = new DailyDiagnosticWriter('', {
    maintenanceMs: 0,
    now: () => stamp(2026, 11, 23),
    disk: {
      list: async () => [],
      remove: async () => {},
      append: async (name, text) => {
        attempted.push(name);
        if (name.startsWith(blocked)) throw new Error('sensitive-writer-error');
        saved.push(text);
      },
    },
  });
  writer.accept('renderer', { event: 'ui.ready' }, true);
  writer.accept('main', { event: 'app.stopped', fields: { outcome: 'ok' } });
  writer.accept('renderer', { event: 'ui.error', fields: { reason: 'exception' } }, true);
  await writer.flush();
  assert.equal(attempted.filter((name) => name.startsWith('frontend-')).length, 1);
  assert.deepEqual(
    parse(saved.join('')).map((e) => e.event),
    ['app.stopped', 'diagnostics.loss'],
  );
  assert.equal(parse(saved.join(''))[1].fields.io, 2);

  blocked = 'backend-';
  writer.accept('main', { event: 'app.started' });
  writer.accept('renderer', { event: 'ui.ready' }, true);
  await writer.flush();
  assert.equal(parse(saved.join('')).at(-1).event, 'ui.ready');
  blocked = 'neither-';
  writer.accept('main', { event: 'app.started' });
  assert.equal(await writer.close(), true);
  const records = parse(saved.join(''));
  assert.deepEqual(
    records.slice(-2).map((e) => e.event),
    ['app.started', 'diagnostics.loss'],
  );
  assert.equal(records.at(-1).fields.io, 1);
  assert.doesNotMatch(saved.join(''), /sensitive-writer-error/);
});

test('same-day cleanup retries temporary listing and removal failures with a delay', async () => {
  const keep = 'backend-2026-10-25.jsonl';
  const expired = 'backend-2026-10-24.jsonl';
  const files = new Set([keep, expired]);
  let now = stamp(2026, 11, 23).getTime(),
    scans = 0,
    removals = 0;
  const saved: string[] = [];
  const writer = new DailyDiagnosticWriter('', {
    maintenanceMs: 0,
    now: () => new Date(now),
    disk: {
      list: async () => {
        if (++scans === 1) throw new Error('fixture-directory-denial');
        return [...files].map((name) => ({ name, regular: true }));
      },
      remove: async (name) => {
        if (++removals === 1) throw new Error('fixture-file-lock');
        files.delete(name);
      },
      append: async (_name, text) => {
        saved.push(text);
      },
    },
  });
  await writer.flush();
  now += 59_000;
  writer.maintain();
  await writer.flush();
  assert.equal(scans, 1);
  now += 1000;
  writer.maintain();
  await writer.flush();
  assert.equal(removals, 1);
  assert.equal(files.has(expired), true);
  now += 60_000;
  writer.maintain();
  await writer.flush();
  assert.deepEqual([...files], [keep]);
  assert.equal(scans, 3);
  assert.equal(parse(saved.join('')).at(-1).fields.cleanup, 2);
  now += 60_000;
  await writer.close();
  assert.equal(scans, 3);
});

test('cleanup does not retry indefinitely on the same local day', async () => {
  let now = stamp(2026, 11, 23).getTime(),
    scans = 0;
  const writer = new DailyDiagnosticWriter('', {
    maintenanceMs: 0,
    now: () => new Date(now),
    disk: {
      list: async () => {
        scans++;
        throw new Error('persistent-fixture-failure');
      },
      remove: async () => {},
      append: async () => {},
    },
  });
  for (let i = 0; i < 6; i++) {
    writer.maintain();
    await writer.flush();
    now += 60_000;
  }
  assert.equal(scans, 3);
  now = stamp(2026, 11, 24).getTime();
  await writer.close();
  assert.equal(scans, 4);
});
