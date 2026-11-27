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
export type ReferenceField =
  | 'body'
  | 'subjectIds'
  | 'beatIds'
  | 'setupChapterId'
  | 'payoffChapterId'
  | 'setupBeatId'
  | 'payoffBeatId';
export interface InvalidReference {
  document: DocRef;
  field: ReferenceField;
  target: { type: DocType | 'beat'; id: string };
}
export interface WriteReport {
  committed: DocRef[];
  pending: DocRef[];
  invalidReferences?: InvalidReference[];
  reason?: string;
  error?: string;
}
export type Protocol = 'chat' | 'responses' | 'messages';
export type Effort = 'low' | 'medium' | 'high';
export type ProviderId = 'custom' | 'deepseek';
export type CapabilitySource = 'provider' | 'provider-fallback' | 'generic-fallback';
export type CapabilityIssue =
  'not_supported' | 'unavailable' | 'auth' | 'timeout' | 'invalid' | 'model_missing';
export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  maxInputTokens?: number;
  source: CapabilitySource;
  issue?: CapabilityIssue;
}
export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: Protocol;
  providerId?: ProviderId;
  capabilities?: ModelCapabilities;
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
export interface LocalWritingProgress {
  done: number;
  total: number;
  remaining: { operation: string; id: string; part?: string; assetMode?: 'patch' | 'pending' }[];
  omitted: number;
}
export interface WorkProgress {
  whole?: { chapters?: { done: number; total: number }; complete: boolean; message?: string };
  local?: LocalWritingProgress;
  step: string;
  done: number;
  total: number;
  complete?: boolean;
  message?: string;
}
export type TaskOutcome =
  'fulfilled' | 'no_write_needed' | 'partial' | 'incomplete' | 'cancelled' | 'interrupted';
export interface RunInfo {
  id: string;
  status: RunStatus;
  error?: string;
  effort?: Effort | 'default';
  taskOutcome?: TaskOutcome;
  preview?: ChapterPreview;
  progress?: WorkProgress;
}
export interface SessionView {
  session: Session;
  messages: ChatLine[];
  streaming: string;
  run?: RunInfo;
}
export interface RuntimeView {
  workerId?: string;
  cursor: number;
  sessions: SessionView[];
}
export interface StartRun {
  id: string;
  profileId?: string;
  effort?: Effort;
  prompt: string;
  attachments?: string[];
  chapterId?: string;
}
export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  reason?: string;
}
