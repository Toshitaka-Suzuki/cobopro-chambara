import { INITIAL_GAME_STATE, TARGETS, isGameFinished, transitionGame } from './game.ts';
import type { GameAction, GameState, TargetId } from './game.ts';
import { parseParryFeedback, parseRhythm } from './rhythm.ts';
import type { ParryFeedback, RhythmSnapshot } from './rhythm.ts';

export const DEFAULT_APP_URL = 'ws://127.0.0.1:8765';
export type ExperienceMode = 'standalone' | 'integrated';
export type IntegratedPhase = 'standby' | 'starting' | 'pre_interview' | 'countdown'
  | 'starting_battle' | 'battle' | 'ending' | 'post_interview' | 'complete' | 'cancelling';
export type IntegratedSnapshot = {
  connection: 'disconnected' | 'connecting' | 'connected';
  phase: IntegratedPhase;
  url: string;
  conversationMode: 'live' | 'mock' | 'mock_silent';
  game: GameState;
  pendingParry: boolean;
  error: string;
  rhythmSupported: boolean;
  rhythm: RhythmSnapshot | null;
  parryFeedback: ParryFeedback | null;
};
export type AppSocket = Pick<WebSocket, 'onopen' | 'onmessage' | 'onerror' | 'onclose' | 'send' | 'close'>;
type Pending = { name: string; deadline: number; sentAt: number; target?: TargetId };
type Options = {
  socketFactory?: (url: string) => AppSocket;
  now?: () => number;
  random?: () => number;
  autoTick?: boolean;
};
const RESPONSE_TIMEOUT_MS = 10_000;

export function appUrlError(value: string, secure = false): string | null {
  try {
    const url = new URL(value.trim());
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      return 'ws:// または wss:// で始まる接続先を指定してください。';
    }
    if (secure && url.protocol === 'ws:') return 'HTTPSの画面では wss:// の接続先が必要です。';
    return null;
  } catch { return '接続先のURLを確認してください。'; }
}

/** Pythonの会話・判定とブラウザーのゲームを同期する。切断後の再送・自動再開はしない。 */
export class IntegratedSession {
  private readonly options: Required<Options>;
  private socket: AppSocket | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, Pending>();
  private serial = 0;
  private handshake = false;
  private postFinished = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private phaseSince = 0;
  private lastHeartbeat = 0;
  private lastRhythmSync = -Infinity;
  private snapshot: IntegratedSnapshot = {
    connection: 'disconnected', phase: 'standby', url: DEFAULT_APP_URL,
    conversationMode: 'live', game: INITIAL_GAME_STATE, pendingParry: false, error: '',
    rhythmSupported: false, rhythm: null, parryFeedback: null,
  };

  constructor(options: Options = {}) {
    this.options = {
      socketFactory: url => new WebSocket(url), now: () => performance.now(),
      random: Math.random, autoTick: true, ...options,
    };
  }

  getSnapshot = (): IntegratedSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get ready(): boolean {
    return this.snapshot.connection === 'connected' && ['standby', 'complete'].includes(this.snapshot.phase);
  }
  get active(): boolean {
    return !['standby', 'complete'].includes(this.snapshot.phase);
  }

  connect = (url: string): void => {
    this.disconnect();
    const error = appUrlError(url, typeof location !== 'undefined' && location.protocol === 'https:');
    if (error) { this.update({ error }); return; }
    this.phaseSince = this.lastHeartbeat = this.options.now();
    this.update({ connection: 'connecting', url: url.trim(), error: '', game: INITIAL_GAME_STATE });
    try {
      const socket = this.options.socketFactory(url.trim());
      this.socket = socket;
      socket.onmessage = event => {
        if (this.socket === socket) this.receive(event.data);
      };
      socket.onerror = () => {
        if (this.socket === socket) this.fail('統合アプリに接続できません。起動状態と接続先を確認してください。');
      };
      socket.onclose = () => {
        if (this.socket === socket) this.fail('統合アプリとの接続が切れました。再接続して新しいゲームを始めてください。');
      };
      if (this.options.autoTick) this.timer = setInterval(this.tick, 50);
    } catch {
      this.fail('統合アプリに接続できません。接続先を確認してください。');
    }
  };

  disconnect = (): void => {
    const socket = this.socket;
    this.socket = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.pending.clear();
    this.handshake = false;
    this.postFinished = false;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    this.update({ connection: 'disconnected', phase: 'standby', pendingParry: false,
      rhythmSupported: false, rhythm: null, parryFeedback: null });
  };

  start = (): boolean => {
    if (!this.ready) return false;
    this.postFinished = false;
    this.update({ game: INITIAL_GAME_STATE, error: '', phase: 'starting', rhythm: null, parryFeedback: null });
    return this.send('game_start');
  };

  skipInterview = (): void => {
    if (this.snapshot.phase === 'pre_interview') this.update({ phase: 'countdown' });
  };

  startBattle = (): void => {
    if (this.snapshot.phase !== 'countdown') return;
    this.update({ phase: 'starting_battle' });
    this.send('battle_start');
  };

  cancel = (message = ''): void => {
    if (!this.active || this.snapshot.phase === 'cancelling' || this.snapshot.connection !== 'connected') return;
    this.pending.clear();
    this.update({ phase: 'cancelling', pendingParry: false, error: message, rhythm: null, parryFeedback: null });
    this.send('game_cancel');
  };

  /** ローカルの成功判定は使わず、受け入力はPythonからの判定を待つ。 */
  action = (action: GameAction): void => {
    if (this.snapshot.phase !== 'battle') return;
    const oldPhase = this.snapshot.game.phase;
    this.advance();
    if (this.snapshot.phase !== 'battle') return;
    const game = this.snapshot.game;
    if (action.type === 'contact' && oldPhase !== game.phase) return;
    if ((action.type === 'contact' || action.type === 'swordClash') && game.phase === 'defend') {
      if (this.snapshot.pendingParry) return;
      const target = TARGETS[Math.floor(this.options.random() * TARGETS.length)].id;
      this.update({ pendingParry: true });
      this.send('parry', undefined, target);
      return;
    }
    if (!['contact', 'hit', 'miss', 'balloon'].includes(action.type)) return;
    this.applyGame(transitionGame(game, action));
  };

  tick = (): void => {
    const now = this.options.now();
    if (this.snapshot.connection === 'disconnected') return;
    if ((this.snapshot.connection === 'connecting'
      || ['starting', 'starting_battle', 'ending', 'cancelling'].includes(this.snapshot.phase))
      && now - this.phaseSince >= RESPONSE_TIMEOUT_MS) {
      this.fail('統合アプリの応答がありません。接続を確認して、最初からやり直してください。');
      return;
    }
    for (const item of this.pending.values()) {
      if (now >= item.deadline) {
        this.fail('統合アプリからの応答が途切れたため、ゲームを終了しました。');
        return;
      }
    }
    this.advance();
    if (this.snapshot.phase === 'battle' && this.snapshot.rhythmSupported && now - this.lastRhythmSync >= 200
      && !Array.from(this.pending.values()).some(item => item.name === 'rhythm_sync')) {
      this.lastRhythmSync = now;
      this.send('rhythm_sync');
    }
    if (this.snapshot.connection === 'connected' && now - this.lastHeartbeat >= 5_000) {
      this.lastHeartbeat = now;
      this.send('heartbeat');
    }
  };

  private advance(): void {
    if (this.snapshot.phase !== 'battle') return;
    const now = this.options.now();
    const elapsedMs = now - this.lastTick;
    this.lastTick = now;
    this.applyGame(transitionGame(this.snapshot.game, { type: 'tick', elapsedMs }));
  }

  private applyGame(game: GameState): void {
    const previous = this.snapshot.game;
    if (game === previous) return;
    if (game.phase !== previous.phase) {
      for (const [id, item] of this.pending) if (item.name === 'parry') this.pending.delete(id);
    }
    const finished = isGameFinished(game.phase);
    const phaseChanged = game.phase !== previous.phase;
    const resetRhythm = phaseChanged || game.hp !== previous.hp;
    if (resetRhythm) {
      for (const [id, item] of this.pending) if (item.name === 'rhythm_sync') this.pending.delete(id);
      this.lastRhythmSync = -Infinity;
    }
    this.update({ game, ...(game.phase !== previous.phase ? { pendingParry: false } : {}),
      ...(finished ? { phase: 'ending' } as const : {}),
      ...(resetRhythm ? { rhythm: null } : {}),
      ...(phaseChanged && game.phase === 'defend' ? { parryFeedback: null } : {}) });
    if (this.snapshot.rhythmSupported && phaseChanged && !finished) {
      if (game.phase === 'defend') this.send('defense_ready');
      else if (previous.phase === 'defend') this.send('defense_pause');
    }
    if (game.hp !== previous.hp) this.send('weak_point_count', game.hp);
    else if (finished && !isGameFinished(previous.phase)) this.send('battle_end');
  }

  private send(name: string, count?: number, target?: TargetId): boolean {
    if (!this.socket || this.snapshot.connection !== 'connected') return false;
    const request_id = String(++this.serial);
    const sentAt = this.options.now();
    this.pending.set(request_id, { name, deadline: sentAt + RESPONSE_TIMEOUT_MS, sentAt, target });
    try {
      this.socket.send(JSON.stringify({ type: 'signal', name, request_id, ...(count === undefined ? {} : { count }) }));
      return true;
    } catch {
      this.fail('信号を送信できませんでした。再接続してください。');
      return false;
    }
  }

  private receive(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch {
      this.fail('統合アプリから不正な応答を受信しました。');
      return;
    }
    if (message.type === 'connected') {
      if (message.protocol_version !== 2) {
        this.fail('統合アプリを更新してください。この画面には通信仕様v2が必要です。');
        return;
      }
      this.handshake = true;
      const mode = message.conversation_mode;
      this.update({ conversationMode: mode === 'mock' || mode === 'mock_silent' ? mode : 'live',
        rhythmSupported: message.rhythm_guide === true });
    } else if (message.type === 'error') {
      this.fail(typeof message.text === 'string' ? message.text : '統合アプリでエラーが発生しました。');
    } else if (message.type === 'status') {
      if (this.handshake) this.status(message.value);
    } else if (message.type === 'received') {
      const id = String(message.request_id);
      const item = this.pending.get(id);
      if (item && item.name === message.name && item.name !== 'parry') this.pending.delete(id);
    } else if (message.type === 'rhythm_state') {
      const id = String(message.request_id);
      const item = this.pending.get(id);
      if (item?.name !== 'rhythm_sync') return;
      this.pending.delete(id);
      if (this.snapshot.phase === 'battle') {
        this.update({ rhythm: parseRhythm(message, item.sentAt, this.options.now()) });
      }
    } else if (message.type === 'parry_result') {
      const id = String(message.request_id);
      const item = this.pending.get(id);
      if (item?.name !== 'parry') return;
      this.pending.delete(id);
      this.advance();
      this.update({ pendingParry: false });
      if (this.snapshot.phase !== 'battle' || this.snapshot.game.phase !== 'defend') return;
      this.update({ parryFeedback: parseParryFeedback(message) });
      if (message.value === 'success') {
        this.applyGame(transitionGame(this.snapshot.game, { type: 'swordClash', target: item.target }));
      } else if (message.value === 'failure') {
        if (message.reason === 'not_ready') {
          this.update({ game: { ...this.snapshot.game, notice: '音楽の準備中です。次の一撃に備えよう。' } });
        } else {
          this.applyGame(transitionGame(this.snapshot.game, { type: 'miss' }));
        }
      } else this.fail('パリイ結果を確認できませんでした。');
    }
  }

  private status(value: unknown): void {
    const phase = this.snapshot.phase;
    if (value === 'standby') {
      if (this.snapshot.connection === 'connecting' || phase === 'cancelling' || phase === 'standby') {
        this.pending.clear();
        this.update({ connection: 'connected', phase: 'standby', pendingParry: false });
      } else if (phase === 'post_interview' && this.postFinished) this.update({ phase: 'complete' });
      else if (phase !== 'complete') this.fail('統合アプリが待機状態に戻ったため、ゲームを終了しました。');
    } else if (value === 'pre_interview' && phase === 'starting') {
      this.update({ phase: 'pre_interview' });
    } else if (value === 'pre_interview_finished' && phase === 'pre_interview') {
      this.update({ phase: 'countdown' });
    } else if (value === 'battle_started' && phase === 'starting_battle') {
      this.lastTick = this.options.now();
      this.lastRhythmSync = -Infinity;
      this.update({ phase: 'battle', game: transitionGame(INITIAL_GAME_STATE, { type: 'start' }) });
    } else if (value === 'post_interview' && phase === 'ending') {
      this.pending.clear();
      this.update({ phase: 'post_interview', pendingParry: false, rhythm: null });
    } else if (value === 'post_interview_finished' && phase === 'post_interview') {
      this.postFinished = true;
    }
  }

  private fail(error: string): void {
    this.disconnect();
    this.update({ error });
  }

  private update(changes: Partial<IntegratedSnapshot>): void {
    if (changes.phase && changes.phase !== this.snapshot.phase) this.phaseSince = this.options.now();
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}
