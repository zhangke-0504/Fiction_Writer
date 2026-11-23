import { createHash } from 'node:crypto';
import { noDiagnostic, type ReportDiagnostic } from '../../shared/diagnostics.js';
import { classified, safeReporter } from '../diagnostics/trace.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export interface WritingSkills {
  consistency: string;
  chapter: string;
  novel: string;
}
const names = ['story-consistency', 'write-chapter', 'generate-novel'] as const;
type SkillName = (typeof names)[number];
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
export function applySkill(
  report: ReportDiagnostic,
  skill: SkillName,
  text: string,
  reason: 'agent' | 'draft' | 'append' | 'replace' | 'workflow',
) {
  safeReporter(report)('skill.applied', { skill, fingerprint: fingerprint(text), reason });
}
export async function loadSkills(directory: string, diagnostic = noDiagnostic): Promise<WritingSkills> {
  const report = safeReporter(diagnostic);
  const read = async (skill: SkillName) => {
    try {
      const content = (await readFile(join(directory, skill, 'SKILL.md'), 'utf8'))
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
        .trim();
      report('skill.loaded', { skill, fingerprint: fingerprint(content) });
      return content;
    } catch (error) {
      report('skill.failed', { skill, reason: classified(error) });
      throw error;
    }
  };
  const [consistency, chapter, novel] = await Promise.all(names.map(read));
  return { consistency, chapter, novel };
}
