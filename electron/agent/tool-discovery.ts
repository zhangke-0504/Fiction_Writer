import type { LocalTool } from './loop.js';

const readTools = new Set([
  'list_files',
  'search_text',
  'read_file',
  'book_get_context',
  'book_search_text',
  'book_memory_recall',
]);
const controlTools = new Set(['skill_search', 'skill_load', 'book_task_scope']);
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().trim();

function terms(text: string) {
  const latin = text.match(/[a-z][a-z0-9_]{1,}/gu) ?? [];
  const han = (text.match(/\p{Script=Han}+/gu) ?? []).flatMap((part) =>
    part.length < 2 ? [part] : Array.from({ length: part.length - 1 }, (_, i) => part.slice(i, i + 2)),
  );
  return [...new Set([...latin, ...han])];
}

/** Operates on one session-filtered catalog; only a new model request sees the selected schemas. */
export function discoverTools(
  tools: LocalTool[],
  bootstrap: readonly string[] = [],
): {
  registry: LocalTool[];
  visible: () => LocalTool[];
} {
  const exposed = new Set([...controlTools, ...bootstrap]);
  const indexed = tools.map((tool) => ({
    tool,
    corpus: normalized(
      `${tool.name} ${tool.description} ${Object.keys(tool.schema.properties ?? {}).join(' ')}`,
    ),
  }));
  const search: LocalTool = {
    name: 'tool_search',
    description:
      '在此会话检索可用工具。传简短的需求关键词或工具 ID。结果只是候选，不授权或执行；选中的 schema 从下一轮开始可用。',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 160 } },
      required: ['query'],
      additionalProperties: false,
    },
    async execute({ query }, ctx) {
      const text = normalized(typeof query === 'string' ? query : '').slice(0, 160);
      const words = terms(text);
      const selected = indexed
        .map(({ tool, corpus }) => {
          const score =
            (text === tool.name ? 400 : 0) +
            (text && corpus.includes(text) ? 30 : 0) +
            words.reduce((n, word) => n + (corpus.includes(word) ? (word.length > 2 ? 4 : 1) : 0), 0);
          return { tool, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .slice(0, 6);
      for (const { tool } of selected) exposed.add(tool.name);
      ctx.diagnostic?.('tool.discovery', { count: selected.length, outcome: 'ok' });
      return {
        candidates: selected.map(({ tool }) => ({
          id: tool.name,
          purpose: tool.description.slice(0, 480),
          access: readTools.has(tool.name)
            ? 'read'
            : exposed.has(tool.name) && controlTools.has(tool.name)
              ? 'control'
              : 'write',
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
