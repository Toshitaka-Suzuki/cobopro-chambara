import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { GamePhase } from './game';
import type { InputMode } from './inputMode';
import { projectRhythm } from './rhythm';
import type { ParryFeedback, RhythmSnapshot } from './rhythm';
import { ParryBurst } from './BattleFeedback';
import './rhythm.css';

type Props = {
  rhythm: RhythmSnapshot | null;
  feedback: ParryFeedback | null;
  phase: GamePhase;
  headingRef: RefObject<HTMLHeadingElement | null>;
  inputMode: InputMode;
  onParry: () => void;
  pendingParry: boolean;
};

/** 文字とレイアウトを固定し、接近する剣・輪だけで目標時刻を予告する。 */
export function RhythmCue({ rhythm, feedback, phase, headingRef, inputMode, onParry, pendingParry }: Props) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    let frame = 0;
    const update = () => { setNow(performance.now()); frame = requestAnimationFrame(update); };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);
  const cue = phase === 'defend' ? projectRhythm(rhythm, now) : null;
  const success = phase === 'success';
  const showFeedback = feedback && ['success', 'miss', 'ready'].includes(phase);
  const progress = success ? 1 : cue?.progress ?? 0;
  const approaching = Boolean(cue && cue.beat > 0);
  const impact = cue?.beat === 4;
  const resultLabel = feedback?.timing === 'on_time' ? '✓ 受け成功 / GOOD'
    : feedback?.timing === 'early' ? '← 早い / EARLY' : '遅い / LATE →';
  // 目標は中央、早い入力は左、遅い入力は右。同じ目盛りを結果の表示中は保つ。
  const feedbackPosition = feedback ? 50 + Math.max(-43, Math.min(43, feedback.deltaMs / 10)) : 50;
  return <div className={`rhythm-guide ${success ? 'is-success' : ''}`}>
    <h1 ref={headingRef} tabIndex={-1}>受ける <span lang="en">PARRY</span></h1>
    <p className="rhythm-hint">輪が重なる瞬間に <span lang="en">MATCH THE RINGS</span></p>

    <div className="rhythm-arena" aria-hidden="true">
      <svg viewBox="100 0 440 240" fill="none">
        <path className="rhythm-approach-path" d="M126 41 246 102" />
        <path className="rhythm-approach-arrow" d="m231 87 15 15-22-3" />
        <circle className="rhythm-track" cx="320" cy="117" r="105" />
        <circle className="rhythm-target-ring" cx="320" cy="117" r="46" />
        <circle className="rhythm-approach-ring" cx="320" cy="117" r={46 + 59 * (1 - progress)}
          style={{ opacity: approaching || success ? 0.85 : 0.12 }} />

        {/* 手前の剣は固定。相手の剣の先端が中央へ到達すると2本が交わる。 */}
        <g className="rhythm-player-sword">
          <path d="m264 173 79-99 10-5-2 12-79 99z" />
          <path d="m255 163 27 23m-17-9-19 24" />
        </g>
        <g className="rhythm-incoming-sword"
          style={{
            transform: `translate(${-94 * (1 - progress)}px, ${-12 * (1 - progress)}px)`,
            opacity: approaching || success ? 1 : 0.22,
          }}>
          <path d="m245 38 78 73 5 14-14-5-78-73z" />
          <path d="m232 53 22-23m-11 11-22-22" />
        </g>
        <g className="rhythm-contact-mark" style={{ opacity: impact || success ? 1 : 0 }}>
          <path d="m306 116-9-2m39 8 9 3m-23-24 2-9m-9 40-2 9" />
        </g>
        {success && <ParryBurst />}
      </svg>
      {success && <div className="parry-success-label">
        <svg viewBox="0 0 40 40" fill="none"><path d="m8 20 8 8 16-17" /></svg>
        <strong lang="en">PARRY!</strong><span>受け成功</span>
      </div>}
      <div className="rhythm-beat-dots">
        {[1, 2, 3].map(beat => <span key={beat} className={cue && cue.beat >= beat ? 'filled' : ''} />)}
        <span className="rhythm-beat-target">✕</span>
      </div>
    </div>

    <div className="rhythm-controls">
      <div className="rhythm-action">
        {inputMode === 'mock' ? <button type="button" className="rhythm-parry-button"
          disabled={phase !== 'defend' || pendingParry} onClick={onParry}
          aria-label="Spaceキー、またはクリックで受ける / Press Space or click to parry">
          <span className="rhythm-key"><span aria-hidden="true">⎵</span> SPACE</span>
          <span>受ける <span lang="en">PARRY</span></span>
        </button> : <span className="rhythm-sensor-action">
          <svg viewBox="0 0 40 40" aria-hidden="true"><path d="m7 33 26-26M3 27l10 10M7 7l26 26m-6 4 10-10" /></svg>
          剣で受ける <span lang="en">BLOCK</span>
        </span>}
      </div>

      <div className={`rhythm-feedback ${showFeedback ? 'has-result' : ''}`} role="status">
        <p className="rhythm-result-label">{showFeedback ? resultLabel : '\u00a0'}</p>
        <div className="rhythm-timing-scale" aria-hidden="true">
          <span className="rhythm-timing-window" />
          <span className="rhythm-timing-center" />
          {showFeedback && <span className="rhythm-input-marker" style={{ left: `${feedbackPosition}%` }} />}
        </div>
        <div className="rhythm-timing-legend" aria-hidden="true">
          <span>EARLY</span><span>●</span><span>LATE</span>
        </div>
      </div>
    </div>
  </div>;
}
