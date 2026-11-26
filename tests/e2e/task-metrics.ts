import type { Log } from './diagnostic-files.js';

export function taskMetrics(trace: Log[], runId: string) {
  const rows = trace.filter(({ fields }) => fields.runId === runId);
  const dispatch = rows.filter(({ event }) => event === 'model.budget_dispatched');
  const main = dispatch.filter(({ fields }) => fields.lane === 'agent');
  const scopes = rows.filter(
    ({ event, fields }) => event === 'writing.task_scope' && fields.outcome === 'ok',
  );
  const ended = rows.find(({ event }) => event === 'run.finished');
  const finishedSpans = new Set(
    rows.filter(({ event }) => event === 'model.finished').map(({ fields }) => fields.spanId),
  );
  const active = new Set<string>();
  let taskOverlap = 0;
  for (const { event, fields } of rows) {
    if (fields.lane !== 'task') continue;
    if (event === 'model.budget_dispatched' && finishedSpans.has(fields.spanId)) {
      active.add(fields.spanId);
      taskOverlap = Math.max(taskOverlap, active.size);
    } else if (event === 'model.finished') active.delete(fields.spanId);
  }
  const projected = rows.filter(
    ({ event, fields }) => event === 'context.projected' && fields.lane === 'agent',
  );
  const resultEstimates = projected.map(
    ({ fields }) =>
      Number(fields.newReadEstimate) +
      Number(fields.historicalReadEstimate) +
      Number(fields.newTaskEstimate ?? 0) +
      Number(fields.historicalTaskEstimate ?? 0),
  );
  const countReads = (lane: string) =>
    rows.filter(
      ({ event, fields }) =>
        event === 'tool.started' &&
        fields.lane === lane &&
        ['book_get_context', 'book_search_text'].includes(fields.tool),
    ).length;
  return {
    mainRequests: main.length,
    preScope: main.filter(({ logSeq }) => logSeq < (scopes[0]?.logSeq ?? Infinity)).length,
    peakInput: main.length ? Math.max(...main.map(({ fields }) => Number(fields.estimatedInput))) : null,
    peakResult: resultEstimates.length ? Math.max(...resultEstimates) : null,
    mainOutputLimits: [...new Set(main.map(({ fields }) => Number(fields.maxTokens)))],
    taskOutputLimits: [
      ...new Set(
        dispatch
          .filter(({ fields }) => fields.lane === 'task')
          .map(({ fields }) => Number(fields.maxTokens)),
      ),
    ],
    taskOverlap,
    tasks: new Set(
      dispatch.filter(({ fields }) => fields.lane === 'task').map(({ fields }) => fields.taskId),
    ).size,
    taskRequests: dispatch.filter(({ fields }) => fields.lane === 'task').length,
    parentReads: countReads('agent'),
    childReads: countReads('task'),
    totalRequests: dispatch.length,
    elapsedMs: ended?.fields.elapsedMs,
    outcome: ended?.fields.outcome,
  };
}
