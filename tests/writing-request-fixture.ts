import assert from 'node:assert/strict';
import type { ModelProvider, ModelRequest } from '../electron/agent/model.js';
import { ScriptedProvider, type Script } from '../electron/agent/scripted.js';

type Lane = 'agent' | 'asset' | 'draft' | 'readback';
const laneOf = ({ tools }: ModelRequest): Lane =>
  !tools.length
    ? 'draft'
    : tools.length === 1 && ['submit_story_descriptions', 'submit_story_sync'].includes(tools[0].name)
      ? 'asset'
      : tools.length === 1 && tools[0].name === 'book_read_chapter'
        ? 'readback'
        : 'agent';
export function captureWritingRequests(script: Script[], inputTokenBudget?: number) {
  const requests: { lane: Lane; wire: Pick<ModelRequest, 'system' | 'history' | 'tools'> }[] = [];
  const provider = new ScriptedProvider(script) as ModelProvider;
  provider.inputTokenBudget = inputTokenBudget;
  const turn = provider.turn.bind(provider);
  provider.turn = (request) => {
    const { system, history, tools } = request;
    requests.push({
      lane: laneOf(request),
      wire: structuredClone({
        system,
        history,
        tools: tools.map(({ name, description, schema }) => ({ name, description, schema })),
      }),
    });
    return turn(request);
  };
  return { provider, requests };
}

export function isolatedRequest({ system, history, tools }: ModelRequest, outerMarker: string) {
  assert.equal(history.length, 1);
  assert.equal(history[0]?.role, 'user');
  assert.ok(!JSON.stringify({ system, history, tools }).includes(outerMarker));
  assert.ok(
    !tools.some(({ name }) =>
      ['book_apply_changes', 'skill_load', 'book_generate_chapter'].includes(name),
    ),
  );
}
