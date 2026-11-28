import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bookMemoryTools } from '../../electron/agent/book-memory.js';
import { FileTools } from '../../electron/agent/files.js';
import type { LocalTool } from '../../electron/agent/local-tool.js';
import type { ModelProvider, ToolSpec } from '../../electron/agent/model.js';
import { NovelTools } from '../../electron/agent/novel-tools.js';
import type { RunContext } from '../../electron/agent/runs.js';
import { SkillCatalog } from '../../electron/agent/skills.js';
import { taskReadTools } from '../../electron/agent/task-read-tools.js';
import { BookTaskScope } from '../../electron/agent/task-scope.js';
import { createTaskTools } from '../../electron/agent/task-tools.js';
import { WorkspaceService } from '../../electron/workspace.js';
import type { CatalogName } from './harness-tool-discovery-corpus.js';

export interface Catalog {
  tools: LocalTool[];
  ctx: RunContext;
  bootstrap: string[];
}

export function toolSpec({ name, description, schema }: ToolSpec): ToolSpec {
  return { name, description, schema };
}

export async function discoveryCatalogs(): Promise<Record<CatalogName, Catalog>> {
  const cwd = process.cwd();
  const workspace = new WorkspaceService({ libraryRoot: join(cwd, 'unused-replay-library') });
  const files = new FileTools(workspace, join(cwd, 'unused-replay-state'));
  const skills = new SkillCatalog(join(cwd, 'skills'));
  const bookId = 'synthetic-book';
  function unexpected(): never {
    throw new Error('Discovery replay must not access manuscript or session data');
  }
  const dirCtx: RunContext = {
    id: 'offline-discovery',
    session: { id: 'offline-session', cwd, label: 'synthetic discovery replay', updated: '' },
    signal: new AbortController().signal,
    text: unexpected,
    line: unexpected,
    preview: unexpected,
    progress: unexpected,
    saveNovelTask: unexpected,
  };
  const bookCtx: RunContext = { ...dirCtx, session: { ...dirCtx.session, bookId } };
  const provider: ModelProvider = { effort: 'default', turn: unexpected };
  const scope = new BookTaskScope(bookCtx, '', provider);
  const novel = new NovelTools(workspace, bookId, provider, skills, { scope });
  const dirTasks = createTaskTools(dirCtx, provider, taskReadTools(workspace, files, dirCtx.session));
  const reads = taskReadTools(workspace, files, bookCtx.session);
  let report: ToolSpec | undefined;
  const childProvider: ModelProvider = {
    effort: 'default',
    async turn(request) {
      report = request.tools.find(({ name }) => name === 'task_report');
      return {
        role: 'assistant',
        text: '',
        calls: [
          {
            id: 'done',
            name: 'task_report',
            args: JSON.stringify({
              status: 'completed',
              summary: 'synthetic',
              references: [],
              unresolved: [],
            }),
          },
        ],
      };
    },
  };
  const bookTasks = createTaskTools(bookCtx, childProvider, reads);
  try {
    const { taskId } = (await bookTasks.tools[0].execute(
      { brief: 'Collect child catalog', deliverable: 'Finish the fixture' },
      bookCtx,
    )) as { taskId: string };
    await bookTasks.tools[1].execute({ taskIds: [taskId] }, bookCtx);
    assert.ok(report, 'The child must advertise its actual report definition');
    return {
      directory: { tools: [...files.tools(), ...dirTasks.tools], ctx: dirCtx, bootstrap: [] },
      book: {
        tools: [
          ...files.readTools(),
          scope.tool(unexpected, novel.scopeSyncTargets),
          ...skills.tools(),
          ...novel.tools(),
          ...bookMemoryTools(workspace, bookId),
          ...bookTasks.tools,
        ],
        ctx: bookCtx,
        bootstrap: ['book_task_scope'],
      },
      child: {
        tools: [...reads, { ...toolSpec(report), execute: unexpected }],
        ctx: bookCtx,
        bootstrap: ['task_report'],
      },
    };
  } finally {
    await Promise.all([dirTasks.close(), bookTasks.close()]);
  }
}
