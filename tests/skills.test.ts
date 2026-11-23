import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../electron/agent/loop.js';
import { RunManager } from '../electron/agent/runs.js';
import { ScriptedProvider } from '../electron/agent/scripted.js';
import { SkillCatalog } from '../electron/agent/skills.js';
import { Journal } from '../electron/journal.js';
import { collectDiagnostics } from './diagnostic-fixture.js';

const catalog = new SkillCatalog(fileURLToPath(new URL('../skills', import.meta.url)));

test('skill discovery ranks Chinese variants without loading instructions', async () => {
  for (const [query, expected] of [
    [
      '将希腊神话故事奥德赛写成小说，大概写10章左右。记得生成主体，伏笔和大纲和章节正文',
      'generate-novel',
    ],
    ['从大纲到正文，把这部故事改编成长篇', 'generate-novel'],
    ['续写指定章节', 'write-chapter'],
    ['同步人物设定，检查伏笔和剧情一致', 'story-consistency'],
  ]) {
    const trace = collectDiagnostics();
    const { candidates } = await catalog.search(query, trace.report);
    assert.equal(candidates[0]?.name, expected);
    assert.deepEqual(Object.keys(candidates[0]), ['name', 'description']);
    assert.equal(
      trace.rows.some((row) => row.event === 'skill.loaded' || row.event === 'skill.applied'),
      false,
    );
    assert.deepEqual(trace.rejected, []);
  }
  assert.deepEqual(await catalog.search('completely unrelated //'), { candidates: [] });
  for (const invalid of ['unknown', '../generate-novel', 'C:/generate-novel/SKILL.md', ''])
    await assert.rejects(catalog.load(invalid), /只能加载/);
});

test('the same agent selects a skill, rejects an invalid path, and applies only the sent result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fw-skill-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = new RunManager(root, new Journal(() => {}));
  await runs.init();
  const session = await runs.create({ cwd: root, bookId: 'fixture' }, 'fixture');
  const trace = collectDiagnostics();
  const use = (id: string, name: string, args: object) => ({
    role: 'assistant' as const,
    text: '',
    calls: [{ id, name, args: JSON.stringify(args) }],
  });
  const model = new ScriptedProvider([
    () => use('search', 'skill_search', { query: '整本小说 伏笔' }),
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /generate-novel/);
      assert.doesNotMatch(JSON.stringify(history.at(-1)), /instructions/);
      return use('path', 'skill_load', { name: '../generate-novel' });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"ok":false/);
      return use('load', 'skill_load', { name: 'generate-novel' });
    },
    ({ history }) => {
      assert.match(JSON.stringify(history.at(-1)), /"instructions":/);
      return { role: 'assistant', text: '测试完成', calls: [] };
    },
  ]);
  const applied: string[] = [];
  runs.start(
    session.id,
    '整本小说',
    async (ctx) => {
      await runAgent(
        ctx,
        model,
        '',
        [],
        '整本小说',
        catalog.tools((name) => applied.push(name)),
      );
    },
    'high',
    trace.report,
  );
  await runs.wait(session.id);
  assert.equal(runs.get(session.id).run?.status, 'completed', runs.get(session.id).run?.error);
  assert.deepEqual(applied, ['generate-novel']);
  const loaded = trace.rows.filter((row) => row.event === 'skill.loaded');
  assert.equal(loaded.length, 1);
  const adoption = trace.rows.find((row) => row.event === 'skill.applied')!;
  assert.equal(loaded[0].fields.fingerprint, adoption.fields.fingerprint);
  assert.equal(loaded[0].fields.callId, adoption.fields.callId);
  assert.notEqual(loaded[0].fields.spanId, adoption.fields.spanId);
  assert.deepEqual(trace.rejected, []);
  assert.doesNotMatch(JSON.stringify(trace.rows), /整本小说|伏笔|\.\.\/generate-novel/);
});
