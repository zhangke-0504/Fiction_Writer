import { createHmac } from 'node:crypto';
import { diagnosticMethods, requestIdPattern, type DiagnosticSource } from '../../shared/diagnostics.js';

type Scalar = string | number | boolean;
type Rule = (value: unknown) => Scalar | undefined;
type Schema = Readonly<Record<string, Rule>>;
const one =
  <T extends string>(...values: T[]): Rule =>
  (v) =>
    typeof v === 'string' && values.includes(v as T) ? v : undefined;
const regexp =
  (re: RegExp): Rule =>
  (v) =>
    typeof v === 'string' && re.test(v) ? v : undefined;
const uuid = regexp(requestIdPattern);
const revision = regexp(/^[a-f0-9]{8,64}$/);
const version = regexp(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:dev|alpha|beta|rc)(?:\.\d{1,5})?)?$/);
const count: Rule = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const sequence: Rule = (v) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
const duration: Rule = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 86_400_000 ? Math.round(v) : undefined;
const exitCode: Rule = (v) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= -2_147_483_648 && v <= 4_294_967_295
    ? v
    : undefined;
const httpStatus: Rule = (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599 ? v : undefined;
const bool: Rule = (v) => (typeof v === 'boolean' ? v : undefined);
const ref: Rule = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= 2048 && !/[\x00-\x1f]/.test(v) ? v : undefined;
const op = one(...diagnosticMethods);
const outcome = one(
  'ok',
  'failed',
  'partial',
  'rejected',
  'cancelled',
  'interrupted',
  'timeout',
  'skipped',
  'conflict',
  'missing',
  'superseded',
  'started',
  'cleared',
  'unknown',
);
const reason = one(
  'exception',
  'unhandled_rejection',
  'react_error',
  'load_failed',
  'preload_error',
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'initialization_failed',
  'application_exit',
  'backend_exit',
  'unavailable',
  'busy',
  'missing',
  'invalid_request',
  'invalid_options',
  'input_validation',
  'invalid_references',
  'context_required',
  'attachment_invalid',
  'profile_missing',
  'credential_unavailable',
  'transport',
  'network',
  'auth',
  'http_error',
  'protocol',
  'malformed_stream',
  'incomplete_stream',
  'output_limit',
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
  'asset_update_route',
  'invalid_skill',
  'unbound_foreshadowing',
  'novel_goal_required',
  'novel_goal_conflict',
  'novel_incomplete',
  'book_edit_incomplete',
  'provider_error',
  'unknown_tool',
  'invalid_json',
  'batch_invalid',
  'invalid_call',
  'result_limit',
  'context_limit',
  'invalid_memory',
  'memory_limit',
  'memory_not_requested',
  'invalid_arguments',
  'tool_failed',
  'command_failed',
  'command_timeout',
  'termination_uncertain',
  'cancelled',
  'timeout',
  'conflict',
  'partial_write',
  'io_failure',
  'iteration_limit',
  'continue_tools',
  'complete',
  'existing_content',
  'no_source',
  'no_match',
  'not_requested',
  'agent',
  'draft',
  'append',
  'replace',
  'insert',
  'readback',
  'managed',
  'watcher',
  'command',
  'focus',
  'sequence_gap',
  'backend_reset',
  'load',
  'user',
  'unknown',
);
const lane = one('agent', 'asset', 'draft', 'readback', 'probe', 'compaction');
const tool = one(
  'list_files',
  'search_text',
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'run_command',
  'book_get_context',
  'book_search_text',
  'book_propose_edits',
  'book_apply_changes',
  'book_generate_chapter',
  'book_patch_chapter',
  'book_patch_asset',
  'book_clean_insert_echo',
  'book_generate_assets',
  'book_read_chapter',
  'book_memory_recall',
  'book_memory_remember',
  'book_memory_forget',
  'tool_search',
  'book_task_scope',
  'skill_search',
  'skill_load',
  'fixture_value',
  'unknown',
);
const skill = one('story-consistency', 'write-chapter', 'generate-novel');
const area = one('runtime', 'library', 'workspace', 'document');
const refreshReason = one(
  'load',
  'focus',
  'book_change',
  'sequence_gap',
  'snapshot_advanced',
  'backend_reset',
  'user',
  'profiles_change',
);
const applied = {
  workspaceRef: ref,
  documentRef: ref,
  reloadId: uuid,
  journalSeq: count,
  workerId: uuid,
};
const action = one('draft', 'append', 'replace', 'insert');
const docType = one('book', 'outline', 'subject', 'clue', 'chapter');
const writingTask = {
  writingTask: one('chapter', 'subject', 'clue'),
  writingAction: one('draft', 'append', 'replace', 'insert', 'create', 'fill', 'update'),
};
const writingTemplate = {
  ...writingTask,
  template: one('write-chapter', 'write-subject', 'write-clue'),
  fingerprint: revision,
};
const writingCounts = { includedRequired: count, includedOptional: count, omittedOptional: count };
const writingStage = one('selection', 'input_budget', 'anchors', 'candidate', 'output_budget');
const writingIssueKind = one(
  'missing_asset',
  'empty_description',
  'missing_section',
  'no_visible_evidence',
  'invalid_anchor',
  'continuity_conflict',
  'budget_limit',
);
const writingFailureRequired = [
  'runId',
  'spanId',
  'workspaceRef',
  'writingTask',
  'writingAction',
  'writingStage',
] as const;
const writingGroup = one(
  'target',
  'book',
  'outline',
  'subject',
  'clue',
  'previous',
  'memory',
  'readback',
  'boundary',
  'reference',
);
const writingRequired = [
  'runId',
  'spanId',
  'workspaceRef',
  'writingTask',
  'writingAction',
  'template',
  'fingerprint',
] as const;
const writingCountsRequired = [
  ...writingRequired,
  'includedRequired',
  'includedOptional',
  'omittedOptional',
] as const;
const memoryRecall = { recallId: uuid, trigger: one('draft', 'tool') };
const memoryDispatch = { recallId: uuid, trigger: one('draft', 'tool') };
const memoryCounts = {
  storyCount: count,
  planCount: count,
  referenceCount: count,
  conventionCount: count,
};
const memoryRequired = ['runId', 'workspaceRef', 'recallId', 'trigger'] as const;
const memoryDispatchRequired = [...memoryRequired, 'spanId'] as const;
const core: Schema = {
  requestId: uuid,
  runId: uuid,
  spanId: uuid,
  originalSpanId: uuid,
  attempt: sequence,
  workerId: uuid,
  rendererId: uuid,
  sessionRef: ref,
  workspaceRef: ref,
  documentRef: ref,
  fileRef: ref,
  profileRef: ref,
  chapterIndex: count,
  changeId: uuid,
  turn: count,
  callId: uuid,
  lane,
};
const final: Schema = { outcome, reason, elapsedMs: duration };
const bookEvent: Schema = {
  journalSeq: count,
  revision,
  expectedRevision: revision,
  actualRevision: revision,
  docType,
};
interface Definition {
  sources: readonly DiagnosticSource[];
  fields: Schema;
  level?: 'info' | 'warn' | 'error';
  ui?: true;
  required?: readonly string[];
}
const main = (fields: Schema, level?: Definition['level']): Definition => ({
  sources: ['main'],
  fields,
  level,
});
const worker = (
  fields: Schema,
  level?: Definition['level'],
  required?: readonly string[],
): Definition => ({
  sources: ['worker'],
  fields,
  level,
  required,
});
const ui = (fields: Schema, required: readonly string[], level?: Definition['level']): Definition => ({
  sources: ['renderer'],
  fields,
  level,
  ui: true,
  required,
});
const writingFailure = worker(
  { ...writingTask, writingStage, outcome, reason, blockedSources: count },
  'warn',
  [...writingFailureRequired, 'outcome', 'reason', 'blockedSources'],
);

const diag = new Map<string, Definition>(
  Object.entries({
    'app.started': main({ version, pid: count }),
    'app.stopping': main({ reason }),
    'app.stopped': main({ ...final }),
    'app.fatal': main({ reason }, 'error'),
    'window.started': main({}),
    'window.closed': main({}),
    'window.closing': main({ reason }),
    'window.load_failed': main({ code: exitCode, reason }, 'error'),
    'window.renderer_gone': main({ code: exitCode, reason }, 'error'),
    'worker.spawned': main({ pid: count }),
    'worker.exited': main({ code: exitCode, reason, expected: bool, pending: count }),
    'worker.restarting': main({ reason }, 'warn'),
    'worker.ready': worker({ pid: count }),
    'worker.initialization_failed': worker({ reason }, 'error'),
    'credential.finished': main({ operation: one('encrypt', 'decrypt'), ...final }),
    'ipc.started': main({ method: op }),
    'ipc.finished': main({ method: op, ...final }),
    'ipc.worker.started': worker({ method: op }),
    'ipc.worker.finished': worker({ method: op, ...final }),
    'ui.operation.started': { sources: ['renderer'], fields: { method: op } },
    'ui.operation.finished': { sources: ['renderer'], fields: { method: op, ...final } },
    'ui.ready': ui({}, []),
    'ui.error': ui(
      { reason: one('exception', 'unhandled_rejection', 'react_error') },
      ['reason'],
      'error',
    ),
    'ui.section': ui(
      {
        section: one('library', 'settings', 'book', 'outline', 'subject', 'clue', 'chapter', 'harness'),
        workspaceRef: ref,
        documentRef: ref,
      },
      ['section'],
    ),
    'ui.book_change_received': ui(
      {
        journalSeq: sequence,
        workerId: uuid,
        changeId: uuid,
        workspaceRef: ref,
      },
      ['journalSeq', 'workerId', 'changeId'],
    ),
    'ui.sequence_gap': ui(
      { journalSeq: sequence, workerId: uuid, expectedSeq: sequence, via: one('push', 'snapshot') },
      ['journalSeq', 'expectedSeq', 'via'],
      'warn',
    ),
    'ui.reload.started': ui({ area, ...applied, reason: refreshReason }, ['area', 'reloadId']),
    'ui.reload.finished': ui(
      {
        area,
        ...applied,
        reason: refreshReason,
        outcome: one('ok', 'failed', 'superseded'),
        elapsedMs: duration,
        revision,
        count,
        issueCount: count,
      },
      ['area', 'reloadId', 'outcome', 'elapsedMs'],
    ),
    'ui.revision_applied': ui({ ...applied, revision }, ['workspaceRef', 'documentRef', 'revision']),
    'ui.draft_preserved': ui(
      { ...applied, expectedRevision: revision, revision, reason: one('conflict', 'missing') },
      ['workspaceRef', 'documentRef', 'expectedRevision', 'reason'],
      'warn',
    ),
    'ui.preview': ui({ workspaceRef: ref, documentRef: ref, outcome: one('started', 'cleared') }, [
      'workspaceRef',
      'documentRef',
      'outcome',
    ]),
    'session.created': worker({}),
    'session.deleted': worker({}),
    'session.workspace_unavailable': worker({}),
    'run.rejected': worker({ reason }, 'warn'),
    'run.started': worker({ effort: one('low', 'medium', 'high', 'default') }),
    'run.finished': worker({ ...final }),
    'run.recovered': worker({ ...final }),
    'run.stop_requested': worker({ reason }),
    'run.stop_finished': worker({ ...final }),
    'model.started': worker({
      protocol: one('chat', 'responses', 'messages'),
      effort: one('low', 'medium', 'high', 'default'),
      messageCount: count,
      toolCount: count,
    }),
    'model.budget_dispatched': worker({
      purpose: one('standard', 'long-writing', 'probe', 'compaction', 'readback'),
      budgetBasis: one('first-whole-skill', 'active-whole-skill'),
      capabilitySource: one('provider', 'provider-fallback', 'generic-fallback'),
      contextWindow: sequence,
      maxOutputTokens: sequence,
      estimatedInput: count,
      maxTokens: sequence,
    }),
    'probe.finished': worker({ ...final, step: one('connection', 'tools') }),
    'model.http': worker({ httpStatus, elapsedMs: duration }),
    'model.first_event': worker({ elapsedMs: duration }),
    'model.messages_arguments_invalid': worker(
      {
        messageClosed: bool,
        stopType: one('tool_use', 'end_turn', 'stop_sequence'),
        reason,
        count,
        invalidCount: count,
        omitted: count,
      },
      'warn',
    ),
    'model.messages_argument_block': worker(
      { blockIndex: count, fragmentCount: count, bytes: count, reason },
      'warn',
    ),
    'model.arguments_retry': worker({ reason }, 'warn'),
    'model.output_limit_recovery': worker({
      recovery: one(
        'dispatched',
        'advanced',
        'completed',
        'ineligible',
        'no_safe_step',
        'input_blocked',
        'repeat_limit',
        'attempt_used',
        'failed',
        'cancelled',
        'invalid_step',
        'no_progress',
      ),
      reason,
    }),
    'writing.edit.scope': worker({
      editMode: one('direct', 'proposal', 'confirmed', 'unresolved'),
      outcome,
      reason,
      count,
      done: count,
    }),
    'writing.edit.sync': worker({ outcome: one('ok', 'failed', 'reused', 'pending'), count, reason }),
    'writing.edit.sync.candidate': worker({
      outcome: one('ok', 'rejected'),
      attempt: count,
      count,
      observed: count,
      issue: one(
        'json',
        'evidence_array',
        'evidence_count',
        'edits_array',
        'edits_count',
        'source_index',
      ),
    }),
    'context.projected': worker({
      newReadEstimate: count,
      historicalReadEstimate: count,
      projectedResults: count,
    }),
    'context.compacted': worker({ count, omittedCount: count }),
    'context.checkpoint': worker({ count, source: one('model', 'excerpt') }),
    'memory.recall.finished': worker(
      {
        ...memoryRecall,
        ...memoryCounts,
        outcome: one('ok', 'failed', 'cancelled'),
        reason,
        elapsedMs: duration,
      },
      undefined,
      [...memoryRequired, 'outcome', 'elapsedMs'],
    ),
    'memory.index.finished': worker(
      {
        ...memoryRecall,
        cacheAction: one('unchanged', 'created', 'updated', 'degraded', 'cancelled'),
        cacheIssue: one('read_failed', 'invalid_format', 'write_failed', 'processing_failed'),
        outcome: one('ok', 'partial', 'cancelled'),
        reusedCount: count,
        rebuiltCount: count,
        staleCount: count,
        elapsedMs: duration,
      },
      undefined,
      [...memoryRequired, 'cacheAction', 'outcome', 'elapsedMs'],
    ),
    'memory.context.dispatched': worker(
      { ...memoryDispatch, ...memoryCounts, sourceCount: count, omittedSources: count },
      undefined,
      [...memoryDispatchRequired, ...Object.keys(memoryCounts), 'sourceCount', 'omittedSources'],
    ),
    'memory.context.source': worker(
      {
        ...memoryDispatch,
        docType,
        revision,
        sourceType: one('story', 'plan', 'reference'),
        sourceChapterOrder: sequence,
      },
      undefined,
      [...memoryDispatchRequired, 'documentRef', 'docType', 'revision', 'sourceType'],
    ),
    'model.finished': worker({
      ...final,
      httpStatus,
      textLength: count,
      toolCount: count,
      providerStop: one('output_limit'),
    }),
    'loop.round.started': worker({}),
    'loop.round.finished': worker({ ...final, toolCount: count }),
    'tool.batch_rejected': worker({ count, omitted: count, reason }, 'warn'),
    'tool.requested': worker({ tool, fieldCount: count, unknownFieldCount: count }),
    'tool.validated': worker({ tool, fieldCount: count }),
    'tool.rejected': worker({ tool, reason }, 'warn'),
    'tool.started': worker({ tool }),
    'tool.discovery': worker({ count, outcome }),
    'writing.task_scope': worker({ count, outcome, reason }),
    'writing.task_result': worker({ count, done: count, outcome }),
    'tool.finished': worker({
      tool,
      ...final,
      transportOk: bool,
      exitCode,
      timedOut: bool,
      truncated: bool,
      termination: one('none', 'confirmed', 'uncertain'),
      affected: count,
      bytes: count,
    }),
    'tool.file': worker({
      operation: one('read', 'write', 'delete', 'list', 'search'),
      affected: count,
      bytes: count,
      truncated: bool,
    }),
    'command.started': worker({ timeoutMs: duration }),
    'command.finished': worker({
      ...final,
      exitCode,
      timedOut: bool,
      truncated: bool,
      termination: one('none', 'confirmed', 'uncertain'),
    }),
    'tool.result_ready': worker({ tool, outcome }),
    'tool.result_sent': worker({ tool, nextTurn: count, delivery: one('full', 'projected') }),
    'tool.result_omitted': worker({ tool, reason }),
    'skill.search': worker({ candidates: count }),
    'skill.candidate': worker({ skill }),
    'skill.loaded': worker({ skill, fingerprint: revision }),
    'skill.failed': worker({ skill, reason }, 'warn'),
    'skill.applied': worker({ skill, fingerprint: revision, reason }),
    'writing.context.blocked': writingFailure,
    'writing.context.rejected_result': writingFailure,
    'writing.context.issue': worker(
      {
        ...writingTask,
        writingStage,
        issueKind: writingIssueKind,
        docType,
        revision,
        part: one('stable', 'visible', 'reveal'),
      },
      'info',
      [...writingFailureRequired, 'issueKind'],
    ),
    'writing.context.prepared': worker(
      { ...writingTemplate, ...writingCounts },
      'info',
      writingCountsRequired,
    ),
    'writing.context.dispatched': worker(
      { ...writingTemplate, ...writingCounts },
      'info',
      writingCountsRequired,
    ),
    'writing.context.group': worker(
      { ...writingTemplate, ...writingCounts, group: writingGroup },
      'info',
      [...writingCountsRequired, 'group'],
    ),
    'writing.context.source': worker(
      { ...writingTemplate, group: writingGroup, required: bool, docType, revision },
      'info',
      [...writingRequired, 'group', 'required', 'docType', 'documentRef', 'revision'],
    ),
    'chapter.generation.started': worker({ action }),
    'chapter.generation.finished': worker({ ...final, action, revision }),
    'novel.goal': worker({
      operation: one('register', 'resume', 'check'),
      outcome,
      done: count,
      total: count,
    }),
    'novel.chapter.reused': worker({ reason }),
    'chapter.retry': worker({ reason }),
    'chapter.patch.review': worker({
      verdict: one('approved', 'denied', 'invalid_verdict', 'incomplete'),
      hasVisibleText: bool,
    }),
    'chapter.patch.finished': worker({ outcome, reason, count, revision }),
    'asset.patch.finished': worker({
      docType: one('subject', 'clue'),
      outcome,
      reason,
      count,
      revision,
    }),
    'chapter.patch.part': worker({ partRef: ref, outcome, reason, revision }),
    'chapter.insertion.receipt': worker({ insertionRef: uuid, revision }),
    'chapter.insertion.cleanup': worker({
      insertionRef: uuid,
      outcome,
      reason,
      revision,
      expectedRevision: revision,
      syncPending: count,
      syncRetained: count,
    }),
    'chapter.insertion.checked': worker({
      outcome: one('ok', 'rejected'),
      issue: one(
        'echo_only',
        'neighbor_echo',
        'boundary_echo',
        'repeated_passage',
        'work_note',
        'obvious_typo',
      ),
      count,
      attempt: count,
    }),
    'chapter.preview': worker({ outcome: one('started', 'cleared'), textLength: count }),
    'chapter.readback.started': worker({ candidates: count }),
    'chapter.readback.item': worker({ ...final, textLength: count }),
    'chapter.readback.finished': worker({
      ...final,
      requested: count,
      hits: count,
      missing: count,
      rejected: count,
      ignored: count,
    }),
    'workspace.commit.started': worker({ count, operation: one('create', 'write', 'delete') }),
    'workspace.commit.finished': worker({
      ...final,
      committed: count,
      pending: count,
      operation: one('create', 'write', 'delete'),
    }),
    'workspace.preconditions': worker({ ...final, ...bookEvent, count, guardCount: count }),
    'workspace.document.pending': worker({ docType }),
    'workspace.document.committed': worker({ ...bookEvent, operation: one('write', 'delete') }),
    'workspace.conflict': worker(
      { ...bookEvent, reason, step: one('guard', 'plan', 'replace') },
      'warn',
    ),
    'workspace.notified': worker({ journalSeq: count, count, reason }),
    'diagnostics.loss': main({ overflow: count, io: count, expired: count, cleanup: count }, 'warn'),
  }),
);
const promoted = new Set([
  'failed',
  'partial',
  'rejected',
  'timeout',
  'conflict',
  'interrupted',
  'missing',
]);
function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
/** Writes only reconstructed values; a producer can never supply the public log envelope. */
export function validateDiagnostic(
  source: DiagnosticSource,
  input: unknown,
  salt: Uint8Array,
  fromRenderer = false,
) {
  if (
    !record(input) ||
    Object.keys(input).some((key) => key !== 'event' && key !== 'fields') ||
    typeof input.event !== 'string'
  )
    return;
  const definition = diag.get(input.event);
  if (
    !definition?.sources.includes(source) ||
    (fromRenderer && (source !== 'renderer' || !definition.ui))
  )
    return;
  const raw = input.fields === undefined ? {} : input.fields;
  if (!record(raw) || Object.keys(raw).length > 32) return;
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(raw)) {
    const rule = Object.hasOwn(definition.fields, key)
      ? definition.fields[key]
      : !fromRenderer && Object.hasOwn(core, key)
        ? core[key]
        : undefined;
    if (!rule) return;
    if (value === undefined) continue;
    const checked = rule(value);
    if (checked === undefined) return;
    out[key] =
      rule === ref || (rule === revision && key !== 'fingerprint')
        ? createHmac('sha256', salt)
            .update((rule === revision ? 'revision' : key) + '\0' + checked)
            .digest('hex')
            .slice(0, 16)
        : checked;
  }
  if (definition.required?.some((key) => !Object.hasOwn(out, key))) return;
  const level =
    definition.level ?? (typeof out.outcome === 'string' && promoted.has(out.outcome) ? 'warn' : 'info');
  return { event: input.event, level, fields: out };
}
