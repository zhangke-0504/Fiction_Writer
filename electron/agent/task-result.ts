import type { DocRef } from '../../shared/contracts.js';
import { tokens } from './context-budget.js';

export type TaskReference =
  | (DocRef & { revision: string; range?: [number, number] })
  | {
      path: string;
      line?: number;
    };

export type TaskBrief = {
  brief: string;
  deliverable: string;
  references?: TaskReference[];
};

export type TaskReport = {
  summary: string;
  references: TaskReference[];
  unresolved: string[];
  candidate?: string;
};

export type TaskOutcome = 'completed' | 'partial' | 'failed' | 'timed_out' | 'cancelled';

export type TaskStatus = {
  taskId: string;
  status: TaskOutcome | 'running' | 'unknown';
  reason?: string;
  report?: TaskReport;
  delivery?: 'sent' | 'deferred';
};

export type TaskWaitResult = {
  tasks: TaskStatus[];
  runningIds: string[];
  waitTimedOut: boolean;
};

export const taskReportBudget = { single: 2_048, batch: 4_096, history: 4_096 } as const;

export function projectTaskReports(value: TaskWaitResult, limit: number, seen: Set<string>) {
  let cost = 0;
  let changed = false;
  const tasks = value.tasks.map((row): TaskStatus => {
    const { report, ...status } = row;
    if (!report) return row;
    const size = tokens(JSON.stringify(report));
    if (size <= taskReportBudget.single && size <= limit - cost && !seen.has(row.taskId)) {
      seen.add(row.taskId);
      cost += size;
      return row;
    }
    changed = true;
    return { ...status, delivery: 'deferred' };
  });
  return { cost, value: changed ? { ...value, tasks } : value };
}
