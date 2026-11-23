import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export interface WritingSkills {
  consistency: string;
  chapter: string;
  novel: string;
}
export async function loadSkills(directory: string): Promise<WritingSkills> {
  const read = async (name: string) =>
    (await readFile(join(directory, name, 'SKILL.md'), 'utf8'))
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
      .trim();
  const [consistency, chapter, novel] = await Promise.all(
    ['story-consistency', 'write-chapter', 'generate-novel'].map(read),
  );
  return { consistency, chapter, novel };
}
