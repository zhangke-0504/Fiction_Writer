import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { discoverTools } from '../../electron/agent/tool-discovery.js';
import { queries, type QueryCase } from './harness-tool-discovery-corpus.js';
import { discoveryCatalogs, toolSpec, type Catalog } from './harness-tool-discovery-fixture.js';

type Row = [id: string, candidates: string[], added: number, serializedBytes: number];
const baselineFile = new URL('./harness-tool-discovery-baseline.json', import.meta.url);
const catalogs = await discoveryCatalogs();

function row(
  id: string,
  catalog: Catalog,
  initiallyVisible: ReadonlySet<string>,
  candidates: string[],
): Row {
  const added = catalog.tools.filter(
    ({ name }) => candidates.includes(name) && !initiallyVisible.has(name),
  );
  return [id, candidates, added.length, Buffer.byteLength(JSON.stringify(added.map(toolSpec)))];
}

async function production(query: QueryCase): Promise<Row> {
  const source = catalogs[query.catalog];
  const catalog = discoverTools(source.tools, source.bootstrap);
  const initiallyVisible = new Set(catalog.visible().map(({ name }) => name));
  const search = catalog.registry[0];
  assert.equal(search.name, 'tool_search');
  const { candidates } = (await search.execute({ query: query.query }, source.ctx)) as {
    candidates: { id: string }[];
  };
  const added = catalog
    .visible()
    .filter(({ name }) => !initiallyVisible.has(name))
    .map(toolSpec);
  return [
    query.id,
    candidates.map(({ id }) => id),
    added.length,
    Buffer.byteLength(JSON.stringify(added)),
  ];
}

function summarize(rows: readonly { sample: QueryCase; row: Row }[]) {
  let targets = 0;
  let first = 0;
  let topThree = 0;
  let reciprocalRank = 0;
  let irrelevant = 0;
  let schemas = 0;
  let schemaBytes = 0;
  let exact = 0;
  for (const {
    sample,
    row: [, candidates, added, serializedBytes],
  } of rows) {
    if (sample.targets.length) {
      targets++;
      if (sample.targets.includes(candidates[0])) first++;
      if (candidates.slice(0, 3).some((id) => sample.targets.includes(id))) topThree++;
    }
    const related = new Set([...sample.targets, ...(sample.prerequisites ?? [])]);
    const relatedIndex = candidates.findIndex((id) => related.has(id));
    if (relatedIndex >= 0) reciprocalRank += 1 / (relatedIndex + 1);
    irrelevant += candidates.filter((id) => !related.has(id)).length;
    schemas += added;
    schemaBytes += serializedBytes - 2;
    if (sample.idsOnly && candidates.join(' ') === sample.targets.join(' ')) exact++;
  }
  return {
    queries: rows.length,
    targets,
    first,
    topThree,
    firstRelevantMrr: Number((reciprocalRank / targets).toFixed(3)),
    irrelevant,
    schemas,
    schemaBytes,
    ...(rows[0].sample.group === 'ids' && { exactIdLists: exact }),
  };
}

if (process.argv.includes('--capture-baseline')) {
  const rows = await Promise.all(queries.map(production));
  const json = `[\n${rows.map((result) => `  ${JSON.stringify(result)}`).join(',\n')}\n]\n`;
  await writeFile(baselineFile, json, { flag: 'wx' });
} else {
  const { bm25Terms, rankBm25 } = await import('./harness-tool-discovery-bm25.js');
  const tokens = bm25Terms('搜索仓库问题 draftText');
  for (const term of ['搜索', '仓库', '问题', 'bi:索仓', 'bi:库问', 'draft', 'text']) {
    assert.ok(tokens.includes(term), `missing tokenizer term ${term}`);
  }
  const baseline = JSON.parse(await readFile(baselineFile, 'utf8')) as Row[];
  assert.deepEqual(
    baseline.map(([id]) => id),
    queries.map(({ id }) => id),
  );
  const cases = process.argv.includes('--calibration')
    ? queries.filter(({ group }) => group === 'calibration')
    : queries;
  const results = await Promise.all(
    cases.map(async (sample) => {
      const source = catalogs[sample.catalog];
      const existing = new Set(
        discoverTools(source.tools, source.bootstrap)
          .visible()
          .map(({ name }) => name),
      );
      const a = baseline.find(([id]) => id === sample.id)!;
      const b = await production(sample);
      const c = row(sample.id, source, existing, rankBm25(sample.query, source.tools));
      return { sample, A: a, B: b, C: c };
    }),
  );
  console.table(
    results.map(({ sample, A, B, C }) => ({
      id: sample.id,
      A: A[1].join(' '),
      B: B[1].join(' '),
      C: C[1].join(' '),
    })),
  );
  console.table(
    ['calibration', 'held-out', 'ids'].flatMap((group) => {
      const selected = results.filter(({ sample }) => sample.group === group);
      return selected.length
        ? (['A', 'B', 'C'] as const).map((variant) => ({
            group,
            variant,
            ...summarize(selected.map((result) => ({ sample: result.sample, row: result[variant] }))),
          }))
        : [];
    }),
  );
}
