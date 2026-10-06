import { useEffect, useRef, useState } from 'react';
import { AdminScreen } from './AdminScreen';
import { Countdown } from './Countdown';
import { GameScreen } from './GameScreen';
import { HomeScreen } from './HomeScreen';
import { PlaySetup } from './PlaySetup';
import { SerialConnection } from './SerialConnection';
import { SCREEN_HASHES, SCREEN_TITLES } from './appNavigation';
import { GameAudio } from './gameAudio';
import { createLazyRosTransport } from './lazyRosTransport';
import { RosMonitor } from './ros';
import { SerialMonitor } from './serial';
import type { SerialApi } from './serial';
import { SwordSensorInput } from './swordSensor';
import { useAppSession } from './useAppSession';

export function App() {
  const [baudRate, setBaudRate] = useState('115200');
  const [customBaudRate, setCustomBaudRate] = useState('');
  // 接続はアプリが所有し、管理画面とプレイ画面を行き来しても維持する。
  const [rosMonitor] = useState(() => new RosMonitor(createLazyRosTransport));
  const [{ serialMonitor, sensor, serialSupported }] = useState(() => {
    const serialApi = window.isSecureContext ? (navigator as Navigator & { serial?: SerialApi }).serial : undefined;
    const serialMonitor = new SerialMonitor(serialApi);
    return { serialMonitor, sensor: new SwordSensorInput(serialMonitor), serialSupported: !!serialApi };
  });
  const session = useAppSession(sensor);
  const { screen, inputMode, sensorState, savedGameRef } = session;
  const [audio, setAudio] = useState<GameAudio | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const title = SCREEN_TITLES[screen];

  useEffect(() => {
    sensor.start();
    return () => {
      sensor.stop();
      void serialMonitor.disconnect();
    };
  }, [serialMonitor, sensor]);

  useEffect(() => {
    const engine = new GameAudio();
    setAudio(engine);
    return () => engine.dispose();
  }, []);

  useEffect(() => () => rosMonitor.disconnect(), [rosMonitor]);

  useEffect(() => {
    document.title = `${title} | ロボットと、チャンバラ。`;
    headingRef.current?.focus();
  }, [title]);

  useEffect(() => {
    // GameScreenが初期状態として受け取った後は、古い復帰用データを残さない。
    if (screen === 'game' && audio) savedGameRef.current = null;
  }, [screen, audio, savedGameRef]);

  const startGame = () => {
    if (!audio || (inputMode === 'sensor' && !sensor.getSnapshot().ready)) return;
    audio.setMuted(!soundEnabled);
    // ブラウザーの音声制限を解除するため、開始クリックの中で呼ぶ。
    void audio.unlock().catch(() => {
      audio.setMuted(true);
      setSoundEnabled(false);
    });
    session.startCountdown();
  };

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
    return <PlaySetup headingRef={headingRef} inputMode={inputMode} sensorState={sensorState}
      notice={session.notice} onModeChange={session.changeInputMode} onStart={startGame} />;
  }

  if (screen === 'countdown' && audio) {
    return <Countdown headingRef={headingRef} onComplete={session.finishCountdown} audio={audio} inputMode={inputMode} />;
  }

  if (screen === 'game' && audio) {
    return <GameScreen headingRef={headingRef} audio={audio} soundEnabled={soundEnabled}
      onToggleSound={() => { void toggleSound(); }} inputMode={inputMode} sensor={sensor}
      initialState={savedGameRef.current} onOpenSettings={session.openSettings} />;
  }

  if (screen === 'admin') {
    return <AdminScreen headingRef={headingRef} monitor={serialMonitor} rosMonitor={rosMonitor}
      connectionControls={<SerialConnection monitor={serialMonitor} supported={serialSupported}
        baudRate={baudRate} customBaudRate={customBaudRate}
        onBaudRateChange={setBaudRate} onCustomBaudRateChange={setCustomBaudRate} />}
      sensorState={sensorState} resumeGameHref={session.canResumeGame ? SCREEN_HASHES.game : undefined} />;
  }

  if (screen !== 'home') {
    return (
      <main className="destination-screen">
        <header className="destination-header">
          <a className="back-link" href={screen === 'game' ? SCREEN_HASHES.play : SCREEN_HASHES.home}>
            <span aria-hidden="true">←</span> {screen === 'game' ? 'プレイの準備に戻る' : '画面選択に戻る'}
          </a>
          <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
        </header>
      </main>
    );
  }

  return <HomeScreen headingRef={headingRef} serialConnected={sensorState.connected} />;
}
