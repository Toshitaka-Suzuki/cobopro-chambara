import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AdminScreen } from './AdminScreen';
import { Countdown } from './Countdown';
import { GameScreen } from './GameScreen';
import { HomeScreen } from './HomeScreen';
import { PlaySetup } from './PlaySetup';
import { SerialConnection } from './SerialConnection';
import { SCREEN_HASHES, SCREEN_TITLES } from './appNavigation';
import { GameAudio } from './gameAudio';
import type { Difficulty } from './game';
import { createLazyRosTransport } from './lazyRosTransport';
import { RosMonitor } from './ros';
import { SerialMonitor } from './serial';
import type { SerialApi } from './serial';
import { SwordSensorInput } from './swordSensor';
import { useAppSession } from './useAppSession';
import { IntegratedSession } from './integratedSession';
import type { ExperienceMode } from './integratedSession';
import { IntegrationConnection } from './IntegrationConnection';
import { IntegratedExperience } from './IntegratedExperience';
import { LegacyEspController } from './legacyEsp';
import { EspConnection } from './EspConnection';

export function App() {
  const [baudRate, setBaudRate] = useState('115200');
  const [customBaudRate, setCustomBaudRate] = useState('');
  // 接続はアプリが所有し、管理画面とプレイ画面を行き来しても維持する。
  const [rosMonitor] = useState(() => new RosMonitor(createLazyRosTransport));
  const [integration] = useState(() => new IntegratedSession());
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>('integrated');
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const integrationState = useSyncExternalStore(integration.subscribe, integration.getSnapshot);
  const [{ serialMonitor, sensor, serialSupported }] = useState(() => {
    const serialApi = window.isSecureContext ? (navigator as Navigator & { serial?: SerialApi }).serial : undefined;
    const serialMonitor = new SerialMonitor(serialApi);
    return { serialMonitor, sensor: new SwordSensorInput(serialMonitor), serialSupported: !!serialApi };
  });
  const [esp] = useState(() => new LegacyEspController(serialMonitor, integration));
  const espState = useSyncExternalStore(esp.subscribe, esp.getSnapshot);
  const session = useAppSession(sensor);
  const { screen, inputMode, sensorState, savedGameRef } = session;
  const [audio, setAudio] = useState<GameAudio | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const title = SCREEN_TITLES[screen];

  useEffect(() => {
    sensor.start();
    esp.start();
    return () => {
      esp.stop();
      sensor.stop();
      void serialMonitor.disconnect();
    };
  }, [serialMonitor, sensor, esp]);

  useEffect(() => {
    const engine = new GameAudio();
    setAudio(engine);
    return () => engine.dispose();
  }, []);

  useEffect(() => () => rosMonitor.disconnect(), [rosMonitor]);
  useEffect(() => () => integration.disconnect(), [integration]);
  useEffect(() => {
    // 戻る・履歴移動でも、画面だけを離れてPythonのBGMや会話を残さない。
    if (screen !== 'integrated' && integration.active && integration.getSnapshot().phase !== 'cancelling') {
      integration.cancel();
    }
  }, [screen, integration]);
  useEffect(() => {
    const leave = () => integration.disconnect();
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [integration]);

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
    if (experienceMode === 'integrated' && !integration.ready) return;
    if (inputMode === 'esp' && (experienceMode !== 'integrated' || !esp.getSnapshot().ready
      || !integrationState.espSupported || !integrationState.rhythmSupported)) return;
    audio.setMuted(!soundEnabled);
    // ブラウザーの音声制限を解除するため、開始クリックの中で呼ぶ。
    void audio.unlock().catch(() => {
      audio.setMuted(true);
      setSoundEnabled(false);
    });
    if (experienceMode === 'integrated') {
      if (inputMode === 'esp' ? esp.startGame(difficulty) : integration.start(difficulty)) session.startIntegrated();
    } else session.startCountdown();
  };

  const changeExperienceMode = (mode: ExperienceMode) => {
    if (mode === 'standalone' && inputMode === 'esp') session.changeInputMode('mock');
    setExperienceMode(mode);
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
      notice={session.notice} onModeChange={session.changeInputMode} onStart={startGame}
      experienceMode={experienceMode} onExperienceModeChange={changeExperienceMode}
      difficulty={difficulty} onDifficultyChange={setDifficulty}
      integrationReady={integrationState.connection === 'connected' && integration.ready}
      espReady={espState.ready && integrationState.espSupported && integrationState.rhythmSupported}
      espControls={<EspConnection controller={esp} monitor={serialMonitor} supported={serialSupported} session={integration} />}
      connectionControls={<IntegrationConnection session={integration} />} />;
  }

  if (screen === 'integrated' && audio) {
    return <IntegratedExperience session={integration} inputMode={inputMode} sensor={sensor}
      audio={audio} headingRef={headingRef} soundEnabled={soundEnabled}
      onToggleSound={() => { void toggleSound(); }} />;
  }
  if (screen === 'countdown' && audio) {
    return <Countdown headingRef={headingRef} onComplete={session.finishCountdown} audio={audio} inputMode={inputMode} />;
  }

  if (screen === 'game' && audio) {
    return <GameScreen headingRef={headingRef} audio={audio} soundEnabled={soundEnabled}
      onToggleSound={() => { void toggleSound(); }} inputMode={inputMode} sensor={sensor}
      difficulty={difficulty}
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
