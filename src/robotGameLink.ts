import { isGameFinished } from './game.ts';
import type { IntegratedSession } from './integratedSession.ts';
import type { RobotBattleController } from './robotBattle.ts';

type Robot = Pick<RobotBattleController, 'getSnapshot' | 'subscribe' | 'startBattle' | 'finish' | 'abort' | 'parry'>;
export type RobotGameLinkSnapshot = {
  enabled: boolean;
  active: boolean;
  waitingForRobot: boolean;
  error: string;
};

/** 任意のロボット連動。ロボットの戦闘開始を確認するまでPythonのBGMとゲーム時計を開始しない。 */
export class RobotGameLink {
  private listeners = new Set<() => void>();
  private subscriptions: (() => void)[] | null = null;
  private snapshot: RobotGameLinkSnapshot = { enabled: false, active: false, waitingForRobot: false, error: '' };
  private generation = 0;
  private identity: { session: string; round: number } | null = null;
  private requested = false;
  private finished = false;
  private previous: ReturnType<IntegratedSession['getSnapshot']>;
  private readonly robot: Robot;
  private readonly session: IntegratedSession;

  constructor(robot: Robot, session: IntegratedSession) {
    this.robot = robot;
    this.session = session;
    this.previous = session.getSnapshot();
  }

  getSnapshot = (): RobotGameLinkSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  start = (): void => {
    if (this.subscriptions) return;
    this.previous = this.session.getSnapshot();
    this.subscriptions = [this.robot.subscribe(this.onRobot), this.session.subscribe(this.onSession)];
  };
  stop = (): void => {
    if (this.snapshot.active || this.robot.getSnapshot().busy) this.abort('画面を終了したため、ロボット連動を中断しました。');
    this.subscriptions?.forEach(stop => stop());
    this.subscriptions = null;
  };

  setEnabled = (enabled: boolean): boolean => {
    if (this.snapshot.active || this.session.active || this.robot.getSnapshot().busy) return false;
    this.update({ enabled, error: '' });
    return true;
  };

  /** 会話から始める一連のゲームを予約する。この時点ではロボットを動かさない。 */
  beginGame = (start: () => boolean): boolean => {
    if (this.snapshot.active || this.session.active || this.robot.getSnapshot().busy) return false;
    const robot = this.robot.getSnapshot();
    if (this.snapshot.enabled && (!robot.canStart || !robot.status)) return false;
    this.generation++;
    this.identity = this.snapshot.enabled && robot.status ? { session: robot.status.session, round: robot.status.round } : null;
    this.requested = this.finished = false;
    this.update({ active: this.snapshot.enabled, waitingForRobot: false, error: '' });
    const started = start();
    if (!started) this.update({ active: false });
    if (started && this.snapshot.enabled && this.session.getSnapshot().parrySource !== 'esp_legacy') {
      this.abort('ロボット連動ではESPの成功判定を使用してください。');
      return false;
    }
    return started;
  };

  /** カウントダウン終了から呼ぶ。連動OFFなら従来どおりPythonだけを開始する。 */
  startBattle = (): void => {
    if (!this.snapshot.enabled) { this.session.startBattle(); return; }
    if (!this.snapshot.active || this.snapshot.waitingForRobot || this.session.getSnapshot().phase !== 'countdown') return;
    const robot = this.robot.getSnapshot();
    if (!robot.canStart || !this.sameIdentity()) {
      this.abort('ロボットの開始準備が変わったため中断しました。接続と待機状態を確認してください。');
      return;
    }
    const generation = this.generation;
    this.requested = true;
    this.update({ waitingForRobot: true });
    void this.robot.startBattle().then(() => {
      if (generation !== this.generation || !this.snapshot.active) return;
      if (this.session.getSnapshot().phase !== 'countdown') {
        this.abort('ゲームの開始手順が中断されたため、ロボットも中断しました。');
        return;
      }
      this.session.startBattle();
      this.update({ waitingForRobot: false });
    }).catch((error: unknown) => {
      if (generation === this.generation && this.snapshot.active) {
        this.abort(error instanceof Error ? error.message : 'ロボットの戦闘開始を確認できませんでした。');
      }
    });
  };

  abort = (reason = 'ロボット連動を中断しました。機器の状態を確認してください。'): void => {
    const shouldAbort = this.requested || this.robot.getSnapshot().busy;
    this.generation++;
    this.requested = false;
    this.identity = null;
    this.update({ active: false, waitingForRobot: false, error: reason });
    // 再入した状態通知が、古いゲームを再び操作しないよう先に予約を破棄する。
    if (shouldAbort) this.robot.abort(reason);
    if (this.session.active) this.session.cancel(reason);
  };

  private sameIdentity(): boolean {
    const status = this.robot.getSnapshot().status;
    return !!status && !!this.identity && status.session === this.identity.session && status.round === this.identity.round;
  }

  private onRobot = (): void => {
    if (!this.snapshot.active) return;
    const robot = this.robot.getSnapshot();
    if (!robot.online || robot.phase === 'fault' || robot.error) {
      this.abort(robot.error || 'ロボットの新しい状態を確認できないため中断しました。');
      return;
    }
    if (!this.requested && (!robot.canStart || !this.sameIdentity())) {
      this.abort('会話・準備中にロボットの状態が変わったため、開始を中止しました。');
      return;
    }
    this.settle();
  };

  private onSession = (): void => {
    const next = this.session.getSnapshot();
    const previous = this.previous;
    this.previous = next;
    if (!this.snapshot.active) return;
    if (!this.finished && isGameFinished(next.game.phase)) {
      this.finished = true;
      if (!this.robot.finish(next.game.phase === 'win')) {
        this.abort('ロボットへ正常終了を指示できませんでした。機器の状態を確認してください。');
        return;
      }
    } else if (!this.finished && (next.connection !== 'connected' || ['cancelling', 'standby'].includes(next.phase))) {
      this.abort(next.error || 'ゲームが中断されたため、ロボット連動も中断しました。');
      return;
    } else if (!this.finished && next.phase === 'battle' && next.parrySource === 'esp_legacy'
      && next.game.phase === 'success' && previous.game.phase !== 'success') {
      this.robot.parry();
    }
    this.settle();
  };

  private settle(): void {
    // 感想会話を離れても、正常終了後の復帰監視とheartbeatを止めない。
    if (this.finished && !this.robot.getSnapshot().busy) {
      this.requested = false;
      this.identity = null;
      this.update({ active: false });
    }
  }

  private update(changes: Partial<RobotGameLinkSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}
