import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiagnosticSource } from '../../shared/diagnostics.js';
import { validateDiagnostic } from './contract.js';

const dayMs = 86_400_000;
const cleanupRetryMs = 60_000;
const maxCleanupAttempts = 3;
const filenamePattern = /^(frontend|backend)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export function localDay(now: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(now.getFullYear()).padStart(4, '0')}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export function dateIndex(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day
    ? date.getTime() / dayMs
    : undefined;
}
export interface DiagnosticDisk {
  list(): Promise<{ name: string; regular: boolean }[]>;
  remove(name: string): Promise<void>;
  append(name: string, text: string): Promise<void>;
}
export function diagnosticDisk(directory: string): DiagnosticDisk {
  const prepare = async () => {
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid diagnostic directory');
  };
  const target = (name: string) => {
    if (!filenamePattern.test(name)) throw new Error('Invalid diagnostic filename');
    return join(directory, name);
  };
  const info = async (name: string) => {
    try {
      return await lstat(target(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  return {
    async list() {
      await prepare();
      return (await readdir(directory, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        regular: entry.isFile() && !entry.isSymbolicLink(),
      }));
    },
    async remove(name) {
      await prepare();
      const prior = await info(name);
      if (prior?.isFile() && !prior.isSymbolicLink()) await unlink(target(name));
    },
    async append(name, text) {
      await prepare();
      const path = target(name),
        prior = await info(name);
      if (prior && (!prior.isFile() || prior.isSymbolicLink()))
        throw new Error('Invalid diagnostic file');
      const handle = await open(path, 'a+');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Invalid diagnostic file');
        let separator = '';
        if (stat.size) {
          const last = Buffer.alloc(1);
          if ((await handle.read(last, 0, 1, stat.size - 1)).bytesRead && last[0] !== 10)
            separator = '\n';
        }
        await handle.appendFile(separator + text, 'utf8');
      } finally {
        await handle.close();
      }
    },
  };
}
interface Entry {
  name: string;
  day: string;
  data: string;
  bytes: number;
  priority: boolean;
}
interface Options {
  now?: () => Date;
  disk?: DiagnosticDisk;
  maxEntries?: number;
  maxBytes?: number;
  maxLine?: number;
  maintenanceMs?: number;
  batchDelayMs?: number;
}
interface CleanupState {
  day: string;
  attempts: number;
  retryAt?: number;
}
type Loss = { overflow: number; io: number; expired: number; cleanup: number };
const noLoss = (): Loss => ({ overflow: 0, io: 0, expired: 0, cleanup: 0 });
export class DailyDiagnosticWriter {
  readonly bootId = randomUUID();
  private readonly salt = randomBytes(32);
  private readonly now: () => Date;
  private readonly disk: DiagnosticDisk;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxLine: number;
  private readonly batchDelay: number;
  private readonly queue: Entry[] = [];
  private bytes = 0;
  private inFlightCount = 0;
  private inFlightBytes = 0;
  private logSeq = 0;
  private loss = noLoss();
  private cleanup?: CleanupState;
  private scheduled?: ReturnType<typeof setTimeout>;
  private maintenance?: ReturnType<typeof setInterval>;
  private pump?: Promise<void>;
  private closed = false;
  constructor(directory: string, options: Options = {}) {
    this.now = options.now ?? (() => new Date());
    this.disk = options.disk ?? diagnosticDisk(directory);
    this.maxEntries = options.maxEntries ?? 1024;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.maxLine = options.maxLine ?? 8 * 1024;
    this.batchDelay = options.batchDelayMs ?? 24;
    if (options.maintenanceMs !== 0)
      this.maintenance = setInterval(() => this.maintain(), options.maintenanceMs ?? 60_000).unref();
    this.maintain();
  }
  private entry(
    source: DiagnosticSource,
    value: unknown,
    fromRenderer: boolean,
    rendererId?: string,
  ): Entry | undefined {
    const safe = validateDiagnostic(source, value, this.salt, fromRenderer);
    if (!safe) return;
    if (fromRenderer && rendererId) safe.fields.rendererId = rendererId;
    const time = this.now(),
      day = localDay(time);
    const data =
      JSON.stringify({
        schemaVersion: 1,
        time: time.toISOString(),
        day,
        bootId: this.bootId,
        logSeq: ++this.logSeq,
        source,
        ...safe,
      }) + '\n';
    const priority =
      safe.level !== 'info' || /^(app\.stopped|run\.finished|worker\.exited)$/.test(safe.event);
    return {
      name: `${source === 'renderer' ? 'frontend' : 'backend'}-${day}.jsonl`,
      day,
      data,
      bytes: Buffer.byteLength(data),
      priority,
    };
  }
  accept(source: DiagnosticSource, input: unknown, fromRenderer = false, rendererId?: string) {
    if (this.closed) return;
    try {
      const entry = this.entry(source, input, fromRenderer, rendererId);
      if (!entry) return;
      const full = () =>
        this.queue.length + this.inFlightCount >= this.maxEntries ||
        this.bytes + this.inFlightBytes + entry.bytes > this.maxBytes;
      if (entry.bytes > Math.min(this.maxLine, this.maxBytes)) {
        this.loss.overflow++;
        return;
      }
      if (entry.priority)
        while (full()) {
          const index = this.queue.findIndex((event) => !event.priority);
          if (index < 0) break;
          this.bytes -= this.queue.splice(index, 1)[0].bytes;
          this.loss.overflow++;
        }
      if (full()) {
        this.loss.overflow++;
        return;
      }
      this.bytes += entry.bytes;
      this.queue.push(entry);
      this.schedule();
    } catch {
      /* A diagnostic call is never a reason for its caller to fail. */
    }
  }
  get buffered() {
    return { entries: this.queue.length + this.inFlightCount, bytes: this.bytes + this.inFlightBytes };
  }
  maintain() {
    if (this.cleanupDue(this.now())) this.schedule();
  }
  private cleanupDue(now: Date, day = localDay(now)) {
    const state = this.cleanup;
    return (
      !state ||
      state.day !== day ||
      (state.retryAt !== undefined &&
        state.attempts < maxCleanupAttempts &&
        now.getTime() >= state.retryAt)
    );
  }
  private schedule() {
    if (this.closed || this.scheduled || this.pump) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.startPump();
    }, this.batchDelay).unref();
  }
  private async sweep() {
    const now = this.now(),
      day = localDay(now);
    if (!this.cleanupDue(now, day)) return false;
    const state: CleanupState = {
      day,
      attempts: this.cleanup?.day === day ? this.cleanup.attempts + 1 : 1,
    };
    this.cleanup = state;
    const failed = () => {
      this.loss.cleanup++;
      state.retryAt = this.now().getTime() + cleanupRetryMs;
    };
    try {
      const oldest = dateIndex(day)! - 29;
      for (const file of await this.disk.list()) {
        const match = filenamePattern.exec(file.name),
          index = match ? dateIndex(match[2]) : undefined;
        if (!file.regular || index === undefined || index >= oldest) continue;
        try {
          await this.disk.remove(file.name);
        } catch {
          failed();
        }
      }
    } catch {
      failed();
    }
    return state.retryAt === undefined;
  }
  private async drain() {
    let progressed = await this.sweep();
    const failed = new Set<string>();
    while (this.queue.length) {
      progressed = (await this.sweep()) || progressed;
      const name = this.queue[0].name,
        oldest = dateIndex(localDay(this.now()))! - 29;
      const batch: Entry[] = [];
      while (batch.length < 32 && this.queue[0]?.name === name) {
        const entry = this.queue.shift()!;
        this.bytes -= entry.bytes;
        if (dateIndex(entry.day)! < oldest) this.loss.expired++;
        else batch.push(entry);
      }
      if (!batch.length) continue;
      if (failed.has(name)) {
        this.loss.io += batch.length;
        continue;
      }
      this.inFlightCount = batch.length;
      this.inFlightBytes = batch.reduce((total, entry) => total + entry.bytes, 0);
      try {
        await this.disk.append(name, batch.map((entry) => entry.data).join(''));
        progressed = true;
      } catch {
        this.loss.io += batch.length;
        // Drop subsequent rows for this file in this drain, not rows for healthy files.
        failed.add(name);
      } finally {
        this.inFlightCount = 0;
        this.inFlightBytes = 0;
      }
    }
    if (progressed && Object.values(this.loss).some(Boolean)) {
      const previous = this.loss;
      const summary = this.entry('main', { event: 'diagnostics.loss', fields: { ...previous } }, false);
      if (!summary || failed.has(summary.name)) return;
      this.loss = noLoss();
      try {
        await this.disk.append(summary.name, summary.data);
      } catch {
        for (const key of Object.keys(previous) as (keyof Loss)[]) this.loss[key] += previous[key];
      }
    }
  }
  private startPump() {
    if (this.pump) return this.pump;
    this.pump = Promise.resolve()
      .then(() => this.drain())
      .catch(() => {
        this.loss.io++;
      })
      .finally(() => {
        this.pump = undefined;
        if (this.queue.length) this.schedule();
      });
    return this.pump;
  }
  async flush(timeoutMs = 750) {
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = undefined;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const drain = async () => {
      do {
        await this.startPump();
      } while (this.queue.length);
      return true;
    };
    try {
      return await Promise.race([
        drain(),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async close(timeoutMs = 750) {
    this.closed = true;
    if (this.maintenance) clearInterval(this.maintenance);
    return this.flush(timeoutMs);
  }
}
