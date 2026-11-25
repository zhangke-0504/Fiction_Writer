import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { AssistantTurn, ModelProvider, ModelRequest } from '../electron/agent/model.js';
import { createProvider } from '../electron/agent/provider.js';

export function messagesRecoveryFixture(
  t: TestContext,
  useOuter: (req: ModelRequest) => boolean,
  inner: ModelProvider,
) {
  const provider = createProvider(
    {
      id: 'fixture',
      name: 'fixture',
      model: 'deepseek-flash',
      providerId: 'deepseek',
      protocol: 'messages',
      baseUrl: 'https://api.deepseek.com/anthropic',
    },
    'synthetic-output-limit-key',
  );
  const scripted: Array<() => AssistantTurn | Promise<AssistantTurn>> = [];
  const wires: Array<{ system: string; messages: unknown[]; max_tokens: number }> = [];
  const originalTurn = provider.turn.bind(provider);
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    wires.push(JSON.parse(String(init.body)));
    const step = scripted.shift();
    assert.ok(step, 'Unexpected extra Messages request');
    const output = await step();
    const events = [];
    if (output.text) {
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      events.push({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: output.text },
      });
      events.push({ type: 'content_block_stop', index: 0 });
    }
    for (const [i, call] of output.calls.entries()) {
      const index = i + Number(!!output.text);
      events.push({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: JSON.parse(call.args),
        },
      });
      events.push({ type: 'content_block_stop', index });
    }
    events.push({
      type: 'message_delta',
      delta: {
        stop_reason:
          output.native === 'truncated-fixture'
            ? 'max_tokens'
            : output.calls.length
              ? 'tool_use'
              : 'end_turn',
      },
    });
    events.push({ type: 'message_stop' });
    return new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  provider.turn = (req) => (useOuter(req) ? originalTurn(req) : inner.turn(req));
  return { provider, scripted, wires };
}
