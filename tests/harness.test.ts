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
import { webResearchTools } from '../electron/agent/web-research.js';
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

test('tool discovery exposes only session tools on the next dispatched turn', async (t) => {
  const { workspace, runs, dir, state } = await fixture(t);
  const session = await runs.create({ cwd: dir }, '工具检索夹具');
  const output = join(dir, 'catalog.txt');
  const trace = collectDiagnostics();
  const provider = new ScriptedProvider([
    ({ tools }) => {
      assert.deepEqual(
        tools.map(({ name }) => name),
        ['tool_search'],
      );
      return assistant('', [
        ['tool_search', { query: 'book_patch_chapter' }],
        ['tool_search', { query: 'write_file' }],
        ['write_file', { path: 'catalog.txt', content: 'too early' }],
      ]);
    },
    async ({ history, tools }) => {
      assert.deepEqual(
        tools.map(({ name }) => name),
        ['tool_search', 'write_file'],
      );
      assert.ok(tools[1].schema.properties);
      const results = history.filter((row) => row.role === 'tool');
      assert.deepEqual(results[0]?.result.value, { candidates: [] });
      assert.equal(results[2]?.result.ok, false);
      await assert.rejects(access(output));
      return assistant('', [['write_file', { path: 'catalog.txt', content: 'discovered' }]]);
    },
    ({ tools, history }) => {
      assert.equal(tools.at(-1)?.name, 'write_file');
      assert.ok(history.at(-1)?.role === 'tool');
      return assistant('已保存');
    },
  ]);
  runs.start(
    session.id,
    '写一个文件',
    async (ctx) => {
      await runAgent(
        ctx,
        provider,
        '',
        [],
        '写一个文件',
        new FileTools(workspace, state).tools(),
        12,
        {},
      );
    },
    'default',
    trace.report,
  );
  await runs.wait(session.id);
  assert.equal(
    runs.get(session.id).run?.status,
    'completed',
    runs.get(session.id).run?.error ?? '写入未完成',
  );
  assert.equal(await readFile(output, 'utf8'), 'discovered');
  assert.deepEqual(trace.rejected, []);
  assert.deepEqual(
    trace.rows.filter((row) => row.event === 'tool.discovery').map((row) => row.fields.count),
    [0, 1],
  );

  const followUp = new ScriptedProvider([
    ({ tools }) => {
      assert.deepEqual(
        tools.map(({ name }) => name),
        ['tool_search'],
      );
      return assistant('收到');
    },
  ]);
  runs.start(session.id, '继续讨论', async (ctx) => {
    await runAgent(ctx, followUp, '', [], '继续讨论', new FileTools(workspace, state).tools(), 12, {});
  });
  await runs.wait(session.id);
  assert.equal(
    runs.get(session.id).run?.status,
    'completed',
    runs.get(session.id).run?.error ?? '续轮未完成',
  );
});

test('discovery metadata stays out of model definitions and context budget', async (t) => {
  const { workspace, runs, dir, state } = await fixture(t);
  const session = await runs.create({ cwd: dir }, '估算夹具');
  const tools = new FileTools(workspace, state).tools().map((tool) => ({
    ...tool,
    discovery: { purpose: '占'.repeat(4_000) },
  }));
  const script = new ScriptedProvider([
    ({ tools }) => {
      assert.deepEqual(
        tools.map(({ name }) => name),
        ['tool_search', 'list_files'],
      );
      for (const tool of tools) assert.deepEqual(Object.keys(tool), ['name', 'description', 'schema']);
      return assistant('', [['tool_search', { query: 'read_file' }]]);
    },
    ({ tools }) => {
      assert.deepEqual(
        tools.map(({ name }) => name),
        ['tool_search', 'list_files', 'read_file'],
      );
      assert.deepEqual(Object.keys(tools[2]), ['name', 'description', 'schema']);
      return assistant('可读取');
    },
  ]);
  const provider = Object.assign(script, { inputTokenBudget: 2_000 });
  runs.start(session.id, '检查读取能力', async (ctx) => {
    await runAgent(ctx, provider, '', [], '检查读取能力', tools, 12, { bootstrap: ['list_files'] });
  });
  await runs.wait(session.id);
  assert.equal(
    runs.get(session.id).run?.status,
    'completed',
    runs.get(session.id).run?.error ?? '检索未完成',
  );
});

test('a book session researches Shenzhen weather and returns a final reply grounded in the fetched page', async (t) => {
  const { runs, dir } = await fixture(t);
  const session = await runs.create({ cwd: dir, bookId: 'weather-fixture' }, '网页取材夹具');
  const query = '深圳天气';
  const source = 'https://weather.example/shenzhen';
  const title = '深圳天气 &amp; 观测';
  const observation = '深圳气象站本次观测气温为27°C，东南风二级。';
  const forbidden = 'RESEARCH_PAGE_SCRIPT';
  const requested: Request[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requested.push(request);
    const html =
      request.url === source
        ? `<!doctype html><html><head><title>${title}</title></head><body>
            <script>${forbidden}</script><main><h1>深圳气象站</h1><p>${observation}</p></main>
          </body></html>`
        : `<div class="results"><div class="result results_links results_links_deep web-result">
            <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(source)}&amp;rut=fixture">${title}</a></h2>
            <a class="result__snippet">天气实况和当日观测</a>
          </div></div>`;
    const response = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    Object.defineProperty(response, 'url', { value: request.url });
    return response;
  };
  const provider = new ScriptedProvider([
    ({ tools }) => {
      assert.deepEqual(
        tools.map(({ name }) => name),
        ['tool_search'],
      );
      return assistant('', [['tool_search', { query: 'web_search web_fetch' }]]);
    },
    ({ tools, history }) => {
      assert.deepEqual(tools.map(({ name }) => name).sort(), ['tool_search', 'web_fetch', 'web_search']);
      const result = history.at(-1);
      assert.ok(result?.role === 'tool' && result.result.ok);
      const value = result.result.value as { candidates: { id: string; access: string }[] };
      assert.deepEqual(
        value.candidates.map(({ id, access }) => ({ id, access })),
        [
          { id: 'web_search', access: 'read' },
          { id: 'web_fetch', access: 'read' },
        ],
      );
      return assistant('', [['web_search', { query }]]);
    },
    ({ history }) => {
      const result = history.at(-1);
      assert.ok(result?.role === 'tool' && result.result.ok);
      const value = result.result.value as {
        provider: string;
        results: { title: string; url: string; snippet: string }[];
      };
      assert.equal(value.provider, 'duckduckgo');
      assert.deepEqual(value.results, [
        { title: '深圳天气 & 观测', url: source, snippet: '天气实况和当日观测' },
      ]);
      return assistant('', [['web_fetch', { url: value.results[0].url }]]);
    },
    ({ history }) => {
      const result = history.at(-1);
      assert.ok(result?.role === 'tool' && result.result.ok);
      const value = result.result.value as { url: string; title: string; text: string };
      assert.equal(value.url, source);
      assert.equal(value.title, '深圳天气 & 观测');
      assert.ok(value.text.includes(observation));
      assert.ok(!value.text.includes(forbidden));
      const fact = value.text.match(/深圳气象站本次观测[^。]+。/u)?.[0];
      return assistant(`${fact}\n来源：${value.url}`);
    },
  ]);
  const prompt = '查一下深圳的天气';
  const trace = collectDiagnostics();
  runs.start(
    session.id,
    prompt,
    async (ctx) => {
      await runAgent(ctx, provider, '', [], prompt, webResearchTools(transport), 12, {});
    },
    'default',
    trace.report,
  );
  await runs.wait(session.id);
  const view = runs.get(session.id);
  assert.equal(view.run?.status, 'completed', view.run?.error);
  assert.equal(view.messages.at(-1)?.role, 'assistant');
  assert.equal(view.messages.at(-1)?.text, `${observation}\n来源：${source}`);
  assert.equal(requested.length, 2);
  assert.equal(requested[0].url, 'https://html.duckduckgo.com/html/');
  assert.equal(requested[0].method, 'POST');
  assert.equal(new URLSearchParams(await requested[0].text()).get('q'), query);
  assert.equal(requested[1].url, source);
  assert.equal(requested[1].method, 'GET');
  assert.deepEqual(trace.rejected, []);
  assert.deepEqual(
    trace.rows.filter(({ event }) => event === 'tool.result_sent').map(({ fields }) => fields.tool),
    ['tool_search', 'web_search', 'web_fetch'],
  );
});

test('DuckDuckGo challenges surface as a search error', async () => {
  const [search] = webResearchTools(
    async () =>
      new Response('<form action="/anomaly.js">Verify you are a human</form>', {
        status: 202,
        headers: { 'content-type': 'text/html' },
      }),
  );
  await assert.rejects(
    search.execute(
      { query: '深圳天气' },
      { session: { cwd: '.' }, signal: new AbortController().signal },
    ),
    { diagnosticReason: 'http_error', message: /DuckDuckGo.*人工验证/u },
  );
});
