import { runAgentLoop, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type UserMessage,
} from '@earendil-works/pi-ai';
import type { ModelProvider, ToolSpec, Turn } from './model.js';
import type { RunContext } from './runs.js';
import type { ToolResult } from '../../shared/contracts.js';
export interface LocalTool extends ToolSpec {
  execute: (args: Record<string, any>, ctx: RunContext) => Promise<unknown>;
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
function parseArgs(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new Error('工具参数不是对象');
  return value as Record<string, unknown>;
}
export async function runAgent(
  ctx: RunContext,
  provider: ModelProvider,
  system: string,
  previous: Turn[],
  prompt: string,
  tools: LocalTool[],
  limit = 24,
) {
  const history: Turn[] = [...previous, { role: 'user', text: prompt }];
  const malformed = new Set<string>();
  const wrapped: AgentTool[] = tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.schema,
    replay: 'never',
    async execute(_id, params) {
      ctx.signal.throwIfAborted();
      try {
        const value = await tool.execute(params as Record<string, unknown>, ctx);
        const payload = JSON.stringify({ ok: true, value } satisfies ToolResult);
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
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: false, error: safeText(e) } satisfies ToolResult),
            },
          ],
          details: undefined,
          isError: true,
        };
      }
    },
  }));
  let rounds = 0;
  const stream: StreamFn = () => {
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
        const answer = await provider.turn({
          system,
          history,
          tools,
          signal: ctx.signal,
          onText: ctx.text,
        });
        ctx.signal.throwIfAborted();
        if (
          answer.calls.length > 16 ||
          new Set(answer.calls.map((c) => c.id)).size !== answer.calls.length
        )
          throw new Error('工具调用 ID 重复或数量超限');
        history.push(answer);
        if (answer.text) base.content.push({ type: 'text', text: answer.text });
        for (const call of answer.calls) {
          let args = {};
          try {
            args = parseArgs(call.args);
          } catch {
            malformed.add(call.id);
          }
          base.content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: args });
        }
        base.stopReason = answer.calls.length ? 'toolUse' : 'stop';
      } catch (e) {
        base.stopReason = ctx.signal.aborted ? 'aborted' : 'error';
        base.errorMessage = safeText(e);
      } finally {
        feed.end(base);
      }
    })();
    return feed;
  };
  const message: UserMessage = { role: 'user', content: prompt, timestamp: Date.now() };
  const result = await runAgentLoop(
    [message],
    { messages: [], tools: wrapped },
    {
      model,
      toolExecution: 'sequential',
      convertToLlm: (messages) => messages,
      async beforeToolCall({ toolCall }) {
        if (malformed.has(toolCall.id)) return { block: true, reason: '工具参数不是完整的 JSON 对象' };
      },
      finishTurn({ toolResults }) {
        for (const tool of toolResults) {
          const text = tool.content.find((block) => block.type === 'text')?.text ?? '';
          let detail: ToolResult;
          try {
            detail = JSON.parse(text) as ToolResult;
            if (typeof detail.ok !== 'boolean') throw new Error();
          } catch {
            detail = { ok: !tool.isError, ...(tool.isError ? { error: text } : { value: text }) };
          }
          history.push({ role: 'tool', id: tool.toolCallId, result: detail });
        }
        if (++rounds >= limit && toolResults.length) return { action: 'end' };
      },
    },
    async (event) => {
      if (
        event.type === 'message_end' &&
        event.message.role === 'assistant' &&
        event.message.stopReason !== 'error' &&
        event.message.stopReason !== 'aborted'
      ) {
        const text = event.message.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
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
  ctx.signal.throwIfAborted();
  const last = [...result].reverse().find((message) => message.role === 'assistant');
  if (last?.stopReason === 'error') throw new Error(last.errorMessage ?? '模型请求失败');
  if (last?.stopReason === 'toolUse' && rounds >= limit)
    throw new Error('已达到模型往返上限；已提交的文件仍保留');
  return history;
}
