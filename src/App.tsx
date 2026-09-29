import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Countdown } from './Countdown';
import { PlaySetup } from './PlaySetup';
import { GameScreen } from './GameScreen';
import { GameAudio } from './gameAudio';
import { AdminScreen } from './AdminScreen';
import { SerialConnection } from './SerialConnection';
import { SerialMonitor } from './serial';
import type { SerialApi } from './serial';
import { SwordSensorInput } from './swordSensor';
import { RosMonitor } from './ros';
import { createLazyRosTransport } from './lazyRosTransport';
import type { Game } from './game';

type Screen = 'home' | 'play' | 'admin' | 'countdown' | 'game';
type RoundPhase = 'idle' | 'countdown' | 'playing' | 'settings';

const screenTitles: Record<Screen, string> = {
  home: '画面を選択', play: 'プレイの準備', admin: '機器の設定',
  countdown: '開始カウントダウン', game: 'ゲーム画面',
};

function currentScreen(): Screen {
  if (window.location.hash === '#/play') return 'play';
  if (window.location.hash === '#/play/countdown') return 'countdown';
  if (window.location.hash === '#/play/game') return 'game';
  if (window.location.hash === '#/admin') return 'admin';
  return 'home';
}

function ScreenIcon({ kind }: { kind: 'play' | 'admin' }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      {kind === 'play' ? (
        <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6" y="8" width="36" height="25" rx="3" />
          <path d="M18 40h12M24 33v7M21 15l9 5.5-9 5.5z" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M10 8v9m0 9v14M24 8v19m0 9v4M38 8v5m0 9v18" />
          <rect x="6" y="17" width="8" height="9" rx="3" />
          <rect x="20" y="27" width="8" height="9" rx="3" />
          <rect x="34" y="13" width="8" height="9" rx="3" />
        </g>
      )}
    </svg>
  );
}

export function App() {
  const [route, setRoute] = useState<Screen>(currentScreen);
  const [roundPhase, setRoundPhase] = useState<RoundPhase>('idle');
  const roundPhaseRef = useRef<RoundPhase>('idle');
  const savedRound = useRef<Game | null>(null);
  const [inputMode, setInputMode] = useState<'mock' | 'sensor'>('mock');
  const inputModeRef = useRef(inputMode);
  const [notice, setNotice] = useState('');
  const [baudRate, setBaudRate] = useState('115200');
  const [customBaudRate, setCustomBaudRate] = useState('');
  const [rosMonitor] = useState(() => new RosMonitor(createLazyRosTransport));
  const [{ monitor, sensor, supported }] = useState(() => {
    const serial = window.isSecureContext ? (navigator as Navigator & { serial?: SerialApi }).serial : undefined;
    const monitor = new SerialMonitor(serial);
    return { monitor, sensor: new SwordSensorInput(monitor), supported: !!serial };
  });
  const sensorState = useSyncExternalStore(sensor.subscribeState, sensor.getSnapshot);
  const [audio, setAudio] = useState<GameAudio | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const needsPreparation = (route === 'countdown' && roundPhase !== 'countdown')
    || (route === 'game' && roundPhase !== 'playing');
  const screen = needsPreparation ? 'play' : route;
  const title = screenTitles[screen];

  const changeRoundPhase = useCallback((phase: RoundPhase) => {
    if (phase === 'idle' || phase === 'countdown') savedRound.current = null;
    roundPhaseRef.current = phase;
    setRoundPhase(phase);
  }, []);

  const cancelCountdown = useCallback(() => {
    if (roundPhaseRef.current !== 'countdown') return;
    changeRoundPhase('idle');
    sensor.discardPending();
    setNotice('接続が切れたため、開始を中止しました。管理画面で再接続と入力確認をしてください。');
    setRoute('play');
    window.location.replace('#/play');
  }, [changeRoundPhase, sensor]);

  useEffect(() => {
    sensor.start();
    const unsubscribe = sensor.subscribeState(snapshot => {
      if (snapshot.ready) setNotice('');
      if (inputModeRef.current === 'sensor' && !snapshot.ready) cancelCountdown();
    });
    return () => {
      unsubscribe();
      sensor.stop();
      void monitor.disconnect();
    };
  }, [monitor, sensor, cancelCountdown]);

  useEffect(() => {
    const engine = new GameAudio();
    setAudio(engine);
    return () => engine.dispose();
  }, []);

  useEffect(() => () => rosMonitor.disconnect(), [rosMonitor]);

  useEffect(() => {
    const onHashChange = () => {
      const next = currentScreen();
      if (next === 'game' && roundPhaseRef.current === 'settings' && savedRound.current) {
        changeRoundPhase('playing');
      } else if (next !== 'countdown' && next !== 'game'
        && !(next === 'admin' && roundPhaseRef.current === 'settings')) {
        changeRoundPhase('idle');
        sensor.discardPending();
      }
      setRoute(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [changeRoundPhase, sensor]);

  useEffect(() => {
    // 直リンク・再読み込み・履歴移動でも、準備を経てから開始する。
    if (needsPreparation) window.location.replace('#/play');
  }, [needsPreparation]);

  useEffect(() => {
    document.title = title + ' | ロボットと、チャンバラ。';
    headingRef.current?.focus();
  }, [title]);

  useEffect(() => {
    // GameScreenは初期化時に停止状態を受け取る。復帰後は古い保存状態を残さない。
    if (screen === 'game' && audio) savedRound.current = null;
  }, [screen, audio]);

  const finishCountdown = useCallback(() => {
    if (currentScreen() !== 'countdown' || roundPhaseRef.current !== 'countdown') return;
    if (inputModeRef.current === 'sensor' && !sensor.getSnapshot().ready) {
      cancelCountdown();
      return;
    }
    sensor.discardPending();
    changeRoundPhase('playing');
    setRoute('game');
    // 戻る操作で、終了したカウントダウンを再表示しない。
    window.location.replace('#/play/game');
  }, [cancelCountdown, changeRoundPhase, sensor]);

  const connectionControls = <SerialConnection monitor={monitor} supported={supported}
    baudRate={baudRate} customBaudRate={customBaudRate}
    onBaudRateChange={setBaudRate} onCustomBaudRateChange={setCustomBaudRate} />;

  const toggleSound = async () => {
    if (!audio) return;
    if (soundEnabled) {
      audio.setMuted(true);
      setSoundEnabled(false);
      return;
    }
    try {
      await audio.unlock();
      audio.setMuted(false);
      setSoundEnabled(true);
    } catch {
      audio.setMuted(true);
      setSoundEnabled(false);
    }
  };

  if (screen === 'play') {
    return <PlaySetup
      headingRef={headingRef}
      inputMode={inputMode}
      sensorState={sensorState}
      notice={notice}
      onModeChange={mode => {
        if (roundPhaseRef.current !== 'idle') return;
        inputModeRef.current = mode;
        setInputMode(mode);
        setNotice('');
        sensor.discardPending();
      }}
      onStart={() => {
        if (!audio || (inputMode === 'sensor' && !sensor.getSnapshot().ready)) return;
        audio.setMuted(!soundEnabled);
        void audio.unlock().catch(() => {
          audio.setMuted(true);
          setSoundEnabled(false);
        });
        setNotice('');
        sensor.discardPending();
        changeRoundPhase('countdown');
        setRoute('countdown');
        window.location.hash = '#/play/countdown';
      }}
    />;
  }

  if (screen === 'countdown' && audio) {
    return <Countdown headingRef={headingRef} onComplete={finishCountdown} audio={audio} inputMode={inputMode} />;
  }

  if (screen === 'game' && audio) {
    return <GameScreen headingRef={headingRef} audio={audio} soundEnabled={soundEnabled}
      onToggleSound={() => { void toggleSound(); }} inputMode={inputMode} sensor={sensor}
      initialState={savedRound.current}
      onOpenSettings={game => {
        if (!game.paused) return;
        savedRound.current = game;
        sensor.discardPending();
        changeRoundPhase('settings');
        setRoute('admin');
        window.location.hash = '#/admin';
      }} />;
  }

  if (screen === 'admin') return <AdminScreen headingRef={headingRef} monitor={monitor}
    rosMonitor={rosMonitor}
    connectionControls={connectionControls} sensorState={sensorState}
    resumeGameHref={roundPhase === 'settings' && savedRound.current ? '#/play/game' : undefined} />;

  if (screen !== 'home') {
    return (
      <main className="destination-screen">
        <header className="destination-header">
          <a className="back-link" href={screen === 'game' ? '#/play' : '#/'}>
            <span aria-hidden="true">←</span> {screen === 'game' ? 'プレイの準備に戻る' : '画面選択に戻る'}
          </a>
          <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
        </header>
      </main>
    );
  }

  return (
    <main className="entry-screen">
      <div className="entry-content">
        <header className="entry-heading">
          <span className="brand-mark" aria-hidden="true">剣</span>
          <p className="brand-name">ロボットと、チャンバラ。</p>
          <h1 ref={headingRef} tabIndex={-1}>画面を選択</h1>
          <p className="entry-description">使用する画面を選んでください。</p>
        </header>

        <nav className="screen-choices" aria-label="画面選択">
          <a className="screen-choice play-choice" href="#/play" aria-labelledby="play-title">
            <span className="choice-icon"><ScreenIcon kind="play" /></span>
            <div className="choice-description">
              <h2 id="play-title">プレイ画面</h2>
              <p>プレイヤー用の画面を開きます。</p>
            </div>
            <span className="choice-action">開く <span aria-hidden="true">→</span></span>
          </a>
          <a className="screen-choice admin-choice" href="#/admin" aria-labelledby="admin-title">
            <span className="choice-icon"><ScreenIcon kind="admin" /></span>
            <div className="choice-description">
              <h2 id="admin-title">管理者画面</h2>
              <p>機器の接続設定と入力を確認します。</p>
            </div>
            <span className="choice-action">開く <span aria-hidden="true">→</span></span>
          </a>
        </nav>
        {sensorState.connected && <p className="entry-description" role="status">USBシリアル接続を保持しています。接続の操作は管理者画面から行えます。</p>}
      </div>
    </main>
  );
}
