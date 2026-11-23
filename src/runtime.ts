import { useEffect, useState } from 'react';
import type { RuntimeView } from '../shared/contracts';
import { api } from './bridge';
import type { UiRefreshContext } from '../shared/diagnostics';
import { startReload } from './diagnostics';
import { errorMessage } from './ui';

/** Sequence gaps invalidate both the workspace projection and the run snapshot. */
export function useRuntime() {
  const [view, setView] = useState<RuntimeView>({ cursor: 0, sessions: [] });
  const [refresh, setRefresh] = useState<UiRefreshContext>({ reason: 'load' }),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false,
      loading = false,
      needed = true,
      seen = 0,
      epoch = 0;
    let workerId: string | undefined;
    let traceTrigger: UiRefreshContext | undefined = { reason: 'load' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!disposed && !loading && !timer)
        timer = setTimeout(() => {
          timer = undefined;
          void load();
        }, 24);
    };
    const load = async () => {
      if (!needed || disposed) return;
      loading = true;
      needed = false;
      const current = epoch,
        started = performance.now();
      const trigger = traceTrigger;
      let reload = trigger && startReload('runtime', trigger, started);
      traceTrigger = undefined;
      try {
        const snapshot = await api.request<RuntimeView>('runtime.snapshot');
        if (!disposed && current === epoch) {
          workerId = snapshot.workerId ?? workerId;
          if (snapshot.cursor >= seen) {
            if (snapshot.cursor > seen) {
              // The snapshot can overtake a push. Refresh the file projection before treating it as seen.
              api.diagnostic('ui.sequence_gap', {
                workerId,
                expectedSeq: seen + 1,
                journalSeq: snapshot.cursor,
                via: 'snapshot',
              });
              seen = snapshot.cursor;
              const trigger = { workerId, journalSeq: seen, reason: 'snapshot_advanced' } as const;
              reload ??= startReload('runtime', trigger, started);
              setRefresh(trigger);
            }
            setView(snapshot);
            reload?.finish('ok');
          } else {
            reload?.finish('superseded');
            traceTrigger ??= trigger;
            needed = true;
          }
          setError('');
        } else reload?.finish('superseded');
      } catch (e) {
        reload?.finish(disposed || current !== epoch ? 'superseded' : 'failed');
        if (!disposed) setError(errorMessage(e));
      } finally {
        loading = false;
        if (needed) schedule();
      }
    };
    const off = api.subscribe((event) => {
      if (event.type === 'toggle-harness') return;
      if (typeof event.workerId === 'string') workerId = event.workerId;
      if (event.type === 'backend-reset') {
        seen = 0;
        epoch++;
      }
      let gap = false;
      const seq = typeof event.seq === 'number' ? event.seq : undefined;
      if (seq !== undefined) {
        // Receipt and application are distinct: an already-reconciled push may be ignored below.
        if (
          event.type === 'book-change' &&
          typeof event.workerId === 'string' &&
          typeof event.changeId === 'string'
        )
          api.diagnostic('ui.book_change_received', {
            journalSeq: seq,
            workerId: event.workerId,
            changeId: event.changeId,
            workspaceRef: typeof event.bookId === 'string' ? event.bookId : undefined,
          });
        if (seq <= seen) return;
        gap = seq > seen + 1;
        if (gap)
          api.diagnostic('ui.sequence_gap', {
            workerId,
            expectedSeq: seen + 1,
            journalSeq: seq,
            via: 'push',
          });
        seen = seq;
      }
      if (gap || event.type !== 'runtime-change') {
        const reason = gap
          ? 'sequence_gap'
          : event.type === 'book-change'
            ? 'book_change'
            : event.type === 'backend-reset'
              ? 'backend_reset'
              : event.type === 'focus'
                ? 'focus'
                : 'profiles_change';
        const trigger: UiRefreshContext = { journalSeq: seq, workerId, reason };
        traceTrigger = trigger;
        setRefresh(trigger);
      }
      needed = true;
      schedule();
    });
    void load();
    return () => {
      disposed = true;
      off();
      clearTimeout(timer);
    };
  }, []);
  return { view, refresh, error };
}
