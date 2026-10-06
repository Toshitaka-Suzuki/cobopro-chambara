import { useEffect, useState } from 'react';
import type { Ref } from 'react';
import type { GameAudio } from './gameAudio';
import { INPUT_MODE_LABELS } from './inputMode';
import type { InputMode } from './inputMode';

const COUNTDOWN_SECONDS = 3;
const START_MESSAGE_DURATION_MS = 600;

type CountdownProps = {
  headingRef: Ref<HTMLHeadingElement>;
  onComplete: () => void;
  audio: GameAudio;
  inputMode: InputMode;
};

export function Countdown({ headingRef, onComplete, audio, inputMode }: CountdownProps) {
  const [secondsRemaining, setSecondsRemaining] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    // 3・2・1を各1秒、「スタート！」を0.6秒表示する。
    const timers = Array.from({ length: COUNTDOWN_SECONDS }, (_, index) =>
      window.setTimeout(() => setSecondsRemaining(COUNTDOWN_SECONDS - index - 1), (index + 1) * 1000),
    );
    timers.push(window.setTimeout(onComplete, COUNTDOWN_SECONDS * 1000 + START_MESSAGE_DURATION_MS));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [onComplete]);

  useEffect(() => {
    audio.play(secondsRemaining === 0 ? 'go' : 'count');
  }, [audio, secondsRemaining]);

  useEffect(() => () => audio.stop(), [audio]);

  const isGo = secondsRemaining === 0;

  return (
    <main className="countdown-screen">
      <nav className="setup-navigation" aria-label="戻る">
        <a className="back-link" href="#/play"><span aria-hidden="true">←</span> プレイの準備に戻る</a>
      </nav>
      <div className="countdown-content">
        <p className="input-mode-label">{INPUT_MODE_LABELS[inputMode]}</p>
        <p className="setup-kicker">まもなく開始</p>
        <h1 ref={headingRef} tabIndex={-1}>剣を構えて</h1>
        <div className={isGo ? 'countdown-counter is-go' : 'countdown-counter'} role="status" aria-live="polite" aria-atomic="true">
          <span className="countdown-value" key={secondsRemaining}>{isGo ? 'スタート！' : secondsRemaining}</span>
        </div>
        <p className="countdown-hint">{isGo ? '相手の剣に、集中しよう。' : 'ロボットの剣を見て、待とう。'}</p>
      </div>
    </main>
  );
}
