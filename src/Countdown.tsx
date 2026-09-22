import { useEffect, useState } from 'react';
import type { Ref } from 'react';
import type { GameAudio } from './gameAudio';

type CountdownProps = {
  headingRef: Ref<HTMLHeadingElement>;
  onComplete: () => void;
  audio: GameAudio;
};

export function Countdown({ headingRef, onComplete, audio }: CountdownProps) {
  const [remaining, setRemaining] = useState(3);

  useEffect(() => {
    // 3・2・1を各1秒、「スタート！」を0.6秒表示する。
    const timers = [1, 2, 3].map(elapsed =>
      window.setTimeout(() => setRemaining(3 - elapsed), elapsed * 1000),
    );
    timers.push(window.setTimeout(onComplete, 3600));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [onComplete]);

  useEffect(() => {
    audio.play(remaining === 0 ? 'go' : 'count');
  }, [audio, remaining]);

  useEffect(() => () => audio.stop(), [audio]);

  const isGo = remaining === 0;

  return (
    <main className="countdown-screen">
      <nav className="setup-navigation" aria-label="戻る">
        <a className="back-link" href="#/play"><span aria-hidden="true">←</span> プレイの準備に戻る</a>
      </nav>
      <div className="countdown-content">
        <p className="setup-kicker">まもなく開始</p>
        <h1 ref={headingRef} tabIndex={-1}>剣を構えて</h1>
        <div className={isGo ? 'countdown-counter is-go' : 'countdown-counter'} role="status" aria-live="polite" aria-atomic="true">
          <span className="countdown-value" key={remaining}>{isGo ? 'スタート！' : remaining}</span>
        </div>
        <p className="countdown-hint">{isGo ? '相手の剣に、集中しよう。' : 'ロボットの剣を見て、待とう。'}</p>
      </div>
    </main>
  );
}
