import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type {
  ChapterPreview,
  ChatLine,
  RunInfo,
  RuntimeView,
  Session,
  SessionView,
  Target,
  WorkProgress,
} from '../../shared/contracts.js';
import { Journal } from '../journal.js';

type StateEntry = { session: Session; line?: ChatLine; run?: RunInfo };
export interface RunContext {
  id: string;
  signal: AbortSignal;
  session: Session;
  text: (delta: string) => void;
  line: (line: ChatLine) => Promise<void>;
  uncertainStop?: (reason: string) => void;
  preview: (value?: ChapterPreview) => void;
  progress: (value: WorkProgress) => void;
}
interface Active {
  controller: AbortController;
  settled: Promise<void>;
  exiting?: boolean;
}
export const directoryKey = (path: string) => {
  const key = normalize(path);
  return process.platform === 'win32' ? key.toLowerCase() : key;
};
export class RunManager {
  private readonly states = new Map<string, SessionView>();
  private readonly active = new Map<string, Active>();
  private readonly reserved = new Set<string>();
  private readonly deleting = new Set<string>();
  private readonly uncertain = new Map<string, string>();
  private readonly unavailable = new Set<string>();
  private readonly historyUpdates = new Map<string, Promise<void>>();
  private readonly creating = new Map<string, Set<Promise<Session>>>();
  readonly directory: string;
  constructor(
    root: string,
    private readonly journal: Journal,
    private readonly workflowFor: (bookId?: string) => WorkProgress | undefined = () => undefined,
  ) {
    this.directory = join(root, 'sessions');
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    for (const file of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(file)) continue;
      const id = file.slice(0, -6),
        lines = (await readFile(join(this.directory, file), 'utf8')).split('\n');
      let state: SessionView | undefined;
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as StateEntry;
          if (entry.session.id !== id) continue;
          state ??= { session: entry.session, messages: [], streaming: '' };
          state.session = entry.session;
          if (entry.line) state.messages.push(entry.line);
          if (entry.run) state.run = entry.run;
        } catch {
          /* A crash can leave the last log record incomplete. */
        }
      }
      if (state) {
        if (state.run?.status === 'running')
          state.run = { id: state.run.id, status: 'interrupted', error: '应用已退出或后台曾中断' };
        this.states.set(id, state);
      }
    }
  }
  private historyPath(id: string) {
    return join(this.directory, `${id}.jsonl`);
  }
  // Only create() may create a history file. Updates never resurrect one.
  private async append(view: SessionView, additions: Omit<StateEntry, 'session'> = {}) {
    const file = await open(this.historyPath(view.session.id), constants.O_WRONLY | constants.O_APPEND);
    try {
      await file.writeFile(`\n${JSON.stringify({ session: view.session, ...additions })}\n`, 'utf8');
    } finally {
      await file.close();
    }
  }
  private updateHistory<T>(id: string, task: () => Promise<T>) {
    const update = (this.historyUpdates.get(id) ?? Promise.resolve()).then(task);
    const settled = update.then(
      () => {},
      () => {},
    );
    this.historyUpdates.set(id, settled);
    void settled.then(() => {
      if (this.historyUpdates.get(id) === settled) this.historyUpdates.delete(id);
    });
    return update;
  }
  private changed(id: string) {
    this.journal.emit({ type: 'runtime-change', sessionId: id });
  }
  async create(target: Target, label: string): Promise<Session> {
    const key = directoryKey(target.cwd);
    if (this.unavailable.has(key)) throw new Error('工作区不可用');
    const session: Session = { ...target, id: randomUUID(), label, updated: new Date().toISOString() };
    const view: SessionView = { session, messages: [], streaming: '' };
    const creation = (async () => {
      await writeFile(this.historyPath(session.id), `${JSON.stringify({ session })}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      this.states.set(session.id, view);
      this.changed(session.id);
      return structuredClone(session);
    })();
    const creating = this.creating.get(key) ?? new Set<Promise<Session>>();
    creating.add(creation);
    this.creating.set(key, creating);
    try {
      return await creation;
    } finally {
      creating.delete(creation);
      if (!creating.size) this.creating.delete(key);
    }
  }
  snapshot(): RuntimeView {
    return {
      cursor: this.journal.cursor,
      sessions: structuredClone(
        [...this.states.values()].map((view) => ({
          ...view,
          workflow: this.workflowFor(view.session.bookId),
        })),
      ),
    };
  }
  get(id: string): SessionView {
    const view = this.states.get(id);
    if (!view || this.deleting.has(id)) throw new Error('会话不存在或正在删除');
    return structuredClone(view);
  }
  start(
    id: string,
    prompt: string,
    operation: (ctx: RunContext) => Promise<void>,
    effort?: RunInfo['effort'],
  ) {
    const view = this.states.get(id);
    if (!view || this.deleting.has(id)) throw new Error('会话不存在或正在删除');
    const key = directoryKey(view.session.cwd);
    if (view.session.missing || this.unavailable.has(key)) throw new Error('工作区不可用');
    if (this.uncertain.has(id)) throw new Error(this.uncertain.get(id));
    if (this.reserved.has(key)) throw new Error('该工作区已有任务在运行');
    const run: RunInfo = { id: randomUUID(), status: 'running', effort };
    const cancel = new AbortController();
    const pushLine = async (line: ChatLine) => {
      await this.append(view, { line });
      view.messages.push(line);
      if (line.role === 'assistant') view.streaming = '';
      this.changed(id);
    };
    view.run = run;
    view.streaming = '';
    view.session.updated = new Date().toISOString();
    this.reserved.add(key);
    const active: Active = { controller: cancel, settled: Promise.resolve() };
    this.active.set(id, active);
    active.settled = (async () => {
      try {
        await this.append(view, { run: { ...run } });
        if (prompt) await pushLine({ role: 'user', text: prompt });
        cancel.signal.throwIfAborted();
        await operation({
          id: run.id,
          signal: cancel.signal,
          session: structuredClone(view.session),
          line: pushLine,
          uncertainStop: (reason) => {
            this.uncertain.set(id, reason);
            cancel.abort();
          },
          text: (delta) => {
            if (!cancel.signal.aborted) {
              view.streaming += delta;
              this.changed(id);
            }
          },
          preview: (value) => {
            if (!cancel.signal.aborted || !value) {
              run.preview = value;
              this.changed(id);
            }
          },
          progress: (value) => {
            run.progress = value;
            this.changed(id);
          },
        });
        run.status = cancel.signal.aborted ? 'cancelled' : 'completed';
      } catch (e) {
        run.status = cancel.signal.aborted ? 'cancelled' : 'failed';
        if (!cancel.signal.aborted) run.error = e instanceof Error ? e.message : String(e);
      } finally {
        if (active.exiting) {
          run.status = 'interrupted';
          run.error = '应用退出，本轮未完成';
        }
        const uncertain = this.uncertain.get(id);
        if (uncertain) {
          run.status = 'failed';
          run.error = uncertain;
        }
        run.preview = undefined;
        view.streaming = '';
        try {
          await this.append(view, { run: { ...run } });
        } catch {
          run.status = 'failed';
          run.error = '无法保存会话状态';
        }
        this.active.delete(id);
        this.reserved.delete(key);
        this.changed(id);
      }
    })();
    this.changed(id);
    return { runId: run.id };
  }
  async wait(id: string) {
    await this.active.get(id)?.settled;
  }
  async stop(id: string) {
    const running = this.active.get(id);
    if (running) {
      running.controller.abort();
      await running.settled;
    }
    const uncertain = this.uncertain.get(id);
    if (uncertain) throw new Error(uncertain);
  }
  async remove(id: string) {
    if (this.deleting.has(id)) throw new Error('会话正在删除');
    if (!this.states.has(id)) return;
    this.deleting.add(id);
    try {
      await this.stop(id);
      await this.updateHistory(id, async () => {
        await unlink(this.historyPath(id)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        this.states.delete(id);
        this.uncertain.delete(id);
        this.changed(id);
      });
    } finally {
      this.deleting.delete(id);
    }
  }
  async removeTarget(path: string, remove: () => Promise<void>) {
    const key = directoryKey(path);
    if (this.unavailable.has(key)) throw new Error('工作区正在删除');
    this.unavailable.add(key);
    try {
      await Promise.allSettled(this.creating.get(key) ?? []);
      const sessions = [...this.states.values()].filter((x) => directoryKey(x.session.cwd) === key);
      await Promise.all(sessions.map((x) => this.stop(x.session.id)));
      await remove();
      const marked = await Promise.allSettled(
        sessions.map((state) => {
          const id = state.session.id;
          return this.updateHistory(id, async () => {
            if (this.states.get(id) !== state) return;
            state.session.missing = true;
            try {
              await this.append(state);
            } finally {
              this.changed(id);
            }
          });
        }),
      );
      const failure = marked.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } finally {
      this.unavailable.delete(key);
    }
  }
  async stopAll() {
    for (const active of this.active.values()) active.exiting = true;
    await Promise.allSettled([...this.active.keys()].map((id) => this.stop(id)));
  }
}
