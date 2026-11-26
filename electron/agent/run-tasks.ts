import { randomUUID } from 'node:crypto';
import { diagnosticScope, noDiagnostic, type ReportDiagnostic } from '../../shared/diagnostics.js';
import { classified, DiagnosticFailure, elapsed, safeReporter } from '../diagnostics/trace.js';
import type { TaskBrief, TaskOutcome, TaskReport, TaskStatus, TaskWaitResult } from './task-result.js';

const defaults = {
  total: 4,
  concurrent: 2,
  requests: 6,
  totalRequests: 16,
  reads: 12,
  totalReads: 24,
  taskMs: 180_000,
  windowMs: 300_000,
};
export type TaskLimits = typeof defaults;
type Counter = 'requests' | 'reads';
type Terminal = { status: TaskOutcome; reason?: string; report?: TaskReport };
type Entry = {
  controller: AbortController;
  settled: Promise<void>;
  terminal?: Terminal;
  seen: boolean;
  delivered: boolean;
  listeners: Set<() => void>;
};

export interface TaskExecution {
  signal: AbortSignal;
  diagnostic: ReportDiagnostic;
  request(): void;
  read(): void;
  finished(): boolean;
  report(value: TaskReport, state: 'progress' | 'completed' | 'partial'): void;
}

const stopped = () => new DOMException('本轮不再运行子任务', 'AbortError');
const expired = () => new DOMException('子任务已到时', 'TimeoutError');

export class RunTasks {
  private readonly entries = new Map<string, Entry>();
  private readonly limits: TaskLimits;
  private readonly used = { requests: 0, reads: 0 };
  private deadline?: number;
  private closing?: Promise<void>;

  constructor(
    private readonly signal: AbortSignal,
    private readonly run: (brief: TaskBrief, task: TaskExecution) => Promise<void>,
    private readonly diagnostic: ReportDiagnostic = noDiagnostic,
    limits: Partial<TaskLimits> = {},
  ) {
    this.limits = { ...defaults, ...limits };
  }

  start(brief: TaskBrief, origin = this.diagnostic) {
    this.signal.throwIfAborted();
    if (this.closing) throw stopped();
    const started = performance.now();
    if (
      this.entries.size >= this.limits.total ||
      this.used.requests >= this.limits.totalRequests ||
      this.used.reads >= this.limits.totalReads ||
      (this.deadline !== undefined && started >= this.deadline)
    )
      throw new DiagnosticFailure(
        'task_budget',
        '本轮子任务预算已用完；可用已有结果或由主 Agent 继续。',
      );
    if ([...this.entries.values()].filter((row) => !row.terminal).length >= this.limits.concurrent)
      throw new DiagnosticFailure('task_capacity', '已有两个子任务占用容量；等待其中之一退出后再试。');

    const id = randomUUID();
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal]);
    this.deadline ??= started + this.limits.windowMs;
    const deadline = Math.min(this.deadline, started + this.limits.taskMs);
    const onDeadline = () => {
      const remaining = deadline - performance.now();
      // Timers can wake slightly before the monotonic deadline used for admission.
      if (remaining > 0) timer = setTimeout(onDeadline, Math.ceil(remaining));
      else controller.abort(expired());
    };
    let timer = setTimeout(onDeadline, Math.ceil(deadline - started));
    const entry: Entry = {
      controller,
      settled: Promise.resolve(),
      seen: false,
      delivered: false,
      listeners: new Set(),
    };
    this.entries.set(id, entry);
    const diagnostic = diagnosticScope(safeReporter(this.diagnostic), { taskId: id, lane: 'task' });
    const usage = { requests: 0, reads: 0 };
    let quota: DiagnosticFailure | undefined;
    let report: TaskReport | undefined;
    let final: 'completed' | 'partial' | undefined;
    const check = () => {
      if (!signal.aborted && performance.now() >= deadline) controller.abort(expired());
      signal.throwIfAborted();
      if (quota) throw quota;
    };
    const reserve = (kind: Counter, total: 'totalRequests' | 'totalReads') => {
      check();
      if (usage[kind] >= this.limits[kind] || this.used[kind] >= this.limits[total]) {
        quota = new DiagnosticFailure('task_budget', '子任务的模型请求或读取配额已用完。');
        throw quota;
      }
      usage[kind]++;
      this.used[kind]++;
    };
    entry.settled = Promise.resolve().then(async () => {
      let terminal: Terminal;
      try {
        check();
        await this.run(brief, {
          signal,
          diagnostic,
          request: () => reserve('requests', 'totalRequests'),
          read: () => reserve('reads', 'totalReads'),
          finished: () => !!(final || quota),
          report(value, state) {
            check();
            report = value;
            if (state !== 'progress') final = state;
          },
        });
        check();
        terminal = final
          ? { status: final, report }
          : { status: report ? 'partial' : 'failed', report, reason: 'task_no_report' };
      } catch (error) {
        const reason = classified(error, signal);
        terminal =
          this.signal.aborted || this.closing || reason === 'cancelled'
            ? { status: 'cancelled', reason: 'cancelled' }
            : reason === 'timeout'
              ? { status: 'timed_out', report, reason: signal.aborted ? 'task_deadline' : 'timeout' }
              : { status: report ? 'partial' : 'failed', report, reason };
      } finally {
        clearTimeout(timer);
      }
      entry.terminal = terminal;
      diagnostic('task.finished', {
        taskStatus: terminal.status,
        reason: terminal.reason,
        hasReport: !!terminal.report,
        attemptedRequests: usage.requests,
        readCount: usage.reads,
        elapsedMs: elapsed(started),
      });
      for (const notify of entry.listeners) notify();
    });
    diagnosticScope(safeReporter(origin), { taskId: id })('task.accepted', {
      activeCount: [...this.entries.values()].filter((row) => !row.terminal).length,
    });
    return { taskId: id };
  }

  async wait(ids: readonly string[], waitMs: number, report = this.diagnostic): Promise<TaskWaitResult> {
    this.signal.throwIfAborted();
    const unique = [...new Set(ids)];
    const known = unique.flatMap((id) => this.entries.get(id) ?? []);
    const running = known.filter((row) => !row.terminal);
    const ready = known.some(
      (row) => row.terminal && (!row.seen || (row.terminal.report && !row.delivered)),
    );
    const started = performance.now();
    let waitTimedOut = false;
    if (!ready && running.length && waitMs > 0) {
      waitTimedOut = await new Promise<boolean>((resolve, reject) => {
        const clean = () => {
          this.signal.removeEventListener('abort', abort);
          clearTimeout(timer);
          for (const row of running) row.listeners.delete(ready);
        };
        const ready = () => {
          clean();
          resolve(false);
        };
        const abort = () => {
          clean();
          reject(this.signal.reason);
        };
        const timer = setTimeout(() => {
          clean();
          resolve(true);
        }, waitMs);
        this.signal.addEventListener('abort', abort, { once: true });
        for (const row of running) row.listeners.add(ready);
      });
      this.signal.throwIfAborted();
    }
    const tasks = unique.map((taskId): TaskStatus => {
      const row = this.entries.get(taskId);
      if (!row) return { taskId, status: 'unknown' };
      if (!row.terminal) return { taskId, status: 'running' };
      const { status, reason, report } = row.terminal;
      return { taskId, status, reason, ...(row.delivered ? { delivery: 'sent' } : { report }) };
    });
    const runningIds = tasks.filter(({ status }) => status === 'running').map(({ taskId }) => taskId);
    report('task.wait_finished', {
      count: tasks.length,
      activeCount: runningIds.length,
      timedOut: waitTimedOut,
      elapsedMs: elapsed(started),
    });
    for (const row of tasks) {
      if (row.status !== 'unknown')
        report('task.wait_status', {
          taskId: row.taskId,
          taskStatus: row.status,
          hasReport: !!row.report,
        });
    }
    return { tasks, runningIds, waitTimedOut };
  }

  observeDispatch(value: TaskWaitResult, report: ReportDiagnostic) {
    for (const { taskId, status, delivery, report: included } of value.tasks) {
      const row = this.entries.get(taskId);
      if (!row?.terminal || row.terminal.status !== status) continue;
      row.seen = true;
      if (row.delivered) continue;
      const trace = diagnosticScope(report, { taskId });
      if (
        included &&
        row.terminal.report &&
        JSON.stringify(included) === JSON.stringify(row.terminal.report)
      ) {
        row.delivered = true;
        trace('task.report_dispatch', { delivery: 'full' });
      } else if (delivery === 'deferred') trace('task.report_dispatch', { delivery: 'projected' });
    }
  }

  close() {
    if (this.closing) return this.closing;
    const rows = [...this.entries.values()];
    this.closing = Promise.allSettled(rows.map(({ settled }) => settled)).then(() =>
      this.entries.clear(),
    );
    for (const row of rows) if (!row.terminal) row.controller.abort(stopped());
    return this.closing;
  }
}
