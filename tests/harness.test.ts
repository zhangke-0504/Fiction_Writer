import { collectDiagnostics } from './diagnostic-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceService } from '../electron/workspace.js';
import { Journal } from '../electron/journal.js';
import { RunManager } from '../electron/agent/runs.js';
import { FileTools } from '../electron/agent/files.js';
import { runAgent } from '../electron/agent/loop.js';
import { runCommand } from '../electron/agent/commands.js';
import { Gate, ScriptedProvider } from '../electron/agent/scripted.js';
const assistant = (text: string, calls: Array<[string, unknown]> = []) => ({
  role: 'assistant' as const,
  text,
  calls: calls.map(([name, args], index) => ({
    id: `call_${name}_${index}`,
    name,
    args: JSON.stringify(args),
  })),
});

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'fw-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state'),
    dir = join(root, 'code'),
    other = join(root, 'other');
  await Promise.all([mkdir(dir), mkdir(other)]);
  const journal = new Journal(() => {}, 3);
  const workspace = new WorkspaceService({ libraryRoot: join(root, 'library') });
  const runs = new RunManager(state, journal);
  await runs.init();
  return { workspace, runs, dir, other, journal, state };
}

test('Pi loop searches, reads and edits an ordinary code directory then executes its test', async (t) => {
  const { workspace, runs, dir, state } = await fixture(t);
  await writeFile(join(dir, 'math.cjs'), 'exports.answer = 41;\n');
  await writeFile(
    join(dir, 'fixture.cjs'),
    'require("node:assert/strict").equal(require("./math.cjs").answer,42); console.log("fixture passed");',
  );
  const session = await runs.create({ cwd: dir }, 'Local code');
  const provider = new ScriptedProvider([
    () =>
      assistant('', [
        ['list_files', {}],
        ['search_text', { query: '41' }],
      ]),
    ({ history }) => {
      assert.equal(history.filter((h) => h.role === 'tool').length, 2);
      return assistant('', [['read_file', { path: 'math.cjs' }]]);
    },
    () =>
      assistant('', [
        ['edit_file', { path: 'math.cjs', oldText: '41', newText: '42' }],
        ['write_file', { path: 'extra.txt', content: 'ok' }],
        ['delete_file', { path: 'extra.txt' }],
      ]),
    () => assistant('', [['run_command', { command: 'node fixture.cjs', timeoutMs: 5000 }]]),
    ({ history, onText }) => {
      const result = history.at(-1);
      assert.ok(result?.role === 'tool' && result.result.ok);
      assert.match(JSON.stringify(result), /fixture passed/);
      onText('测试通过');
      return assistant('测试通过');
    },
  ]);
  runs.start(session.id, '修改并测试', (ctx) =>
    runAgent(ctx, provider, '', [], 'go', new FileTools(workspace, state).tools()).then(() => {}),
  );
  await runs.wait(session.id);
  const view = runs.get(session.id);
  assert.equal(view.run?.status, 'completed', view.run?.error);
  assert.equal(view.messages.at(-1)?.text, '测试通过');
  assert.match(await readFile(join(dir, 'math.cjs'), 'utf8'), /42/);
  await assert.rejects(access(join(dir, 'extra.txt')));
});

test('timeout terminates a real process tree and session work is independent', async (t) => {
  const { runs, dir, other } = await fixture(t);
  const wait = new Gate(),
    a = await runs.create({ cwd: dir }, 'A'),
    b = await runs.create({ cwd: dir }, 'B'),
    c = await runs.create({ cwd: other }, 'C');
  runs.start(a.id, '', (ctx) => wait.wait(ctx.signal));
  assert.throws(() => runs.start(b.id, '', async () => {}), /已有任务/);
  runs.start(c.id, '', async () => {});
  await runs.wait(c.id);
  assert.equal(runs.get(c.id).run?.status, 'completed');
  await runs.stop(a.id);
  assert.equal(runs.get(a.id).run?.status, 'cancelled');
  const command = `node -e "setTimeout(() => require('fs').writeFileSync('late.txt','x'),1800)"`;
  const trace = collectDiagnostics();
  const result = await runCommand(dir, command, 650, new AbortController().signal, trace.report);
  assert.deepEqual(trace.rejected, []);
  assert.equal(trace.rows.at(-1)?.fields.termination, 'confirmed');
  assert.equal(trace.rows.at(-1)?.fields.timedOut, true);
  assert.equal(result.timeout, true);
  await delay(1900);
  await assert.rejects(access(join(dir, 'late.txt')));
});

test('hard deletion waits for cleanup and old events or a restart do not resurrect history', async (t) => {
  const { runs, state, dir, journal } = await fixture(t);
  const session = await runs.create({ cwd: dir }, 'A');
  const gate = new Gate();
  let cleaned = false;
  let entered!: () => void;
  const enter = new Promise<void>((r) => {
    entered = r;
  });
  runs.start(session.id, 'recoverable', async (ctx) => {
    entered();
    try {
      await gate.wait(ctx.signal);
    } finally {
      await delay(30);
      cleaned = true;
    }
  });
  await enter;
  const removing = runs.remove(session.id);
  assert.throws(() => runs.start(session.id, '', async () => {}), /正在删除/);
  await removing;
  assert.ok(cleaned);
  assert.deepEqual(runs.snapshot().sessions, []);
  assert.equal(journal.after(0), null);
  await assert.rejects(access(join(runs.directory, `${session.id}.jsonl`)));
  const restored = new RunManager(state, journal);
  await restored.init();
  assert.deepEqual(restored.snapshot().sessions, []);
  const b = await runs.create({ cwd: dir }, 'interruption');
  await appendFile(
    join(runs.directory, `${b.id}.jsonl`),
    JSON.stringify({ session: b, run: { id: 'before-exit', status: 'running' } }) + '\n',
  );
  const afterCrash = new RunManager(state, journal);
  await afterCrash.init();
  assert.equal(afterCrash.get(b.id).run?.status, 'interrupted');
});

test('deleting a workspace cannot recreate a concurrently deleted session record', async (t) => {
  const { runs, state, dir, journal } = await fixture(t);
  const removed = await runs.create({ cwd: dir, bookId: 'book' }, 'remove me');
  const keep = await runs.create({ cwd: dir, bookId: 'book' }, 'preserve me');
  runs.start(keep.id, 'preserved history', async () => {});
  await runs.wait(keep.id);
  let entered!: () => void;
  let finish!: () => void;
  const enteredRemoval = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finishRemoval = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const deletingBook = runs.removeTarget(dir, async () => {
    entered();
    await finishRemoval;
  });
  await enteredRemoval;
  const path = join(runs.directory, `${removed.id}.jsonl`);
  try {
    await runs.remove(removed.id);
    await assert.rejects(access(path), { code: 'ENOENT' });
  } finally {
    finish();
    await deletingBook;
  }
  await assert.rejects(access(path), { code: 'ENOENT' });
  const reopened = new RunManager(state, journal);
  await reopened.init();
  const sessions = reopened.snapshot().sessions;
  assert.deepEqual(
    sessions.map(({ session }) => session.id),
    [keep.id],
  );
  assert.equal(sessions[0].session.missing, true);
  assert.equal(sessions[0].messages[0].text, 'preserved history');
});

test('the real loop records its cap and does not claim to dispatch a final tool result', async (t) => {
  const { workspace, runs, dir, state } = await fixture(t);
  const session = await runs.create({ cwd: dir }, 'Fixture');
  const trace = collectDiagnostics();
  const provider = new ScriptedProvider([() => assistant('', [['list_files', {}]])]);
  runs.start(
    session.id,
    'fixture',
    async (ctx) => {
      await runAgent(ctx, provider, '', [], 'fixture', new FileTools(workspace, state).tools(), 1);
    },
    'high',
    trace.report,
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'failed');
  assert.deepEqual(trace.rejected, []);
  const first = trace.rows.find((e) => e.event === 'loop.round.started')!,
    end = trace.rows.find((e) => e.event === 'loop.round.finished')!;
  assert.equal(first.fields.turn, 1);
  assert.equal(end.fields.spanId, first.fields.spanId);
  assert.equal(end.fields.reason, 'iteration_limit');
  assert.ok(trace.rows.some((e) => e.event === 'tool.result_ready' && e.fields.outcome === 'ok'));
  assert.ok(!trace.rows.some((e) => e.event === 'tool.result_sent'));
});

test('a cancelled command records the observed stop, not just the abort request', async (t) => {
  const { dir } = await fixture(t);
  const trace = collectDiagnostics(),
    ab = new AbortController();
  const work = runCommand(
    dir,
    process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20',
    8000,
    ab.signal,
    trace.report,
  );
  await delay(450);
  ab.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.deepEqual(trace.rejected, []);
  assert.equal(trace.rows.at(-1)?.event, 'command.finished');
  assert.equal(trace.rows.at(-1)?.fields.termination, 'confirmed');
  assert.equal(trace.rows.at(-1)?.fields.outcome, 'cancelled');
});
