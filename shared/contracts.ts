export type DocType = 'book' | 'outline' | 'subject' | 'clue' | 'chapter';
export type SubjectKind = 'character' | 'item' | 'scene';
export interface Fields {
  id?: string;
  title?: string;
  name?: string;
  kind?: SubjectKind;
  genre?: string;
  style?: string;
  author?: string;
  order?: number;
  subjectIds?: string[];
  beatIds?: string[];
  setupChapterId?: string;
  payoffChapterId?: string;
  setupBeatId?: string;
  payoffBeatId?: string;
}
export interface DocRef {
  type: DocType;
  id: string;
}
export interface Manuscript extends DocRef {
  fields: Fields;
  body: string;
  revision: string;
}
export interface DocSummary extends DocRef {
  fields: Fields;
  revision: string;
}
export interface BookSummary {
  id: string;
  title: string;
  genre?: string;
  author?: string;
  summary: string;
}
export interface BookView {
  documents: DocSummary[];
  diagnostics: string[];
}
export interface LibraryView {
  books: BookSummary[];
  diagnostics: string[];
}
export type Change =
  | (DocRef & { expect: string | null; fields: Fields; body: string })
  | (DocRef & { expect: string; delete: true });
export interface WriteReport {
  committed: DocRef[];
  pending: DocRef[];
  error?: string;
}
export type Protocol = 'chat' | 'responses' | 'messages';
export type Effort = 'low' | 'medium' | 'high';
export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: Protocol;
}
export interface Target {
  cwd: string;
  bookId?: string;
}
export interface Session extends Target {
  id: string;
  label: string;
  updated: string;
  missing?: boolean;
}
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface ChatLine {
  role: 'user' | 'assistant' | 'tool' | 'status';
  text: string;
}
export interface ChapterPreview {
  bookId: string;
  chapterId: string;
  content: string;
  base: string;
}
export interface WorkProgress {
  step: string;
  done: number;
  total: number;
  complete?: boolean;
  blocked?: boolean;
  message?: string;
}
export interface RunInfo {
  id: string;
  status: RunStatus;
  error?: string;
  effort?: Effort | 'default';
  preview?: ChapterPreview;
  progress?: WorkProgress;
}
export interface SessionView {
  session: Session;
  messages: ChatLine[];
  streaming: string;
  run?: RunInfo;
  workflow?: WorkProgress;
}
export interface RuntimeView {
  cursor: number;
  sessions: SessionView[];
}
export interface StartRun {
  id: string;
  profileId?: string;
  effort?: Effort;
  prompt: string;
  attachments?: string[];
  action?: 'chat' | 'draft' | 'append' | 'replace' | 'novel';
  chapterId?: string;
  restartWorkflow?: boolean;
}
export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}
