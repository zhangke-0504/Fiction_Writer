import type { ReportableUiEvents, UiReloadContext } from '../shared/diagnostics';
import { api } from './bridge';

type Result = Pick<ReportableUiEvents['ui.reload.finished'], 'revision' | 'count' | 'issueCount'>;
export function startReload(
  area: ReportableUiEvents['ui.reload.started']['area'],
  context: UiReloadContext = {},
  started = performance.now(),
) {
  const reloadId = crypto.randomUUID();
  const fields = { ...context, area, reloadId };
  api.diagnostic('ui.reload.started', fields);
  return {
    origin: { reloadId, journalSeq: context.journalSeq, workerId: context.workerId },
    finish(outcome: ReportableUiEvents['ui.reload.finished']['outcome'], result?: Result) {
      api.diagnostic('ui.reload.finished', {
        ...fields,
        outcome,
        elapsedMs: performance.now() - started,
        ...result,
      });
    },
  };
}
