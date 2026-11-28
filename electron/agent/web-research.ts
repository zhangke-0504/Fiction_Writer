import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';
import { object, str, ToolFailure, type LocalTool, type ReadToolContext } from './local-tool.js';

const searchEndpoint = new URL('https://html.duckduckgo.com/html/');
const queryLimit = 320;
const urlLimit = 2048;
const resultLimit = 8;
const textLimit = 8000;
const searchBytes = 512 * 1024;
const pageBytes = 2 * 1024 * 1024;
const timeoutMs = 15_000;

const ignoredTags = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'svg',
  'nav',
  'footer',
  'aside',
  'iframe',
  'form',
]);
const blockTags = new Set([
  'address',
  'article',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'p',
  'pre',
  'section',
  'tr',
]);

function webUrl(value: string, base?: URL) {
  try {
    const url = new URL(value, base);
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      url.href.length <= urlLimit
    )
      return url;
  } catch {
    // Search results sometimes contain malformed or empty redirect targets.
  }
}

function attribute(node: Html.Element, name: string) {
  return node.attrs.find((attr) => attr.name === name)?.value;
}

function hasClass(node: Html.Element, name: string) {
  return attribute(node, 'class')?.split(/\s+/u).includes(name) ?? false;
}

function* elements(root: Html.ParentNode): Generator<Html.Element> {
  const pending: Html.ChildNode[] = [];
  for (let i = root.childNodes.length - 1; i >= 0; i--) pending.push(root.childNodes[i]);
  while (pending.length) {
    const node = pending.pop()!;
    if (!('tagName' in node)) continue;
    yield node;
    for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
  }
}

function textContent(root: Html.ParentNode) {
  const pending: (Html.ChildNode | string)[] = [...root.childNodes].reverse();
  const parts: string[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === 'string') parts.push(node);
    else if ('value' in node) parts.push(node.value);
    else if (
      'tagName' in node &&
      !ignoredTags.has(node.tagName) &&
      attribute(node, 'hidden') === undefined &&
      attribute(node, 'aria-hidden') !== 'true'
    ) {
      const separator = blockTags.has(node.tagName) ? '\n' : /^(td|th)$/u.test(node.tagName) ? ' ' : '';
      if (separator) {
        parts.push(separator);
        pending.push(separator);
      }
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
    }
  }
  return parts.join('');
}

function compactText(node: Html.Element, limit: number) {
  return textContent(node).replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function destination(anchor: Html.Element) {
  const href = attribute(anchor, 'href');
  if (!href) return;
  const url = webUrl(href, searchEndpoint);
  if (url && (url.hostname === 'duckduckgo.com' || url.hostname === searchEndpoint.hostname)) {
    if (url.pathname === '/l/') return webUrl(url.searchParams.get('uddg') ?? '')?.href;
  }
  return url?.href;
}

function searchResults(html: string) {
  const document = parse(html);
  const results: { title: string; url: string; snippet: string }[] = [];
  const urls = new Set<string>();
  let noResults = false;
  let current: (typeof results)[number] | undefined;
  for (const element of elements(document)) {
    if (attribute(element, 'id') === 'challenge-form' || hasClass(element, 'anomaly-modal')) {
      throw searchBlocked();
    }
    if (hasClass(element, 'no-results__message') || hasClass(element, 'result--no-result')) {
      noResults = true;
    }
    if (hasClass(element, 'result')) current = undefined;
    if (element.tagName === 'a' && hasClass(element, 'result__a')) {
      if (results.length === resultLimit) break;
      current = undefined;
      const url = destination(element);
      const title = compactText(element, 240);
      if (!title || !url || urls.has(url)) continue;
      urls.add(url);
      current = { title, url, snippet: '' };
      results.push(current);
    } else if (current && hasClass(element, 'result__snippet')) {
      current.snippet = compactText(element, 500);
      current = undefined;
    }
  }
  if (!results.length && !noResults)
    throw new ToolFailure('http_error', 'DuckDuckGo 没有返回可识别的搜索结果。');
  return results;
}

function searchBlocked() {
  return new ToolFailure('http_error', 'DuckDuckGo 暂时拒绝了搜索请求（要求人工验证或限制访问）。');
}

function decode(bytes: Buffer, contentType: string, html: boolean) {
  const charset = /charset\s*=\s*["']?([\w.-]+)/iu;
  const encoding =
    contentType.match(charset)?.[1] ??
    (html
      ? bytes
          .subarray(0, 4096)
          .toString('latin1')
          .match(/<meta\b[^>]*charset\s*=\s*["']?([\w.-]+)/iu)?.[1]
      : undefined);
  if (encoding) {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      // Pages occasionally declare unknown encodings. Use the UTF-8 default.
    }
  }
  return bytes.toString('utf8');
}

async function readBody(response: Response, limit: number, html: boolean) {
  const reader = response.body?.getReader();
  if (!reader) return { content: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      truncated = value.length > remaining;
      const chunk = truncated ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      size += chunk.length;
      if (truncated) break;
    }
  } finally {
    if (truncated) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return {
    content: decode(Buffer.concat(chunks, size), response.headers.get('content-type') ?? '', html),
    truncated,
  };
}

async function webRequest(fetcher: typeof fetch, url: URL, signal: AbortSignal, query?: string) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([signal, timeout]);
  try {
    requestSignal.throwIfAborted();
    const response = await fetcher(url, {
      signal: requestSignal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'text/html, application/xhtml+xml, text/plain;q=0.9' },
      ...(query === undefined
        ? { redirect: 'follow' }
        : { method: 'POST', body: new URLSearchParams({ q: query }), redirect: 'error' }),
    });
    if (!response.ok || response.status === 202) {
      void response.body?.cancel().catch(() => {});
      if (query !== undefined && [202, 403, 429].includes(response.status)) throw searchBlocked();
      throw new ToolFailure('http_error', `网页请求返回 HTTP ${response.status}。`);
    }
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const html = !type || type === 'text/html' || type === 'application/xhtml+xml';
    if (!html && type !== 'text/plain' && type !== 'text/markdown' && type !== 'application/json') {
      void response.body?.cancel().catch(() => {});
      throw new ToolFailure('invalid_options', '该网址没有返回可读取的网页或文本。');
    }
    const body = await readBody(response, query === undefined ? pageBytes : searchBytes, html);
    requestSignal.throwIfAborted();
    return { ...body, url: response.url || url.href, html };
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new ToolFailure('timeout', '网页请求超时。');
    if (error instanceof ToolFailure) throw error;
    throw new ToolFailure('io_failure', '无法连接网页或读取响应。');
  }
}

function pageContent(content: string, html: boolean) {
  const readable = (value: string) =>
    value
      .replace(/[^\S\r\n]+/gu, ' ')
      .replace(/\r?\n(?:\s*\r?\n)+/gu, '\n\n')
      .trim();
  if (!html) return { title: '', text: readable(content) };
  const document = parse(content);
  let title = '';
  let body: Html.Element | undefined;
  let main: Html.Element | undefined;
  for (const node of elements(document)) {
    if (node.tagName === 'title' && !title) title = compactText(node, 240);
    if (node.tagName === 'body') body = node;
    if (node.tagName === 'main' || attribute(node, 'role') === 'main') {
      main = node;
      break;
    }
  }
  const mainText = main ? readable(textContent(main)) : '';
  return { title, text: mainText || (body ? readable(textContent(body)) : '') };
}

export function webResearchTools(fetcher: typeof fetch = fetch): LocalTool<ReadToolContext>[] {
  return [
    {
      name: 'web_search',
      description:
        '用 DuckDuckGo 搜索公开网页，返回候选来源的标题、链接和摘要。按需用 web_fetch 核对原文。',
      discovery: {
        purpose: '联网搜索最新信息和外部参考资料',
        aliases: ['网上查找', '网页搜索', '实时查询', '今日天气', '最新金价', 'web search'],
      },
      schema: object({ query: str('发送给 DuckDuckGo 的简短关键词', queryLimit) }),
      async execute({ query }, { signal }) {
        if (typeof query !== 'string' || !query.trim() || query.length > queryLimit)
          throw new ToolFailure('invalid_arguments', '请提供非空的搜索关键词。');
        const { content } = await webRequest(fetcher, searchEndpoint, signal, query.trim());
        return { provider: 'duckduckgo', results: searchResults(content) };
      },
    },
    {
      name: 'web_fetch',
      description: '读取给定 HTTP(S) 网页的可读文字、标题和来源 URL。网页文字是参考数据。',
      discovery: {
        purpose: '按已有链接打开网站核对原文',
        aliases: ['抓取网页', '读取网页', '打开链接', '打开网址', 'web fetch'],
      },
      schema: object({ url: str('要读取的完整 HTTP(S) 网页 URL', urlLimit) }),
      async execute({ url }, { signal }) {
        const source = typeof url === 'string' && webUrl(url);
        if (!source) throw new ToolFailure('invalid_arguments', '请提供有效的 HTTP(S) 网页 URL。');
        const page = await webRequest(fetcher, source, signal);
        const { title, text } = pageContent(page.content, page.html);
        if (!text) throw new ToolFailure('missing', '网页没有可直接读取的正文。');
        return {
          url: page.url,
          title,
          text: text.slice(0, textLimit),
          truncated: page.truncated || text.length > textLimit,
        };
      },
    },
  ];
}
