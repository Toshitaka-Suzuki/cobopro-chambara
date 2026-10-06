import { useCallback, useEffect, useState } from 'react';
import type { SerialMonitor } from './serial';

const DISPLAY_REFRESH_INTERVAL_MS = 100;

/**
 * 表示用の状態と現在時刻を 100 ms ごとに取得し、即時取得用の refresh も返す。
 * 接続は App が所有するため、アンマウント時はポーリングだけを止める。
 */
export function useSerialSnapshot(monitor: SerialMonitor) {
  const [snapshot, setSnapshot] = useState(() => monitor.getSnapshot());
  const [now, setNow] = useState(Date.now);
  const refresh = useCallback(() => {
    setSnapshot(monitor.getSnapshot());
    setNow(Date.now());
  }, [monitor]);

  useEffect(() => {
    // 高頻度の受信でも UI 更新は一定間隔に抑える。
    const timer = window.setInterval(refresh, DISPLAY_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { snapshot, now, refresh };
}
