import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

export type Log = {
  event: string;
  source: string;
  bootId: string;
  logSeq: number;
  fields: Record<string, any>;
};
export async function diagnosticText(root: string, stream: 'frontend' | 'backend') {
  const folder = join(root, 'electron-user-data', 'logs');
  const names = await readdir(folder).catch(() => []);
  const matches = names.sort().filter((name) => name.startsWith(`${stream}-`));
  return (await Promise.all(matches.map((name) => readFile(join(folder, name), 'utf8')))).join('\n');
}
export async function readDiagnostics(root: string, stream: 'frontend' | 'backend') {
  const events: Log[] = [];
  for (const line of (await diagnosticText(root, stream)).split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* A live reader can see a partial last line. */
    }
  }
  return events;
}
