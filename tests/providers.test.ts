import { collectDiagnostics } from './diagnostic-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { object, runAgent } from '../electron/agent/loop.js';
import type { RunContext } from '../electron/agent/runs.js';
import type { ToolReceipt } from '../electron/agent/tool-receipts.js';
import { createProvider, checkProvider } from '../electron/agent/provider.js';
import type { ModelRequest } from '../electron/agent/model.js';
import { buildWritingRequest } from '../electron/agent/writing-request.js';
import type { ModelProfile, Protocol } from '../shared/contracts.js';
const key = 'synthetic-only-secret-fixture';
async function fixture(
  t: import('node:test').TestContext,
  protocol: Protocol,
  respond: (body: any, res: ServerResponse, req: IncomingMessage) => void,
) {
  const requests: { body: any; path?: string; headers: IncomingMessage['headers'] }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ body, path: req.url, headers: req.headers });
    respond(body, res, req);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as import('node:net').AddressInfo).port;
  const profile: ModelProfile = {
    id: 'a',
    name: 'fixture',
    model: protocol === 'chat' ? 'deepseek-v4-flash' : 'synthetic',
    protocol,
    baseUrl: `http://127.0.0.1:${port}/gate/v1`,
  };
  return { profile, requests };
}
function sse(res: ServerResponse, ...events: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const payload = Buffer.from(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n',
  );
  res.write(payload.subarray(0, 21));
  res.end(payload.subarray(21));
}
const chat = (delta: object, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
});
const ctx = (): ModelRequest => ({
  system: 'System',
  history: [{ role: 'user', text: 'Call read_file.' }],
  tools: [{ name: 'read_file', description: 'Fixture', schema: { type: 'object' } }],
  signal: AbortSignal.timeout(3000),
  onText: () => {},
});

test('Chat Completions joins fragmented calls and returns tool ID plus DeepSeek reasoning in the same run', async (t) => {
  const { profile, requests } = await fixture(t, 'chat', (body, res) => {
    if (body.messages.at(-1).role === 'tool') {
      sse(res, chat({ content: '测试通过' }), chat({}, 'stop'));
      return;
    }
    sse(
      res,
      chat({ reasoning_content: 'fixture reasoning' }),
      chat({
        tool_calls: [
          { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"' } },
        ],
      }),
      chat({ tool_calls: [{ index: 0, function: { arguments: 'a.md"}' } }] }),
      chat({}, 'tool_calls'),
    );
  });
  const provider = createProvider(profile, key, 'high');
  const trace = collectDiagnostics();
  const request = { ...ctx(), diagnostic: trace.report };
  const first = await provider.turn(request);
  assert.equal(first.calls[0].args, '{"path":"a.md"}');
  assert.equal(provider.effort, 'high');
  const chunks: string[] = [];
  const follow = await provider.turn({
    ...request,
    history: [
      ...request.history,
      first,
      { role: 'tool', id: 'call_1', result: { ok: true, value: 'data' } },
    ],
    onText: (t) => chunks.push(t),
  });
  assert.equal(follow.text, '测试通过');
  assert.deepEqual(chunks, ['测试通过']);
  assert.equal(requests[1].path, '/gate/v1/chat/completions');
  assert.equal(requests[1].headers.authorization, `Bearer ${key}`);
  assert.equal(requests[1].body.messages.at(-2).reasoning_content, 'fixture reasoning');
  assert.equal(requests[1].body.messages.at(-1).tool_call_id, 'call_1');
  assert.deepEqual(trace.rejected, []);
  const starts = trace.rows.filter((e) => e.event === 'model.started');
  assert.equal(new Set(starts.map((e) => e.fields.spanId)).size, 2);
  for (const start of starts) {
    assert.equal(start.fields.protocol, 'chat');
    assert.equal(start.fields.effort, 'high');
    assert.equal(typeof start.fields.profileRef, 'string');
    const events = trace.rows.filter((e) => e.fields.spanId === start.fields.spanId);
    assert.deepEqual(
      events.map((e) => e.event),
      ['model.started', 'model.http', 'model.first_event', 'model.finished'],
    );
    assert.equal(events.at(-1)!.fields.outcome, 'ok');
    assert.equal(events[1].fields.httpStatus, 200);
    assert.equal(typeof events[2].fields.elapsedMs, 'number');
  }
  assert.doesNotMatch(JSON.stringify(trace.rows), /fixture reasoning|call_1|a\.md/);
});

test('Responses resubmits completed native output and function_call_output by call_id', async (t) => {
  const native = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'read_file',
    arguments: '{"path":"a.md"}',
    status: 'completed',
  };
  const { profile, requests } = await fixture(t, 'responses', (body, res) => {
    if (body.input.at(-1).type === 'function_call_output') {
      sse(
        res,
        { type: 'response.output_text.delta', delta: '好' },
        { type: 'response.completed', response: { output: [] } },
      );
      return;
    }
    sse(
      res,
      { type: 'response.output_item.added', output_index: 0, item: { ...native, arguments: '' } },
      { type: 'response.function_call_arguments.delta', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', delta: '"a.md"}' },
      { type: 'response.output_item.done', output_index: 0, item: native },
      { type: 'response.completed', response: { output: [native] } },
    );
  });
  const provider = createProvider(profile, key);
  const request = ctx();
  const first = await provider.turn(request);
  assert.deepEqual(first.calls, [{ id: 'call_1', name: 'read_file', args: native.arguments }]);
  assert.equal(
    (
      await provider.turn({
        ...request,
        history: [...request.history, first, { role: 'tool', id: 'call_1', result: { ok: true } }],
      })
    ).text,
    '好',
  );
  const { path, body } = requests[1];
  assert.equal(path, '/gate/v1/responses');
  assert.equal(body.store, false);
  assert.deepEqual(body.input.at(-2), native);
  assert.deepEqual(body.input.at(-1), {
    type: 'function_call_output',
    call_id: 'call_1',
    output: '{"ok":true}',
  });
});

test('Messages validates fragmented tool input, repeats the original tool_use block, and uses Anthropic auth', async (t) => {
  const { profile, requests } = await fixture(t, 'messages', (body, res) => {
    if (body.messages.at(-1).content[0].type === 'tool_result') {
      sse(
        res,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      );
      return;
    }
    sse(
      res,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"a.md"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    );
  });
  const provider = createProvider(profile, key);
  const request = ctx();
  const first = await provider.turn(request);
  assert.equal(provider.effort, 'default');
  assert.equal(
    (
      await provider.turn({
        ...request,
        history: [
          ...request.history,
          first,
          { role: 'tool', id: 'toolu_1', result: { ok: false, error: 'Missing' } },
        ],
      })
    ).text,
    '完成',
  );
  const { path, headers, body } = requests[1];
  assert.equal(path, '/gate/v1/messages');
  assert.equal(headers['x-api-key'], key);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(body.messages.at(-2).content[0].input, { path: 'a.md' });
  assert.equal(body.messages.at(-1).content[0].tool_use_id, 'toolu_1');
  assert.equal(body.messages.at(-1).content[0].is_error, true);
});

test('auth diagnostics never include provider response body and ordinary chat cannot pass the tool check', async (t) => {
  const auth = await fixture(t, 'chat', (_body, res) => {
    res.writeHead(401);
    res.end(`bad ${key}`);
  });
  const trace = collectDiagnostics();
  const result = await checkProvider(auth.profile, key, AbortSignal.timeout(3000), trace.report);
  assert.equal('kind' in result && result.kind, 'auth');
  assert.ok(!JSON.stringify(result).includes(key));
  assert.deepEqual(trace.rejected, []);
  assert.deepEqual(
    trace.rows.map((e) => e.event),
    ['model.started', 'model.http', 'model.finished', 'probe.finished'],
  );
  assert.equal(trace.rows[2].fields.httpStatus, 401);
  assert.equal(trace.rows[2].fields.reason, 'auth');
  assert.equal(trace.rows[2].fields.lane, 'probe');
  assert.ok(!JSON.stringify(trace.rows).includes(key));
  const chatOnly = await fixture(t, 'chat', (_body, res) =>
    sse(res, chat({ content: 'OK' }), chat({}, 'stop')),
  );
  assert.deepEqual(await checkProvider(chatOnly.profile, key, AbortSignal.timeout(3000)), {
    connection: true,
    tools: false,
    issue: '模型未正确调用测试工具',
  });
});

test('missing terminal event, error events and explicit cancellation do not return a committable turn', async (t) => {
  const trace = collectDiagnostics();
  for (const protocol of ['chat', 'responses', 'messages'] as const) {
    const { profile } = await fixture(t, protocol, (_body, res) =>
      sse(
        res,
        protocol === 'chat' ? chat({ content: 'partial' }) : { type: 'error', error: { message: key } },
      ),
    );
    await assert.rejects(
      createProvider(profile, key).turn({ ...ctx(), diagnostic: trace.report }),
      (error: Error) => !error.message.includes(key),
    );
  }
  const { profile } = await fixture(t, 'chat', (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(chat({ content: 'partial' }))}\n\n`);
  });
  const abort = new AbortController();
  const chunks: string[] = [];
  await assert.rejects(
    createProvider(profile, key).turn({
      ...ctx(),
      signal: abort.signal,
      diagnostic: trace.report,
      onText: (t) => {
        chunks.push(t);
        abort.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(chunks, ['partial']);
  assert.deepEqual(trace.rejected, []);
  assert.deepEqual(
    trace.rows
      .filter((e) => e.event === 'model.finished')
      .map((e) => [e.fields.outcome, e.fields.reason, e.fields.httpStatus]),
    [
      ['failed', 'incomplete_stream', 200],
      ['failed', 'provider_error', 200],
      ['failed', 'provider_error', 200],
      ['cancelled', 'cancelled', 200],
    ],
  );
  assert.equal(trace.rows.filter((e) => e.event === 'model.first_event').length, 4);
});

test('transport loss and malformed SSE reach distinct terminal diagnoses', async (t) => {
  const trace = collectDiagnostics();
  let disconnect: (() => void) | undefined;
  const dropped = await fixture(t, 'chat', (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    disconnect = () => res.destroy();
    res.write(
      [
        chat({
          tool_calls: [
            {
              index: 0,
              id: 'private-native-id',
              function: { name: 'read_file', arguments: '{"path":"private-filename"}' },
            },
          ],
        }),
        chat({ content: 'partial transport' }),
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join(''),
    );
  });
  await assert.rejects(
    createProvider(dropped.profile, key).turn({
      ...ctx(),
      diagnostic: trace.report,
      onText: () => disconnect?.(),
    }),
  );
  const malformed = await fixture(t, 'chat', (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${key}\n\n`);
  });
  await assert.rejects(
    createProvider(malformed.profile, key).turn({ ...ctx(), diagnostic: trace.report }),
  );
  assert.deepEqual(trace.rejected, []);
  assert.deepEqual(
    trace.rows.filter((e) => e.event === 'model.finished').map((e) => e.fields.reason),
    ['incomplete_stream', 'malformed_stream'],
  );
  assert.equal(trace.rows.filter((e) => e.event === 'model.first_event').length, 2);
  assert.deepEqual(
    trace.rows
      .filter((e) => e.event.startsWith('tool.'))
      .map((e) => [e.event, e.fields.tool, e.fields.reason]),
    [
      ['tool.requested', 'read_file', undefined],
      ['tool.rejected', 'read_file', 'incomplete_stream'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(trace.rows), /private-native-id|private-filename/);
  assert.ok(!JSON.stringify(trace.rows).includes(key));
});

test('Responses leaves a rejected candidate when a finished tool item is followed by an incomplete turn', async (t) => {
  const trace = collectDiagnostics();
  const { profile } = await fixture(t, 'responses', (_body, res) =>
    sse(
      res,
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'private-item-id',
          call_id: 'private-call-id',
          name: 'read_file',
          arguments: '{"path":"private-argument-value"}',
        },
      },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call' } },
      { type: 'response.incomplete', response: { status: 'incomplete' } },
    ),
  );
  await assert.rejects(createProvider(profile, key).turn({ ...ctx(), diagnostic: trace.report }));
  assert.deepEqual(trace.rejected, []);
  const tools = trace.rows.filter((e) => e.event.startsWith('tool.'));
  assert.deepEqual(
    tools.map((e) => e.event),
    ['tool.requested', 'tool.rejected'],
  );
  assert.equal(tools[0].fields.tool, 'read_file');
  assert.equal(tools[0].fields.callId, tools[1].fields.callId);
  assert.equal(tools[1].fields.reason, 'incomplete_stream');
  assert.equal(tools[1].fields.spanId, trace.rows.at(-1)?.fields.spanId);
  assert.equal(trace.rows.at(-1)?.fields.reason, 'incomplete_stream');
  assert.doesNotMatch(
    JSON.stringify(trace.rows),
    /private-item-id|private-call-id|private-argument-value/,
  );
});

test('Messages records other candidates as not executed when one block invalidates the batch', async (t) => {
  const trace = collectDiagnostics();
  const { profile } = await fixture(t, 'messages', (_body, res) =>
    sse(
      res,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'private-call-a', name: 'read_file', input: {} },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'private-call-b', name: 'list_files', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"path":"private-malformed' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'private-call-c', name: 'read_file', input: {} },
      },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ),
  );
  const request = ctx();
  request.tools.push({ name: 'list_files', description: 'Fixture', schema: { type: 'object' } });
  await assert.rejects(createProvider(profile, key).turn({ ...request, diagnostic: trace.report }));
  assert.deepEqual(trace.rejected, []);
  const rows = trace.rows.filter((e) => e.event.startsWith('tool.'));
  assert.equal(rows.length, 6);
  const candidates = rows.filter((e) => e.event === 'tool.requested');
  assert.equal(new Set(candidates.map((e) => e.fields.callId)).size, 3);
  assert.deepEqual(
    candidates.map((request) => {
      const affected = rows.filter((row) => row.fields.callId === request.fields.callId);
      assert.deepEqual(
        affected.map((row) => row.event),
        ['tool.requested', 'tool.rejected'],
      );
      return [affected[1].fields.tool, affected[1].fields.reason];
    }),
    [
      ['read_file', 'batch_invalid'],
      ['list_files', 'invalid_json'],
      ['read_file', 'batch_invalid'],
    ],
  );
  assert.equal(trace.rows.at(-1)?.fields.reason, 'malformed_stream');
  assert.doesNotMatch(JSON.stringify(trace.rows), /private-call-|private-malformed/);
});

function malformedMessagesBatch(res: ServerResponse, mixed: boolean, visible = '') {
  sse(
    res,
    ...(visible
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: visible } },
          { type: 'content_block_stop', index: 0 },
        ]
      : []),
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'bad-call-private', name: 'read_file', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"private-malformed' },
    },
    { type: 'content_block_stop', index: 1 },
    ...(mixed
      ? [
          {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'tool_use', id: 'valid-sibling', name: 'read_file', input: {} },
          },
          { type: 'content_block_stop', index: 2 },
        ]
      : []),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  );
}

function harnessFixture(
  trace: ReturnType<typeof collectDiagnostics>,
  overrides: Partial<RunContext> = {},
): RunContext {
  return {
    id: randomUUID(),
    session: { id: randomUUID(), label: 'fixture', cwd: '.', updated: '' },
    signal: AbortSignal.timeout(8000),
    diagnostic: trace.report,
    text() {},
    async line() {},
    preview() {},
    progress() {},
    async saveNovelTask() {},
    ...overrides,
  };
}

for (const mixed of [false, true]) {
  test(`an ended Messages batch with invalid JSON never executes (${mixed ? 'mixed' : 'one block'})`, async (t) => {
    const { profile, requests } = await fixture(t, 'messages', (_body, res) =>
      malformedMessagesBatch(res, mixed),
    );
    const trace = collectDiagnostics();
    let executions = 0;
    await assert.rejects(
      runAgent(harnessFixture(trace), createProvider(profile, key), '', [], 'fixture', [
        {
          name: 'read_file',
          description: 'fixture',
          schema: object({}, []),
          async execute() {
            executions++;
            return 'executed';
          },
        },
      ]),
      /Messages 工具参数/,
    );
    assert.equal(requests.length, 2);
    assert.equal(executions, 0);
    const batch = mixed ? ['invalid_json', 'batch_invalid'] : ['invalid_json'];
    assert.deepEqual(
      trace.rows.filter((r) => r.event === 'tool.rejected').map((r) => r.fields.reason),
      [...batch, ...batch],
    );
    assert.equal(trace.rows.filter((r) => r.event === 'loop.round.started').length, 1);
    assert.equal(trace.rows.filter((r) => r.event === 'model.arguments_retry').length, 1);
    assert.ok(
      !trace.rows.some((r) => r.event === 'tool.started' || r.event === 'workspace.document.committed'),
    );
  });
}

function messagesCall(res: ServerResponse, id: string, name: string, input: object = {}) {
  sse(
    res,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  );
}
const messagesText = (res: ServerResponse, text: string) =>
  sse(
    res,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  );

test('a Messages retry keeps the prior valid exchange and executes only its replacement, in the same round', async (t) => {
  const trace = collectDiagnostics();
  let n = 0;
  const { profile, requests } = await fixture(t, 'messages', (_body, res) => {
    switch (n++) {
      case 0:
        return messagesCall(res, 'old-call', 'write_file', { tag: 'old' });
      case 1:
        return malformedMessagesBatch(res, true, 'ABANDONED_TEMPORARY_TEXT');
      case 2:
        return messagesCall(res, 'good-call', 'write_file', { tag: 'new' });
      default:
        return messagesText(res, '只保存了两次。');
    }
  });
  const receipts: ToolReceipt[] = [],
    commits: string[] = [],
    transcript: string[] = [];
  let streaming = '';
  const ctx = harnessFixture(trace, {
    text: (delta) => {
      streaming += delta;
    },
    resetText: () => {
      streaming = '';
    },
    async line(line) {
      if (line.role === 'assistant') transcript.push(line.text);
    },
    async recordTool(receipt) {
      receipts.push(receipt);
    },
  });
  await runAgent(ctx, createProvider(profile, key), '', [], 'AUTHOR_PRIVATE_FIXTURE', [
    {
      name: 'write_file',
      description: 'fixture',
      schema: object({ tag: { type: 'string' } }),
      async execute({ tag }, context) {
        commits.push(tag);
        context.diagnostic?.('workspace.document.committed', {
          documentRef: `chapter/${tag}`,
          operation: 'write',
          revision: 'a'.repeat(64),
        });
        return { saved: true };
      },
    },
    {
      name: 'read_file',
      description: 'unused on rejection',
      schema: object({}, []),
      async execute() {
        assert.fail('bad batch must not execute');
      },
    },
  ]);
  assert.deepEqual(commits, ['old', 'new']);
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((r) => r.commitCount === 1));
  assert.deepEqual(requests[1].body, requests[2].body);
  assert.doesNotMatch(
    JSON.stringify(requests[3].body),
    /ABANDONED_TEMPORARY_TEXT|bad-call-private|valid-sibling/,
  );
  assert.deepEqual(transcript, ['只保存了两次。']);
  assert.doesNotMatch(streaming, /ABANDONED_TEMPORARY_TEXT/);
  assert.deepEqual(trace.rejected, []);
  const retry = trace.rows.find((r) => r.event === 'model.arguments_retry')!;
  const invalid = trace.rows.find((r) => r.event === 'model.messages_arguments_invalid')!;
  const block = trace.rows.find((r) => r.event === 'model.messages_argument_block')!;
  assert.equal(invalid.fields.spanId, retry.fields.originalSpanId);
  assert.notEqual(retry.fields.spanId, retry.fields.originalSpanId);
  assert.equal(retry.fields.turn, 2);
  assert.equal(retry.fields.attempt, 2);
  assert.deepEqual(
    [
      invalid.fields.messageClosed,
      invalid.fields.stopType,
      invalid.fields.invalidCount,
      invalid.fields.count,
      invalid.fields.omitted,
    ],
    [true, 'tool_use', 1, 2, 0],
  );
  assert.deepEqual(
    [block.fields.blockIndex, block.fields.fragmentCount, block.fields.bytes],
    [1, 2, Buffer.byteLength('{"path":"private-malformed')],
  );
  assert.equal(
    trace.rows.find((r) => r.event === 'tool.started' && r.fields.turn === 2)?.fields.spanId,
    retry.fields.spanId,
  );
  assert.equal(trace.rows.filter((r) => r.event === 'loop.round.started').length, 3);
  assert.doesNotMatch(
    JSON.stringify(trace.rows),
    /AUTHOR_PRIVATE_FIXTURE|private-malformed|ABANDONED_TEMPORARY_TEXT|synthetic-only-secret-fixture/,
  );
});

test('cancelling the one Messages retry prevents the replacement from executing', async (t) => {
  let requests = 0;
  const cancel = new AbortController();
  const { profile } = await fixture(t, 'messages', (_body, res) => {
    if (++requests === 1) malformedMessagesBatch(res, false);
    else {
      cancel.abort();
      messagesCall(res, 'too-late', 'read_file');
    }
  });
  const trace = collectDiagnostics();
  await assert.rejects(
    runAgent(
      harnessFixture(trace, { signal: cancel.signal }),
      createProvider(profile, key),
      '',
      [],
      'fixture',
      [
        {
          name: 'read_file',
          description: 'fixture',
          schema: object({}, []),
          async execute() {
            assert.fail('aborted');
          },
        },
      ],
    ),
    { name: 'AbortError' },
  );
  assert.equal(requests, 2);
  assert.equal(trace.rows.filter((r) => r.event === 'model.arguments_retry').length, 1);
  assert.ok(!trace.rows.some((r) => r.event === 'tool.started'));
});

for (const type of ['missing-end', 'max-tokens', 'auth', 'valid-schema-error'] as const) {
  test(`Messages does not retry ${type} as malformed arguments`, async (t) => {
    const trace = collectDiagnostics();
    const { profile, requests } = await fixture(t, 'messages', (_body, res) => {
      if (type === 'auth') {
        res.writeHead(401);
        res.end();
        return;
      }
      if (type === 'missing-end') {
        sse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' } });
        return;
      }
      if (type === 'max-tokens') {
        sse(
          res,
          { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
          { type: 'message_stop' },
        );
        return;
      }
      if (_body.messages.at(-1)?.content?.[0]?.type === 'tool_result')
        return messagesText(res, '参数需要修正');
      messagesCall(res, 'bad-schema', 'read_file', { unknown: true });
    });
    const operation = runAgent(harnessFixture(trace), createProvider(profile, key), '', [], 'fixture', [
      {
        name: 'read_file',
        description: 'fixture',
        schema: object({}, []),
        async execute() {
          assert.fail('not executable');
        },
      },
    ]);
    if (type === 'valid-schema-error') await operation;
    else await assert.rejects(operation);
    assert.equal(requests.length, type === 'valid-schema-error' ? 2 : 1);
    assert.ok(
      !trace.rows.some((r) => r.event === 'model.arguments_retry' || r.event === 'tool.started'),
    );
  });
}

test('the Messages invalid-block diagnostics are bounded and report omissions', async (t) => {
  const trace = collectDiagnostics();
  const { profile } = await fixture(t, 'messages', (_body, res) =>
    sse(
      res,
      ...Array.from({ length: 19 }, (_, index) => [
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: `bad-${index}`, name: 'read_file', input: {} },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: '{"private-raw' },
        },
        { type: 'content_block_stop', index },
      ]).flat(),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ),
  );
  await assert.rejects(createProvider(profile, key).turn({ ...ctx(), diagnostic: trace.report }));
  assert.equal(trace.rows.filter((r) => r.event === 'model.messages_argument_block').length, 16);
  assert.equal(
    trace.rows.find((r) => r.event === 'model.messages_arguments_invalid')?.fields.omitted,
    3,
  );
  assert.doesNotMatch(JSON.stringify(trace.rows), /private-raw/);
  assert.deepEqual(trace.rejected, []);
});

test('a larger tool output budget is only advertised for supported official DeepSeek profiles', () => {
  const profile: ModelProfile = {
    id: 'fixture',
    name: 'fixture',
    model: 'deepseek-flash',
    protocol: 'messages',
    baseUrl: 'https://api.deepseek.com/anthropic',
  };
  assert.equal(createProvider(profile, key).extendedOutputTokens, 16_384);
  assert.equal(
    createProvider({ ...profile, baseUrl: 'https://example.invalid/anthropic' }, key)
      .extendedOutputTokens,
    undefined,
  );
  assert.equal(
    createProvider({ ...profile, model: 'other-model' }, key).extendedOutputTokens,
    undefined,
  );
  assert.equal(createProvider({ ...profile, protocol: 'chat' }, key).extendedOutputTokens, undefined);
});

test('official DeepSeek uses direct output only for eligible prose and bounded result requests', async (t) => {
  const requests: { thinking?: { type: string } }[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    assert.equal(new URL(String(_input)).origin, 'https://api.deepseek.com');
    requests.push(JSON.parse(init.body as string));
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '完整文本。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const provider = createProvider(
    {
      id: 'fixture',
      name: 'fixture',
      model: 'deepseek-flash',
      protocol: 'messages',
      baseUrl: 'https://api.deepseek.com/anthropic',
    },
    key,
  );
  await provider.turn(ctx());
  await provider.turn({ ...ctx(), directProse: true });
  await provider.turn({ ...ctx(), directProse: true, tools: [] });
  const one = ctx();
  assert.equal(one.tools.length, 1);
  await provider.turn({ ...one, directToolResult: true });
  await provider.turn({
    ...one,
    tools: [...one.tools, { ...one.tools[0], name: 'another' }],
    directToolResult: true,
  });
  assert.deepEqual(
    requests.map((request) => request.thinking),
    [undefined, undefined, { type: 'disabled' }, { type: 'disabled' }, undefined],
  );
});

test('Messages distinguishes an open stream from a closed max_tokens result', async (t) => {
  const trace = collectDiagnostics();
  let closed = false;
  const { profile } = await fixture(t, 'messages', (_body, res) =>
    sse(
      res,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'private-partial-prose' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      ...(closed ? [{ type: 'message_stop' }] : []),
    ),
  );
  const provider = createProvider(profile, key);
  for (const reason of ['incomplete_stream', 'output_limit']) {
    await assert.rejects(provider.turn({ ...ctx(), tools: [], diagnostic: trace.report }), {
      detail: reason,
    });
    closed = true;
  }
  assert.deepEqual(
    trace.rows.filter((row) => row.event === 'model.finished').map((row) => row.fields.reason),
    ['incomplete_stream', 'output_limit'],
  );
  assert.deepEqual(trace.rejected, []);
  assert.doesNotMatch(JSON.stringify(trace.rows), /private-partial-prose/);
});

test('Messages distinguishes closed tool blocks from unfinished blocks on early EOF', async (t) => {
  const trace = collectDiagnostics();
  const { profile } = await fixture(t, 'messages', (_body, res) =>
    sse(
      res,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'closed', name: 'read_file', input: {} },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'open', name: 'read_file', input: {} },
      },
    ),
  );
  await assert.rejects(createProvider(profile, key).turn({ ...ctx(), diagnostic: trace.report }));
  assert.deepEqual(trace.rejected, []);
  const rows = trace.rows.filter((e) => e.event.startsWith('tool.'));
  assert.deepEqual(
    rows.map((e) => e.event),
    ['tool.requested', 'tool.rejected'],
  );
  assert.equal(rows[1].fields.reason, 'incomplete_stream');
});

for (const protocol of ['chat', 'responses', 'messages'] as const) {
  test(`${protocol} preserves the latest native cycle when the real request history is compacted`, async (t) => {
    const rounds = 9;
    const name = (n: number) => (n === 0 ? 'skill_load' : 'read_file');
    const callId = (n: number) => `bounded-call-${n}`;
    const native = (n: number) => `ORIGINAL_NATIVE_STATE_${n}_${'r'.repeat(720)}`;
    let step = 0;
    const { profile, requests } = await fixture(t, protocol, (_, res) => {
      const n = step++;
      if (n === rounds) {
        if (protocol === 'chat') return sse(res, chat({ content: '任务结束。' }), chat({}, 'stop'));
        if (protocol === 'responses')
          return sse(
            res,
            { type: 'response.output_text.delta', delta: '任务结束。' },
            { type: 'response.completed', response: { output: [] } },
          );
        return sse(
          res,
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '任务结束。' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        );
      }
      if (protocol === 'chat')
        return sse(
          res,
          chat({ reasoning_content: native(n) }),
          chat({
            tool_calls: [{ index: 0, id: callId(n), function: { name: name(n), arguments: '{}' } }],
          }),
          chat({}, 'tool_calls'),
        );
      if (protocol === 'responses') {
        const reasoning = {
          type: 'reasoning',
          id: `rs_${n}`,
          summary: [],
          encrypted_content: native(n),
        };
        const tool = {
          type: 'function_call',
          id: `fc_${n}`,
          call_id: callId(n),
          name: name(n),
          arguments: '{}',
          status: 'completed',
        };
        return sse(
          res,
          { type: 'response.output_item.done', output_index: 0, item: reasoning },
          { type: 'response.output_item.done', output_index: 1, item: tool },
          { type: 'response.completed', response: { output: [reasoning, tool] } },
        );
      }
      return sse(
        res,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: native(n), signature: `signature_${n}` },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: callId(n), name: name(n), input: {} },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      );
    });
    const provider = Object.assign(createProvider(profile, key), { inputTokenBudget: 3300 });
    const trace = collectDiagnostics();
    const receipts: ToolReceipt[] = [];
    const context: RunContext = {
      id: randomUUID(),
      session: { id: randomUUID(), label: 'fixture', cwd: '.', updated: '' },
      signal: AbortSignal.timeout(5000),
      diagnostic: trace.report,
      text() {},
      async line() {},
      preview() {},
      progress() {},
      async saveNovelTask() {},
      async recordTool(receipt) {
        receipts.push(receipt);
      },
    };
    const prompt = '必须保持本轮作者指令 CURRENT_AUTHOR_DIRECTION';
    const instruction = 'ACTIVE_SKILL_STAYS: keep named settings and write no unrelated file.';
    await runAgent(context, provider, 'fixture harness', [], prompt, [
      {
        name: 'skill_load',
        description: 'fixture skill',
        schema: object({}, []),
        execute: async () => ({ name: 'write-chapter', instructions: instruction }),
      },
      {
        name: 'read_file',
        description: 'fixture reread',
        schema: object({}, []),
        execute: async () => `LONG_REREADABLE_RESULT_${'中'.repeat(660)}`,
      },
    ]);
    assert.equal(requests.length, rounds + 1);
    assert.equal(receipts.length, rounds);
    // The latest reply carries its exact native state and a matched result on every protocol's wire.
    for (let i = 1; i <= rounds; i++) {
      const { body } = requests[i];
      const wire = JSON.stringify(body);
      assert.ok(wire.includes(native(i - 1)), `round ${i}: preserve native state`);
      assert.match(wire, /CURRENT_AUTHOR_DIRECTION/);
      let calls: string[], results: string[];
      if (protocol === 'chat') {
        calls = body.messages.flatMap((row: any) => (row.tool_calls ?? []).map((c: any) => c.id));
        results = body.messages
          .filter((row: any) => row.role === 'tool')
          .map((row: any) => row.tool_call_id);
      } else if (protocol === 'responses') {
        calls = body.input
          .filter((row: any) => row.type === 'function_call')
          .map((row: any) => row.call_id);
        results = body.input
          .filter((row: any) => row.type === 'function_call_output')
          .map((row: any) => row.call_id);
      } else {
        const blocks = body.messages.flatMap((row: any) => row.content);
        calls = blocks.filter((row: any) => row.type === 'tool_use').map((row: any) => row.id);
        results = blocks
          .filter((row: any) => row.type === 'tool_result')
          .map((row: any) => row.tool_use_id);
        assert.match(wire, new RegExp(`signature_${i - 1}`));
      }
      assert.deepEqual(results, calls);
      assert.equal(calls.at(-1), callId(i - 1));
      if (i === rounds) assert.ok(!calls.includes(callId(0)), 'an old complete cycle was compacted');
    }
    assert.match(JSON.stringify(requests.at(-1)?.body), /ACTIVE_SKILL_STAYS/);
    assert.ok(
      trace.rows.some((row) => row.event === 'context.compacted' && Number(row.fields.omittedCount) > 0),
    );
    assert.ok(
      trace.rows.some((row) => row.event === 'context.compacted' && Number(row.fields.count) > 0),
    );
    assert.doesNotMatch(
      JSON.stringify(receipts),
      /ORIGINAL_NATIVE_STATE|LONG_REREADABLE_RESULT|bounded-call/,
    );
    assert.deepEqual(trace.rejected, []);
  });
}

for (const protocol of ['chat', 'responses', 'messages'] as const)
  test(`isolated asset candidates use the existing ${protocol} tool result protocol`, async (t) => {
    const items = [{ id: 'bell', body: '## 稳定设定\n裂开的铜铃。' }];
    const args = JSON.stringify({ items });
    const fn = 'submit_story_descriptions';
    const { profile, requests } = await fixture(t, protocol, (_body, res) => {
      if (protocol === 'chat')
        sse(
          res,
          chat({
            tool_calls: [{ index: 0, id: 'call_asset', function: { name: fn, arguments: args } }],
          }),
          chat({}, 'tool_calls'),
        );
      else if (protocol === 'responses') {
        const item = {
          type: 'function_call',
          id: 'fc_asset',
          call_id: 'call_asset',
          name: fn,
          arguments: args,
          status: 'completed',
        };
        sse(
          res,
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { output: [item] } },
        );
      } else
        sse(
          res,
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_asset', name: fn, input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: args },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          { type: 'message_stop' },
        );
    });
    const provider = createProvider(profile, key);
    const compiled = buildWritingRequest(
      provider,
      { kind: 'subject', action: 'fill' },
      { author: '补铜铃的说明' },
      [],
    );
    const reply = await provider.turn({
      ...compiled.request,
      signal: AbortSignal.timeout(3000),
      onText() {},
    });
    assert.deepEqual(reply.calls, [{ id: 'call_asset', name: fn, args }]);
    const body = requests[0].body;
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name ?? body.tools[0].function.name, fn);
    assert.match(body.system ?? body.instructions ?? body.messages[0].content, /生成主体说明/);
    assert.match(JSON.stringify(body.input ?? body.messages), /补铜铃的说明/);
    assert.doesNotMatch(JSON.stringify(body), /book_apply_changes|book_get_context/);
  });
