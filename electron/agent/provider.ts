import type { Effort, ModelProfile } from '../../shared/contracts.js';
import type { AssistantTurn, ModelProvider, ModelRequest, ToolCall, ToolSpec } from './model.js';
import { sse } from './sse.js';

const operation = { chat: '/chat/completions', responses: '/responses', messages: '/messages' } as const;
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'network' | 'protocol' | 'timeout' = 'protocol',
  ) {
    super(message);
  }
}
const error = (message: string) => new ProviderError(message);
function reply(text: string, calls: ToolCall[], native?: unknown): AssistantTurn {
  return { role: 'assistant', text, calls, native };
}
function failStatus(status: number) {
  if (status === 401 || status === 403)
    return new ProviderError(`HTTP ${status}：鉴权失败，请核对 API Key 与访问权限`, 'auth');
  return error(`HTTP ${status}：接口未接受请求，请核对地址、模型 ID 与协议`);
}
function assertCalls(calls: ToolCall[]) {
  for (const call of calls)
    if (
      !call.id ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(call.name) ||
      typeof call.args !== 'string' ||
      call.args.length > 300_000
    )
      throw error('模型返回了无效或不完整的工具调用');
}
function settings(profile: ModelProfile, effort: Effort) {
  const name = profile.model.toLowerCase();
  if (profile.protocol === 'chat' && /^deepseek-v4-(flash|pro)$/.test(name) && effort === 'high')
    return { used: effort, fields: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } };
  if (profile.protocol === 'messages' && /^claude-(opus-4-[678]|sonnet-4-6)(?:-|$)/.test(name))
    return { used: effort, fields: { thinking: { type: 'adaptive' }, output_config: { effort } } };
  if (
    profile.protocol !== 'messages' &&
    /^(gpt-5(?:$|[.\-])|o[134](?:$|-))/.test(name) &&
    !/chat-latest|pro|nano/.test(name)
  )
    return {
      used: effort,
      fields:
        profile.protocol === 'responses'
          ? { reasoning: { effort }, include: ['reasoning.encrypted_content'] }
          : { reasoning_effort: effort },
    };
  return { used: 'default' as const, fields: {} };
}
function toolDefinitions(tools: ToolSpec[], protocol: ModelProfile['protocol']) {
  return tools.map(({ name, description, schema }) =>
    protocol === 'messages'
      ? { name, description, input_schema: schema }
      : protocol === 'responses'
        ? { type: 'function', name, description, parameters: schema, strict: false }
        : { type: 'function', function: { name, description, parameters: schema } },
  );
}
function chatBody(request: ModelRequest, profile: ModelProfile) {
  const messages: unknown[] = [{ role: 'system', content: request.system }];
  for (const turn of request.history) {
    if (turn.role === 'user') messages.push({ role: 'user', content: turn.text });
    if (turn.role === 'assistant')
      messages.push({
        role: 'assistant',
        content: turn.text || (turn.calls.length ? null : ''),
        ...(turn.calls.length
          ? {
              tool_calls: turn.calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.args },
              })),
            }
          : {}),
        ...(typeof turn.native === 'string' ? { reasoning_content: turn.native } : {}),
      });
    if (turn.role === 'tool')
      messages.push({ role: 'tool', tool_call_id: turn.id, content: JSON.stringify(turn.result) });
  }
  const tokenField = /^(o[134](?:-|$)|gpt-5)/.test(profile.model)
    ? 'max_completion_tokens'
    : 'max_tokens';
  return { messages, [tokenField]: request.maxTokens ?? 8192 };
}
function responsesBody(request: ModelRequest) {
  const input: unknown[] = [];
  for (const turn of request.history) {
    if (turn.role === 'user') input.push({ role: 'user', content: turn.text });
    if (turn.role === 'tool')
      input.push({
        type: 'function_call_output',
        call_id: turn.id,
        output: JSON.stringify(turn.result),
      });
    if (turn.role === 'assistant') {
      if (Array.isArray(turn.native)) input.push(...turn.native);
      else {
        if (turn.text) input.push({ role: 'assistant', content: turn.text });
        for (const call of turn.calls)
          input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.args });
      }
    }
  }
  return {
    input,
    instructions: request.system,
    store: false,
    max_output_tokens: request.maxTokens ?? 8192,
  };
}
function messagesBody(request: ModelRequest) {
  type Row = { role: 'user' | 'assistant'; content: Array<Record<string, unknown>> };
  const messages: Row[] = [];
  const add = (role: Row['role'], ...content: Row['content']) => {
    if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content);
    else messages.push({ role, content });
  };
  for (const turn of request.history) {
    if (turn.role === 'user') add('user', { type: 'text', text: turn.text });
    if (turn.role === 'tool')
      add('user', {
        type: 'tool_result',
        tool_use_id: turn.id,
        content: JSON.stringify(turn.result),
        is_error: !turn.result.ok,
      });
    if (turn.role === 'assistant') {
      if (Array.isArray(turn.native)) add('assistant', ...turn.native);
      else if (turn.text) add('assistant', { type: 'text', text: turn.text });
    }
  }
  return { messages, system: request.system, max_tokens: request.maxTokens ?? 8192 };
}
type Payload = { label: string; value: any };
async function* stream(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Payload> {
  for await (const frame of sse(body, signal)) {
    if (frame.data.trim() === '[DONE]') break;
    let value: any;
    try {
      value = JSON.parse(frame.data);
    } catch {
      throw error('模型返回无法解析的流式数据');
    }
    if (value?.error || value?.type === 'error' || frame.type === 'error')
      throw error('模型在流式响应中报告错误');
    if (!value || typeof value !== 'object') throw error('模型返回无效流式事件');
    yield { label: value.type ?? frame.type, value };
  }
}
async function parseChat(events: AsyncIterable<Payload>, textOut: (delta: string) => void) {
  let text = '',
    reasoning = '',
    stop = '';
  const calls = new Map<number, ToolCall>();
  for await (const { value } of events) {
    const choice = value.choices?.find((c: any) => (c.index ?? 0) === 0);
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      textOut(delta.content);
    }
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const call of delta.tool_calls ?? []) {
      if (!Number.isInteger(call.index) || call.index < 0 || call.index >= 32)
        throw error('工具调用索引无效');
      const current = calls.get(call.index) ?? { id: '', name: '', args: '' };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.args += call.function.arguments;
      calls.set(call.index, current);
    }
    if (typeof choice.finish_reason === 'string') stop = choice.finish_reason;
  }
  if (!['stop', 'tool_calls'].includes(stop))
    throw error(stop === 'length' ? '模型达到输出上限，未提交响应' : '流式回复中断或未正常结束');
  const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (stop === 'tool_calls' && !ordered.length) throw error('模型未传回工具调用');
  assertCalls(ordered);
  return reply(text, ordered, reasoning || undefined);
}
async function parseResponses(events: AsyncIterable<Payload>, textOut: (delta: string) => void) {
  let text = '',
    ended = false;
  let output: any[] = [];
  const interim = new Map<number, any>();
  for await (const { label, value } of events) {
    if (label === 'response.output_text.delta' && typeof value.delta === 'string') {
      text += value.delta;
      textOut(value.delta);
    }
    if (label === 'response.output_item.done' && value.item) interim.set(value.output_index, value.item);
    if (label === 'response.failed' || label === 'response.incomplete' || label === 'response.cancelled')
      throw error('Responses 输出中断或未完成');
    if (label === 'response.completed') {
      ended = true;
      output = Array.isArray(value.response?.output)
        ? value.response.output
        : [...interim].sort(([a], [b]) => a - b).map(([, item]) => item);
      break;
    }
  }
  if (!ended) throw error('Responses 流缺少完成事件');
  const calls = output
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({ id: item.call_id, name: item.name, args: item.arguments }));
  assertCalls(calls);
  if (!text) {
    text = output
      .flatMap((item) =>
        item?.type === 'message' && Array.isArray(item.content)
          ? item.content.filter((c: any) => c.type === 'output_text').map((c: any) => c.text)
          : [],
      )
      .join('');
    if (text) textOut(text);
  }
  return reply(
    text,
    calls,
    output.filter((item) => ['function_call', 'message', 'reasoning'].includes(item?.type)),
  );
}
async function parseMessages(events: AsyncIterable<Payload>, textOut: (delta: string) => void) {
  const blocks = new Map<number, any>();
  const json = new Map<number, string>();
  let finish = '',
    closed = false;
  for await (const { label, value } of events) {
    if (label === 'content_block_start') {
      blocks.set(value.index, value.content_block);
      if (value.content_block?.type === 'text' && value.content_block.text)
        textOut(value.content_block.text);
    }
    if (label === 'content_block_delta') {
      const block = blocks.get(value.index);
      if (!block) throw error('Messages 内容块顺序无效');
      const datum = value.delta ?? {};
      if (datum.type === 'text_delta' && typeof datum.text === 'string') {
        block.text = (block.text ?? '') + datum.text;
        textOut(datum.text);
      }
      if (datum.type === 'input_json_delta' && typeof datum.partial_json === 'string')
        json.set(value.index, (json.get(value.index) ?? '') + datum.partial_json);
      if (datum.type === 'thinking_delta')
        block.thinking = (block.thinking ?? '') + (datum.thinking ?? '');
      if (datum.type === 'signature_delta')
        block.signature = (block.signature ?? '') + (datum.signature ?? '');
    }
    if (label === 'message_delta' && value.delta?.stop_reason) finish = value.delta.stop_reason;
    if (label === 'message_stop') {
      closed = true;
      break;
    }
  }
  if (!closed || !['end_turn', 'tool_use', 'stop_sequence'].includes(finish))
    throw error('Messages 输出中断或未完成');
  const ordered = [...blocks].sort(([a], [b]) => a - b);
  const calls: ToolCall[] = [];
  for (const [index, block] of ordered)
    if (block.type === 'tool_use') {
      const args = json.get(index) ?? JSON.stringify(block.input ?? {});
      try {
        block.input = JSON.parse(args);
      } catch {
        throw error('Messages 工具参数不是完整 JSON');
      }
      calls.push({ id: block.id, name: block.name, args });
    }
  assertCalls(calls);
  const native = ordered
    .map(([, block]) => block)
    .filter((block) => ['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(block.type));
  return reply(
    native
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    calls,
    native,
  );
}
export function createProvider(
  profile: ModelProfile,
  key: string,
  effort: Effort = 'high',
  timeoutMs = 120_000,
): ModelProvider {
  const configuration = settings(profile, effort);
  return {
    effort: configuration.used,
    async turn(request) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
      const url = profile.baseUrl + operation[profile.protocol];
      const hdr: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      };
      if (profile.protocol === 'messages') {
        hdr['x-api-key'] = key;
        hdr['anthropic-version'] = '2023-06-01';
      } else hdr.authorization = `Bearer ${key}`;
      const params =
        profile.protocol === 'chat'
          ? chatBody(request, profile)
          : profile.protocol === 'responses'
            ? responsesBody(request)
            : messagesBody(request);
      const body = JSON.stringify({
        ...params,
        model: profile.model,
        stream: true,
        ...configuration.fields,
        ...(request.tools.length ? { tools: toolDefinitions(request.tools, profile.protocol) } : {}),
      });
      let response: Response;
      try {
        response = await fetch(url, { method: 'POST', headers: hdr, redirect: 'error', body, signal });
      } catch {
        request.signal.throwIfAborted();
        throw new ProviderError(
          signal.aborted ? '模型请求超时' : '连接模型失败（网络、证书或重定向）',
          signal.aborted ? 'timeout' : 'network',
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failStatus(response.status);
      }
      if (
        !response.body ||
        !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
      ) {
        await response.body?.cancel().catch(() => {});
        throw error('接口没有返回 SSE 流，请核对协议');
      }
      let pending = '';
      const display = (delta: string, final = false) => {
        pending = (pending + delta).replaceAll(key, '[已隐藏]');
        let tail = 0;
        if (!final)
          for (let i = Math.min(pending.length, key.length - 1); i > 0; i--) {
            if (key.startsWith(pending.slice(-i))) {
              tail = i;
              break;
            }
          }
        const visible = pending.slice(0, pending.length - tail);
        pending = pending.slice(pending.length - tail);
        if (visible) request.onText(visible);
      };
      try {
        const events = stream(response.body, signal);
        const result = await (profile.protocol === 'chat'
          ? parseChat(events, display)
          : profile.protocol === 'responses'
            ? parseResponses(events, display)
            : parseMessages(events, display));
        request.signal.throwIfAborted();
        display('', true);
        if (JSON.stringify(result).includes(key)) throw error('模型返回了受保护的凭据信息，已拒绝写入');
        return result;
      } catch (cause) {
        request.signal.throwIfAborted();
        if (signal.aborted) throw new ProviderError('模型流超时', 'timeout');
        if (cause instanceof ProviderError) throw cause;
        throw error('模型流读取失败或不符合所选协议');
      }
    },
  };
}
export async function checkProvider(profile: ModelProfile, key: string, signal: AbortSignal) {
  const provider = createProvider(profile, key, 'high', 18_000);
  const system = 'You are a connectivity fixture. Follow the request using only fixture values.';
  const request: ModelRequest = {
    system,
    history: [{ role: 'user', text: 'Reply with exactly FW_OK.' }],
    tools: [],
    signal,
    maxTokens: 1024,
    onText: () => {},
  };
  try {
    const initial = await provider.turn(request);
    if (!initial.text.trim()) throw error('模型未返回文本');
  } catch (cause) {
    const e = cause instanceof ProviderError ? cause : error('连接测试未完成');
    return { connection: false, tools: false, issue: e.message, kind: e.kind };
  }
  try {
    const tool: ToolSpec = {
      name: 'fixture_value',
      description: 'Return a synthetic fixture value.',
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    };
    const user = {
      role: 'user' as const,
      text: 'Call the fixture_value tool exactly once. After receiving its result, reply with that value.',
    };
    const first = await provider.turn({ ...request, history: [user], tools: [tool] });
    const call = first.calls[0];
    if (
      first.calls.length !== 1 ||
      call?.name !== tool.name ||
      Object.keys(JSON.parse(call.args)).length !== 0
    )
      throw error('模型未正确调用测试工具');
    const result = await provider.turn({
      ...request,
      tools: [tool],
      history: [user, first, { role: 'tool', id: call.id, result: { ok: true, value: 'FW_TOOL_OK' } }],
    });
    if (!result.text.includes('FW_TOOL_OK') || result.calls.length)
      throw error('模型未返回测试工具结果');
    return { connection: true, tools: true };
  } catch (cause) {
    return {
      connection: true,
      tools: false,
      issue: cause instanceof ProviderError ? cause.message : '工具往返未通过',
    };
  }
}
