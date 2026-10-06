import { useCallback, useSyncExternalStore } from 'react';
import type { RosMonitor, RosSnapshot } from './ros';

const MESSAGE_RENDER_INTERVAL_MS = 100;

/**
 * ROS の最新状態を表示用に購読する。受信だけの変更はまとめ、接続や操作結果は即時に通知する。
 * アンマウント時は表示の購読とタイマーだけを解除し、ROS 接続や topic 購読は操作しない。
 */
export function useRosSnapshot(monitor: RosMonitor): RosSnapshot {
  const subscribe = useCallback((notify: () => void) => {
    let previous = monitor.getSnapshot();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const unsubscribe = monitor.subscribeState(next => {
      const receivedMessageOnly = next.status === previous.status && next.error === previous.error
        && next.topics === previous.topics && next.services === previous.services
        && next.service === previous.service && next.call === previous.call
        && next.topic.name === previous.topic.name && next.topic.status === previous.topic.status
        && next.topic.receivedCount > previous.topic.receivedCount;
      previous = next;
      if (receivedMessageOnly) {
        timer ??= setTimeout(() => { timer = null; notify(); }, MESSAGE_RENDER_INTERVAL_MS);
      } else { cancel(); notify(); }
    });
    return () => { cancel(); unsubscribe(); };
  }, [monitor]);
  return useSyncExternalStore(subscribe, monitor.getSnapshot);
}
