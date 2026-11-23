import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'fw-pi-fixture-'));
const paths = [],
  requests = [];
let inSlow;
const slow = new Promise((resolve) => (inSlow = resolve));
const server = createServer(async (req, res) => {
  paths.push(req.url);
  let raw = '';
  for await (const part of req) raw += part;
  const input = JSON.parse(raw);
  requests.push(input);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) =>
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'r',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'synthetic',
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n',
    );
  const last = input.messages.at(-1);
  if (JSON.stringify(last?.content)?.includes('aborting')) {
    emit({ role: 'assistant', content: 'wait' });
    inSlow();
    return;
  }
  if (last?.role === 'tool') {
    emit({ role: 'assistant', content: 'finished' });
    emit({}, 'stop');
  } else {
    emit({ role: 'assistant', reasoning_content: 'fixture reasoning' });
    emit({
      tool_calls: [
        {
          index: 0,
          id: 'call_ledger',
          type: 'function',
          function: { name: 'save_novel_fixture', arguments: '{"title":"' },
        },
      ],
    });
    emit({ tool_calls: [{ index: 0, function: { arguments: 'sea"}' } }] });
    emit({}, 'tool_calls');
  }
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/gateway/v1`;
const runtime = await ModelRuntime.create({
  authPath: join(dir, 'auth.json'),
  modelsPath: null,
  modelsStorePath: join(dir, 'models.sqlite'),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
runtime.registerProvider('fixture', {
  name: 'Fixture',
  baseUrl,
  api: 'openai-completions',
  apiKey: 'fixture-key',
  models: [
    {
      id: 'synthetic',
      name: 'Fixture',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16000,
      maxTokens: 1024,
      reasoning: true,
      compat: { requiresReasoningContent: true },
    },
  ],
});
let writes = 0;
async function session() {
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    systemPrompt: 'Fixture only.',
  });
  await resourceLoader.reload();
  return (
    await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime: runtime,
      model: runtime.getModel('fixture', 'synthetic'),
      thinkingLevel: 'high',
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      noTools: 'builtin',
      customTools: [
        {
          name: 'save_novel_fixture',
          label: 'Save synthetic document',
          description: 'Uses application write service',
          parameters: Type.Object({ title: Type.String() }),
          async execute(_id, { title }) {
            assert.equal(title, 'sea');
            writes++;
            return { content: [{ type: 'text', text: 'fixture saved' }], details: {} };
          },
        },
      ],
    })
  ).session;
}
const a = await session(),
  b = await session(),
  events = [];
a.subscribe((e) => events.push(e.type));
try {
  const stopping = b.prompt('aborting');
  await Promise.race([
    slow,
    stopping.then(() => {
      throw new Error('slow fixture ended early: ' + JSON.stringify(b.messages.slice(-1)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('no slow request')), 5000).unref()),
  ]);
  await a.prompt('write');
  await b.abort();
  await stopping.catch(() => {});
  assert.equal(writes, 1);
  assert.ok(events.includes('tool_execution_start'));
  assert.ok(events.includes('message_update'));
  assert.ok(paths.every((p) => p === '/gateway/v1/chat/completions'));
  assert.ok(requests.every((r) => r.tools.every((t) => t.function.name === 'save_novel_fixture')));
  const continuation = requests.find((r) => r.messages.at(-1)?.role === 'tool');
  assert.ok(continuation);
  assert.equal(continuation.messages.find((m) => m.tool_calls)?.reasoning_content, 'fixture reasoning');
  console.log('PASS: custom endpoint, app tool, independent sessions, streaming and abort.');
} finally {
  a.dispose();
  b.dispose();
  server.closeAllConnections();
  server.close();
}
