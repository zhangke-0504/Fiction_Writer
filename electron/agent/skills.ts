import { createHash } from 'node:crypto';
import { noDiagnostic, type ReportDiagnostic } from '../../shared/diagnostics.js';
import { classified, DiagnosticFailure, safeReporter } from '../diagnostics/trace.js';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { object, str, type LocalTool } from './loop.js';
const names = ['story-consistency', 'write-chapter', 'generate-novel'] as const;
export type SkillName = (typeof names)[number];
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
export function applySkill(
  report: ReportDiagnostic,
  skill: SkillName,
  text: string,
  reason: 'agent' | 'draft' | 'append' | 'replace' | 'insert',
) {
  safeReporter(report)('skill.applied', { skill, fingerprint: fingerprint(text), reason });
}
interface SkillEntry {
  name: SkillName;
  description: string;
}
const aliases: Record<SkillName, readonly string[]> = {
  'generate-novel': [
    '整书',
    '全书',
    '整本小说',
    '整部小说',
    '写一本小说',
    '写成小说',
    '改编成长篇',
    '全本',
    '写完整部',
    '全部章节',
    '所有章节',
    '多章正文',
    '每章正文',
    '章节正文',
    '从大纲到正文',
    'whole novel',
    'full book',
  ],
  'write-chapter': [
    '单章',
    '当前章',
    '本章',
    '指定章节',
    '写一章',
    '续写',
    '重写',
    '改写正文',
    'draft chapter',
  ],
  'story-consistency': [
    '伏笔',
    '设定一致性',
    '联动',
    '同步资产',
    '人物设定',
    '剧情一致',
    '改大纲',
    'continuity',
  ],
};
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, '');
const isSkillName = (value: unknown): value is SkillName => names.some((name) => name === value);
function header(text: string, name: SkillName) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new DiagnosticFailure('invalid_skill', '内置 Skill 缺少元数据');
  const entry = parse(match[1]) as Partial<SkillEntry> | null;
  if (
    entry?.name !== name ||
    typeof entry.description !== 'string' ||
    !entry.description.trim() ||
    entry.description.length > 1024
  )
    throw new DiagnosticFailure('invalid_skill', '内置 Skill 元数据无效');
  return { name, description: entry.description.trim(), bodyStart: match[0].length };
}

export class SkillCatalog {
  constructor(private readonly directory: string) {}

  async search(query: string, diagnostic = noDiagnostic) {
    const report = safeReporter(diagnostic);
    const input = normalize(query);
    const matches: (SkillEntry & { score: number })[] = [];
    if (input.length >= 2)
      for (const name of names) {
        try {
          const file = await open(join(this.directory, name, 'SKILL.md'), 'r');
          const buffer = Buffer.alloc(4096);
          let prefix: string;
          try {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            prefix = buffer.toString('utf8', 0, bytesRead);
          } finally {
            await file.close();
          }
          const { description } = header(prefix, name);
          const id = normalize(name);
          let score = input === id ? 100 : input.includes(id) ? 40 : 0;
          for (const alias of aliases[name].map(normalize)) {
            if (input.includes(alias)) score += alias.length + 2;
            else if (input.length >= 3 && alias.includes(input)) score += 1;
          }
          if (normalize(description).includes(input)) score += 2;
          if (score) matches.push({ name, description, score });
        } catch (error) {
          report('skill.failed', { skill: name, reason: classified(error) });
        }
      }
    const candidates = matches
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map(({ name, description }) => ({ name, description }));
    report('skill.search', { candidates: candidates.length });
    for (const { name } of candidates) report('skill.candidate', { skill: name });
    return { candidates };
  }

  async load(name: unknown, diagnostic = noDiagnostic) {
    if (!isSkillName(name))
      throw new DiagnosticFailure('invalid_skill', '只能加载检索目录中已注册的内置 Skill');
    const report = safeReporter(diagnostic);
    try {
      const text = await readFile(join(this.directory, name, 'SKILL.md'), 'utf8');
      const body = text.slice(header(text, name).bodyStart).trim();
      if (!body || body.length > 20_000)
        throw new DiagnosticFailure('invalid_skill', '内置 Skill 指令为空或过长');
      report('skill.loaded', { skill: name, fingerprint: fingerprint(body) });
      return body;
    } catch (error) {
      report('skill.failed', { skill: name, reason: classified(error) });
      throw error;
    }
  }

  tools(onApply?: (skill: SkillName) => void): LocalTool[] {
    return [
      {
        name: 'skill_search',
        description:
          '按创作意图或能力名称查找内置写作 Skill（整本小说、指定章节、设定一致性等）；只返回候选，不执行任务。',
        schema: object({ query: str('用简短中文描述要找的写作能力', 512) }),
        execute: async ({ query }, ctx) => this.search(query, ctx.diagnostic),
      },
      {
        name: 'skill_load',
        description: '加载选中的内置 Skill 指令。name 必须是检索返回的注册名称，不是文件路径。',
        schema: object({ name: { ...str(undefined, 40), enum: names } }),
        execute: async ({ name }, ctx) => ({
          name,
          instructions: await this.load(name, ctx.diagnostic),
        }),
        onResultSent(result, report) {
          const skill = result.value as { name?: unknown; instructions?: unknown } | undefined;
          if (result.ok && isSkillName(skill?.name) && typeof skill.instructions === 'string') {
            applySkill(report, skill.name, skill.instructions, 'agent');
            onApply?.(skill.name);
          }
        },
      },
    ];
  }
}
