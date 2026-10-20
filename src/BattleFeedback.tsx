import type { RefObject } from 'react';
import { MAX_ROBOT_HP } from './game';
import './battle-feedback.css';

export function LevelMeter({ level }: { level: number }) {
  return <div className="game-level" aria-label={`レベル ${level} / ${MAX_ROBOT_HP}`}>
    <span className="hud-label" lang="en">LEVEL</span>
    <div className="game-level-value"><strong>{level}</strong><span>/ {MAX_ROBOT_HP}</span>
      {level === MAX_ROBOT_HP && <b className="game-level-max">MAX</b>}
    </div>
    <div className="level-steps" aria-hidden="true">{[1, 2, 3].map(step =>
      <span key={step} className={step <= level ? 'is-filled' : ''} />)}</div>
  </div>;
}

export function LevelUpCue({ level, integrated, headingRef }: {
  level: number;
  integrated: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return <div className="level-up-cue">
    <p className="level-up-hit">✓ HIT! <span>命中</span></p>
    <h1 ref={headingRef} tabIndex={-1} className="level-up-title" lang="en">LEVEL UP</h1>
    <div className="level-up-numbers" aria-label={`レベル ${level - 1} から ${level} へ`}>
      <span className="level-up-previous" aria-hidden="true">{level - 1}</span>
      <svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="m12 12 20 20-20 20m20-40 20 20-20 20" /></svg>
      <strong className="level-up-next" aria-hidden="true">{level}</strong>
    </div>
    <div className="level-steps level-up-steps" aria-hidden="true">{[1, 2, 3].map(step =>
      <span key={step} className={`${step <= level ? 'is-filled' : ''} ${step === level ? 'is-new' : ''}`} />)}</div>
    <p className="level-up-detail" lang="en">{level === MAX_ROBOT_HP ? 'MAX LEVEL' : 'NEXT LEVEL'}
      {integrated && <span> · BGM SPEED UP ↑</span>}</p>
    <p className="level-up-hint">{level === MAX_ROBOT_HP ? '最高レベル！ あと一撃。' : 'レベルアップ！ 次の一撃に備えよう。'}</p>
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
