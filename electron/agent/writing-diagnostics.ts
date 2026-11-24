import { diagnosticScope, type ReportDiagnostic } from '../../shared/diagnostics.js';
import { docKey } from '../documents.js';
import { safeReporter } from '../diagnostics/trace.js';
import {
  WritingContextFailure,
  type WritingBlock,
  type WritingRequest,
  type WritingIssue,
  type WritingScope,
} from './writing-request.js';

const taskFields = ({ kind, action }: WritingScope) => ({ writingTask: kind, writingAction: action });

type FailureStage = 'selection' | 'input_budget' | 'anchors' | 'candidate' | 'output_budget';

function reportIssues(
  report: ReportDiagnostic,
  scope: WritingScope,
  stage: FailureStage,
  reason: string,
  blockedSources: number,
  issues: readonly WritingIssue[],
) {
  const safe = safeReporter(report);
  const fields = { ...taskFields(scope), writingStage: stage };
  const event =
    stage === 'candidate' || stage === 'output_budget'
      ? 'writing.context.rejected_result'
      : 'writing.context.blocked';
  safe(event, {
    ...fields,
    outcome: reason === 'conflict' ? 'conflict' : 'failed',
    reason,
    blockedSources,
  });
  for (const { kind, ref, revision, part } of issues.slice(0, 12))
    safe('writing.context.issue', {
      ...fields,
      issueKind: kind,
      part,
      revision,
      ...(ref && { docType: ref.type, documentRef: docKey(ref) }),
    });
}

export function reportWritingBlock(
  report: ReportDiagnostic,
  scope: WritingScope,
  error: WritingContextFailure,
  stage?: FailureStage,
) {
  reportIssues(
    report,
    scope,
    stage ??
      (error.diagnosticReason === 'context_limit'
        ? 'input_budget'
        : error.issues.some(({ kind }) => kind === 'invalid_anchor' || kind === 'continuity_conflict')
          ? 'anchors'
          : 'selection'),
    error.diagnosticReason,
    error.refs.length,
    error.issues,
  );
}

export function reportWritingOutputLimit(
  report: ReportDiagnostic,
  scope: WritingScope,
  blockedSources = 0,
) {
  reportIssues(report, scope, 'output_budget', 'output_limit', blockedSources, [
    { kind: 'budget_limit' },
  ]);
}

/** Observe the final wire projection, never the larger selection before filtering or fitting. */
export function prepareWritingDispatch(
  report: ReportDiagnostic,
  scope: WritingScope,
  compiled: WritingRequest,
  spanId: string,
) {
  const base = safeReporter(report);
  const fields = {
    ...taskFields(scope),
    template: compiled.template,
    fingerprint: compiled.fingerprint,
  };
  const counts = (included: readonly WritingBlock[], omitted: readonly WritingBlock[]) => ({
    includedRequired: included.filter((block) => block.required).length,
    includedOptional: included.filter((block) => !block.required).length,
    omittedOptional: omitted.length,
  });
  const summary = { ...fields, ...counts(compiled.included, compiled.omitted) };
  diagnosticScope(base, { spanId })('writing.context.prepared', summary);
  return (dispatchedSpanId: string) => {
    const dispatched = diagnosticScope(base, { spanId: dispatchedSpanId });
    dispatched('writing.context.dispatched', summary);
    const groups = new Set([...compiled.included, ...compiled.omitted].map(({ group }) => group));
    for (const group of groups)
      dispatched('writing.context.group', {
        ...fields,
        group,
        ...counts(
          compiled.included.filter((b) => b.group === group),
          compiled.omitted.filter((b) => b.group === group),
        ),
      });
    const seen = new Set<string>();
    for (const { group, required, sources } of compiled.included) {
      for (const { type, id, revision } of sources ?? []) {
        const documentRef = docKey({ type, id });
        const key = `${group}:${documentRef}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dispatched('writing.context.source', {
          ...fields,
          group,
          required: !!required,
          documentRef,
          docType: type,
          revision,
        });
        if (seen.size === 12) return;
      }
    }
  };
}
