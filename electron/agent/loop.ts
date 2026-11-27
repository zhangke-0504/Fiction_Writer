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
import type { AssistantTurn, ModelProvider, ModelRequest, Turn } from './model.js';
import { ToolFailure, type LocalTool, type ReadToolContext } from './local-tool.js';
import { ChatOutputLimit, MalformedMessagesArguments, MessagesOutputLimit } from './provider.js';
import type { RunContext } from './runs.js';
import type { ToolResult } from '../../shared/contracts.js';
import { ActiveContext } from './active-context.js';
import { discoverTools } from './tool-discovery.js';
import {
  contextOverflow,
  inputEstimate,
  planModelBudget,
  prepareSessionHistory,
  tokens,
} from './context-budget.js';
import {
  callRef,
  commitReceiptLimit,
  observedCommit,
  receiptReason,
  type ToolReceipt,
} from './tool-receipts.js';

export { object, str, ToolFailure, type LocalTool } from './local-tool.js';
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
  notDispatched?: boolean;
  rejected?: boolean;
  executed?: boolean;
  observeDispatch?: (report: ReportDiagnostic, result: ToolResult) => void;
}
interface Round {
  number: number;
  answer?: AssistantTurn;
  receipts: ToolReceipt[];
  narrowStep?: NarrowedWritingStep;
  narrowSpanId?: string;
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
export interface NarrowedWritingStep {
  readonly complete: boolean;
  readonly canAdvance: boolean;
  readonly status: string;
  readonly instructions: string;
  readonly toolNames?: readonly string[];
  accepts(name: string, args: Record<string, unknown>): boolean;
}
interface AgentBudget {
  roundLimit: () => number;
  budgetPurpose: () => ModelRequest['budgetPurpose'];
  qualifiesForWholeGuideBudget?: () => boolean;
  narrowedWritingStep?: (
    ctx: RunContext,
    prospective?: readonly ToolResult[],
  ) => Promise<NarrowedWritingStep | undefined>;
}
type Discovery = { bootstrap?: string[] };
interface TaskLoopOptions {
  beforeRequest: () => void;
  finished: () => boolean;
}

export async function runAgent(
  ctx: RunContext,
  provider: ModelProvider,
  system: string,
  previous: Turn[],
  prompt: string,
  tools: LocalTool[],
  budget: number | AgentBudget = defaultRoundLimit,
  discovery?: Discovery,
) {
  return runLoop(ctx, provider, system, previous, prompt, tools, {
    runId: ctx.id,
    parent: ctx,
    budget,
    discovery,
  });
}

export async function runTaskAgent(
  ctx: ReadToolContext,
  runId: string,
  provider: ModelProvider,
  system: string,
  prompt: string,
  tools: LocalTool<ReadToolContext>[],
  task: TaskLoopOptions,
  bootstrap: string[] = [],
) {
  const {
    signal,
    diagnostic,
    session: { cwd, bookId },
  } = ctx;
  await runLoop({ session: { cwd, bookId }, signal, diagnostic }, provider, system, [], prompt, tools, {
    runId,
    budget: Infinity,
    task,
    discovery: { bootstrap },
  });
}

async function runLoop<Context extends ReadToolContext>(
  ctx: Context,
  provider: ModelProvider,
  system: string,
  previous: Turn[],
  prompt: string,
  tools: LocalTool<Context>[],
  {
    runId,
    parent,
    budget,
    discovery,
    task,
  }: {
    runId: string;
    parent?: RunContext;
    budget: number | AgentBudget;
    discovery?: Discovery;
    task?: TaskLoopOptions;
  },
) {
  const catalog = discovery && discoverTools(tools, discovery.bootstrap);
  const registry = catalog?.registry ?? tools;
  const initialTools = catalog?.visible() ?? tools;
  const trace = diagnosticScope(safeReporter(ctx.diagnostic ?? noDiagnostic), {
    lane: task ? 'task' : 'agent',
  });
  const purpose = () => (typeof budget === 'number' ? undefined : budget.budgetPurpose());
  const { inputTokens, capabilities } = planModelBudget(provider, purpose());
  const spare = inputTokens - inputEstimate(system, [{ role: 'user', text: prompt }], initialTools);
  if (spare < 0) throw contextOverflow();
  const session = await prepareSessionHistory(
    parent?.history,
    provider,
    { inputTokens, capabilitySource: capabilities.source, spare },
    ctx.signal,
    diagnosticScope(trace, { lane: 'compaction' }),
  );
  const context = new ActiveContext(
    system,
    session.prelude,
    [...previous, ...session.turns],
    prompt,
    initialTools,
    provider.textHistoryInPrompt,
  );
  let history: Turn[] = [];
  let finalAnswer: AssistantTurn | undefined;
  let receiptFailure = false;
  let projectionFailure: DiagnosticFailure | undefined;
  let previousCompaction = 0;
  const registered = new Map(registry.map((tool) => [tool.name, tool]));
  const outbound: { id: string; candidate: Candidate; result: ToolResult; tool?: LocalTool<Context> }[] =
    [];
  let narrowed = false;
  let recoveryOrigin: string | undefined;
  const recovery = (
    report: ReportDiagnostic,
    state: string,
    reason?: string,
    original?: string,
    span?: string,
  ) =>
    report('model.output_limit_recovery', {
      recovery: state,
      reason,
      originalSpanId: original,
      spanId: span,
    });
  const stepFor = (prospective?: readonly ToolResult[]) =>
    typeof budget === 'number' || !parent?.session.bookId
      ? undefined
      : budget.narrowedWritingStep?.(parent, prospective);
  const stopped = (why: string, step?: NarrowedWritingStep, reason = 'output_limit') =>
    new DiagnosticFailure(
      reason,
      `${why}。${step ? step.status + '。' : ''}已保存的内容保留，可在同一会话继续。`,
    );
  const narrowNotice = (step: NarrowedWritingStep, maxTokens: number) =>
    [
      '输出触限后的逐项续接：原触限回复及其工具调用未执行。原目标与授权不变，不重复已保存事项。',
      step.complete
        ? '现稿已通过完成核对；只作简短总结，不再调用工具。'
        : `本次只提交一个下列范围内、可独立校验的工具调用。参数须简短（估算不超过 ${Math.floor(maxTokens / 8)} token）；不复述原稿，不提交其他动作。`,
      step.status,
      step.instructions,
    ].join('\n');
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
  const wrapped: AgentTool[] = registry.map((tool) => ({
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
        runId,
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
          ...(parent && {
            narrowedWriting: narrowed,
            onToolResultDispatch(
              observe: Parameters<NonNullable<RunContext['onToolResultDispatch']>>[0],
            ) {
              if (call) call.observeDispatch = observe;
            },
            progress(value: Parameters<RunContext['progress']>[0]) {
              context.setProgress(value);
              parent.progress(value);
            },
          }),
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
          await parent?.recordTool?.(receipt);
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
        ctx.signal.throwIfAborted();
        const activePurpose = purpose();
        const pendingWholeSkill =
          activePurpose !== 'long-writing' &&
          typeof budget !== 'number' &&
          budget.qualifiesForWholeGuideBudget?.()
            ? outbound.find(
                ({ candidate, tool, result }) =>
                  candidate.executed && tool?.isWholeSkillResult?.(result),
              )
            : undefined;
        const budgetPurpose = pendingWholeSkill ? 'long-writing' : activePurpose;
        const planned = planModelBudget(provider, budgetPurpose);
        const visibleTools = catalog?.visible() ?? tools;
        let dispatchedTools = visibleTools;
        const fit = (step?: NarrowedWritingStep) => {
          dispatchedTools = visibleTools;
          // A verified step may need an existing schema the Agent has not discovered yet.
          if (step?.toolNames) {
            const visible = new Set(visibleTools.map(({ name }) => name));
            const needed = new Set(step.toolNames);
            dispatchedTools = [
              ...visibleTools,
              ...tools.filter(({ name }) => needed.has(name) && !visible.has(name)),
            ];
          }
          const wire = context.fit(
            planned.inputTokens,
            pendingWholeSkill,
            step && narrowNotice(step, planned.maxTokens),
            dispatchedTools,
          );
          history = wire.history;
          const stats = context.stats;
          if (stats.removed + stats.reductions !== previousCompaction) {
            previousCompaction = stats.removed + stats.reductions;
            report('context.compacted', { count: stats.removed, omittedCount: stats.reductions });
          }
          return wire;
        };
        const nextReadResults = (wire: ReturnType<typeof fit>) =>
          outbound.flatMap(({ id, tool }) => {
            const result = wire.latest.get(id);
            return tool?.name === 'book_get_context' && result?.ok ? [result] : [];
          });
        const sameStep = (a: NarrowedWritingStep, b: NarrowedWritingStep) =>
          a.complete === b.complete &&
          a.canAdvance === b.canAdvance &&
          a.status === b.status &&
          a.instructions === b.instructions &&
          JSON.stringify(a.toolNames) === JSON.stringify(b.toolNames);
        let wire: ReturnType<typeof fit>;
        if (narrowed) {
          const readsPending = outbound.some(
            ({ tool, result }) => tool?.name === 'book_get_context' && result.ok,
          );
          let step = await stepFor(readsPending ? nextReadResults(fit()) : undefined);
          for (let i = 0; ; i++) {
            ctx.signal.throwIfAborted();
            if (!step || (!step.complete && !step.canAdvance)) {
              recovery(report, 'no_safe_step', 'output_limit', recoveryOrigin);
              throw stopped('已不能安全选出下一项，停止自动续接', step);
            }
            wire = fit(step);
            if (!readsPending) break;
            // Candidate schemas/notice have their own cost. Recheck against what will really be sent.
            const actual = await stepFor(nextReadResults(wire));
            if (actual && sameStep(step, actual)) {
              step = actual;
              break;
            }
            if (i >= 2) throw contextOverflow();
            step = actual;
          }
          round.narrowStep = step;
        } else wire = fit();
        let answeredSpanId = spanId;
        const send = (attemptId: string, attempt: 1 | 2, replan = false) => {
          ctx.signal.throwIfAborted();
          task?.beforeRequest();
          const requestTrace = diagnosticScope(report, {
            spanId: attemptId,
            attempt,
            ...(attempt === 2 && { originalSpanId: spanId }),
          });
          return provider.turn({
            system: wire.system,
            history: wire.history,
            tools: dispatchedTools,
            budgetPurpose,
            budgetBasis: pendingWholeSkill
              ? 'first-whole-skill'
              : activePurpose === 'long-writing'
                ? 'active-whole-skill'
                : undefined,
            signal: ctx.signal,
            onText: parent?.text ?? (() => {}),
            diagnostic: requestTrace,
            spanId: attemptId,
            onDispatch(nextSpanId) {
              if (round.narrowStep) round.narrowSpanId = nextSpanId;
              if (replan) recovery(requestTrace, 'dispatched', 'output_limit', spanId, nextSpanId);
              diagnosticScope(requestTrace, { spanId: nextSpanId })(
                'context.projected',
                wire.projection,
              );
              // A transport handoff, not an acknowledgement or model adoption.
              for (const { id, candidate, result, tool } of outbound.splice(0)) {
                const actual = wire.latest.get(id);
                if (!actual) {
                  candidate.report('tool.result_omitted', {
                    spanId: nextSpanId,
                    reason: 'context_limit',
                  });
                  continue;
                }
                candidate.report('tool.result_sent', {
                  spanId: nextSpanId,
                  nextTurn: number,
                  delivery: actual === result ? 'full' : 'projected',
                });
                const sent = diagnosticScope(candidate.context, { spanId: nextSpanId, turn: number });
                tool?.onResultSent?.(actual, sent);
                if (actual.ok) candidate.observeDispatch?.(sent, actual);
              }
            },
          });
        };
        let answer: AssistantTurn;
        try {
          answer = await send(spanId, 1);
        } catch (error) {
          if (!parent) throw error;
          if (error instanceof MessagesOutputLimit) {
            parent.resetText?.();
            ctx.signal.throwIfAborted();
            if (narrowed) {
              recovery(report, 'repeat_limit', 'output_limit', recoveryOrigin);
              throw stopped('单步续接后再次达到输出上限，未执行该轮工具', round.narrowStep);
            }
            recoveryOrigin = spanId;
            const step = await stepFor();
            ctx.signal.throwIfAborted();
            if (!step || step.complete || !step.canAdvance) {
              recovery(report, step ? 'no_safe_step' : 'ineligible', 'output_limit', spanId);
              throw stopped('模型达到输出上限，未能安全拆出下一项，未执行本轮工具', step);
            }
            try {
              wire = fit(step);
            } catch (fitError) {
              if (classified(fitError) !== 'context_limit') throw fitError;
              recovery(report, 'input_blocked', 'context_limit', spanId);
              throw stopped('模型达到输出上限，续接所需上下文无法装入', step);
            }
            ctx.signal.throwIfAborted();
            narrowed = true;
            round.narrowStep = step;
            const retryId = randomUUID();
            try {
              answer = await send(retryId, 2, true);
              answeredSpanId = retryId;
            } catch (retryError) {
              parent.resetText?.();
              ctx.signal.throwIfAborted();
              recovery(
                report,
                retryError instanceof MessagesOutputLimit ? 'repeat_limit' : 'failed',
                classified(retryError),
                spanId,
                round.narrowSpanId,
              );
              throw stopped(
                retryError instanceof MessagesOutputLimit
                  ? '单步续接仍达到输出上限，未执行本轮工具'
                  : '单步续接未完成，未执行本轮工具',
                step,
                classified(retryError, ctx.signal),
              );
            }
          } else {
            if (!(error instanceof MalformedMessagesArguments)) throw error;
            // Up to this boundary no native reply or tool candidate from this round entered Pi.
            parent.resetText?.();
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
              parent.resetText?.();
              ctx.signal.throwIfAborted();
              if (retryError instanceof MessagesOutputLimit) {
                recovery(report, 'attempt_used', 'output_limit', spanId, retryId);
                throw stopped(
                  '重取坏 JSON 后达到输出上限，本轮已使用额外尝试，未执行本轮工具',
                  round.narrowStep,
                );
              }
              throw new DiagnosticFailure(
                classified(retryError, ctx.signal),
                `Messages 工具参数无效，已重取一次当前轮，仍未完成：${safeText(retryError)}。本轮未执行工具；已保存内容保留，可在同一会话继续。`,
                { cause: retryError },
              );
            }
          }
        }
        ctx.signal.throwIfAborted();
        const dispatchedNames = new Set(dispatchedTools.map(({ name }) => name));
        const step = round.narrowStep;
        if (step) {
          const call = answer.calls[0];
          const valid = step.complete
            ? answer.calls.length === 0 && !!answer.text.trim()
            : answer.calls.length === 1 &&
              !!call &&
              tokens(call.args) <= Math.floor(planned.maxTokens / 8) &&
              (() => {
                try {
                  return step.accepts(call.name, parseArgs(call.args));
                } catch {
                  return false;
                }
              })();
          if (!valid) {
            parent?.resetText?.();
            for (const rejected of answer.calls.slice(0, 16)) {
              diagnosticScope(report, { spanId: answeredSpanId, callId: randomUUID() })(
                'tool.rejected',
                {
                  tool: registered.get(rejected.name)?.name ?? 'unknown',
                  reason: 'invalid_call',
                },
              );
            }
            recovery(report, 'invalid_step', 'invalid_call', recoveryOrigin, answeredSpanId);
            throw stopped('续接响应没有给出一个合法且必要的小动作，未执行本轮工具', step);
          }
        }
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
          else if (!tool || !dispatchedNames.has(call.name)) {
            candidate.notDispatched = true;
            reject(candidate, 'unknown_tool');
          } else if (candidate.parseFailure) reject(candidate, candidate.parseFailure);
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
        round.failure =
          task && !ctx.signal.aborted && e instanceof ChatOutputLimit
            ? 'output_limit'
            : classified(e, ctx.signal);
        if (ctx.signal.aborted && recoveryOrigin)
          recovery(report, 'cancelled', 'cancelled', recoveryOrigin, round.narrowSpanId);
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
          if (task?.finished()) return { block: true, reason: '子任务已结束' };
          if (receiptFailure) return { block: true, reason: '回执未保存；本轮不再执行工具' };
          const candidate = active?.candidates.get(toolCall.id);
          if (candidate?.notDispatched)
            return { block: true, reason: '此能力未在本轮模型请求中出现，请先检索可用工具' };
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
              outbound.push({
                id: tool.toolCallId,
                candidate,
                result: detail,
                tool: registered.get(tool.toolName),
              });
            }
          }
          if (ctx.signal.aborted || message.stopReason === 'aborted') {
            if (active?.narrowStep && message.stopReason !== 'aborted')
              recovery(active.report, 'cancelled', 'cancelled', recoveryOrigin, active.narrowSpanId);
            for (const candidate of active?.candidates.values() ?? []) reject(candidate, 'cancelled');
            finish('cancelled', 'cancelled', toolResults.length);
          } else if (message.stopReason === 'error') {
            failure = active?.failure ?? 'provider_error';
            finish('failed', failure);
          } else if (receiptFailure) {
            finish('failed', 'io_failure', toolResults.length);
            return { action: 'end' };
          } else if (task?.finished()) {
            finish('ok', 'complete', toolResults.length);
            return { action: 'end' };
          } else if (
            active?.narrowStep &&
            toolResults.length &&
            !active.receipts.some(
              (r) =>
                r.outcome === 'ok' &&
                (r.commitCount > 0 || r.tool === 'book_get_context' || r.tool === 'book_task_scope'),
            )
          ) {
            recovery(
              active.report,
              'no_progress',
              results[0]?.result.reason,
              recoveryOrigin,
              active.narrowSpanId,
            );
            projectionFailure = stopped(
              '逐项续接没有取得新的可核对结果',
              active.narrowStep,
              results[0]?.result.reason ?? 'output_limit',
            );
            finish('failed', projectionFailure.diagnosticReason, toolResults.length);
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
            if (active?.narrowStep)
              recovery(
                active.report,
                toolResults.length ? 'advanced' : 'completed',
                undefined,
                recoveryOrigin,
                active.narrowSpanId,
              );
            finish('ok', toolResults.length ? 'continue_tools' : 'complete', toolResults.length);
          }
        },
      },
      async (event) => {
        if (!parent) return;
        if (
          event.type === 'message_end' &&
          event.message.role === 'assistant' &&
          event.message.stopReason !== 'error' &&
          event.message.stopReason !== 'aborted'
        ) {
          const text = event.message.content
            .flatMap((c) => (c.type === 'text' ? [c.text] : []))
            .join('');
          if (text) await parent.line({ role: 'assistant', text });
        }
        if (event.type === 'tool_execution_start')
          await parent.line({ role: 'tool', text: `运行 ${event.toolName}` });
        if (event.type === 'tool_execution_end')
          await parent.line({
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
  } finally {
    for (const { candidate } of outbound.splice(0)) candidate.report('tool.result_omitted');
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
