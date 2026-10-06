import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { resolveScreen, screenFromHash, SCREEN_HASHES, sessionPhaseAfterNavigation } from './appNavigation';
import type { AppScreen, SessionPhase } from './appNavigation';
import type { GameState } from './game';
import type { InputMode } from './inputMode';
import type { SwordSensorInput } from './swordSensor';

const currentScreen = () => screenFromHash(window.location.hash);

/**
 * URL遷移とゲーム開始・中断・復帰を管理し、表示状態と操作関数を返す。
 * sensorの開始・停止は呼び出し元が担当し、このフックは状態通知だけを購読する。
 * savedGameRefは復帰先の初期化に使い、受け渡し後に呼び出し元でクリアする。
 */
export function useAppSession(sensor: SwordSensorInput) {
  const [route, setRoute] = useState<AppScreen>(currentScreen);
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('idle');
  const sessionPhaseRef = useRef<SessionPhase>('idle');
  const savedGameRef = useRef<GameState | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>('mock');
  const inputModeRef = useRef(inputMode);
  const [notice, setNotice] = useState('');
  const sensorState = useSyncExternalStore(sensor.subscribeState, sensor.getSnapshot);
  const screen = resolveScreen(route, sessionPhase);

  /** 開始手順を同期更新し、終了・新規開始の際は以前の復帰データを破棄する。 */
  const changeSessionPhase = useCallback((phase: SessionPhase) => {
    if (phase === 'idle' || phase === 'countdown') savedGameRef.current = null;
    // センサとhashchangeは再描画前にも届くため、判定用の参照を同期更新する。
    sessionPhaseRef.current = phase;
    setSessionPhase(phase);
  }, []);

  /** 表示先とURLを更新する。replace時は戻る履歴に現在の画面を残さない。 */
  const navigate = useCallback((next: AppScreen, replace = false) => {
    setRoute(next);
    if (replace) window.location.replace(SCREEN_HASHES[next]);
    else window.location.hash = SCREEN_HASHES[next];
  }, []);

  /** 実機の準備状態が失われた場合、進行中のカウントダウンだけを中止する。 */
  const cancelCountdown = useCallback(() => {
    if (sessionPhaseRef.current !== 'countdown') return;
    changeSessionPhase('idle');
    sensor.discardPending();
    setNotice('接続が切れたため、開始を中止しました。管理画面で再接続と入力確認をしてください。');
    navigate('play', true);
  }, [changeSessionPhase, navigate, sensor]);

  useEffect(() => sensor.subscribeState(snapshot => {
    if (snapshot.ready) setNotice('');
    if (inputModeRef.current === 'sensor' && !snapshot.ready) cancelCountdown();
  }), [cancelCountdown, sensor]);

  useEffect(() => {
    const onHashChange = () => {
      const next = currentScreen();
      const phase = sessionPhaseAfterNavigation(next, sessionPhaseRef.current, savedGameRef.current !== null);
      changeSessionPhase(phase);
      if (phase === 'idle') sensor.discardPending();
      setRoute(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [changeSessionPhase, sensor]);

  useEffect(() => {
    // 直リンク・再読み込み・履歴移動でも準備画面へ戻す。
    if (route !== screen) window.location.replace(SCREEN_HASHES.play);
  }, [route, screen]);

  /** ゲーム開始前だけ入力方法を変更し、それまでの未完の入力を破棄する。 */
  const changeInputMode = (mode: InputMode) => {
    if (sessionPhaseRef.current !== 'idle') return;
    inputModeRef.current = mode;
    setInputMode(mode);
    setNotice('');
    sensor.discardPending();
  };

  /** 開始条件を再確認してカウントダウンへ進む。音声の利用許可は呼び出し元で行う。 */
  const startCountdown = () => {
    if (sessionPhaseRef.current !== 'idle') return;
    if (inputModeRef.current === 'sensor' && !sensor.getSnapshot().ready) return;
    setNotice('');
    sensor.discardPending();
    changeSessionPhase('countdown');
    navigate('countdown');
  };

  /** カウントダウン完了時に接続を再確認し、画面を離れていなければゲームへ進む。 */
  const finishCountdown = useCallback(() => {
    if (currentScreen() !== 'countdown' || sessionPhaseRef.current !== 'countdown') return;
    if (inputModeRef.current === 'sensor' && !sensor.getSnapshot().ready) {
      cancelCountdown();
      return;
    }
    sensor.discardPending();
    changeSessionPhase('playing');
    // 戻る操作で、終了したカウントダウンを再表示しない。
    navigate('game', true);
  }, [cancelCountdown, changeSessionPhase, navigate, sensor]);

  /** 一時停止済みのゲームを保存して管理画面へ退避する。進行中の状態は保存しない。 */
  const openSettings = (game: GameState) => {
    if (!game.paused) return;
    savedGameRef.current = game;
    sensor.discardPending();
    changeSessionPhase('settings');
    navigate('admin');
  };

  return {
    screen, inputMode, sensorState, notice, savedGameRef,
    canResumeGame: sessionPhase === 'settings' && savedGameRef.current !== null,
    changeInputMode, startCountdown, finishCountdown, openSettings,
  };
}
