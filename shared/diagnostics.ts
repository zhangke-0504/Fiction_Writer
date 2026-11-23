export type DiagnosticSource = 'main' | 'worker' | 'renderer';
export type DiagnosticValue = string | number | boolean | undefined;
export type DiagnosticFields = Readonly<Record<string, DiagnosticValue>>;
export interface DiagnosticEvent {
  event: string;
  fields?: DiagnosticFields;
}
export type ReportDiagnostic = (event: string, fields?: DiagnosticFields) => void;
export const noDiagnostic: ReportDiagnostic = () => {};
export function diagnosticScope(report: ReportDiagnostic, context: DiagnosticFields): ReportDiagnostic {
  return (event, fields) => report(event, { ...context, ...fields });
}
export const diagnosticMethods = [
  'library.list',
  'book.create',
  'book.read',
  'book.doc.read',
  'book.doc.write',
  'book.changes.write',
  'book.doc.delete',
  'book.delete',
  'session.create',
  'session.start',
  'session.stop',
  'session.delete',
  'profiles.save',
  'profiles.check',
  'picker.directory',
  'picker.files',
  'shutdown',
] as const;
export type DiagnosticMethod = (typeof diagnosticMethods)[number];
const methods = new Set<string>(diagnosticMethods);
export function isDiagnosticMethod(method: string): method is DiagnosticMethod {
  return methods.has(method);
}
export interface UiRefreshContext {
  journalSeq?: number;
  workerId?: string;
  reason?:
    | 'load'
    | 'focus'
    | 'book_change'
    | 'sequence_gap'
    | 'snapshot_advanced'
    | 'backend_reset'
    | 'user'
    | 'profiles_change';
}
export interface UiReloadContext extends UiRefreshContext {
  workspaceRef?: string;
  documentRef?: string;
}
export interface UiAppliedContext {
  workspaceRef: string;
  documentRef: string;
  reloadId?: string;
  journalSeq?: number;
  workerId?: string;
}
export interface ReportableUiEvents {
  'ui.ready': Record<string, never>;
  'ui.error': { reason: 'exception' | 'unhandled_rejection' | 'react_error' };
  'ui.section': {
    section: 'library' | 'settings' | 'book' | 'outline' | 'subject' | 'clue' | 'chapter' | 'harness';
    workspaceRef?: string;
    documentRef?: string;
  };
  'ui.book_change_received': {
    journalSeq: number;
    workerId: string;
    changeId: string;
    workspaceRef?: string;
  };
  'ui.sequence_gap': {
    expectedSeq: number;
    journalSeq: number;
    workerId?: string;
    via: 'push' | 'snapshot';
  };
  'ui.reload.started': UiReloadContext & {
    area: 'runtime' | 'library' | 'workspace' | 'document';
    reloadId: string;
  };
  'ui.reload.finished': ReportableUiEvents['ui.reload.started'] & {
    outcome: 'ok' | 'failed' | 'superseded';
    elapsedMs: number;
    revision?: string;
    count?: number;
    issueCount?: number;
  };
  'ui.revision_applied': UiAppliedContext & { revision: string };
  'ui.draft_preserved': UiAppliedContext & {
    expectedRevision: string;
    revision?: string;
    reason: 'conflict' | 'missing';
  };
  'ui.preview': { workspaceRef: string; documentRef: string; outcome: 'started' | 'cleared' };
}
export type UiEventName = keyof ReportableUiEvents;
export const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function formatRequestFailure(message: string, requestId: string) {
  return `[fw-request:${requestId}] ${message}`;
}
export function diagnosticFailure(message: string) {
  const match = /^(?:Error:\s*)?\[fw-request:([a-f0-9-]{36})\]\s*/i.exec(message);
  return match && requestIdPattern.test(match[1])
    ? { message: message.slice(match[0].length), requestId: match[1] }
    : { message, requestId: undefined };
}
