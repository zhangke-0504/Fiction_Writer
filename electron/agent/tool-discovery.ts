import type { LocalTool, ReadToolContext } from './local-tool.js';

const readTools = new Set([
  'list_files',
  'search_text',
  'read_file',
  'book_get_context',
  'book_search_text',
  'book_memory_recall',
  'web_search',
  'web_fetch',
]);
const defaultControlTools = ['skill_search', 'skill_load', 'book_task_scope'];
const controlTools = new Set([...defaultControlTools, 'start_task', 'wait_tasks', 'task_report']);
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().trim();
const queryLimit = 160;
const candidateLimit = 6;

export function parseToolQuery(query: string, names: ReadonlySet<string>) {
  const ids = new Set<string>();
  const text = normalized(query)
    .slice(0, queryLimit)
    .replace(/[a-z0-9_-]+/gu, (token) => {
      if (names.has(token)) ids.add(token);
      // Tool IDs use underscores. Keep unavailable IDs out of the lexical query too.
      else if (!token.includes('_')) return token;
      return ' ';
    });
  return { ids: [...ids], text: text.trim().replace(/\s+/gu, ' ') };
}

function terms(text: string) {
  const latin = text.match(/[a-z][a-z0-9_]{1,}/gu) ?? [];
  const han = (text.match(/\p{Script=Han}+/gu) ?? []).flatMap((part) =>
    part.length < 2 ? [part] : Array.from({ length: part.length - 1 }, (_, i) => part.slice(i, i + 2)),
  );
  return [...new Set([...latin, ...han])];
}

/** Operates on one session-filtered catalog; only a new model request sees the selected schemas. */
export function discoverTools<Context extends ReadToolContext>(
  tools: LocalTool<Context>[],
  bootstrap: readonly string[] = [],
): {
  registry: LocalTool<Context>[];
  visible: () => LocalTool<Context>[];
} {
  const exposed = new Set([...defaultControlTools, ...bootstrap]);
  const byName = new Map(tools.map((tool) => [normalized(tool.name), tool]));
  const names = new Set(byName.keys());
  const indexed = tools.map((tool) => ({
    name: normalized(tool.name),
    tool,
    corpus: normalized(
      [
        tool.name,
        tool.discovery?.purpose ?? '',
        ...(tool.discovery?.aliases ?? []),
        ...Object.keys(tool.schema.properties ?? {}),
      ].join(' '),
    ),
  }));
  const search: LocalTool<Context> = {
    name: 'tool_search',
    description:
      '在此会话检索可用工具。传简短的需求关键词或工具 ID。结果只是候选，不授权或执行；选中的 schema 从下一轮开始可用。',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: queryLimit } },
      required: ['query'],
      additionalProperties: false,
    },
    async execute({ query }, ctx) {
      const { ids, text } = parseToolQuery(typeof query === 'string' ? query : '', names);
      const selected = ids.slice(0, candidateLimit).map((id) => byName.get(id)!);
      if (text && selected.length < candidateLimit) {
        const exact = new Set(ids);
        const words = terms(text);
        const ranked = indexed
          .filter(({ name }) => !exact.has(name))
          .map(({ tool, corpus }) => {
            const score =
              (corpus.includes(text) ? 30 : 0) +
              words.reduce((n, word) => n + (corpus.includes(word) ? (word.length > 2 ? 4 : 1) : 0), 0);
            return { tool, score };
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
          .slice(0, candidateLimit - selected.length);
        selected.push(...ranked.map(({ tool }) => tool));
      }
      for (const tool of selected) exposed.add(tool.name);
      ctx.diagnostic?.('tool.discovery', { count: selected.length, outcome: 'ok' });
      return {
        candidates: selected.map((tool) => ({
          id: tool.name,
          purpose: tool.description.slice(0, 480),
          access: readTools.has(tool.name) ? 'read' : controlTools.has(tool.name) ? 'control' : 'write',
          parameters: Object.keys(tool.schema.properties ?? {}).slice(0, 20),
          required: tool.schema.required,
        })),
      };
    },
  };
  return {
    registry: [search, ...tools],
    visible: () => [search, ...tools.filter(({ name }) => exposed.has(name))],
  };
}
