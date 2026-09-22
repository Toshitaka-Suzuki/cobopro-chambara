export type Phase = 'idle' | 'ready' | 'defend' | 'success' | 'attack' | 'damage' | 'miss' | 'unknown' | 'win' | 'lose' | 'timeup';
export type Target = 0 | 1 | 2;
export type Game = {
  phase: Phase; hp: number; target: Target | null;
  remainingMs: number; timeLeftMs: number; phaseRemainingMs: number;
  pendingTarget: Target | null; paused: boolean; notice: string;
};
export type Action =
  | { type: 'start' | 'reset' | 'cue' | 'miss' | 'unknown' | 'balloon' | 'pause' | 'resume' | 'retry' | 'expire' }
  | { type: 'success'; target?: Target }
  | { type: 'open'; target: Target }
  | { type: 'hit'; target: Target }
  | { type: 'tick'; elapsed: number };

export const initialGame: Game = {
  phase: 'idle', hp: 3, target: null, remainingMs: 0,
  timeLeftMs: 60000, phaseRemainingMs: 0, pendingTarget: null, paused: false, notice: '',
};
export const targetNames = ['赤', '青', '黄'];
// 画面と人力試作の仮値。ロボット速度・認識判定の仕様を表しません。
export const targetWindows = [8000, 6000, 4000];
export const levelOf = (hp: number) => Math.min(3, Math.max(1, 4 - hp));
const active = (game: Game) => !['idle', 'win', 'lose', 'timeup'].includes(game.phase);

const clearTarget = { target: null, pendingTarget: null, remainingMs: 0, phaseRemainingMs: 0 };
const openTarget = (game: Game, target: Target): Game => ({
  ...game, ...clearTarget, phase: 'attack', target,
  remainingMs: targetWindows[levelOf(game.hp) - 1], notice: '',
});
const missed = (game: Game): Game => ({
  ...game, ...clearTarget, phase: 'miss', phaseRemainingMs: 900,
  notice: '攻撃チャンス終了。次の一撃にそなえよう。',
});

function advance(game: Game, elapsed: number): Game {
  if (!active(game) || !Number.isFinite(elapsed) || elapsed <= 0) return game;
  const timeLeftMs = Math.max(0, game.timeLeftMs - elapsed);
  if (timeLeftMs === 0) return { ...game, ...clearTarget, phase: 'timeup', timeLeftMs, notice: '' };
  let next = { ...game, timeLeftMs };
  let rest = elapsed;
  // 遅いフレームでも、表示待ちを越えた時間を次の場面へ引き継ぐ。
  while (rest > 0) {
    if (next.phase === 'attack') {
      const spent = Math.min(rest, next.remainingMs);
      next = { ...next, remainingMs: next.remainingMs - spent };
      rest -= spent;
      if (next.remainingMs === 0) next = missed(next);
      else break;
    } else if (['success', 'damage', 'miss'].includes(next.phase)) {
      const spent = Math.min(rest, next.phaseRemainingMs);
      next = { ...next, phaseRemainingMs: next.phaseRemainingMs - spent };
      rest -= spent;
      if (next.phaseRemainingMs > 0) break;
      next = next.phase === 'success'
        ? openTarget(next, next.pendingTarget ?? 1)
        : { ...next, ...clearTarget, phase: 'ready', notice: '' };
    } else break;
  }
  return next;
}

export function transition(game: Game, action: Action): Game {
  if (action.type === 'reset') return { ...initialGame };
  if (action.type === 'pause') return active(game) ? { ...game, paused: true } : game;
  if (action.type === 'resume') return active(game) ? { ...game, paused: false } : game;
  if (game.paused) return game;
  if (action.type === 'start') return ['idle', 'win', 'lose', 'timeup'].includes(game.phase) ? { ...initialGame, phase: 'ready' } : game;
  if (action.type === 'tick') return advance(game, action.elapsed);
  if (action.type === 'balloon') return active(game) ? { ...game, ...clearTarget, phase: 'lose', notice: '' } : game;
  if (action.type === 'cue' && ['ready', 'damage', 'miss'].includes(game.phase)) return { ...game, ...clearTarget, phase: 'defend', notice: '' };
  if (action.type === 'retry' && game.phase === 'unknown') return { ...game, ...clearTarget, phase: 'ready', notice: '' };
  if (game.phase === 'defend') {
    if (action.type === 'success') return { ...game, ...clearTarget, phase: 'success', pendingTarget: action.target ?? 1, phaseRemainingMs: 900, notice: '' };
    if (action.type === 'miss') return { ...game, ...clearTarget, phase: 'miss', phaseRemainingMs: 900, notice: '' };
    if (action.type === 'unknown') return { ...game, ...clearTarget, phase: 'unknown', notice: '' };
  }
  if (action.type === 'open' && game.phase === 'success') {
    return openTarget(game, action.target);
  }
  if (action.type === 'hit' && game.phase === 'attack' && game.remainingMs > 0) {
    if (action.target !== game.target) return { ...game, notice: '光っている弱点を叩いて！' };
    const hp = game.hp - 1;
    return { ...game, ...clearTarget, phase: hp === 0 ? 'win' : 'damage', hp, phaseRemainingMs: hp === 0 ? 0 : 900, notice: '' };
  }
  if (action.type === 'expire' && game.phase === 'attack') return missed(game);
  return game;
}

export function sample(phase: Phase): Game {
  return {
    ...initialGame, phase,
    hp: phase === 'win' ? 0 : phase === 'damage' ? 2 : 3,
    target: phase === 'attack' ? 1 : null,
    remainingMs: phase === 'attack' ? 8000 : 0,
    timeLeftMs: phase === 'timeup' ? 0 : 60000,
    phaseRemainingMs: ['success', 'damage', 'miss'].includes(phase) ? 900 : 0,
    pendingTarget: phase === 'success' ? 1 : null,
  };
}
