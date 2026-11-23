import { DiagnosticFailure } from '../diagnostics/trace.js';
import { noDiagnostic, type ReportDiagnostic } from '../../shared/diagnostics.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  opendir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkspaceService } from '../workspace.js';
import { runCommand, CommandStopError } from './commands.js';
import { object, str, type LocalTool } from './loop.js';
import type { RunContext } from './runs.js';

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function missing(e: unknown) {
  return (e as NodeJS.ErrnoException).code === 'ENOENT';
}
const excluded = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  '.env',
  '.env.local',
  'ds_config.txt',
]);
function blockedPath(path: string) {
  return path
    .split(/[\\/]/)
    .some((piece) => /^\.env(?:\.|$)/i.test(piece) || piece.toLowerCase() === 'ds_config.txt');
}
const MAX_FILE = 256_000;
async function readText(path: string, signal: AbortSignal, max = MAX_FILE) {
  signal.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const data = Buffer.alloc(max + 1);
    const initial = await handle.stat();
    if (!initial.isFile()) throw new Error('不是普通文件');
    if (initial.size > max) throw new Error('文本文件超出大小限制');
    let bytesRead = 0;
    while (bytesRead < data.length) {
      signal.throwIfAborted();
      const read = await handle.read({
        buffer: data,
        offset: bytesRead,
        length: data.length - bytesRead,
        position: bytesRead,
      });
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > max) throw new Error('文本文件超出大小限制');
    if (data.subarray(0, bytesRead).includes(0)) throw new Error('只支持 UTF-8 文本文件');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      data.subarray(0, bytesRead),
    );
  } finally {
    await handle.close();
  }
}
async function* walk(
  root: string,
  signal: AbortSignal,
  budget = { left: 4000 },
  depth = 0,
): AsyncGenerator<string> {
  if (depth > 12 || budget.left <= 0) return;
  for await (const entry of await opendir(root)) {
    signal.throwIfAborted();
    if (--budget.left < 0) return;
    if (excluded.has(entry.name) || blockedPath(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path, signal, budget, depth + 1);
    else if (entry.isFile()) yield path;
  }
}

export class FileTools {
  constructor(
    private workspace: WorkspaceService,
    private stateRoot: string,
    private rescan: (report?: ReportDiagnostic) => void = () => {},
  ) {}
  private async path(cwd: string, name: string, allowMissing: boolean) {
    const path = resolve(cwd, name);
    if (!inside(cwd, path) || inside(this.stateRoot, path) || blockedPath(path))
      throw new Error('请选择工作目录内的普通文件');
    let nearest = path;
    for (;;) {
      try {
        const canonical = await realpath(nearest);
        if (!inside(cwd, canonical) || inside(this.stateRoot, canonical) || blockedPath(canonical))
          throw new Error('路径不属于工作目录');
        return resolve(canonical, relative(nearest, path));
      } catch (e) {
        if (!missing(e) || !allowMissing || nearest === cwd) throw e;
        nearest = dirname(nearest);
      }
    }
  }
  async attachments(paths: string[] = []) {
    if (paths.length > 8) throw new Error('最多添加 8 个参考文件');
    let budget = 96_000;
    const refs: { path: string; text: string }[] = [];
    for (const selection of paths) {
      try {
        const path = await realpath(selection);
        if (inside(this.stateRoot, path) || blockedPath(path) || !(await stat(path)).isFile())
          throw new Error('不是可附加的普通文件');
        const text = await readText(path, AbortSignal.timeout(5000), Math.min(32_000, budget));
        budget -= Buffer.byteLength(text);
        refs.push({ path, text });
      } catch {
        throw new Error(`无法附加文件（文件缺失、不为 UTF-8 文本或超限）：${selection}`);
      }
    }
    return refs;
  }
  private async write(path: string, content: string, ctx: RunContext, expect?: string) {
    const managed = this.workspace.managedPath(path);
    ctx.diagnostic?.('tool.file', {
      operation: 'write',
      fileRef: path,
      bytes: Buffer.byteLength(content),
    });
    if (managed)
      return this.workspace.writeRaw(
        managed.bookId,
        managed.doc,
        content,
        ctx.signal,
        expect,
        ctx.diagnostic,
      );
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error('文本文件超出大小限制');
    await mkdir(dirname(path), { recursive: true });
    if (
      expect !== undefined &&
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== expect
    )
      throw new Error('文件已变化，请重新读取');
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { encoding: 'utf8', flag: 'wx', signal: ctx.signal });
      ctx.signal.throwIfAborted();
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    return { path: relative(ctx.session.cwd, path) };
  }
  tools(): LocalTool[] {
    const field = str('相对工作目录的路径', 4096);
    const content = { type: 'string', maxLength: MAX_FILE };
    const deliver = (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      execute: LocalTool['execute'],
    ): LocalTool => ({ name, description, schema, execute });
    return [
      deliver(
        'list_files',
        '列出工作目录中的文件。',
        object({ path: field }, []),
        async ({ path = '.' }, ctx) => {
          const root = await this.path(ctx.session.cwd, path, false),
            files: string[] = [];
          for await (const file of walk(root, ctx.signal)) {
            if (inside(this.stateRoot, file)) continue;
            files.push(relative(ctx.session.cwd, file));
            if (files.length === 250) break;
          }
          ctx.diagnostic?.('tool.file', {
            operation: 'list',
            fileRef: root,
            affected: files.length,
            truncated: files.length === 250,
          });
          return { files, limited: files.length === 250 };
        },
      ),
      deliver(
        'search_text',
        '在 UTF-8 文件中查找文本，返回文件、行号和截短的匹配行。',
        object({ query: str(undefined, 1000), path: field }, ['query']),
        async ({ query, path = '.' }, ctx) => {
          const root = await this.path(ctx.session.cwd, path, false),
            found: { path: string; line: number; text: string }[] = [];
          const needle = String(query).toLowerCase();
          const finish = (truncated: boolean) =>
            ctx.diagnostic?.('tool.file', {
              operation: 'search',
              fileRef: root,
              affected: found.length,
              truncated,
            });
          for await (const file of walk(root, ctx.signal, { left: 1600 })) {
            if (inside(this.stateRoot, file)) continue;
            let text: string;
            try {
              text = await readText(file, ctx.signal);
            } catch {
              ctx.signal.throwIfAborted();
              continue;
            }
            for (const [i, line] of text.split(/\r?\n/).entries())
              if (line.toLowerCase().includes(needle)) {
                found.push({
                  path: relative(ctx.session.cwd, file),
                  line: i + 1,
                  text: line.slice(0, 500),
                });
                if (found.length === 80) {
                  finish(true);
                  return { matches: found, limited: true };
                }
              }
          }
          finish(false);
          return { matches: found };
        },
      ),
      deliver(
        'read_file',
        '读取 UTF-8 文件，可指定起始行和行数。',
        object(
          {
            path: field,
            start: { type: 'integer', minimum: 1 },
            lines: { type: 'integer', minimum: 1, maximum: 2000 },
          },
          ['path'],
        ),
        async ({ path, start = 1, lines = 500 }, ctx) => {
          const file = await this.path(ctx.session.cwd, path, false);
          if (!(await stat(file)).isFile()) throw new Error('不是普通文件');
          const text = await readText(file, ctx.signal);
          const all = text.split('\n');
          ctx.diagnostic?.('tool.file', {
            operation: 'read',
            fileRef: file,
            bytes: Buffer.byteLength(text),
            affected: all.length,
          });
          return {
            start,
            total: all.length,
            text: all
              .slice(start - 1, start + lines - 1)
              .join('\n')
              .slice(0, 90_000),
          };
        },
      ),
      deliver(
        'write_file',
        '创建或覆盖 UTF-8 文件；小说资产应优先使用小说专用工具。',
        object({ path: field, content }),
        async ({ path, content }, ctx) =>
          this.write(await this.path(ctx.session.cwd, path, true), content, ctx),
      ),
      deliver(
        'edit_file',
        '替换文件中恰好出现一次的精确文本。',
        object({ path: field, oldText: str(), newText: content }),
        async ({ path, oldText, newText }, ctx) => {
          const file = await this.path(ctx.session.cwd, path, false),
            text = await readText(file, ctx.signal),
            index = text.indexOf(oldText);
          if (index < 0 || text.indexOf(oldText, index + 1) >= 0)
            throw new Error('原文本必须恰好出现一次');
          return this.write(
            file,
            text.slice(0, index) + newText + text.slice(index + oldText.length),
            ctx,
            createHash('sha256').update(text).digest('hex'),
          );
        },
      ),
      deliver(
        'delete_file',
        '永久删除指定单个文件。',
        object({ path: field }),
        async ({ path }, ctx) => {
          const file = await this.path(ctx.session.cwd, path, false);
          ctx.signal.throwIfAborted();
          const direct = await lstat(resolve(ctx.session.cwd, path));
          if (direct.isSymbolicLink() || !(await lstat(file)).isFile())
            throw new Error('只支持删除普通文件，不跟随文件链接');
          ctx.diagnostic?.('tool.file', { operation: 'delete', fileRef: file });
          const managed = this.workspace.managedPath(file);
          if (managed) {
            const report = await this.workspace.deleteDocument(
              managed.bookId,
              managed.doc,
              ctx.signal,
              ctx.diagnostic,
            );
            if (report.error)
              throw new DiagnosticFailure(report.reason ?? 'unknown', JSON.stringify(report));
          } else await unlink(file);
          return { deleted: true };
        },
      ),
      deliver(
        'run_command',
        '在工作目录使用 PowerShell（非 Windows 则使用 sh）运行明确的本地开发命令，返回退出码与输出。',
        object(
          {
            command: str(undefined, 4000),
            timeoutMs: { type: 'integer', minimum: 100, maximum: 120_000 },
          },
          ['command'],
        ),
        async ({ command, timeoutMs = 30_000 }, ctx) => {
          try {
            return await runCommand(
              ctx.session.cwd,
              command,
              timeoutMs,
              ctx.signal,
              ctx.diagnostic ?? noDiagnostic,
            );
          } catch (error) {
            if (error instanceof CommandStopError) ctx.uncertainStop?.(error.message);
            throw error;
          } finally {
            this.rescan(ctx.diagnostic);
          }
        },
      ),
    ];
  }
}
