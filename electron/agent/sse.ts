export class ModelStreamReadError extends Error {}

export async function* sse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ type: string; data: string }> {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    type = '',
    lines: string[] = [],
    count = 0;
  function parseLine(line: string) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      const event = { type, data: lines.join('\n') };
      type = '';
      lines = [];
      return event.data ? event : undefined;
    }
    const colon = line.indexOf(':'),
      field = colon < 0 ? line : line.slice(0, colon),
      value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') type = value;
    else if (field === 'data') lines.push(value);
    return undefined;
  }
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      signal.throwIfAborted();
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        signal.throwIfAborted();
        throw new ModelStreamReadError('模型流读取失败', { cause });
      }
      const { value, done } = chunk;
      signal.throwIfAborted();
      if (value) {
        count += value.byteLength;
        if (count > 8_000_000) throw new Error('模型流超过处理上限');
      }
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const event = parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event) yield event;
      }
      if (done) {
        if (buffer) parseLine(buffer);
        const last = parseLine('');
        if (last) yield last;
        break;
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
