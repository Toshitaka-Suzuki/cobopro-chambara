import { EspLineDecoder } from './espProtocol.ts';
import type { EspEvent } from './espProtocol.ts';
import type { Difficulty, GamePhase } from './game.ts';
import type { IntegratedSession } from './integratedSession.ts';
import type { SerialMonitor } from './serial.ts';
import { RHYTHM_STALE_MS } from './rhythm.ts';

export const ESP_DEFAULT_ADVANCE_MS = 200;
export const ESP_MAX_ADVANCE_MS = 500;
export const ESP_RESULT_WAIT_MS = 1_200;
export const ESP_WEAK_WINDOW_MS = 10_000;
const MAX_COMMAND_LATENESS_MS = 100;
const WRITE_TIMEOUT_MS = 1_000;
const MAX_LOG_ENTRIES = 80;

export type LegacyEspSnapshot = {
  connected: boolean;
  ready: boolean;
  advanceMs: number;
  error: string;
  log: readonly { at: number; text: string }[];
};
type Options = { now?: () => number; autoTick?: boolean };
type Plan = {
  key: string;
  commands: { command: string; at: number }[];
  next: number;
  activeSent: boolean;
  resultDeadline: number;
  targetAt: number;
};

/** 資料の既存コマンドと確定ログだけを使用する試験用の中継。FWへの追加要求はない。 */
export class LegacyEspController {
  private readonly monitor: SerialMonitor;
  private readonly session: IntegratedSession;
  private readonly now: () => number;
  private readonly autoTick: boolean;
  private readonly decoder = new EspLineDecoder();
  private readonly listeners = new Set<() => void>();
  private subscriptions: (() => void)[] | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private checking = false;
  private epoch = 0;
  private gameGeneration = 0;
  private gamePhase: GamePhase = 'idle';
  private phaseSince = 0;
  private cooldownUntil = 0;
  private plan: Plan | null = null;
  private weakStartedAt: number | null = null;
  private weakEndAt: number | null = null;
  private writes = new Map<symbol, number>();
  private snapshot: LegacyEspSnapshot = {
    connected: false, ready: false, advanceMs: ESP_DEFAULT_ADVANCE_MS, error: '', log: [],
  };

  constructor(monitor: SerialMonitor, session: IntegratedSession, options: Options = {}) {
    this.monitor = monitor;
    this.session = session;
    this.now = options.now ?? (() => performance.now());
    this.autoTick = options.autoTick ?? true;
  }

  getSnapshot = (): LegacyEspSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start = (): void => {
    if (this.subscriptions) return;
    this.decoder.reset();
    this.subscriptions = [this.monitor.subscribeState(this.onSerial),
      this.monitor.subscribeText(this.onText), this.session.subscribe(this.onSession)];
    this.onSerial();
    if (this.autoTick) this.timer = setInterval(this.tick, 10);
  };

  stop = (): void => {
    if (this.running) {
      this.shutdown();
      this.session.cancel();
    }
    this.subscriptions?.forEach(unsubscribe => unsubscribe());
    this.subscriptions = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.decoder.reset();
  };

  setAdvanceMs = (value: number): void => {
    if (this.running || !Number.isInteger(value) || value < 0 || value > ESP_MAX_ADVANCE_MS) return;
    this.update({ advanceMs: value });
  };

  startGame = (difficulty: Difficulty): boolean => {
    this.refreshReady();
    if (!this.subscriptions || !this.snapshot.ready || !this.session.ready) return false;
    const state = this.session.getSnapshot();
    if (!state.espSupported || !state.rhythmSupported) {
      this.update({ error: 'ESP連携対応のPythonアプリへ更新・再起動し、4拍ガイドを有効にしてください。' });
      return false;
    }
    this.running = true;
    this.gameGeneration++;
    this.epoch++;
    this.decoder.reset();
    this.plan = null;
    this.weakStartedAt = this.weakEndAt = null;
    this.gamePhase = 'idle';
    this.update({ error: '', log: [], ready: false });
    if (!this.session.start(difficulty, 'esp_legacy')) {
      this.running = false;
      this.update({ error: this.session.getSnapshot().error });
      this.refreshReady();
      return false;
    }
    this.record(`開始：前倒し ${this.snapshot.advanceMs}ms（実測して調整）／弱点A・10秒`);
    this.transmit('r');
    this.transmit('p 0');
    return true;
  };

  /** テストでも同じ予定時刻と期限判定を使う。 */
  tick = (): void => {
    if (this.checking) return;
    this.checking = true;
    try {
      this.refreshReady();
      if (!this.running) return;
      const now = this.now();
      if ([...this.writes.values()].some(at => now - at >= WRITE_TIMEOUT_MS)) {
        this.fail('USBへの指示送信が完了しません。接続を確認してください。');
        void this.monitor.disconnect();
        return;
      }
      const state = this.session.getSnapshot();
      if (state.phase !== 'battle') return;
      if (state.game.phase === 'defend') {
        const rhythm = state.rhythm;
        if (!rhythm || !rhythm.active || now - rhythm.receivedAt > RHYTHM_STALE_MS) {
          if (this.plan || now - this.phaseSince > 5_000) {
            this.fail('音の時刻を確認できないため、ESP連携を中断しました。Pythonの音声出力・接続を確認してください。');
          }
          return;
        }
        const key = `${rhythm.generation}:${rhythm.beatsMs.join(',')}`;
        if (this.plan && this.plan.key !== key) {
          this.fail('結果待ち中にパリィの予定が変わりました。PythonをESP連携対応版へ更新してください。');
          return;
        }
        if (!this.plan) {
          // Python音声位置とブラウザー時計の対応は最初の正常な応答で固定する。
          // 同期更新のたびに予約時刻を動かすと、送信間隔まで変動してしまう。
          const base = rhythm.receivedAt - rhythm.positionMs;
          const targetAt = base + rhythm.beatsMs[3];
          const advance = this.snapshot.advanceMs;
          this.plan = { key, next: 0, activeSent: false, targetAt,
            resultDeadline: targetAt + rhythm.windowMs / 2 + ESP_RESULT_WAIT_MS,
            commands: [
              { command: 'p 1', at: base + rhythm.beatsMs[0] - advance },
              { command: 'p 2', at: targetAt - rhythm.windowMs / 2 - advance },
              { command: 'p 0', at: targetAt + rhythm.windowMs / 2 - advance },
            ] };
          this.record(`予定：カン ${Math.round(targetAt)}ms ／ ${advance}ms前倒し`);
        }
        const plan = this.plan;
        const command = plan.commands[plan.next];
        if (command && now >= command.at) {
          const late = now - command.at;
          if (late > MAX_COMMAND_LATENESS_MS) {
            this.fail(`指示の送信予定を${Math.round(late)}ms過ぎたため中断しました。画面を前面にして、前倒し量やPC負荷を確認してください。`);
            return;
          }
          plan.next++;
          if (command.command === 'p 2') plan.activeSent = true;
          this.transmit(command.command, command.at);
        }
        if (now >= plan.resultDeadline) {
          this.record('成功通知なし：衝撃なし・通信欠落は区別できません。次の機会へ進みます。');
          this.session.espParryUnconfirmed();
        }
      } else if (state.game.phase === 'attack' && this.weakStartedAt !== null) {
        if (this.weakEndAt !== null) {
          if (now >= this.weakEndAt) this.session.espWeakEnd();
        } else if (now - this.weakStartedAt >= ESP_WEAK_WINDOW_MS + ESP_RESULT_WAIT_MS) {
          this.fail('弱点Aの終了通知が届きません。弱点Aの電源・ESP-NOW通信・ログ形式を確認してください。');
        }
      }
    } finally {
      this.checking = false;
    }
  };

  private onSerial = (): void => {
    const connected = this.monitor.getSnapshot().status === 'connected';
    if (connected !== this.snapshot.connected) {
      this.decoder.reset();
      this.epoch++;
      this.update({ connected });
      if (!connected && this.running) this.fail('XIAOとのUSB接続が切れたため、ゲームを中断しました。');
    }
    this.refreshReady();
  };

  private onSession = (): void => {
    if (!this.running) { this.refreshReady(); return; }
    const state = this.session.getSnapshot();
    if (state.connection !== 'connected' || state.parrySource !== 'esp_legacy'
      || ['standby', 'ending', 'post_interview', 'complete', 'cancelling'].includes(state.phase)) {
      this.shutdown();
      return;
    }
    if (state.game.phase !== this.gamePhase) {
      const oldPhase = this.gamePhase;
      this.gamePhase = state.game.phase;
      this.phaseSince = this.now();
      this.epoch++;
      this.decoder.discardPending();
      if (oldPhase === 'defend') {
        this.plan = null;
        this.transmit('p 0');
      }
      if (oldPhase === 'attack') this.weakStartedAt = this.weakEndAt = null;
      if (state.phase === 'battle' && state.game.phase === 'attack') {
        this.weakStartedAt = this.now();
        this.weakEndAt = null;
        this.transmit('w A');
      }
    }
    this.tick();
  };

  private onText = (text: string): void => {
    if (!this.snapshot.connected) return;
    const epoch = this.epoch;
    for (const event of this.decoder.push(text)) {
      if (epoch !== this.epoch) break;
      this.handleEvent(event);
    }
  };

  private handleEvent(event: EspEvent): void {
    const now = this.now();
    this.record(`受信：${event.type}${'weakpoint' in event ? ` ${event.weakpoint}` : ''}`);
    if (!this.running || this.session.getSnapshot().phase !== 'battle') return;
    if (event.type === 'parry_success') {
      if (!this.plan?.activeSent || now > this.plan.resultDeadline || this.gamePhase !== 'defend') return;
      this.record(`パリィ採用：カン予定から${Math.round(now - this.plan.targetAt)}ms後に通知（衝撃時刻ではありません）`);
      this.session.espParrySuccess();
    } else if (event.weakpoint === 'A' && this.gamePhase === 'attack' && this.weakStartedAt !== null) {
      if (event.type === 'weak_hit') this.session.espWeakHit();
      else if (this.weakEndAt === null) {
        // 終了通知には命中後の終了も含まれる。近接した命中通知を少し待ってから次へ進む。
        this.weakEndAt = now + 300;
      }
    }
  }

  private transmit(command: string, plannedAt?: number): void {
    if (!this.monitor.canWrite) return;
    const token = Symbol(command);
    this.writes.set(token, this.now());
    const generation = this.gameGeneration;
    this.record(`送信要求：${command}${plannedAt === undefined ? '' : ` ／ 予定との差 +${Math.round(this.now() - plannedAt)}ms`}`);
    void this.monitor.writeLine(command).then(() => {
      this.writes.delete(token);
      if (generation === this.gameGeneration) this.record(`USB書込完了：${command}`);
      this.refreshReady();
      if (generation === this.gameGeneration && this.running && plannedAt !== undefined && this.now() - plannedAt > MAX_COMMAND_LATENESS_MS) {
        this.fail('USB送信の遅れが大きいため、ゲームを中断しました。');
      }
    }, () => {
      this.writes.delete(token);
      this.refreshReady();
      if (generation === this.gameGeneration && this.running) this.fail('XIAOへの指示を送信できませんでした。USB接続を確認してください。');
    });
  }

  private shutdown(): void {
    this.running = false;
    this.gameGeneration++;
    this.plan = null;
    this.weakStartedAt = this.weakEndAt = null;
    this.epoch++;
    this.decoder.reset();
    this.monitor.discardPendingWrites();
    this.cooldownUntil = this.now() + ESP_RESULT_WAIT_MS;
    this.transmit('p 0');
    this.transmit('r');
    this.record('停止：p 0 / r を送信。機器側の受領を保証するACKはありません。');
    this.refreshReady();
  }

  private fail(error: string): void {
    this.update({ error });
    this.record(error);
    if (this.running) {
      this.shutdown();
      this.session.cancel(error);
    }
  }

  private refreshReady(): void {
    this.update({ ready: this.snapshot.connected && this.monitor.canWrite && this.monitor.baudRate === 115200
      && !this.running && this.writes.size === 0 && this.now() >= this.cooldownUntil });
  }

  private record(text: string): void {
    this.update({ log: [...this.snapshot.log, { at: this.now(), text }].slice(-MAX_LOG_ENTRIES) });
  }

  private update(changes: Partial<LegacyEspSnapshot>): void {
    if (Object.entries(changes).every(([key, value]) => this.snapshot[key as keyof LegacyEspSnapshot] === value)) return;
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of [...this.listeners]) listener();
  }
}
