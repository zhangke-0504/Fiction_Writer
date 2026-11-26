import type { WorkspaceService } from '../workspace.js';
import { bookReadTools } from './book-read-tools.js';
import type { FileTools } from './files.js';
import type { ReadToolContext } from './local-tool.js';

export function taskReadTools(
  workspace: WorkspaceService,
  files: FileTools,
  session: ReadToolContext['session'],
) {
  return session.bookId ? bookReadTools(workspace, session.bookId) : files.readTools();
}
