import { createHash } from 'node:crypto';
import type { DocRef } from '../../shared/contracts.js';
import { isId } from '../documents.js';
import type { DiagnosticFields } from '../../shared/diagnostics.js';

export type CommitReceipt = DocRef & { operation: 'write' | 'delete'; revision?: string };
export type ToolReceipt = {
  runId: string;
  round: number;
  callRef: string;
  tool: string;
  phase?: 'chapter-readback';
  outcome: 'ok' | 'partial' | 'failed' | 'cancelled' | 'timeout';
  reason?: string;
  commits: CommitReceipt[];
  commitCount: number;
  exitCode?: number;
  resultOmitted?: boolean;
  conventionId?: string;
};
const reasons = new Set([
  'missing',
  'no_match',
  'invalid_arguments',
  'input_validation',
  'invalid_references',
  'unbound_foreshadowing',
  'context_required',
  'context_limit',
  'invalid_options',
  'invalid_json',
  'invalid_call',
  'rewrite_not_authorized',
  'insert_not_authorized',
  'insertion_quality',
  'insert_cleanup_scope',
  'insert_cleanup_receipt',
  'insert_cleanup_unsafe',
  'insert_cleanup_sync',
  'patch_not_authorized',
  'patch_anchor',
  'patch_scope',
  'patch_evidence',
  'chapter_body_not_supported',
  'novel_goal_required',
  'novel_goal_conflict',
  'novel_incomplete',
  'malformed_stream',
  'incomplete_stream',
  'output_limit',
  'network',
  'auth',
  'http_error',
  'provider_error',
  'invalid_skill',
  'invalid_memory',
  'memory_limit',
  'memory_not_requested',
  'command_failed',
  'command_timeout',
  'termination_uncertain',
  'cancelled',
  'timeout',
  'conflict',
  'partial_write',
  'io_failure',
  'result_limit',
  'tool_failed',
]);
const docTypes = ['book', 'outline', 'subject', 'clue', 'chapter'];
export const recentReceiptLimit = 32;
export const commitReceiptLimit = 24;
export const callRef = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 24);
export const receiptReason = (reason?: string) =>
  reason && (reasons.has(reason) ? reason : 'tool_failed');

function isCommit(row: CommitReceipt): boolean {
  return (
    row &&
    docTypes.includes(row.type) &&
    isId(row.id) &&
    (row.operation === 'delete' ||
      (row.operation === 'write' && /^[a-f0-9]{64}$/u.test(row.revision ?? '')))
  );
}
/** Derived from the workspace's completed-write observation, never from call arguments. */
export function observedCommit(fields?: DiagnosticFields): CommitReceipt | undefined {
  if (typeof fields?.documentRef !== 'string') return undefined;
  const [type, id, extra] = fields.documentRef.split('/');
  if (extra !== undefined) return undefined;
  const row: CommitReceipt = {
    type: type as DocRef['type'],
    id,
    operation: fields.operation as CommitReceipt['operation'],
    revision: typeof fields.revision === 'string' ? fields.revision : undefined,
  };
  return isCommit(row) ? row : undefined;
}
export function readReceipt(value: unknown): ToolReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as ToolReceipt;
  if (
    typeof row.runId !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(row.runId) ||
    !Number.isSafeInteger(row.round) ||
    row.round < 1 ||
    !/^[a-f0-9]{24}$/u.test(row.callRef) ||
    !/^[a-z][a-z_0-9]{0,47}$/u.test(row.tool) ||
    !['ok', 'partial', 'failed', 'cancelled', 'timeout'].includes(row.outcome) ||
    !Array.isArray(row.commits) ||
    row.commits.length > commitReceiptLimit ||
    !row.commits.every(isCommit) ||
    !Number.isSafeInteger(row.commitCount) ||
    row.commitCount < row.commits.length
  )
    return undefined;
  return {
    runId: row.runId,
    round: row.round,
    callRef: row.callRef,
    tool: row.tool,
    phase: row.phase === 'chapter-readback' ? row.phase : undefined,
    outcome: row.outcome,
    reason: typeof row.reason === 'string' ? receiptReason(row.reason) : undefined,
    commitCount: row.commitCount,
    commits: row.commits.map(({ type, id, operation, revision }) => ({
      type,
      id,
      operation,
      revision: operation === 'write' ? revision : undefined,
    })),
    exitCode: Number.isSafeInteger(row.exitCode) ? row.exitCode : undefined,
    resultOmitted: row.resultOmitted === true ? true : undefined,
    conventionId: isId(row.conventionId) ? row.conventionId : undefined,
  };
}
