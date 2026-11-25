import type {
  CapabilityIssue,
  ModelCapabilities,
  ModelProfile,
  ProviderId,
} from '../../shared/contracts.js';

const deepseekOrigin = 'https://api.deepseek.com';
const capabilityIssues = ['not_supported', 'unavailable', 'auth', 'timeout', 'invalid', 'model_missing'];
const validTokenLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function isOfficialDeepSeek(profile: Pick<ModelProfile, 'baseUrl' | 'protocol'>): boolean {
  const base = profile.baseUrl;
  return (profile.protocol === 'messages' ? ['/anthropic', '/anthropic/v1'] : ['', '/v1']).some(
    (path) => base === deepseekOrigin + path,
  );
}

function canonicalDeepSeekModel(profile: ModelProfile) {
  const id = profile.model;
  if (id === 'deepseek-v4-flash' || id === 'deepseek-v4-flash-vision-exp') return 'deepseek-flash';
  if (profile.protocol === 'messages' && id.startsWith('claude'))
    return id.startsWith('claude-opus') ? 'deepseek-v4-pro' : 'deepseek-flash';
  return id;
}

type TokenLimits = Pick<ModelCapabilities, 'contextWindow' | 'maxOutputTokens' | 'maxInputTokens'>;
type Adapter = {
  matches: (profile: ModelProfile) => boolean;
  fallback: (profile: ModelProfile) => TokenLimits | undefined;
  endpoint: string;
  headers: (key: string) => HeadersInit;
  parse: (profile: ModelProfile, payload: unknown) => TokenLimits | 'invalid' | 'model_missing';
};

const capabilityAdapters: Partial<Record<ProviderId, Adapter>> = {
  deepseek: {
    matches: isOfficialDeepSeek,
    fallback: (profile) =>
      ['deepseek-flash', 'deepseek-v4-pro'].includes(canonicalDeepSeekModel(profile))
        ? { contextWindow: 1_048_576, maxOutputTokens: 393_216 }
        : undefined,
    endpoint: `${deepseekOrigin}/models`,
    headers: (key) => ({ authorization: `Bearer ${key}`, accept: 'application/json' }),
    parse: parseDeepSeekLimits,
  },
};

function adapterFor(profile: ModelProfile) {
  const adapter = profile.providerId && capabilityAdapters[profile.providerId];
  return adapter?.matches(profile) ? adapter : undefined;
}

export const canDiscover = (profile: ModelProfile) => adapterFor(profile) !== undefined;

export const genericCapabilities = {
  contextWindow: 64_000,
  maxOutputTokens: 8_192,
  source: 'generic-fallback',
} as const satisfies ModelCapabilities;

export function fallbackCapabilities(
  profile: ModelProfile,
  issue: CapabilityIssue = 'not_supported',
): ModelCapabilities {
  const known = adapterFor(profile)?.fallback(profile);
  return known ? { ...known, source: 'provider-fallback', issue } : { ...genericCapabilities, issue };
}

function validLimits(contextWindow: unknown, maxOutputTokens: unknown, maxInputTokens?: unknown) {
  return (
    validTokenLimit(contextWindow) &&
    validTokenLimit(maxOutputTokens) &&
    maxOutputTokens <= contextWindow &&
    (maxInputTokens === undefined ||
      (validTokenLimit(maxInputTokens) && maxInputTokens <= contextWindow))
  );
}

export function savedCapabilities(profile: ModelProfile): ModelCapabilities {
  const c = profile.capabilities;
  if (
    c &&
    validLimits(c.contextWindow, c.maxOutputTokens, c.maxInputTokens) &&
    (c.source === 'generic-fallback' ||
      (canDiscover(profile) && (c.source === 'provider' || c.source === 'provider-fallback')))
  ) {
    return {
      contextWindow: c.contextWindow,
      maxOutputTokens: c.maxOutputTokens,
      source: c.source,
      ...(c.maxInputTokens === undefined ? {} : { maxInputTokens: c.maxInputTokens }),
      ...(c.issue && capabilityIssues.includes(c.issue) ? { issue: c.issue } : {}),
    };
  }
  return fallbackCapabilities(profile);
}

function parseDeepSeekLimits(profile: ModelProfile, payload: unknown) {
  const entries = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(entries)) return 'invalid';
  const lookup = (id: string) => entries.filter((entry: { id?: unknown } | null) => entry?.id === id);
  // Prefer an exact result; consult a documented alias only when it is absent.
  const exact = lookup(profile.model);
  const matches = exact.length ? exact : lookup(canonicalDeepSeekModel(profile));
  if (!matches.length) return 'model_missing';
  const { context_window: contextWindow, max_output_tokens: maxOutputTokens } = matches[0] as {
    context_window?: unknown;
    max_output_tokens?: unknown;
  };
  if (
    matches.length !== 1 ||
    !validTokenLimit(contextWindow) ||
    !validTokenLimit(maxOutputTokens) ||
    maxOutputTokens > contextWindow
  )
    return 'invalid';
  return { contextWindow, maxOutputTokens };
}

const maxResponseBytes = 256 * 1024;
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0,
    text = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw new Error();
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function discoverCapabilities(
  profile: ModelProfile,
  key: string,
  fetcher = globalThis.fetch,
  timeoutMs = 3_000,
): Promise<ModelCapabilities> {
  const fallback = (issue: CapabilityIssue) => fallbackCapabilities(profile, issue);
  const adapter = adapterFor(profile);
  if (!adapter) return fallback('not_supported');
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetcher(adapter.endpoint, {
      method: 'GET',
      headers: adapter.headers(key),
      redirect: 'error',
      signal,
    });
  } catch {
    return fallback(signal.aborted ? 'timeout' : 'unavailable');
  }
  if (!response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {});
    return fallback(response.status === 401 || response.status === 403 ? 'auth' : 'unavailable');
  }
  try {
    const limits = adapter.parse(profile, await boundedJson(response, signal));
    return typeof limits === 'string' ? fallback(limits) : { ...limits, source: 'provider' };
  } catch {
    return fallback(signal.aborted ? 'timeout' : 'invalid');
  }
}
