import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import { SCREEN_HASHES } from './appNavigation';
import { MAX_ROBOT_HP, TARGETS } from './game';
import { TutorialScene } from './TutorialScene';
import { balloonContactAt, firstHitAt, firstParryAt, winRoundAt } from './tutorialIllustration';
import './game-guide.css';

const chapters = [
  {
    id: 'parry', start: 0, label: '剣をたたく合図',
    title: '青はチャンスの合図。赤でたたこう！',
    description: 'COBOTTA PROの白いスポンジ剣を見てね。光が青から赤に変わった瞬間、自分の剣でロボットの剣をたたこう。',
  },
  {
    id: 'weakness', start: 6, label: '弱点ライト',
    title: '光った弱点をたたこう。',
    description: '赤のタイミングで剣をたたけたら、赤・青・黄のライトのどれか1つが光るよ。そのライトをたたくと、ロボットの体力（HP）が1つ減る！',
  },
  {
    id: 'win', start: 12.5, label: '勝つには',
    title: '弱点に3回当てたら、きみの勝ち！',
    description: 'もう一度、剣の色を見よう。赤で剣をたたいて、次は光った弱点へ。あと2回当てると、ロボットのHPは0！',
  },
  {
    id: 'balloon', start: 22.5, label: '風船を守る',
    title: 'きみの紙風船を守ろう。',
    description: 'ロボットがねらうのは、きみの側にある紙風船。ロボットの剣が風船に届いたら、きみの負け。',
  },
] as const;

const duration = 30;

function sceneAt(elapsed: number) {
  const next = chapters.findIndex(chapter => chapter.start > elapsed);
  const index = next === -1 ? chapters.length - 1 : Math.max(0, next - 1);
  const chapter = chapters[index];
  const end = chapters[index + 1]?.start ?? duration;
  const progress = Math.max(0, Math.min(1, (elapsed - chapter.start) / (end - chapter.start)));
  return { chapter, progress, index, length: end - chapter.start };
}

type SceneCue = { label: string; color: string; hp: number | null; hitAt?: number };

// Each cue and HP change shares the illustration's contact frame.
function sceneCue(chapter: typeof chapters[number]['id'], progress: number): SceneCue {
  const ready = { label: '青！ 次は赤', color: 'blue' };
  const parry = { label: '赤！ 今たたこう', color: 'red' };
  switch (chapter) {
    case 'parry':
      return { ...(progress < firstParryAt ? ready : parry), hp: 3 };
    case 'weakness':
      return progress < firstHitAt
        ? { label: '次は青いライト！', color: 'blue', hp: 3 }
        : { label: '弱点に命中！', color: 'hit', hp: 2, hitAt: firstHitAt };
    case 'win': {
      const { parryAt, lampAt, hitAt, lampIndex, hpBefore } = winRoundAt(progress);
      if (progress < parryAt) return { ...ready, hp: hpBefore };
      if (progress < lampAt) return { ...parry, hp: hpBefore };
      const lamp = TARGETS[lampIndex];
      if (progress < hitAt) return { label: `次は${lamp.name}のライト！`, color: lamp.color, hp: hpBefore };
      return { label: hpBefore === 1 ? '3回命中、勝ち！' : '2回目も命中！', color: 'hit', hp: hpBefore - 1, hitAt };
    }
    case 'balloon':
      return progress < balloonContactAt
        ? { label: '風船を守ろう', color: 'neutral', hp: null }
        : { label: '風船に届いた！ きみの負け', color: 'red', hp: null };
  }
}

function HitFeedback({ label, hp, age }: { label: string; hp: number; age: number }) {
  // Use playback time so pausing and seeking also freeze or move the emphasis.
  const scale = 1 + .12 * Math.sin(Math.PI * Math.min(1, age / .42));
  return <div className="guide-hit" style={{ '--hit-scale': scale } as CSSProperties}>
    <strong className="guide-hit-label">{label}</strong>
    <div className="guide-hit-hp">
      <span>ロボットのHP</span>
      <span className="guide-hit-count" aria-label={`${hp + 1}から${hp}に減った`}>
        <span>{hp + 1}</span><span aria-hidden="true"> → </span><b>{hp}</b>
      </span>
    </div>
  </div>;
}

export function GuideFilm({ elapsed }: { elapsed: number }) {
  const { chapter, progress, index, length } = sceneAt(elapsed);
  const { color, label, hp, hitAt } = sceneCue(chapter.id, progress);
  return (
    <figure className="guide-film">
      <div className="guide-stage">
        <div className="guide-scene-frame">
          <TutorialScene chapter={chapter.id} progress={progress} />
          {hitAt !== undefined && hp !== null ? (
            <HitFeedback label={label} hp={hp} age={(progress - hitAt) * length} />
          ) : (
            <div className="guide-hud">
              <span className={`guide-signal signal-${color}`}><i aria-hidden="true" />{label}</span>
              {hp !== null && <span className="guide-hp">
                <span>ロボットHP</span>
                <span className="guide-hp-bars" aria-hidden="true">
                  {Array.from({ length: MAX_ROBOT_HP }, (_, i) => <i className={i < hp ? 'full' : ''} key={i} />)}
                </span>
                <b>{hp}<small> / {MAX_ROBOT_HP}</small></b>
              </span>}
            </div>
          )}
        </div>
      </div>
      <figcaption className="guide-caption">
        <div className="guide-caption-index"><b>{String(index + 1).padStart(2, '0')}</b><span> / 04</span></div>
        <div>
          <h2>{chapter.title}</h2>
          <p>{chapter.description}</p>
        </div>
      </figcaption>
    </figure>
  );
}

function formatTime(seconds: number) {
  return `0:${String(Math.floor(seconds)).padStart(2, '0')}`;
}

export function GameGuide({ headingRef, showAppLinks = true }: { headingRef?: Ref<HTMLHeadingElement>; showAppLinks?: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const position = useRef(0);
  const [playing, setPlaying] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const { index } = sceneAt(elapsed);
  const finished = elapsed >= duration;

  useEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    let frame: number;
    const tick = (now: number) => {
      if (!document.hidden) {
        position.current = Math.min(duration, position.current + (now - previous) / 1000);
        setElapsed(position.current);
      }
      previous = now;
      if (position.current >= duration) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    const resetClock = () => { previous = performance.now(); };
    document.addEventListener('visibilitychange', resetClock);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', resetClock);
    };
  }, [playing]);

  function seek(time: number) {
    position.current = time;
    setElapsed(time);
    if (time >= duration) setPlaying(false);
  }

  const buttonText = finished ? 'もう一度見る' : playing ? '一時停止' : '再生';
  return (
    <main className="guide-page">
      {showAppLinks && <header className="guide-masthead">
        <a className="guide-brand" href={SCREEN_HASHES.home}><span aria-hidden="true">剣</span>ロボットと、チャンバラ。</a>
        <a className="guide-exit" href={SCREEN_HASHES.play}>プレイの準備へ <span aria-hidden="true">→</span></a>
      </header>}
      <div className="guide-body">
        <h1 tabIndex={-1} ref={headingRef}>チャンバラの遊び方</h1>
        <div className="guide-player">
          <GuideFilm elapsed={elapsed} />
          <div className="guide-controls">
            <button type="button" className="guide-play" onClick={() => {
              if (finished) seek(0);
              setPlaying(!playing);
            }}>
              <i className={playing ? 'pause-icon' : 'play-icon'} aria-hidden="true" />{buttonText}
            </button>
            <input className="guide-seek" type="range" min="0" max={duration} step="0.1"
              aria-label="アニメーションの再生位置" aria-valuetext={`${Math.floor(elapsed)}秒 / ${duration}秒`}
              value={elapsed} onChange={event => seek(Number(event.target.value))}
              style={{ '--played': `${elapsed / duration * 100}%` } as CSSProperties} />
            <span className="guide-time" aria-hidden="true">{formatTime(elapsed)} <span>/ {formatTime(duration)}</span></span>
          </div>
        </div>
        <nav aria-label="見たい場面を選ぶ" className="guide-chapters">
          {chapters.map((chapter, i) => (
            <button type="button" key={chapter.id} aria-current={i === index ? 'step' : undefined}
              onClick={() => seek(chapter.start)}>
              <span>{String(i + 1).padStart(2, '0')}</span>{chapter.label}
            </button>
          ))}
        </nav>
      </div>
    </main>
  );
}
