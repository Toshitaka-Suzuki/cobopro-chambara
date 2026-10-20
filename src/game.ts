export type GamePhase = 'idle' | 'ready' | 'defend' | 'success' | 'attack' | 'damage' | 'miss' | 'win' | 'lose' | 'timeup';
export type TargetId = 0 | 1 | 2;

export type GameState = {
  phase: GamePhase;
  hp: number;
  target: TargetId | null;
  pendingTarget: TargetId | null;
  attackRemainingMs: number;
  roundRemainingMs: number;
  phaseRemainingMs: number;
  paused: boolean;
  notice: string;
};

export type GameAction =
  | { type: 'start' | 'miss' | 'balloon' | 'pause' | 'resume' }
  | { type: 'swordClash' | 'contact'; target?: TargetId }
  | { type: 'hit'; target: TargetId }
  | { type: 'tick'; elapsedMs: number };

export const MAX_ROBOT_HP = 3;
export const ROUND_DURATION_MS = 60_000;
const FEEDBACK_DURATION_MS = 900;
const READY_DURATION_MS = 1_500;
const DEFAULT_TARGET: TargetId = 1;

// 画面試作の設定値。ロボットの速度やセンサの認識精度を表す値ではない。
const ATTACK_WINDOWS_MS = [8_000, 6_000, 4_000] as const;
export const TARGETS = [
  { id: 0, name: '赤', color: 'red', position: '左' },
  { id: 1, name: '青', color: 'blue', position: '中央' },
  { id: 2, name: '黄', color: 'yellow', position: '右' },
] as const;

export const INITIAL_GAME_STATE: GameState = {
  phase: 'idle',
  hp: MAX_ROBOT_HP,
  target: null,
  pendingTarget: null,
  attackRemainingMs: 0,
  roundRemainingMs: ROUND_DURATION_MS,
  phaseRemainingMs: 0,
  paused: false,
  notice: '',
};

/** 勝利・敗北・時間切れの結果場面かを判定する。開始前の待機は含めない。 */
export function isGameFinished(phase: GamePhase): boolean {
  return phase === 'win' || phase === 'lose' || phase === 'timeup';
}

function isGameActive(game: GameState): boolean {
  return game.phase !== 'idle' && !isGameFinished(game.phase);
}

/** 残り HP に応じた攻撃受付時間をミリ秒で返す。命中するたびに短くなる。 */
export function getAttackWindowMs(hp: number): number {
  return ATTACK_WINDOWS_MS[getGameLevel(hp) - 1];
}

/** 命中で1→2→3へ進む。最後の命中は勝利なので、レベル4にはしない。 */
export function getGameLevel(hp: number): number {
  return Math.min(MAX_ROBOT_HP, Math.max(1, MAX_ROBOT_HP - hp + 1));
}

const CLEARED_TARGET = { target: null, pendingTarget: null, attackRemainingMs: 0, phaseRemainingMs: 0 };

function openTarget(game: GameState): GameState {
  return {
    ...game,
    ...CLEARED_TARGET,
    phase: 'attack',
    target: game.pendingTarget ?? DEFAULT_TARGET,
    attackRemainingMs: getAttackWindowMs(game.hp),
    notice: '',
  };
}

function missAttack(game: GameState): GameState {
  return {
    ...game,
    ...CLEARED_TARGET,
    phase: 'miss',
    phaseRemainingMs: FEEDBACK_DURATION_MS,
    notice: '攻撃チャンス終了。次の一撃にそなえよう。',
  };
}

function prepareNextDefense(game: GameState): GameState {
  return { ...game, ...CLEARED_TARGET, phase: 'ready', phaseRemainingMs: READY_DURATION_MS, notice: '' };
}

/** 経過ミリ秒を総時間と場面の待ち時間へ適用する。総時間切れを場面遷移より優先する。 */
function advanceTime(game: GameState, elapsedMs: number): GameState {
  if (!isGameActive(game) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return game;

  const roundRemainingMs = Math.max(0, game.roundRemainingMs - elapsedMs);
  if (roundRemainingMs === 0) {
    return { ...game, ...CLEARED_TARGET, phase: 'timeup', roundRemainingMs, notice: '' };
  }

  let next = { ...game, roundRemainingMs };
  let unprocessedMs = elapsedMs;
  // 遅いフレームでも表示待ちを越えた時間を次の場面へ引き継ぎ、制限時間を延ばさない。
  while (unprocessedMs > 0) {
    if (next.phase === 'attack') {
      const spentMs = Math.min(unprocessedMs, next.attackRemainingMs);
      next = { ...next, attackRemainingMs: next.attackRemainingMs - spentMs };
      unprocessedMs -= spentMs;
      if (next.attackRemainingMs > 0) break;
      next = missAttack(next);
    } else if (['success', 'damage', 'miss', 'ready'].includes(next.phase)) {
      const spentMs = Math.min(unprocessedMs, next.phaseRemainingMs);
      next = { ...next, phaseRemainingMs: next.phaseRemainingMs - spentMs };
      unprocessedMs -= spentMs;
      if (next.phaseRemainingMs > 0) break;

      if (next.phase === 'success') next = openTarget(next);
      else if (next.phase === 'ready') next = { ...next, ...CLEARED_TARGET, phase: 'defend', notice: '' };
      else next = prepareNextDefense(next);
    } else {
      break;
    }
  }
  return next;
}

/**
 * センサ・モック共通の入力から次の状態を返す。元の状態は変更せず、受付対象外ならそのまま返す。
 * 時刻・乱数・入出力には依存しない。tick の経過時間はミリ秒で渡す。
 */
export function transitionGame(game: GameState, action: GameAction): GameState {
  if (action.type === 'pause') return isGameActive(game) ? { ...game, paused: true } : game;
  if (action.type === 'resume') return isGameActive(game) ? { ...game, paused: false } : game;
  if (game.paused) return game;
  if (action.type === 'start') return isGameActive(game) ? game : { ...INITIAL_GAME_STATE, phase: 'defend' };
  if (action.type === 'tick') return advanceTime(game, action.elapsedMs);
  if (action.type === 'balloon') {
    return isGameActive(game) ? { ...game, ...CLEARED_TARGET, phase: 'lose', notice: '' } : game;
  }

  if (game.phase === 'defend') {
    if (action.type === 'swordClash' || action.type === 'contact') {
      return {
        ...game,
        ...CLEARED_TARGET,
        phase: 'success',
        pendingTarget: action.target ?? DEFAULT_TARGET,
        phaseRemainingMs: FEEDBACK_DURATION_MS,
        notice: '',
      };
    }
    if (action.type === 'miss') {
      return { ...game, ...CLEARED_TARGET, phase: 'miss', phaseRemainingMs: FEEDBACK_DURATION_MS, notice: '' };
    }
  }

  if ((action.type === 'hit' || action.type === 'contact') && game.phase === 'attack' && game.attackRemainingMs > 0) {
    // 現行センサは接触位置を返さない。色の一致を検証できるのはモックの hit だけ。
    if (action.type === 'hit' && action.target !== game.target) return { ...game, notice: '光っている弱点を叩いて！' };
    const hp = game.hp - 1;
    return {
      ...game,
      ...CLEARED_TARGET,
      phase: hp === 0 ? 'win' : 'damage',
      hp,
      phaseRemainingMs: hp === 0 ? 0 : FEEDBACK_DURATION_MS,
      notice: '',
    };
  }
  return game;
}

/**
 * 入力直前の経過ミリ秒を処理してから入力を適用し、受付期限を守った次の状態を返す。
 * 場面が切り替わった場合は、前の場面から届いた接触を新しい受け・命中として採用しない。
 */
export function transitionGameWithElapsed(game: GameState, action: GameAction, elapsedMs: number): GameState {
  const next = transitionGame(game, { type: 'tick', elapsedMs });
  if (action.type === 'contact' && next.phase !== game.phase) return next;
  return transitionGame(next, action);
}
