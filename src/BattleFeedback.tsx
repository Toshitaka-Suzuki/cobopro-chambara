import type { RefObject } from 'react';
import { DIFFICULTY_LABELS } from './game';
import type { Difficulty } from './game';
import './battle-feedback.css';

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  return <div className={`game-difficulty difficulty-${difficulty}`} aria-label={`難易度：${DIFFICULTY_LABELS[difficulty]}`}>
    <span className="hud-label">難易度</span>
    <strong lang="en">{difficulty.toUpperCase()}</strong>
    <span className="game-difficulty-name">{DIFFICULTY_LABELS[difficulty]}</span>
  </div>;
}

export function HitCue({ remaining, difficulty, headingRef }: {
  remaining: number;
  difficulty: Difficulty;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return <div className="hit-cue">
    <p className="hit-cue-label" lang="en">✓ HIT!</p>
    <h1 ref={headingRef} tabIndex={-1} className="hit-cue-title">命中！</h1>
    <div className="hit-cue-remaining" aria-label={`あと${remaining}回で勝利`}>
      <span aria-hidden="true">あと</span><strong aria-hidden="true">{remaining}</strong><span aria-hidden="true">回で勝利</span>
    </div>
    <p className="hit-cue-hint">{remaining === 1 ? 'あと一撃！ 落ち着いて構えよう。' : 'その調子！ 次の一撃に備えよう。'}</p>
    <p className="hit-cue-difficulty">難易度：{DIFFICULTY_LABELS[difficulty]}</p>
  </div>;
}

/** SVGの剣が交わる位置に重ねる。一度だけ外へ広がり、次の攻撃前に消える。 */
export function ParryBurst() {
  return <g className="parry-burst" transform="translate(320 117)">
    <circle className="parry-shockwave" r="42" />
    <circle className="parry-shockwave parry-shockwave-outer" r="42" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map(angle =>
      <g key={angle} transform={`rotate(${angle})`}>
        <path className="parry-spark" d="M18 0h17m7 0h4" />
      </g>)}
  </g>;
}
