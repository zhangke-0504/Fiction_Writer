import type { Push } from '../shared/rpc.js';
export type Event = Push & { seq: number };
export class Journal {
  #cursor = 0;
  #buffer: Event[] = [];
  constructor(
    private readonly notify: (event: Event) => void,
    private readonly retained = 512,
  ) {}
  get cursor() {
    return this.#cursor;
  }
  emit(event: Push) {
    const item = { ...event, seq: ++this.#cursor };
    this.#buffer.push(item);
    if (this.#buffer.length > this.retained) this.#buffer.shift();
    this.notify(item);
    return item.seq;
  }
  after(cursor: number): Event[] | null {
    if (cursor > this.cursor || cursor < (this.#buffer[0]?.seq ?? 1) - 1) return null;
    return this.#buffer.filter((item) => item.seq > cursor);
  }
}
