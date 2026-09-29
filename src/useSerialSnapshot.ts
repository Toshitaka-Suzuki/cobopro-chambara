import { useCallback, useEffect, useState } from 'react';
import type { SerialMonitor } from './serial';

export function useSerialSnapshot(monitor: SerialMonitor) {
  const [snapshot, setSnapshot] = useState(() => monitor.getSnapshot());
  const [now, setNow] = useState(Date.now);
  const refresh = useCallback(() => {
    setSnapshot(monitor.getSnapshot());
    setNow(Date.now());
  }, [monitor]);

  useEffect(() => {
    // Keep display updates bounded even when the serial source is very busy.
    // The application owns the connection; leaving this view only stops polling.
    const timer = window.setInterval(refresh, 100);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { snapshot, now, refresh };
}
