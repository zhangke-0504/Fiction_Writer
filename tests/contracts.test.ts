import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate, ScriptedProvider } from '../electron/agent/scripted.js';
import { Journal } from '../electron/journal.js';

const request = (signal: AbortSignal, out: string[]) => ({
  system: '',
  history: [],
  tools: [],
  signal,
  onText: (text: string) => out.push(text),
});
test('fixture streams two independently controlled chunks and observes cancellation', async () => {
  const gate = new Gate(),
    controller = new AbortController(),
    out: string[] = [];
  const script = () =>
    new ScriptedProvider([
      async ({ signal, onText }) => {
        onText('先');
        await gate.wait(signal);
        onText('后');
        return { role: 'assistant', text: '先后', calls: [] };
      },
    ]);
  const run = script().turn(request(controller.signal, out));
  assert.deepEqual(out, ['先']);
  gate.release();
  assert.equal((await run).text, '先后');
  assert.deepEqual(out, ['先', '后']);
  const two = new Gate();
  const next = new ScriptedProvider([
    async ({ signal }) => {
      await two.wait(signal);
      throw new Error('fixture error');
    },
  ]);
  const aborting = next.turn(request(controller.signal, out));
  controller.abort();
  await assert.rejects(aborting, { name: 'AbortError' });
});
test('journal replays ordered events or requests resnapshot after a gap', () => {
  const events: number[] = [];
  const journal = new Journal((event) => events.push(event.seq), 2);
  for (let i = 0; i < 3; i++) journal.emit({ type: String(i) });
  assert.deepEqual(events, [1, 2, 3]);
  assert.equal(journal.after(0), null);
  assert.deepEqual(
    journal.after(1)?.map((e) => e.seq),
    [2, 3],
  );
});
