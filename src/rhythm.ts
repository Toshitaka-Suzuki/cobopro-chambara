/** Pythonの音声出力位置を基準にした4拍ガイド。ブラウザーでは独立した拍時計を作らない。 */
export type RhythmSnapshot = {
  generation: number;
  stage: string;
  active: boolean;
  positionMs: number;
  receivedAt: number;
  beatsMs: [number, number, number, number];
  windowMs: number;
};
export type ParryFeedback = { timing: 'on_time' | 'early' | 'late'; deltaMs: number };
export const RHYTHM_STALE_MS = 750;
export const RHYTHM_MAX_RTT_MS = 180;

export function parseRhythm(message: Record<string, unknown>, sentAt: number, now: number): RhythmSnapshot | null {
  const rtt = now - sentAt;
  const beats = message.beats_ms;
  if (!message.ready || typeof message.active !== 'boolean' || rtt < 0 || rtt > RHYTHM_MAX_RTT_MS
    || typeof message.generation !== 'number' || !Number.isSafeInteger(message.generation)
    || typeof message.position_ms !== 'number' || !Number.isFinite(message.position_ms) || message.position_ms < 0
    || typeof message.window_ms !== 'number' || !Number.isFinite(message.window_ms)
    || message.window_ms <= 0 || message.window_ms > 1000
    || !Array.isArray(beats) || beats.length !== 4
    || !beats.every((n, i) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && (i === 0 || n > beats[i - 1]))
  ) return null;
  return {
    generation: message.generation, stage: String(message.stage), active: message.active,
    positionMs: message.position_ms + rtt / 2, receivedAt: now,
    beatsMs: beats as RhythmSnapshot['beatsMs'], windowMs: message.window_ms,
  };
}

export function projectRhythm(state: RhythmSnapshot | null, now: number) {
  if (!state || !state.active || now - state.receivedAt > RHYTHM_STALE_MS) return null;
  // 同期応答はRAFの間にも届く。直前のフレーム時刻が受信時刻より古くても、
  // 待機表示へ戻さず、届いた音声位置から描画を続ける。
  const position = state.positionMs + Math.max(0, now - state.receivedAt);
  const [start, second, third, target] = state.beatsMs;
  // 次の同期情報を受け取るまで、過ぎた攻撃を繰り返さない。
  if (position >= target + state.windowMs / 2) return null;
  const progress = Math.max(0, Math.min(1, (position - start) / (target - start)));
  const inWindow = position >= target - state.windowMs / 2 && position < target + state.windowMs / 2;
  const beat = position < start ? 0 : position < second ? 1 : position < third ? 2 : position < target ? 3 : 4;
  return { position, progress, beat, inWindow, untilMs: target - position };
}

export function parseParryFeedback(message: Record<string, unknown>): ParryFeedback | null {
  if (!['on_time', 'early', 'late'].includes(String(message.timing))
    || typeof message.delta_ms !== 'number' || !Number.isFinite(message.delta_ms)) return null;
  return { timing: message.timing as ParryFeedback['timing'], deltaMs: message.delta_ms };
}
