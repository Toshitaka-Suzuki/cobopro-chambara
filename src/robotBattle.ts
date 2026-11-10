import type { RosMonitor, RosPublisher, RosQos, RosSnapshot } from './ros.ts';

export const ROBOT_STATUS_TOPIC = '/chambara/battle/status';
export const ROBOT_COMMAND_TOPIC = '/chambara/battle/command';
export const ROBOT_HEARTBEAT_TOPIC = '/chambara/battle/heartbeat';
export const ROBOT_PARRY_TOPIC = '/parry';
export const ROBOT_STATUS_TIMEOUT_MS = 2_000;
export const ROBOT_HEARTBEAT_INTERVAL_MS = 250;
export const ROBOT_COMMAND_TIMEOUT_MS = 10_000;
export const ROBOT_PARRY_PULSE_MS = 100;
const CONTINUITY_INTERVAL_MS = 250;
const LOG_LIMIT = 100;

const CONTROL_QOS: RosQos = { history: 'keep_last', depth: 10, reliability: 'reliable', durability: 'volatile' };
const STATUS_QOS: RosQos = { history: 'keep_last', depth: 1, reliability: 'reliable', durability: 'transient_local' };
const STATES = ['initializing', 'standby', 'fighting', 'holding', 'stopping', 'returning', 'fault'] as const;
export type RobotState = typeof STATES[number];
export type RobotStatus = {
  type: 'status'; session: string; round: number; state: RobotState;
  human_result: 0 | 1 | null; event: string;
};
export type RobotBattleSnapshot = {
  connection: RosSnapshot['status']; online: boolean; status: RobotStatus | null;
  phase: 'idle' | 'starting' | 'fighting' | 'finishing' | 'returning' | 'fault';
  busy: boolean; canStart: boolean; heartbeat: boolean; error: string;
  logs: readonly { at: number; text: string }[];
};
type Identity = Pick<RobotStatus, 'session' | 'round'>;
type Publishers = { command: RosPublisher; heartbeat: RosPublisher; parry: RosPublisher };

/** String.data のJSONだけを受け付ける。sessionはコマンドの1トークンとして使用する。 */
export function parseRobotStatus(message: unknown): RobotStatus | null {
  if (!message || typeof message !== 'object' || !('data' in message)
    || typeof message.data !== 'string' || message.data.length > 16_384) return null;
  try {
    const value: unknown = JSON.parse(message.data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (item.type !== 'status' || typeof item.session !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.session)
      || !Number.isSafeInteger(item.round) || (item.round as number) < 0
      || !STATES.includes(item.state as RobotState)
      || ![null, 0, 1].includes(item.human_result as number | null)
      || typeof item.event !== 'string' || !item.event || item.event.length > 128) return null;
    return { type: 'status', session: item.session, round: item.round as number, state: item.state as RobotState,
      human_result: item.human_result as 0 | 1 | null, event: item.event };
  } catch { return null; }
}

/**
 * 既存ROS接続上で、1ゲーム分のロボット指示を管理する。
 * 状態監視だけでは動作を始めない。再接続・復旧で指示を再送せず、startBattleの明示呼出しを待つ。
 */
export class RobotBattleController {
  private readonly monitor: RosMonitor;
  private readonly now: () => number;
  private readonly autoTick: boolean;
  private readonly listeners = new Set<() => void>();
  private started = false;
  private stopMonitor: (() => void) | null = null;
  private stopStatus: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connection: RosSnapshot['status'] = 'disconnected';
  private connectionGeneration = 0;
  private channelFailed = false;
  private publishers: Publishers | null = null;
  private status: RobotStatus | null = null;
  private lastStatusAt: number | null = null;
  private continuitySince: number | null = null;
  private qualified = false;
  private recoveryStandbySince: number | null = null;
  private phase: RobotBattleSnapshot['phase'] = 'idle';
  private battle: Identity | null = null;
  private startingRound: number | null = null;
  private deadline: number | null = null;
  private startWait: { resolve(): void; reject(error: Error): void } | null = null;
  private heartbeat = false;
  private lastHeartbeatAt: number | null = null;
  private pulseUntil: number | null = null;
  private failing = false;
  private error = '';
  private logs: RobotBattleSnapshot['logs'] = [];
  private snapshot: RobotBattleSnapshot = {
    connection: 'disconnected', online: false, status: null, phase: 'idle',
    busy: false, canStart: false, heartbeat: false, error: '', logs: [],
  };

  constructor(monitor: RosMonitor, options: { now?: () => number; autoTick?: boolean } = {}) {
    this.monitor = monitor;
    this.now = options.now ?? (() => performance.now());
    this.autoTick = options.autoTick ?? true;
  }

  getSnapshot = (): RobotBattleSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start = (): void => {
    if (this.started) return;
    this.started = true;
    this.stopMonitor = this.monitor.subscribeState(this.connectionChanged);
    this.connectionChanged();
    if (this.autoTick) this.timer = setInterval(this.tick, 50);
  };

  stop = (): void => {
    if (!this.started) return;
    this.abort('ロボットの連携を終了しました。');
    this.started = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.stopMonitor?.();
    this.stopMonitor = null;
    this.closeChannels();
    this.connection = 'disconnected';
    this.resetFreshness();
    this.status = null;
    this.update();
  };

  /** heartbeatと/parry=0を先に送り、fightingを受信するまで開始完了にしない。 */
  startBattle = (): Promise<void> => {
    this.tick();
    if (!this.snapshot.canStart || !this.status) return Promise.reject(new Error('ロボットの新しいstandby通知を確認してから開始してください。'));
    try { this.preparePublishers(); }
    catch (error) {
      if (!this.channelFailed) this.channelError(error instanceof Error ? error : new Error(String(error)));
      return Promise.reject(new Error(this.error));
    }
    // 発行元の準備中に状態・接続の通知が同期的に変わる通信実装でも、古いstandbyで開始しない。
    this.tick();
    if (!this.snapshot.canStart || !this.status) return Promise.reject(new Error('ロボットの準備状態が変わりました。新しいstandby通知を確認してください。'));
    const battle = { session: this.status.session, round: this.status.round };
    const promise = new Promise<void>((resolve, reject) => { this.startWait = { resolve, reject }; });
    this.battle = battle;
    this.startingRound = battle.round;
    this.phase = 'starting';
    this.deadline = this.now() + ROBOT_COMMAND_TIMEOUT_MS;
    this.error = '';
    this.heartbeat = true;
    this.record('heartbeat開始（250ms周期）。戦闘終了後も復帰完了まで継続します。');
    try {
      this.sendHeartbeat();
      if (this.battle === battle) this.publishParry(0);
      if (this.battle === battle) this.publishCommand('start', battle);
    } catch (error) { this.channelError(error instanceof Error ? error : new Error(String(error))); }
    this.update();
    return promise;
  };

  finish = (humanWon: boolean): boolean => {
    this.tick();
    if (typeof humanWon !== 'boolean' || !this.battle || this.phase !== 'fighting'
      || !this.isFresh() || !this.sameIdentity(this.status) || !['fighting', 'holding'].includes(this.status!.state)) return false;
    const battle = this.battle;
    this.phase = 'finishing';
    this.deadline = this.now() + ROBOT_COMMAND_TIMEOUT_MS;
    this.pulseUntil = null;
    try {
      this.publishParry(0);
      if (this.battle === battle) this.publishCommand(`finish`, battle, humanWon ? 1 : 0);
    } catch (error) { this.channelError(error instanceof Error ? error : new Error(String(error))); }
    this.update();
    return this.snapshot.phase !== 'fault';
  };

  /** 自分が開始したゲームのみ中断する。新sessionや古い状態へ指示を送らない。 */
  abort = (reason = 'ゲームを中断しました。ロボット側の状態を確認してください。'): void => {
    if (!this.battle) return;
    this.fail(reason, true);
  };

  /** ESPの確定成功ごとに1回呼ぶ。処理中の重複は保留せず捨てる。 */
  parry = (): boolean => {
    this.tick();
    if (!this.battle || this.phase !== 'fighting' || !this.isFresh()
      || !this.sameIdentity(this.status) || this.status!.state !== 'fighting' || this.pulseUntil !== null) return false;
    this.pulseUntil = this.now() + ROBOT_PARRY_PULSE_MS;
    try { this.publishParry(1); }
    catch (error) { this.channelError(error instanceof Error ? error : new Error(String(error))); }
    this.update();
    return this.snapshot.phase !== 'fault';
  };

  tick = (): void => {
    if (!this.started) return;
    const now = this.now();
    if (this.lastStatusAt !== null && now - this.lastStatusAt >= ROBOT_STATUS_TIMEOUT_MS) {
      this.qualified = false;
      this.continuitySince = null;
      if (this.battle) {
        this.fail('ロボットの状態通知が2秒途絶えました。heartbeatを停止しました。接続とロボットの停止状態を確認してください。');
        return;
      }
      if (this.phase !== 'fault') this.error = 'ロボットの状態通知が2秒以上届いていません。';
    }
    if (this.battle && this.heartbeat && this.lastHeartbeatAt !== null && now - this.lastHeartbeatAt >= ROBOT_STATUS_TIMEOUT_MS) {
      this.fail('heartbeatの送信処理が2秒以上停止しました。遅れた指示は再送せず、ロボットの状態確認を待ちます。');
      return;
    }
    if (this.battle && this.deadline !== null && now >= this.deadline) {
      this.fail('ロボットの指示後の状態変化を10秒以内に確認できませんでした。自動再送はしません。', true);
      return;
    }
    try {
      if (this.battle && this.pulseUntil !== null && now >= this.pulseUntil) {
        this.pulseUntil = null;
        this.publishParry(0);
      }
      if (this.battle && this.heartbeat && (this.lastHeartbeatAt === null || now - this.lastHeartbeatAt >= ROBOT_HEARTBEAT_INTERVAL_MS)) this.sendHeartbeat();
    } catch (error) { this.channelError(error instanceof Error ? error : new Error(String(error))); }
    this.update();
  };

  private connectionChanged = (): void => {
    const connection = this.monitor.getSnapshot().status;
    if (!this.started || connection === this.connection) return;
    if (this.battle) this.fail('ROS接続が切り替わったため、ゲームを中断しました。以前の指示は再送しません。');
    this.closeChannels();
    this.connection = connection;
    this.channelFailed = false;
    this.status = null;
    this.resetFreshness();
    if (connection === 'connected') {
      const generation = this.connectionGeneration;
      try {
        const stop = this.monitor.watchTopic(ROBOT_STATUS_TOPIC, 'std_msgs/msg/String', message => {
          if (this.started && generation === this.connectionGeneration && !this.channelFailed) this.receive(message);
        }, error => {
          if (generation === this.connectionGeneration) this.channelError(error);
        }, { throttleRateMs: 0, queueLength: 10, qos: STATUS_QOS });
        if (generation === this.connectionGeneration && !this.channelFailed) this.stopStatus = stop;
        else stop();
      } catch (error) { this.channelError(error instanceof Error ? error : new Error(String(error))); }
    }
    this.update();
  };

  private receive(message: unknown): void {
    const status = parseRobotStatus(message);
    if (!status) return; // 不正な通知では受信期限を延長しない。
    const now = this.now();
    const previous = this.status;
    const gap = this.lastStatusAt === null || now - this.lastStatusAt >= ROBOT_STATUS_TIMEOUT_MS;
    if (gap && this.battle) this.fail('ロボットの状態通知が2秒途絶えたため、ゲームを中断しました。新しい通知が来ても自動再開しません。');
    if (gap || previous?.session !== status.session) {
      this.continuitySince = now;
      this.qualified = false;
    } else if (this.continuitySince !== null && now - this.continuitySince >= CONTINUITY_INTERVAL_MS) this.qualified = true;
    this.lastStatusAt = now;
    this.status = status;
    if (!previous || previous.state !== status.state || previous.session !== status.session || previous.round !== status.round || status.event !== 'state') {
      this.record(`状態：${status.state} / session=${status.session} round=${status.round} / ${status.event}`);
    }
    const returningStandby = !!this.battle && ['finishing', 'returning'].includes(this.phase)
      && status.state === 'standby' && status.session === this.battle.session;
    // roundの更新時点は資料で未規定。start受付で次roundへ進む実装にも対応する。
    // 送信元が1アプリである前提で、開始待ちの同session・一度だけの+1を認める。
    if (this.battle && this.phase === 'starting' && status.session === this.battle.session
      && this.startingRound !== null && status.round === this.startingRound + 1
      && (status.state === 'fighting' || (status.state === 'standby' && status.event === 'command_accepted'))) {
      this.battle.round = status.round;
    }
    if (this.battle && !this.sameIdentity(status) && !returningStandby) {
      this.fail('戦闘中にロボットのsessionまたはroundが変わりました。新しいゲームへ指示は送信しません。');
    } else if (status.state === 'fault') {
      if (this.phase !== 'fault') this.fail('ロボットがfault状態になりました。ロボット側で復旧し、新しいstandby通知を確認してください。');
    } else if (this.battle) {
      if (status.event === 'command_rejected') this.fail('ロボットがコマンドを拒否しました。状態を確認してください。');
      else if (this.phase === 'starting' && status.state === 'fighting') {
        this.phase = 'fighting';
        this.startingRound = null;
        this.deadline = null;
        const wait = this.startWait;
        this.startWait = null;
        wait?.resolve();
        this.record('戦闘開始を状態通知で確認しました。');
      } else if (returningStandby) {
        this.record('開始位置への復帰完了を確認し、heartbeatを終了しました。');
        this.battle = null;
        this.phase = 'idle';
        this.heartbeat = false;
        this.lastHeartbeatAt = null;
        this.deadline = null;
        this.pulseUntil = null;
      } else if (['finishing', 'returning'].includes(this.phase) && ['stopping', 'returning'].includes(status.state)) {
        this.phase = 'returning';
        this.deadline = null; // 復帰所要時間は資料で規定されていない。状態の鮮度で監視を続ける。
      } else if (this.phase === 'fighting' && !['fighting', 'holding'].includes(status.state)) {
        this.fail('終了指示前にロボットが戦闘状態を離れました。ゲームを中断しました。');
      } else if (this.phase === 'returning' && !['stopping', 'returning'].includes(status.state)) {
        this.fail('ロボットの復帰中に予期しない状態を受信しました。状態を確認してください。');
      }
    }
    if (this.phase === 'fault') {
      if (status.state !== 'standby') this.recoveryStandbySince = null;
      else if (this.recoveryStandbySince === null) this.recoveryStandbySince = now;
      else if (this.qualified && now - this.recoveryStandbySince >= CONTINUITY_INTERVAL_MS && !this.channelFailed) {
        this.phase = 'idle';
        this.error = '';
        this.recoveryStandbySince = null;
        this.record('新しいstandbyの継続受信を確認しました。再開にはゲーム開始操作が必要です。');
      }
    } else if (!this.battle && this.qualified && status.state === 'standby') this.error = '';
    this.update();
  }

  private preparePublishers(): void {
    if (this.publishers) return;
    const generation = this.connectionGeneration;
    const created: RosPublisher[] = [];
    const create = (topic: string, type: string) => {
      const publisher = this.monitor.createPublisher(topic, type, CONTROL_QOS, error => {
        if (generation === this.connectionGeneration) this.channelError(error);
      });
      created.push(publisher);
      if (generation !== this.connectionGeneration || this.channelFailed) throw new Error('ロボット指示の通信準備に失敗しました。');
      return publisher;
    };
    try {
      this.publishers = { command: create(ROBOT_COMMAND_TOPIC, 'std_msgs/msg/String'),
        heartbeat: create(ROBOT_HEARTBEAT_TOPIC, 'std_msgs/msg/UInt8'), parry: create(ROBOT_PARRY_TOPIC, 'std_msgs/msg/UInt8') };
    } catch (error) {
      for (const publisher of created) { try { publisher.close(); } catch { /* 残りも解除する。 */ } }
      throw error;
    }
  }

  private sendHeartbeat(): void {
    if (!this.publishers || !this.battle || !this.heartbeat) return;
    this.lastHeartbeatAt = this.now();
    this.publishers.heartbeat.publish({ data: 1 });
  }

  private publishParry(value: 0 | 1): void {
    if (!this.publishers) throw new Error('ロボットの送信準備ができていません。');
    this.record(`/parry：${value}`);
    this.publishers.parry.publish({ data: value });
  }

  private publishCommand(name: 'start' | 'finish' | 'abort', identity: Identity, result?: 0 | 1): void {
    if (!this.publishers) throw new Error('ロボットの送信準備ができていません。');
    const data = `${name} ${identity.session} ${identity.round}${result === undefined ? '' : ` ${result}`}`;
    this.record(`送信：${data}（受付・完了は状態通知で確認）`);
    this.publishers.command.publish({ data });
  }

  private fail(reason: string, sendAbort = false): void {
    if (this.failing) return;
    this.failing = true;
    const battle = this.battle;
    const send = sendAbort && battle !== null && this.isFresh() && this.sameIdentity(this.status) && !this.channelFailed;
    const wait = this.startWait;
    this.startWait = null;
    this.battle = null;
    this.startingRound = null;
    this.phase = 'fault';
    this.heartbeat = false;
    this.lastHeartbeatAt = null;
    this.deadline = null;
    this.pulseUntil = null;
    this.recoveryStandbySince = null;
    this.error = reason;
    this.record(reason);
    if (send) {
      try { this.publishParry(0); }
      catch { this.record('/parryの解除を確認できませんでした。'); }
      try { this.publishCommand('abort', battle!); }
      catch { this.record('中断指示の送信を確認できませんでした。ロボット側の状態を確認してください。'); }
    }
    wait?.reject(new Error(reason));
    this.failing = false;
    this.update();
  }

  private channelError(error: Error): void {
    this.channelFailed = true;
    this.qualified = false;
    this.fail(`ROSのロボット通信でエラー：${error.message} 再接続して状態を確認してください。`);
    this.closeChannels();
    this.update();
  }

  private closeChannels(): void {
    ++this.connectionGeneration;
    const stop = this.stopStatus;
    this.stopStatus = null;
    try { stop?.(); } catch { /* 切断後も残りを解放する。 */ }
    const publishers = this.publishers;
    this.publishers = null;
    if (publishers) for (const publisher of Object.values(publishers)) {
      try { publisher.close(); } catch { /* 切断後も残りを解放する。 */ }
    }
  }

  private sameIdentity(status: RobotStatus | null): boolean {
    return !!status && !!this.battle && status.session === this.battle.session && status.round === this.battle.round;
  }
  private isFresh(): boolean {
    return this.started && this.connection === 'connected' && !this.channelFailed && this.qualified
      && this.lastStatusAt !== null && this.now() - this.lastStatusAt < ROBOT_STATUS_TIMEOUT_MS;
  }
  private resetFreshness(): void {
    this.lastStatusAt = this.continuitySince = this.recoveryStandbySince = null;
    this.qualified = false;
  }
  private record(text: string): void { this.logs = [...this.logs, { at: this.now(), text }].slice(-LOG_LIMIT); }
  private update(): void {
    const online = this.isFresh();
    const next: RobotBattleSnapshot = { connection: this.connection, online, status: this.status, phase: this.phase,
      busy: this.battle !== null, canStart: online && this.status?.state === 'standby' && this.phase === 'idle' && !this.battle,
      heartbeat: this.heartbeat, error: this.error, logs: this.logs };
    if ((Object.keys(next) as (keyof RobotBattleSnapshot)[]).every(key => next[key] === this.snapshot[key])) return;
    this.snapshot = next;
    for (const listener of this.listeners) {
      try { listener(); } catch { /* 一つの表示処理の例外で、他の監視やゲーム停止を妨げない。 */ }
    }
  }
}
