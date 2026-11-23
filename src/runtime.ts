import { useEffect, useState } from 'react';
import type { RuntimeView } from '../shared/contracts';
import { api } from './bridge';
import { errorMessage } from './ui';

/** Sequence gaps invalidate both the workspace projection and the run snapshot. */
export function useRuntime() {
  const [view, setView] = useState<RuntimeView>({ cursor: 0, sessions: [] });
  const [refresh, setRefresh] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false,
      loading = false,
      needed = true,
      seen = 0,
      epoch = 0;
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
      const current = epoch;
      try {
        const snapshot = await api.request<RuntimeView>('runtime.snapshot');
        if (!disposed && current === epoch) {
          if (snapshot.cursor >= seen) {
            if (snapshot.cursor > seen) {
              // The snapshot can overtake a push. Refresh the file projection before treating it as seen.
              seen = snapshot.cursor;
              setRefresh((n) => n + 1);
            }
            setView(snapshot);
          } else needed = true;
          setError('');
        }
      } catch (e) {
        if (!disposed) setError(errorMessage(e));
      } finally {
        loading = false;
        if (needed) schedule();
      }
    };
    const off = api.subscribe((event) => {
      if (event.type === 'toggle-harness') return;
      if (event.type === 'backend-reset') {
        seen = 0;
        epoch++;
      }
      let gap = false;
      if (typeof event.seq === 'number') {
        if (event.seq <= seen) return;
        gap = event.seq > seen + 1;
        seen = event.seq;
      }
      if (gap || event.type !== 'runtime-change') setRefresh((n) => n + 1);
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
