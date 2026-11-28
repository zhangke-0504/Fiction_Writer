import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalTool, ReadToolContext } from '../electron/agent/local-tool.js';
import { discoverTools } from '../electron/agent/tool-discovery.js';
import { discoveryCatalogs } from './spikes/harness-tool-discovery-fixture.js';

const context: ReadToolContext = { session: { cwd: '.' }, signal: new AbortController().signal };

function definition(name: string, purpose: string, description = purpose): LocalTool<ReadToolContext> {
  return {
    name,
    description,
    discovery: { purpose },
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async execute() {
      assert.fail('A discovery candidate must not execute its tool');
    },
  };
}

function catalog<Context extends ReadToolContext>(
  tools: LocalTool<Context>[],
  ctx: Context,
  bootstrap?: readonly string[],
) {
  const { registry, visible } = discoverTools(tools, bootstrap);
  return {
    visible,
    async query(text: string) {
      const result = (await registry[0].execute({ query: text }, ctx)) as {
        candidates: {
          id: string;
          purpose: string;
          access: string;
          parameters: string[];
          required: string[];
        }[];
      };
      return result.candidates;
    },
  };
}

test('exact tool IDs use normalized query order and retain the candidate contract', async () => {
  const reader = definition('book_get_context', '读取当前稿件');
  const editor = definition('book_patch_asset', '替换主体或伏笔说明的一句文字', '调用时需提供资料 ID。');
  const { query, visible } = catalog([reader, editor], context);
  assert.deepEqual(
    visible().map(({ name }) => name),
    ['tool_search'],
  );

  const results = await query('  ＢＯＯＫ＿ＰＡＴＣＨ＿ＡＳＳＥＴ　book_get_context BOOK_PATCH_ASSET  ');
  assert.deepEqual(
    results.map(({ id }) => id),
    ['book_patch_asset', 'book_get_context'],
  );
  assert.deepEqual(results[0], {
    id: 'book_patch_asset',
    purpose: editor.description,
    access: 'write',
    parameters: ['id'],
    required: ['id'],
  });
  assert.equal(visible().find(({ name }) => name === editor.name)?.schema, editor.schema);
});

test('unknown and unavailable IDs do not produce substitutes in exact or mixed searches', async () => {
  const get = definition('book_get_context', '读取当前稿件');
  const patch = definition('book_patch_chapter', '删除段间多余换行');
  const apply = definition('book_apply_changes', '提交作品大纲', '章节文字请用 book_patch_chapter');
  const parent = catalog([get, patch, apply], context);
  const other = catalog([apply, get], context);

  assert.deepEqual(await other.query('book_patch_chapter'), []);
  assert.deepEqual(await parent.query('book_patch_chapter_missing'), []);
  assert.deepEqual(
    (await other.query('book_patch_chapter book_get_context')).map(({ id }) => id),
    ['book_get_context'],
  );
  assert.deepEqual(
    (await parent.query('book_get_context book_patch_chapter_missing 删除段间多余换行')).map(
      ({ id }) => id,
    ),
    ['book_get_context', 'book_patch_chapter'],
  );
  assert.deepEqual(await other.query('book_patch_chapter_missing 删除段间多余换行'), []);
});

test('relevance uses positive metadata and leaves unrelated searches empty', async () => {
  const patch = definition('book_patch_chapter', '替换章节旧文', '不用于插入新场景');
  const generate = definition('book_generate_chapter', '起草正文或插入新场景');
  const { directory } = await discoveryCatalogs();
  const { query } = catalog([patch, generate, ...directory.tools], directory.ctx);

  assert.deepEqual(
    (await query('插入新场景')).map(({ id }) => id),
    ['book_generate_chapter'],
  );
  assert.equal((await query('查询文件中原文'))[0]?.id, 'search_text');
  assert.deepEqual(await query('quuxxyz 嗖嘶霹咻'), []);
});

test('bound book discovery ranks precise edits, insertions and text lookup by action', async () => {
  const { book } = await discoveryCatalogs();
  const { query } = catalog(book.tools, book.ctx, book.bootstrap);
  assert.equal((await query('人物卡一句话定点修订'))[0]?.id, 'book_patch_asset');
  assert.equal((await query('在现有章节插入一段过渡'))[0]?.id, 'book_generate_chapter');
  const [result] = await query('搜索章节原文关键词');
  assert.equal(result?.id, 'book_search_text');
  assert.equal(result?.access, 'read');
});

test('exact IDs and lexical matches share a deterministic six-candidate limit', async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `sample_${i}`);
  const tools = ids.map((id) => definition(id, '资料检索'));
  const { query } = catalog(tools.reverse(), context);
  assert.deepEqual(
    (await query(ids.join(' '))).map(({ id }) => id),
    ids.slice(0, 6),
  );
  assert.deepEqual(
    (await query('sample_7 资料检索')).map(({ id }) => id),
    ['sample_7', ...ids.slice(0, 5)],
  );
});
