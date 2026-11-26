import type { ToolResult, WorkProgress } from '../../shared/contracts.js';
import { DiagnosticFailure } from '../diagnostics/trace.js';
import { contextOverflow, excerpt, inputEstimate } from './context-budget.js';
import type { AssistantTurn, ToolSpec, Turn } from './model.js';
import { recentReceiptLimit, type ToolReceipt } from './tool-receipts.js';
import { projectReadResult, readIdentity, readResultBudget } from './tool-context.js';
import { projectTaskReports, taskReportBudget, type TaskWaitResult } from './task-result.js';

type ResultTurn = Extract<Turn, { role: 'tool' }>;
export type ProtectedResult = Pick<ResultTurn, 'id' | 'result'>;
type Cycle = {
  assistant: AssistantTurn;
  results: ResultTurn[];
  receipts: ToolReceipt[];
  projected: Set<string>;
};
/** A disposable request projection. Neither the Pi loop's messages nor the disk transcript are rewritten. */
export class ActiveContext {
  private readonly cycles: Cycle[] = [];
  private readonly omitted: ToolReceipt[] = [];
  private readonly skills = new Map<string, string>();
  private readonly scope = new Map<string, unknown>();
  private snippets: string[] = [];
  private goal?: string;
  private progress?: WorkProgress;
  private compacted = false;
  private removed = 0;
  private reductions = 0;

  constructor(
    private readonly base: string,
    private prelude: string,
    private past: Turn[],
    private readonly prompt: string,
    private readonly tools: ToolSpec[],
    private readonly textHistoryInPrompt = false,
  ) {}
  get stats() {
    return { removed: this.removed, reductions: this.reductions };
  }
  setProgress(value: WorkProgress) {
    this.progress = value;
  }
  append(assistant: AssistantTurn, results: ResultTurn[], receipts: ToolReceipt[]) {
    const byId = new Map(results.map((result) => [result.id, result]));
    if (!assistant.calls.length) return;
    if (
      byId.size !== results.length ||
      byId.size !== assistant.calls.length ||
      assistant.calls.some((call) => !byId.has(call.id))
    )
      throw new DiagnosticFailure('invalid_call', '工具往返不完整，未将不匹配的结果发送给模型');
    const ordered = assistant.calls.map((call) => byId.get(call.id)!);
    assistant.calls.forEach(({ name }, i) => {
      const result = ordered[i].result;
      if (!result.value || typeof result.value !== 'object') return;
      const value = result.value as Record<string, unknown>;
      if (
        name === 'skill_load' &&
        result.ok &&
        typeof value.name === 'string' &&
        typeof value.instructions === 'string'
      )
        this.skills.set(value.name, value.instructions);
      if (name === 'book_task_scope' && result.ok && Array.isArray(value.targets)) {
        for (const target of value.targets)
          this.scope.set(JSON.stringify([target.operation, target.id, target.part]), target);
      }
      if (
        name === 'book_get_context' &&
        Array.isArray(value.chapterIds) &&
        typeof value.total === 'number'
      ) {
        const fields = [
          'chapterIds',
          'done',
          'total',
          'complete',
          'firstUnwritten',
          'lastFailedChapterId',
          'missingChapters',
          'originalDirection',
          'amendedDirection',
        ];
        this.goal = JSON.stringify(
          Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]])),
        );
      }
    });
    this.cycles.push({ assistant, results: ordered, receipts, projected: new Set() });
  }

  private summarizeCycle(cycle: Cycle) {
    this.omitted.push(...cycle.receipts);
    if (this.omitted.length > recentReceiptLimit)
      this.omitted.splice(0, this.omitted.length - recentReceiptLimit);
    if (cycle.assistant.text.trim())
      this.snippets = [...this.snippets, excerpt(cycle.assistant.text, 170)].slice(-4);
    this.removed++;
  }
  private activeSummary(limit: number) {
    if (!this.compacted) return '';
    const committed = new Map<string, ToolReceipt['commits'][number]>();
    for (const receipt of this.omitted)
      for (const commit of receipt.commits)
        committed.set(JSON.stringify([commit.type, commit.id]), commit);
    const finished = [...committed.values()];

    return [
      '本轮已压缩的工具历史（不重做旧操作；不确定时重新读现稿）：',
      this.progress && `当前进度：${JSON.stringify(this.progress)}`,
      this.goal && `当前整书目标：${this.goal}`,
      this.scope.size && `本轮已登记范围：${JSON.stringify([...this.scope.values()])}`,
      this.skills.size && `本轮已加载的 Skill：\n${[...this.skills.values()].join('\n\n')}`,
      finished.length && `已执行回执：${JSON.stringify(finished)}`,
      this.snippets.length &&
        `早先可见回复摘录：${excerpt(this.snippets.join('\n'), Math.min(380, limit * 0.05))}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  private wire(limit: number, selections: ResultTurn[][], notice?: string) {
    const system = [this.base, this.prelude, this.activeSummary(limit), notice]
      .filter(Boolean)
      .join('\n\n');
    const flat = this.textHistoryInPrompt && this.past.length;
    const history: Turn[] = [
      ...(flat ? [] : this.past),
      {
        role: 'user',
        text: flat
          ? `会话上下文（前几轮文本，不含工具状态）：\n${JSON.stringify(this.past)}\n\n本轮：\n${this.prompt}`
          : this.prompt,
      },
      ...this.cycles.flatMap(({ assistant }, index) => [assistant, ...selections[index]]),
    ];
    return { system, history };
  }
  private select(allowance: number) {
    let newReadEstimate = 0,
      historicalReadEstimate = 0,
      projectedResults = 0;
    let newTaskEstimate = 0,
      historicalTaskEstimate = 0;
    const selections: ResultTurn[][] = [];
    const seen = new Set<string>();
    const seenTasks = new Set<string>();
    const latest = this.cycles.length - 1;
    for (let c = latest; c >= 0; c--) {
      const cycle = this.cycles[c];
      const historical = c !== latest;
      let remainingRows = cycle.results.reduce(
        (count, row, i) =>
          count + Number(projectReadResult(cycle.assistant.calls[i].name, row.result, 0) !== undefined),
        0,
      );
      selections[c] = cycle.results.map((row, i) => {
        const tool = cycle.assistant.calls[i].name;
        if (tool === 'wait_tasks' && row.result.ok) {
          const remaining = historical
            ? taskReportBudget.history - historicalTaskEstimate
            : taskReportBudget.batch - newTaskEstimate;
          const reports = projectTaskReports(
            row.result.value as TaskWaitResult,
            Math.min(remaining, allowance),
            seenTasks,
          );
          allowance -= reports.cost;
          if (historical) historicalTaskEstimate += reports.cost;
          else newTaskEstimate += reports.cost;
          if (reports.value === row.result.value) return row;
          return { ...row, result: { ...row.result, value: reports.value } };
        }
        const lane = historical
          ? readResultBudget.history - historicalReadEstimate
          : readResultBudget.batch - newReadEstimate;
        const available = Math.max(0, Math.min(allowance, lane));
        const share = historical ? available : Math.floor(available / Math.max(1, remainingRows));
        const identity = readIdentity(tool, row.result.value);
        const budget =
          historical && identity && seen.has(identity) ? 0 : Math.min(readResultBudget.single, share);
        const projected = projectReadResult(tool, row.result, budget, historical);
        if (!projected) return row;
        remainingRows--;
        allowance -= projected.cost;
        if (historical) historicalReadEstimate += projected.cost;
        else newReadEstimate += projected.cost;
        const carried = readIdentity(tool, projected.value);
        if (carried) seen.add(carried);
        if (projected.value !== row.result.value || cycle.projected.has(row.id)) projectedResults++;
        if (projected.value === row.result.value) return row;
        return { ...row, result: { ...row.result, value: projected.value } };
      });
    }
    return {
      selections,
      newReadEstimate,
      historicalReadEstimate,
      projectedResults,
      newTaskEstimate,
      historicalTaskEstimate,
    };
  }

  fit(limit: number, keep?: ProtectedResult, notice?: string, tools = this.tools) {
    const measure = (allowance: number) => {
      const selection = this.select(allowance);
      const wire = this.wire(limit, selection.selections, notice);
      const latest = selection.selections.at(-1) ?? [];
      if (keep && !latest.some((row) => row.id === keep.id && row.result === keep.result))
        throw contextOverflow();
      return { wire, selection, latest, size: inputEstimate(wire.system, wire.history, tools) };
    };
    // Reserve space for non-rereadable controls and paired reference envelopes before allocating text.
    let floor = measure(0);
    while (floor.size > limit && this.cycles.length > 1) {
      this.compacted = true;
      this.summarizeCycle(this.cycles.shift()!);
      floor = measure(0);
    }
    if (floor.size > limit && this.past.length) {
      this.past = [];
      floor = measure(0);
    }
    if (floor.size > limit && this.prelude) {
      this.prelude = excerpt(this.prelude, Math.floor(limit * 0.09));
      floor = measure(0);
    }
    if (floor.size > limit) throw contextOverflow();

    let spare = limit - floor.size;
    let final = spare ? measure(spare) : floor;
    // Native/JSON wrapper overhead can differ from the read payload estimate. Never overrun the hard limit.
    if (final.size > limit) {
      spare -= final.size - limit;
      final = spare > 0 ? measure(spare) : floor;
      if (final.size > limit) final = floor;
    }
    const { wire, selection, latest } = final;
    // Never resurrect material withheld on a prior request or silently change its cursor later.
    for (const [i, cycle] of this.cycles.entries()) {
      const outgoing = selection.selections[i];
      for (const [j, row] of outgoing.entries()) {
        if (cycle.results[j] !== row) {
          cycle.projected.add(row.id);
          this.reductions++;
        }
      }
      cycle.results = outgoing;
    }
    return {
      ...wire,
      latest: new Map(latest.map((row) => [row.id, row.result])),
      projection: {
        newReadEstimate: selection.newReadEstimate,
        historicalReadEstimate: selection.historicalReadEstimate,
        projectedResults: selection.projectedResults,
        ...(selection.newTaskEstimate && { newTaskEstimate: selection.newTaskEstimate }),
        ...(selection.historicalTaskEstimate && {
          historicalTaskEstimate: selection.historicalTaskEstimate,
        }),
      },
    };
  }
}
