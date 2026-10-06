import type { SerialMonitor, SerialSnapshot } from './serial.ts';
import { SwordClashDecoder } from './swordProtocol.ts';

// 接触信号がこの時間途切れた後の入力を、新しい接触として扱う。実機の送信間隔に応じて調整する。
export const SENSOR_QUIET_PERIOD_MS = 250;

export type SwordSensorSnapshot = {
  connected: boolean;
  ready: boolean;
  clashesReceived: number;
  lastClashAt: number | null;
};

/** シリアル入力を接触イベントに変換する。生成だけでは購読せず、start / stop で監視する。 */
export class SwordSensorInput {
  private readonly monitor: SerialMonitor;
  private readonly now: () => number;
  private readonly decoder = new SwordClashDecoder();
  private readonly stateListeners = new Set<(snapshot: SwordSensorSnapshot) => void>();
  private readonly clashListeners = new Set<() => void>();
  private subscriptions: (() => void)[] | null = null;
  private connectionVersion = 0;
  private deliveryVersion = 0;
  private lastSignalAtMs: number | null = null;
  private snapshot: SwordSensorSnapshot = {
    connected: false, ready: false, clashesReceived: 0, lastClashAt: null,
  };

  constructor(monitor: SerialMonitor, now: () => number = () => performance.now()) {
    this.monitor = monitor;
    this.now = now;
  }

  /** 現在の入力確認状態を返す。変更がない間は同じ参照を返すため、呼び出し側では書き換えない。 */
  getSnapshot = (): SwordSensorSnapshot => this.snapshot;

  /** 以後の状態変更を同期通知する。初期状態は再送せず、返した関数で購読を解除する。 */
  subscribeState = (listener: (snapshot: SwordSensorSnapshot) => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  };

  /** 連続した信号を1回にまとめ、新しい接触だけを同期通知する。過去の接触は再送しない。 */
  subscribeClash = (listener: () => void): (() => void) => {
    this.clashListeners.add(listener);
    return () => { this.clashListeners.delete(listener); };
  };

  /** 現在の接続状態を取り込み、新着入力の監視を始める。監視中の再呼び出しは何もしない。 */
  start = (): void => {
    if (this.subscriptions) return;
    this.decoder.reset();
    this.subscriptions = [
      this.monitor.subscribeState(this.handleSerialState),
      this.monitor.subscribeText(this.handleText),
    ];
    this.handleSerialState(this.monitor.getSnapshot());
  };

  /** 監視と受信履歴をリセットする。シリアル接続と、このクラスへの購読は維持する。 */
  stop = (): void => {
    this.subscriptions?.forEach((unsubscribe) => unsubscribe());
    this.subscriptions = null;
    this.resetConnection(false);
  };

  /**
   * 場面変更・一時停止時に未完の行と、処理中の USB チャンクの残り配信を無効化する。
   * 受信行の集計と連続信号の抑制は続け、場面をまたぐ残信号を新しい接触にしない。
   */
  discardPending = (): void => {
    this.deliveryVersion++;
    this.decoder.discardPending();
  };

  private handleSerialState = (serial: SerialSnapshot): void => {
    const connected = serial.status === 'connected';
    if (connected === this.snapshot.connected) return;
    this.resetConnection(connected);
  };

  /** 完全な接触行を集計して配信する。通知中の切断・場面変更は後続の通知にも反映する。 */
  private handleText = (text: string): void => {
    if (!this.subscriptions || !this.snapshot.connected) return;
    const connectionVersion = this.connectionVersion;
    const deliveryVersion = this.deliveryVersion;
    const count = this.decoder.push(text);
    const receivedAtMs = this.now();
    const isNewContact = this.lastSignalAtMs === null || receivedAtMs - this.lastSignalAtMs >= SENSOR_QUIET_PERIOD_MS;
    // 配信しない信号でも静穏待ちを延ばす。場面変更や購読の切り替えでは解除しない。
    if (count > 0) this.lastSignalAtMs = receivedAtMs;
    for (let index = 0; index < count; index++) {
      if (!this.isCurrentConnection(connectionVersion)) break;
      this.update({
        ready: true,
        clashesReceived: this.snapshot.clashesReceived + 1,
        lastClashAt: Date.now(),
      });
      // 状態通知の途中で stop / disconnect が呼ばれることもある。
      if (!this.isCurrentConnection(connectionVersion)) break;
      // 同じ受信チャンクの信号には時間差を識別できないため、最大1回だけ配信する。
      if (!isNewContact || index > 0) continue;
      for (const listener of [...this.clashListeners]) {
        // 先に呼ばれた購読者が場面変更した場合は、残りの購読者にも渡さない。
        if (!this.isCurrentConnection(connectionVersion) || this.deliveryVersion !== deliveryVersion) break;
        try {
          listener();
        } catch {
          // 購読者の例外で他の購読者への配信を止めない。
        }
      }
    }
  };

  private isCurrentConnection(version: number): boolean {
    return this.subscriptions !== null && this.snapshot.connected && this.connectionVersion === version;
  }

  private resetConnection(connected: boolean): void {
    // 接続ごとの入力確認と部分行をリセットし、処理中の古い通知も無効化する。
    this.connectionVersion++;
    this.decoder.reset();
    this.lastSignalAtMs = null;
    this.update({ connected, ready: false, clashesReceived: 0, lastClashAt: null });
  }

  private update(changes: Partial<SwordSensorSnapshot>): void {
    if (Object.entries(changes).every(([key, value]) => this.snapshot[key as keyof SwordSensorSnapshot] === value)) return;
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of [...this.stateListeners]) {
      try {
        listener(this.snapshot);
      } catch {
        // UI の例外で入力の解釈や接続の後始末を止めない。
      }
    }
  }
}
