import { useCallback, useEffect, useRef, useState } from 'react';
import { Countdown } from './Countdown';
import { PlaySetup } from './PlaySetup';
import { GameScreen } from './GameScreen';
import { GameAudio } from './gameAudio';

type Screen = 'home' | 'play' | 'admin' | 'countdown' | 'game';
type RoundPhase = 'idle' | 'countdown' | 'playing';

const screenTitles: Record<Screen, string> = {
  home: '画面を選択', play: 'プレイの準備', admin: '管理者画面',
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
  const [swordRecognized, setSwordRecognized] = useState(false);
  const [roundPhase, setRoundPhase] = useState<RoundPhase>('idle');
  const [audio, setAudio] = useState<GameAudio | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const needsPreparation = (route === 'countdown' && roundPhase !== 'countdown')
    || (route === 'game' && roundPhase !== 'playing');
  const screen = needsPreparation ? 'play' : route;
  const title = screenTitles[screen];

  useEffect(() => {
    const engine = new GameAudio();
    setAudio(engine);
    return () => engine.dispose();
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const next = currentScreen();
      setSwordRecognized(false);
      if (next !== 'countdown' && next !== 'game') setRoundPhase('idle');
      setRoute(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    // 直リンク・再読み込み・履歴移動でも、認識を確認してから開始する。
    if (needsPreparation) window.location.replace('#/play');
  }, [needsPreparation]);

  useEffect(() => {
    document.title = title + ' | ロボットと、チャンバラ。';
    headingRef.current?.focus();
  }, [title]);

  const finishCountdown = useCallback(() => {
    if (currentScreen() !== 'countdown') return;
    setRoundPhase('playing');
    setRoute('game');
    // 戻る操作で、終了したカウントダウンを再表示しない。
    window.location.replace('#/play/game');
  }, []);

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
      recognized={swordRecognized}
      onRecognitionChange={setSwordRecognized}
      onStart={() => {
        if (!swordRecognized || !audio) return;
        audio.setMuted(!soundEnabled);
        void audio.unlock().catch(() => {
          audio.setMuted(true);
          setSoundEnabled(false);
        });
        setRoundPhase('countdown');
        setRoute('countdown');
        window.location.hash = '#/play/countdown';
      }}
    />;
  }

  if (screen === 'countdown' && audio) {
    return <Countdown headingRef={headingRef} onComplete={finishCountdown} audio={audio} />;
  }

  if (screen === 'game' && audio) {
    return <GameScreen headingRef={headingRef} audio={audio} soundEnabled={soundEnabled} onToggleSound={() => { void toggleSound(); }} />;
  }

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
              <p>スタッフ用の画面を開きます。</p>
            </div>
            <span className="choice-action">開く <span aria-hidden="true">→</span></span>
          </a>
        </nav>
      </div>
    </main>
  );
}
