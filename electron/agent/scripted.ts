import { randomUUID } from 'node:crypto';
import type { AssistantTurn, ModelProvider, ModelRequest } from './model.js';
export type Script = (request: ModelRequest) => AssistantTurn | Promise<AssistantTurn>;
export class ScriptedProvider implements ModelProvider {
  readonly effort = 'high';
  constructor(private readonly script: Script[]) {}
  async turn(request: ModelRequest) {
    request.signal.throwIfAborted();
    const step = this.script.shift();
    if (!step) throw new Error('Fixture exhausted');
    request.onDispatch?.(request.spanId ?? randomUUID());
    const response = await step(request);
    request.signal.throwIfAborted();
    return response;
  }
}
export class Gate {
  private waiter?: () => void;
  private opened = false;
  wait(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.opened) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiter = undefined;
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waiter = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
    });
  }
  release() {
    this.opened = true;
    this.waiter?.();
    this.waiter = undefined;
  }
}
