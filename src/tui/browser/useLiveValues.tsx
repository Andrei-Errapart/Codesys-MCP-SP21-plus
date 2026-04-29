import React from 'react';
import { LiveValueSnapshot } from '../shared/live-values.js';
import { readLiveValues } from '../shared/live-values-read.js';

/**
 * Poll the live-values file every `intervalMs` and return the values map
 * iff the snapshot's pou_name matches the requested `pouName`. Returns
 * null when:
 *   - pouName is null (cursor not on a POU)
 *   - file is missing / stale / invalid
 *   - snapshot's pou_name disagrees with the requested pouName
 */
export function useLiveValues(
  filePath: string | null,
  pouName: string | null,
  intervalMs = 500
): Record<string, LiveValueSnapshot> | null {
  const [values, setValues] = React.useState<Record<string, LiveValueSnapshot> | null>(null);

  React.useEffect(() => {
    if (!filePath || !pouName) {
      setValues(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const r = await readLiveValues(filePath);
      if (cancelled) return;
      if (r.status === 'ok' && r.payload.pou_name === pouName) {
        setValues(r.payload.values);
      } else {
        setValues(null);
      }
      timer = setTimeout(tick, intervalMs);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [filePath, pouName, intervalMs]);

  return values;
}
