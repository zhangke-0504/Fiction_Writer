import { validateDiagnostic } from '../electron/diagnostics/contract.js';
import type { DiagnosticFields, ReportDiagnostic } from '../shared/diagnostics.js';

export function collectDiagnostics() {
  const rows: NonNullable<ReturnType<typeof validateDiagnostic>>[] = [],
    rejected: string[] = [];
  const salt = new Uint8Array(32);
  const report: ReportDiagnostic = (event: string, fields?: DiagnosticFields) => {
    const row = validateDiagnostic('worker', { event, fields }, salt);
    if (row) rows.push(row);
    else rejected.push(event);
  };
  return { rows, report, rejected };
}
