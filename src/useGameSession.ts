import { useCallback, useEffect, useRef, useState } from 'react';
import { INITIAL_GAME_STATE, TARGETS, isGameFinished, transitionGame, transitionGameWithElapsed } from './game';
import type { GameAction, GameState, TargetId } from './game';
import type { InputMode } from './inputMode';
import type { SwordSensorInput } from './swordSensor';

const GAME_TICK_INTERVAL_MS = 50;

type GameSessionOptions = {
  inputMode: InputMode;
  sensor: SwordSensorInput;
  initialState: GameState | null;
};

/**
 * initialState を初回だけ採用し、null ならゲームを開始する。状態・操作関数・最新値を読む ref を返す。
 * 時計・キー入力・センサ購読を管理し、実機モードではセンサ未準備時に停止する。
 * アンマウント時は購読とタイマーを解除し、シリアル接続は維持する。
 */
export function useGameSession({ inputMode, sensor, initialState }: GameSessionOptions) {
  const [game, setGame] = useState<GameState>(() => {
    const round = initialState ?? transitionGame(INITIAL_GAME_STATE, { type: 'start' });
    return inputMode === 'sensor' && !sensor.getSnapshot().ready ? transitionGame(round, { type: 'pause' }) : round;
  });
  const [sensorState, setSensorState] = useState(() => sensor.getSnapshot());
  const gameRef = useRef(game);
  const lastTickMs = useRef(performance.now());

  /** 実経過時間を精算して入力を処理し、同じ受信処理内でも参照できる最新状態へ更新する。 */
  const sendAction = useCallback((action: GameAction) => {
    const now = performance.now();
    const next = transitionGameWithElapsed(gameRef.current, action, now - lastTickMs.current);
    lastTickMs.current = now;
    if (next !== gameRef.current) {
      // 前の場面や停止中の部分行を、新しい受け・命中の入力にしない。
      if (inputMode === 'sensor' && (next.paused !== gameRef.current.paused || next.phase !== gameRef.current.phase)) sensor.discardPending();
      gameRef.current = next;
      setGame(next);
    }
  }, [inputMode, sensor]);

  /** 停止と再開を切り替える。実機モードではセンサの準備が整うまで再開しない。 */
  const togglePause = useCallback(() => {
    if (gameRef.current.paused && inputMode === 'sensor' && !sensor.getSnapshot().ready) return;
    sendAction({ type: gameRef.current.paused ? 'resume' : 'pause' });
  }, [inputMode, sensor, sendAction]);

  /** 剣の入力をモード別の action へ変換する。次に光らせる弱点は画面側でランダムに選ぶ。 */
  const receiveSword = useCallback(() => {
    if (inputMode === 'sensor' && !sensor.getSnapshot().ready) return;
    sendAction({
      type: inputMode === 'sensor' ? 'contact' : 'swordClash',
      target: TARGETS[Math.floor(Math.random() * TARGETS.length)].id,
    });
  }, [inputMode, sensor, sendAction]);

  useEffect(() => {
    if (inputMode !== 'sensor') return;
    // 準備・カウントダウン中に受け始めた部分行はゲームに持ち込まない。
    sensor.discardPending();
    const updateSensor = (snapshot: ReturnType<SwordSensorInput['getSnapshot']>) => {
      setSensorState(snapshot);
      if (!snapshot.ready && !gameRef.current.paused) sendAction({ type: 'pause' });
    };
    const unsubscribeState = sensor.subscribeState(updateSensor);
    updateSensor(sensor.getSnapshot());
    const unsubscribeClash = sensor.subscribeClash(receiveSword);
    return () => {
      unsubscribeState();
      unsubscribeClash();
      sensor.discardPending();
    };
  }, [inputMode, sensor, receiveSword, sendAction]);

  useEffect(() => {
    lastTickMs.current = performance.now();
    const timer = window.setInterval(() => sendAction({ type: 'tick', elapsedMs: 0 }), GAME_TICK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [sendAction]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        togglePause();
        return;
      }
      if (gameRef.current.paused || isGameFinished(gameRef.current.phase)) return;
      if (event.code === 'Space' && target instanceof HTMLElement && target.closest('button, a, summary')) return;
      if (event.code === 'Space' && inputMode === 'mock') {
        event.preventDefault();
        receiveSword();
      }
      if (event.code === 'KeyF') {
        event.preventDefault();
        sendAction({ type: 'miss' });
      }
      if (event.code === 'KeyB') {
        event.preventDefault();
        sendAction({ type: 'balloon' });
      }
      const digit = /^(?:Digit|Numpad)([123])$/.exec(event.code);
      if (digit && inputMode === 'mock') {
        event.preventDefault();
        sendAction({ type: 'hit', target: (Number(digit[1]) - 1) as TargetId });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inputMode, sendAction, receiveSword, togglePause]);

  return { game, gameRef, sensorState, sendAction, receiveSword, togglePause };
}
