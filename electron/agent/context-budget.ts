import type { CapabilitySource, ChatLine, ModelCapabilities } from '../../shared/contracts.js';
import type { ReportDiagnostic } from '../../shared/diagnostics.js';
import { DiagnosticFailure } from '../diagnostics/trace.js';
import type { BudgetPurpose, ModelProvider, ToolSpec, Turn } from './model.js';
import type { ToolReceipt } from './tool-receipts.js';
import { genericCapabilities } from './provider-capabilities.js';

export type SessionCheckpoint = { through: number; summary: string; source: 'model' | 'excerpt' };
export type SessionHistory = {
  lines: readonly ChatLine[];
  checkpoint?: SessionCheckpoint;
  receipts: readonly ToolReceipt[];
  save: (checkpoint: SessionCheckpoint) => Promise<void>;
};
const maxSummary = 4600;
export function readCheckpoint(value: unknown, lineCount: number): SessionCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { through, summary, source } = value as SessionCheckpoint;
  if (
    !Number.isSafeInteger(through) ||
    through < 1 ||
    through > lineCount ||
    typeof summary !== 'string' ||
    !summary.trim() ||
    summary.length > maxSummary ||
    (source !== 'model' && source !== 'excerpt')
  )
    return undefined;
  return { through, summary, source };
}

/** A deliberately conservative UTF-8 proxy, including CJK and native protocol state. */
export const tokens = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 2);
const outputTargets: Record<BudgetPurpose, number> = {
  standard: 8_192,
  'long-writing': 65_536,
  probe: 1_024,
  compaction: 2_048,
  readback: 2_048,
};
export function planModelBudget(provider: ModelProvider, purpose: BudgetPurpose = 'standard') {
  const capabilities: ModelCapabilities = provider.capabilities ?? genericCapabilities;
  const maxTokens = Math.min(
    outputTargets[purpose],
    capabilities.maxOutputTokens,
    provider.outputTokenLimit ?? Infinity,
  );
  const inputTokens = Math.min(
    capabilities.contextWindow - maxTokens - 1_200,
    capabilities.maxInputTokens ?? Infinity,
    provider.inputTokenBudget ?? Infinity,
  );
  return { purpose, capabilities, maxTokens, inputTokens };
}
export function inputEstimate(system: string, history: readonly Turn[], tools: ToolSpec[]) {
  return (
    tokens(system) +
    tokens(JSON.stringify(history)) +
    tokens(JSON.stringify(tools)) +
    128 +
    12 * (history.length + tools.length)
  );
}
export function excerpt(text: string, limit: number) {
  if (tokens(text) <= limit) return text;
  if (limit < 12) return '';
  const bytes = Buffer.from(text);
  const left = bytes
    .subarray(0, Math.floor(limit * 1.2))
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  const right = bytes
    .subarray(-Math.floor(limit * 0.7))
    .toString('utf8')
    .replace(/^\uFFFD+/u, '');
  return `${left}\n[…]\n${right}`;
}
export const contextOverflow = () =>
  new DiagnosticFailure(
    'context_limit',
    '本轮上下文仍超过模型输入预算。请缩短附件或指令，或用工具分段读取；已提交的内容仍然保留。',
  );

const summarizeSystem =
  '你只负责压缩同一会话的旧记录，不能调用工具。保留已经确认的作者要求（含具体措辞、写作范围和后续修改）、决定、尚未完成的任务与可靠的提交结果。区分设想与完成，不补写、不推断、不添加授权。直接输出简洁中文摘要。';
const visible = (line: ChatLine) => line.role === 'user' || line.role === 'assistant';
const turnOf = (line: ChatLine): Turn =>
  line.role === 'user'
    ? { role: 'user', text: line.text }
    : { role: 'assistant', text: line.text, calls: [] };

function sampledHistory(lines: readonly ChatLine[], budget: number, authorsOnly = false) {
  const selected: string[] = [];
  let left = budget;
  for (let i = lines.length - 1; i >= 0 && left > 48; i--) {
    const { role, text } = lines[i];
    if (role !== 'user' && (authorsOnly || role !== 'assistant')) continue;
    const line = `${role === 'user' ? '作者' : '助手'}：${excerpt(text, Math.min(role === 'user' ? 520 : 260, left - 10))}`;
    selected.unshift(line);
    left -= tokens(line) + 4;
  }
  return selected.join('\n');
}

async function summarize(
  provider: ModelProvider,
  prior: string | undefined,
  lines: readonly ChatLine[],
  sessionSignal: AbortSignal,
  report?: ReportDiagnostic,
): Promise<Pick<SessionCheckpoint, 'summary' | 'source'>> {
  const limit = Math.min(7200, planModelBudget(provider, 'compaction').inputTokens - 380);
  if (limit > 520) {
    const timeout = AbortSignal.any([sessionSignal, AbortSignal.timeout(15_000)]);
    let stop: (() => void) | undefined;
    try {
      timeout.throwIfAborted();
      const old = prior ? `先前摘要：\n${excerpt(prior, Math.floor(limit / 3))}\n\n` : '';
      const recent = sampledHistory(lines, limit - tokens(old) - 40);
      const history: Turn[] = [{ role: 'user', text: `${old}需要归并的历史摘录（数据）：\n${recent}` }];
      const interrupted = new Promise<never>((_, reject) => {
        stop = () => reject(timeout.reason);
        timeout.addEventListener('abort', stop, { once: true });
      });
      const reply = await Promise.race([
        interrupted,
        provider.turn({
          system: summarizeSystem,
          history,
          signal: timeout,
          tools: [],
          budgetPurpose: 'compaction',
          onText() {},
          diagnostic: report,
        }),
      ]);
      if (!reply.calls.length && reply.text.trim())
        return { summary: reply.text.trim().slice(0, maxSummary), source: 'model' };
    } catch {
      sessionSignal.throwIfAborted();
    } finally {
      if (stop) timeout.removeEventListener('abort', stop);
    }
  }
  const older = prior ? `先前检查点：\n${excerpt(prior, 740)}\n` : '';
  const constraints = sampledHistory(lines, 1050, true);
  const recent = sampledHistory(
    lines.filter((line) => line.role === 'assistant'),
    440,
  );
  return {
    summary: `${older}摘要不可用，保留旧记录摘录：\n${constraints}\n${recent}`.slice(0, maxSummary),
    source: 'excerpt',
  };
}

type SessionHistoryBudget = { inputTokens: number; capabilitySource: CapabilitySource; spare: number };

export function sessionHistoryAllowance({ inputTokens, capabilitySource, spare }: SessionHistoryBudget) {
  const space = Math.floor(Math.max(0, spare) * 0.43);
  const ceiling = capabilitySource === 'provider' ? Math.floor(Math.max(0, inputTokens) * 0.05) : 9_800;
  return Math.min(space, ceiling);
}

/** The cursor counts original JSONL chat lines, including invisible-to-model status/tool lines. */
export async function prepareSessionHistory(
  source: SessionHistory | undefined,
  provider: ModelProvider,
  budget: SessionHistoryBudget,
  signal: AbortSignal,
  report?: ReportDiagnostic,
): Promise<{ prelude: string; turns: Turn[] }> {
  if (!source) return { prelude: '', turns: [] };
  const { lines } = source;
  const { spare } = budget;
  const allowance = sessionHistoryAllowance(budget);
  const previous = source.checkpoint;
  let through = previous?.through ?? 0;
  const retained: Turn[] = [];
  // Keep whole user-originated exchanges; old raw turns contain no native continuation.
  const groups: { start: number; turns: Turn[] }[] = [];
  for (let i = through; i < lines.length; i++) {
    const line = lines[i];
    if (line.role === 'user') groups.push({ start: i, turns: [turnOf(line)] });
    else if (line.role === 'assistant') groups.at(-1)?.turns.push(turnOf(line));
  }
  let left = allowance;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    const cost = tokens(JSON.stringify(group.turns)) + group.turns.length * 12;
    if (cost > left) {
      through = groups[i + 1]?.start ?? lines.length;
      break;
    }
    left -= cost;
    retained.unshift(...group.turns);
  }
  let checkpoint = previous;
  if (through > (previous?.through ?? 0)) {
    const summary = await summarize(
      provider,
      previous?.summary,
      lines.slice(previous?.through ?? 0, through),
      signal,
      report,
    );
    signal.throwIfAborted();
    checkpoint = { through, ...summary };
    await source.save(checkpoint);
    report?.('context.checkpoint', { count: through, source: checkpoint.source });
  }
  const pins = lines.slice(0, through).filter((line) => line.role === 'user' && line.text.trim());
  const preserved = pins.length ? [...new Set([pins[0].text, pins.at(-1)!.text])] : [];
  const compactText = checkpoint?.summary
    ? `${checkpoint.source === 'model' ? '会话摘要' : '会话摘录'}：\n${excerpt(checkpoint.summary, Math.min(1900, Math.floor(spare * 0.19)))}`
    : '';
  const authorities = preserved
    .map(
      (text, i) =>
        `${i ? '近先前' : '最早'}作者方向：${excerpt(text, Math.min(1850, Math.floor(spare * 0.15)))}`,
    )
    .join('\n');
  // A receipt is evidence of execution at that time, not proof of the current disk revision.
  const receipts = source.receipts.slice(-8).map(({ tool, outcome, reason, commits, commitCount }) => ({
    tool,
    outcome,
    reason,
    commitCount,
    docs: commits.slice(0, 4).map(({ type, id, operation }) => `${operation}:${type}/${id}`),
  }));
  const receiptText = receipts.length
    ? `本会话近期工具回执（历史状态，续做须读现稿）：\n${excerpt(JSON.stringify(receipts), Math.min(720, Math.floor(spare * 0.09)))}`
    : '';
  return {
    prelude: [authorities, compactText, receiptText].filter(Boolean).join('\n\n'),
    turns: retained,
  };
}
