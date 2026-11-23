import {
  requestIdPattern,
  type DiagnosticFields,
  type ReportDiagnostic,
} from '../../shared/diagnostics.js';

/** Classify without forwarding raw error text to a diagnostic record. */
export function errorReason(error: unknown, signal?: AbortSignal) {
  if (error instanceof Error && error.name === 'CommandStopError') return 'termination_uncertain';
  if (signal?.aborted) return signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
  if (!error || typeof error !== 'object') return 'unknown';
  const e = error as { name?: string; code?: string; kind?: string; detail?: string };
  if (e.name === 'AbortError') return 'cancelled';
  if (e.name === 'TimeoutError' || e.kind === 'timeout') return 'timeout';
  if (e.kind === 'auth') return 'auth';
  if (e.kind === 'network') return 'network';
  if (e.kind === 'protocol') return e.detail ?? 'protocol';
  if (e.code === 'ENOENT') return 'missing';
  if (e.code === 'invalid_references' || e.code === 'unbound_foreshadowing') return e.code;
  if (e.code === 'validation' || e.code === 'invalid_frontmatter' || e.code === 'workspace_error')
    return 'input_validation';
  if (e.code === 'conflict') return 'conflict';
  if (typeof e.code === 'string' && /^(EACCES|EPERM|EBUSY|ENOSPC|EROFS|EIO)$/.test(e.code))
    return 'io_failure';
  return 'unknown';
}
export function elapsed(start: number) {
  return Math.max(0, performance.now() - start);
}
export class DiagnosticFailure extends Error {
  constructor(
    readonly diagnosticReason: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export function classified(error: unknown, signal?: AbortSignal) {
  return !signal?.aborted && error instanceof DiagnosticFailure
    ? error.diagnosticReason
    : errorReason(error, signal);
}
export function safeReporter(report: ReportDiagnostic): ReportDiagnostic {
  return (event, fields) => {
    try {
      report(event, fields);
    } catch {
      /* Diagnostics must not affect an operation. */
    }
  };
}

/** Some RPCs transport a domain failure in a normal reply. Decode status, not its payload. */
export function responseDiagnostic(method: string, result: unknown): DiagnosticFields {
  if (!result || typeof result !== 'object') return {};
  switch (method) {
    case 'session.start': {
      const { runId } = result as { runId?: unknown };
      return typeof runId === 'string' && requestIdPattern.test(runId) ? { runId } : {};
    }
    case 'book.doc.write':
    case 'book.changes.write':
    case 'book.doc.delete': {
      const { error, committed, reason } = result as {
        error?: unknown;
        committed?: unknown[];
        reason?: string;
      };
      return !error
        ? {}
        : {
            outcome: committed?.length ? 'partial' : reason === 'conflict' ? 'conflict' : 'failed',
            reason,
          };
    }
    case 'profiles.check': {
      const { connection, tools, kind } = result as {
        connection?: boolean;
        tools?: boolean;
        kind?: string;
      };
      return !connection
        ? { outcome: 'failed', reason: kind }
        : tools
          ? {}
          : { outcome: 'partial', reason: 'provider_error' };
    }
    default:
      return {};
  }
}
