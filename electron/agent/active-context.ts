import type { ToolResult, WorkProgress } from '../../shared/contracts.js';
import { DiagnosticFailure } from '../diagnostics/trace.js';
import { contextOverflow, excerpt, inputEstimate, tokens } from './context-budget.js';
import type { AssistantTurn, ToolSpec, Turn } from './model.js';
import { recentReceiptLimit, type ToolReceipt } from './tool-receipts.js';

type ResultTurn = Extract<Turn, { role: 'tool' }>;
export type ProtectedResult = Pick<ResultTurn, 'id' | 'result'>;
type Cycle = { assistant: AssistantTurn; results: ResultTurn[]; receipts: ToolReceipt[] };
const rereadable = new Set([
  'list_files',
  'search_text',
  'read_file',
  'book_get_context',
  'book_memory_recall',
]);
const note =
  '工具已执行；为腾出上下文，此处只保留部分结果。需要原文时用只读工具缩小范围重新查询，不要重做已完成的写入。';

/** A disposable request projection. Neither the Pi loop's messages nor the disk transcript are rewritten. */
export class ActiveContext {
  private readonly cycles: Cycle[] = [];
  private readonly omitted: ToolReceipt[] = [];
  private readonly skills = new Map<string, string>();
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
    this.cycles.push({ assistant, results: ordered, receipts });
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
    const finished = this.omitted.map(({ tool, outcome, reason, commits, commitCount }) => ({
      tool,
      outcome,
      reason,
      commitCount,
      docs: commits.slice(0, 5).map(({ operation, type, id }) => `${operation}:${type}/${id}`),
    }));
    return [
      '本轮已压缩的工具历史（不重做旧操作；不确定时重新读现稿）：',
      this.progress && `当前进度：${JSON.stringify(this.progress)}`,
      this.goal && `当前整书目标（摘录）：${excerpt(this.goal, Math.min(2400, limit * 0.17))}`,
      this.skills.size &&
        `本轮已加载的 Skill：\n${excerpt([...this.skills.values()].join('\n\n'), Math.min(4400, limit * 0.25))}`,
      finished.length && `已执行回执：${excerpt(JSON.stringify(finished), Math.min(1250, limit * 0.1))}`,
      this.snippets.length &&
        `早先可见回复摘录：${excerpt(this.snippets.join('\n'), Math.min(380, limit * 0.05))}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  private wire(limit: number, notice?: string) {
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
      ...this.cycles.flatMap(({ assistant, results }) => [assistant, ...results]),
    ];
    return { system, history };
  }
  private shrink(cycle: Cycle, limit: number, readOnly: boolean, keep?: ProtectedResult) {
    let shrunk = 0;
    cycle.results = cycle.results.map((row, i) => {
      if (row.result === keep?.result && row.id === keep.id) return row;
      const tool = cycle.assistant.calls[i].name;
      const { ok, reason, error, value } = row.result;
      if ((readOnly && !rereadable.has(tool)) || tokens(JSON.stringify(row.result)) <= limit + 150)
        return row;
      const result: ToolResult = {
        ok,
        reason,
        error: error && excerpt(error, 240),
        value: { note, excerpt: excerpt(JSON.stringify(value ?? null), limit) },
      };
      shrunk++;
      return { ...row, result };
    });
    this.reductions += shrunk;
    return shrunk;
  }

  fit(limit: number, keep?: ProtectedResult, notice?: string) {
    const measure = () => {
      const wire = this.wire(limit, notice);
      if (
        keep &&
        !wire.history.some(
          (row) => row.role === 'tool' && row.id === keep.id && row.result === keep.result,
        )
      )
        throw contextOverflow();
      return { wire, fits: inputEstimate(wire.system, wire.history, this.tools) <= limit };
    };
    let { wire, fits } = measure();
    if (fits) return wire;

    // First reduce old, re-readable payloads without changing any call, ID or native block.
    for (const cycle of this.cycles.slice(0, -1)) this.shrink(cycle, 720, true, keep);
    this.compacted ||= this.reductions > 0;
    ({ wire, fits } = measure());
    // Cut only whole completed groups. The latest native assistant + matching results stays intact.
    while (!fits && this.cycles.length > 1) {
      this.compacted = true;
      if (keep && this.cycles[0].results.some((row) => row.id === keep.id && row.result === keep.result))
        break;
      this.summarizeCycle(this.cycles.shift()!);
      ({ wire, fits } = measure());
    }
    if (fits) return wire;

    // Make room for a large latest tool result before rejecting an otherwise valid call.
    const latest = this.cycles.at(-1);
    if (latest) {
      for (const size of [Math.max(480, Math.floor((limit * 0.09) / latest.results.length)), 280]) {
        this.compacted = !!this.shrink(latest, size, false, keep) || this.compacted;
        ({ wire, fits } = measure());
        if (fits) return wire;
      }
    }
    // Historical plain chat is optional here. The checkpoint, current input and native cycle are not.
    if (this.past.length) {
      this.past = [];
      ({ wire, fits } = measure());
    }
    if (!fits && this.prelude) {
      this.prelude = excerpt(this.prelude, Math.floor(limit * 0.09));
      ({ wire, fits } = measure());
    }
    if (!fits) throw contextOverflow();
    return wire;
  }
}
