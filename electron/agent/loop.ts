import { randomUUID } from 'node:crypto';
import { diagnosticScope, noDiagnostic, type ReportDiagnostic } from '../../shared/diagnostics.js';
import { classified, DiagnosticFailure, elapsed, safeReporter } from '../diagnostics/trace.js';
import { runAgentLoop, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type JsonObject,
  type UserMessage,
} from '@earendil-works/pi-ai';
import type { AssistantTurn, ModelProvider, ToolSpec, Turn } from './model.js';
import { MalformedMessagesArguments } from './provider.js';
import type { ReportMemoryDispatch } from './book-memory.js';
import type { RunContext } from './runs.js';
import type { ToolResult } from '../../shared/contracts.js';
import { ActiveContext } from './active-context.js';
import { contextOverflow, inputBudget, inputEstimate, prepareSessionHistory } from './context-budget.js';
import {
  callRef,
  commitReceiptLimit,
  observedCommit,
  receiptReason,
  type ToolReceipt,
} from './tool-receipts.js';

export interface LocalTool extends ToolSpec {
  execute: (args: Record<string, any>, ctx: RunContext) => Promise<unknown>;
  onResultSent?: (result: ToolResult, report: ReportDiagnostic) => void;
}
/** A domain failure can carry a bounded tool result, without forwarding it to diagnostics. */
export class ToolFailure extends DiagnosticFailure {
  constructor(
    reason: string,
    message: string,
    readonly value?: unknown,
  ) {
    super(reason, message);
  }
}
export const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const str = (description?: string, maxLength = 200_000) => ({
  type: 'string',
  minLength: 1,
  maxLength,
  ...(description && { description }),
});
const model: Model<'openai-completions'> = {
  id: 'fw',
  name: 'Fiction Writer',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 96_000,
  maxTokens: 8192,
};
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function safeText(thing: unknown) {
  return (thing instanceof Error ? thing.message : String(thing)).slice(0, 2000);
}
function parseArgs(raw: string): JsonObject {
  const value: unknown = JSON.parse(raw);
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new DiagnosticFailure('invalid_arguments', '工具参数不是对象');
  return value as JsonObject;
}
interface Candidate {
  report: ReportDiagnostic;
  context: ReportDiagnostic;
  fieldCount?: number;
  parseFailure?: string;
  rejected?: boolean;
  executed?: boolean;
}
interface Round {
  number: number;
  answer?: AssistantTurn;
  receipts: ToolReceipt[];
  started: number;
  report: ReportDiagnostic;
  candidates: Map<string, Candidate>;
  failure?: string;
}
function reject(candidate: Candidate, reason: string) {
  if (candidate.rejected || candidate.executed) return;
  candidate.rejected = true;
  candidate.report('tool.rejected', { reason });
}
function commandOutcome(value: unknown) {
  const result = value as { code: number | null; timeout: boolean; truncated: boolean };
  return {
    outcome: result.timeout
      ? ('timeout' as const)
      : result.code === 0
        ? ('ok' as const)
        : ('failed' as const),
    reason: result.timeout ? 'command_timeout' : result.code === 0 ? undefined : 'command_failed',
    exitCode: result.code ?? undefined,
    timedOut: result.timeout,
    truncated: result.truncated,
    termination: result.timeout ? 'confirmed' : 'none',
  };
}

export const defaultRoundLimit = 200;
interface AgentBudget {
  roundLimit: () => number;
  outputTokens: () => number | undefined;
}

export async function runAgent(
  ctx: RunContext,
  provider: ModelProvider,
  system: string,
  previous: Turn[],
  prompt: string,
  tools: LocalTool[],
  budget: number | AgentBudget = defaultRoundLimit,
  reportAttachedMemory?: ReportMemoryDispatch,
) {
  const trace = diagnosticScope(safeReporter(ctx.diagnostic ?? noDiagnostic), { lane: 'agent' });
  const maxOutput = () => (typeof budget === 'number' ? undefined : budget.outputTokens());
  const spare =
    inputBudget(provider, maxOutput()) - inputEstimate(system, [{ role: 'user', text: prompt }], tools);
  if (spare < 0) throw contextOverflow();
  const session = await prepareSessionHistory(
    ctx.history,
    provider,
    spare,
    ctx.signal,
    diagnosticScope(trace, { lane: 'compaction' }),
  );
  const context = new ActiveContext(
    system,
    session.prelude,
    [...previous, ...session.turns],
    prompt,
    tools,
    provider.textHistoryInPrompt,
  );
  let history: Turn[] = [];
  let finalAnswer: AssistantTurn | undefined;
  let receiptFailure = false;
  let projectionFailure: DiagnosticFailure | undefined;
  let previousCompaction = 0;
  const registered = new Map(tools.map((tool) => [tool.name, tool]));
  const outbound: { candidate: Candidate; result: ToolResult; tool?: LocalTool }[] = [];
  let rounds = 0;
  const roundLimit = () => (typeof budget === 'number' ? budget : budget.roundLimit());
  let active: Round | undefined;
  let failure: string | undefined;
  const finish = (outcome: string, reason: string, toolCount = 0) => {
    active?.report('loop.round.finished', {
      outcome,
      reason,
      toolCount,
      elapsedMs: elapsed(active.started),
    });
    active = undefined;
  };
  const wrapped: AgentTool[] = tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.schema,
    replay: 'never',
    async execute(id, params) {
      ctx.signal.throwIfAborted();
      const round = active;
      const call = round?.candidates.get(id);
      const started = performance.now();
      const receipt: ToolReceipt = {
        runId: ctx.id,
        round: round?.number ?? rounds,
        callRef: callRef(id),
        tool: tool.name,
        outcome: 'ok',
        commits: [],
        commitCount: 0,
      };
      const report = call?.context ?? ctx.diagnostic;
      if (call) {
        call.executed = true;
        call.report('tool.started');
      }
      try {
        const value = await tool.execute(params as Record<string, unknown>, {
          ...ctx,
          progress(value) {
            context.setProgress(value);
            ctx.progress(value);
          },
          diagnostic(event, fields) {
            if (event === 'workspace.document.committed') {
              const commit = observedCommit(fields);
              if (commit) {
                receipt.commitCount++;
                if (receipt.commits.length < commitReceiptLimit) receipt.commits.push(commit);
              }
            }
            report?.(event, fields);
          },
        });
        if (tool.name === 'run_command') {
          const command = commandOutcome(value);
          receipt.outcome = command.outcome;
          receipt.reason = command.reason;
          receipt.exitCode = command.exitCode;
        }
        if (tool.name === 'book_memory_remember' || tool.name === 'book_memory_forget')
          receipt.conventionId = (value as { id?: string } | undefined)?.id;
        const payload = JSON.stringify({ ok: true, value } satisfies ToolResult);
        const oversized = payload.length > 120_000;
        if (oversized) receipt.resultOmitted = true;
        call?.report('tool.finished', {
          transportOk: !oversized,
          elapsedMs: elapsed(started),
          ...(oversized
            ? { outcome: 'failed', reason: 'result_limit', truncated: true }
            : tool.name === 'run_command'
              ? commandOutcome(value)
              : { outcome: 'ok' }),
        });
        return {
          content: [
            {
              type: 'text',
              text:
                payload.length > 120_000
                  ? JSON.stringify({ ok: false, error: '工具结果超出上下文范围，请缩小查询' })
                  : payload,
            },
          ],
          details: undefined,
          isError: payload.length > 120_000,
        };
      } catch (e) {
        const reason = classified(e, ctx.signal);
        receipt.outcome = receipt.commitCount
          ? 'partial'
          : reason === 'cancelled'
            ? 'cancelled'
            : reason === 'timeout'
              ? 'timeout'
              : 'failed';
        receipt.reason = receiptReason(reason);
        call?.report('tool.finished', {
          reason: reason === 'unknown' ? 'tool_failed' : reason,
          outcome: reason === 'cancelled' ? 'cancelled' : 'failed',
          elapsedMs: elapsed(started),
          transportOk: false,
          termination: reason === 'termination_uncertain' ? 'uncertain' : undefined,
        });
        const result: ToolResult = { ok: false, error: safeText(e), reason };
        const payload = JSON.stringify({
          ...result,
          ...(e instanceof ToolFailure && { value: e.value }),
        });
        return {
          content: [
            { type: 'text', text: payload.length <= 120_000 ? payload : JSON.stringify(result) },
          ],
          details: undefined,
          isError: true,
        };
      } finally {
        round?.receipts.push(receipt);
        try {
          await ctx.recordTool?.(receipt);
        } catch {
          // The original action may have committed; do not let the loop retry it.
          receiptFailure = true;
        }
      }
    },
  }));
  const stream: StreamFn = () => {
    const number = ++rounds,
      spanId = randomUUID();
    const report = diagnosticScope(trace, { turn: number, spanId });
    const round: Round = {
      number,
      started: performance.now(),
      report,
      candidates: new Map(),
      receipts: [],
    };
    active = round;
    report('loop.round.started');
    const feed = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      api: model.api,
      provider: model.provider,
      model: model.id,
      role: 'assistant',
      timestamp: Date.now(),
      content: [],
      usage,
      stopReason: 'stop',
    };
    void (async () => {
      try {
        const maxTokens = maxOutput();
        const wire = context.fit(inputBudget(provider, maxTokens));
        history = wire.history;
        const stats = context.stats;
        if (stats.removed + stats.reductions !== previousCompaction) {
          previousCompaction = stats.removed + stats.reductions;
          report('context.compacted', { count: stats.removed, omittedCount: stats.reductions });
        }
        let answeredSpanId = spanId;
        const send = (attemptId: string, attempt: 1 | 2) => {
          const requestTrace = diagnosticScope(report, {
            spanId: attemptId,
            attempt,
            ...(attempt === 2 && { originalSpanId: spanId }),
          });
          return provider.turn({
            ...wire,
            tools,
            maxTokens,
            signal: ctx.signal,
            onText: ctx.text,
            diagnostic: requestTrace,
            spanId: attemptId,
            onDispatch(nextSpanId) {
              // The base system block is intact in the fitted wire projection.
              reportAttachedMemory?.(diagnosticScope(requestTrace, { spanId: nextSpanId }));
              // Dispatch metadata and business receipts for already executed tools stay unique.
              for (const { candidate, result, tool } of outbound.splice(0)) {
                candidate.report('tool.result_sent', { spanId: nextSpanId, nextTurn: number });
                tool?.onResultSent?.(
                  result,
                  diagnosticScope(candidate.context, { spanId: nextSpanId, turn: number }),
                );
              }
            },
          });
        };
        let answer: AssistantTurn;
        try {
          answer = await send(spanId, 1);
        } catch (error) {
          if (!(error instanceof MalformedMessagesArguments)) throw error;
          // Up to this boundary no native reply or tool candidate from this round entered Pi.
          ctx.resetText?.();
          ctx.signal.throwIfAborted();
          const retryId = randomUUID();
          report('model.arguments_retry', {
            spanId: retryId,
            originalSpanId: spanId,
            attempt: 2,
            reason: 'invalid_json',
          });
          try {
            answer = await send(retryId, 2);
            answeredSpanId = retryId;
          } catch (retryError) {
            ctx.resetText?.();
            ctx.signal.throwIfAborted();
            throw new DiagnosticFailure(
              classified(retryError, ctx.signal),
              `Messages 工具参数无效，已重取一次当前轮，仍未完成：${safeText(retryError)}。本轮未执行工具；已保存内容保留，可在同一会话继续。`,
              { cause: retryError },
            );
          }
        }
        ctx.signal.throwIfAborted();
        const badBatch =
          answer.calls.length > 16 ||
          new Set(answer.calls.map((c) => c.id)).size !== answer.calls.length;
        if (badBatch && answer.calls.length > 32)
          report('tool.batch_rejected', {
            count: answer.calls.length,
            omitted: answer.calls.length - 32,
            reason: 'invalid_call',
          });
        for (const call of badBatch ? answer.calls.slice(0, 32) : answer.calls) {
          const tool = registered.get(call.name);
          const context = diagnosticScope(report, { callId: randomUUID(), spanId: answeredSpanId });
          const candidate: Candidate = {
            context,
            report: (event, fields) => context(event, { tool: tool?.name ?? 'unknown', ...fields }),
          };
          let args: JsonObject = {};
          try {
            args = parseArgs(call.args);
            candidate.fieldCount = Object.keys(args).length;
          } catch (error) {
            candidate.parseFailure =
              error instanceof DiagnosticFailure ? error.diagnosticReason : 'invalid_json';
          }
          const properties = tool?.schema.properties;
          candidate.report('tool.requested', {
            fieldCount: candidate.fieldCount,
            unknownFieldCount:
              candidate.fieldCount !== undefined && properties && typeof properties === 'object'
                ? Object.keys(args).filter((field) => !Object.hasOwn(properties, field)).length
                : undefined,
          });
          if (badBatch) reject(candidate, 'invalid_call');
          else if (!tool) reject(candidate, 'unknown_tool');
          else if (candidate.parseFailure) reject(candidate, candidate.parseFailure);
          round.candidates.set(call.id, candidate);
          if (!badBatch)
            base.content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: args });
        }
        if (badBatch) throw new DiagnosticFailure('invalid_call', '工具调用 ID 重复或数量超限');
        round.answer = answer;
        finalAnswer = answer;
        if (answer.text) base.content.unshift({ type: 'text', text: answer.text });
        base.stopReason = answer.calls.length ? 'toolUse' : 'stop';
      } catch (e) {
        round.failure = classified(e, ctx.signal);
        base.stopReason = ctx.signal.aborted ? 'aborted' : 'error';
        base.errorMessage = safeText(e);
      } finally {
        feed.end(base);
      }
    })();
    return feed;
  };
  const message: UserMessage = { role: 'user', content: prompt, timestamp: Date.now() };
  let result: Awaited<ReturnType<typeof runAgentLoop>>;
  try {
    result = await runAgentLoop(
      [message],
      { messages: [], tools: wrapped },
      {
        model,
        toolExecution: 'sequential',
        convertToLlm: (messages) => messages,
        async beforeToolCall({ toolCall }) {
          if (receiptFailure) return { block: true, reason: '回执未保存；本轮不再执行工具' };
          const candidate = active?.candidates.get(toolCall.id);
          if (candidate?.parseFailure) return { block: true, reason: '工具参数不是完整的 JSON 对象' };
          if (!ctx.signal.aborted)
            candidate?.report('tool.validated', { fieldCount: candidate.fieldCount });
        },
        finishTurn({ message, toolResults }) {
          const results: Extract<Turn, { role: 'tool' }>[] = [];
          for (const tool of toolResults) {
            const text = tool.content.find((block) => block.type === 'text')?.text ?? '';
            let detail: ToolResult;
            try {
              detail = JSON.parse(text) as ToolResult;
              if (typeof detail.ok !== 'boolean') throw new Error();
            } catch {
              detail = { ok: !tool.isError, ...(tool.isError ? { error: text } : { value: text }) };
            }
            results.push({ role: 'tool', id: tool.toolCallId, result: detail });
            const candidate = active?.candidates.get(tool.toolCallId);
            if (candidate) {
              if (!candidate.executed)
                reject(candidate, ctx.signal.aborted ? 'cancelled' : 'invalid_arguments');
              candidate.report('tool.result_ready', { outcome: detail.ok ? 'ok' : 'failed' });
              outbound.push({ candidate, result: detail, tool: registered.get(tool.toolName) });
            }
          }
          if (ctx.signal.aborted || message.stopReason === 'aborted') {
            for (const candidate of active?.candidates.values() ?? []) reject(candidate, 'cancelled');
            finish('cancelled', 'cancelled', toolResults.length);
          } else if (message.stopReason === 'error') {
            failure = active?.failure ?? 'provider_error';
            finish('failed', failure);
          } else if (receiptFailure) {
            finish('failed', 'io_failure', toolResults.length);
            return { action: 'end' };
          } else if (rounds >= roundLimit() && toolResults.length) {
            finish('failed', 'iteration_limit', toolResults.length);
            return { action: 'end' };
          } else {
            try {
              if (active?.answer) context.append(active.answer, results, active.receipts);
            } catch (error) {
              projectionFailure = error instanceof DiagnosticFailure ? error : contextOverflow();
              finish('failed', projectionFailure.diagnosticReason, toolResults.length);
              return { action: 'end' };
            }
            finish('ok', toolResults.length ? 'continue_tools' : 'complete', toolResults.length);
          }
        },
      },
      async (event) => {
        if (
          event.type === 'message_end' &&
          event.message.role === 'assistant' &&
          event.message.stopReason !== 'error' &&
          event.message.stopReason !== 'aborted'
        ) {
          const text = event.message.content
            .flatMap((c) => (c.type === 'text' ? [c.text] : []))
            .join('');
          if (text) await ctx.line({ role: 'assistant', text });
        }
        if (event.type === 'tool_execution_start')
          await ctx.line({ role: 'tool', text: `运行 ${event.toolName}` });
        if (event.type === 'tool_execution_end')
          await ctx.line({
            role: 'tool',
            text: `${event.toolName} · ${event.isError ? '未完成' : '已完成'}`,
          });
      },
      ctx.signal,
      stream,
    );
  } catch (error) {
    const reason = classified(error, ctx.signal);
    for (const candidate of active?.candidates.values() ?? []) reject(candidate, reason);
    finish(reason === 'cancelled' ? 'cancelled' : 'failed', reason);
    throw error;
  }
  ctx.signal.throwIfAborted();
  if (receiptFailure)
    throw new DiagnosticFailure('io_failure', '工具可能已执行，但回执无法保存；请先核对已落盘的文件');
  if (projectionFailure) throw projectionFailure;
  const last = [...result].reverse().find((message) => message.role === 'assistant');
  if (last?.stopReason === 'error')
    throw new DiagnosticFailure(failure ?? 'provider_error', last.errorMessage ?? '模型请求失败');
  if (last?.stopReason === 'toolUse' && rounds >= roundLimit())
    throw new DiagnosticFailure('iteration_limit', '已达到模型往返上限；已提交的文件仍保留');
  return finalAnswer ? [...history, finalAnswer] : history;
}
