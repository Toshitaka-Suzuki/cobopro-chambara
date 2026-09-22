import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { initialGame, levelOf, targetNames, targetWindows, transition } from './game';
import type { Action, Game, Phase, Target } from './game';
import type { GameAudio } from './gameAudio';
import './game-screen.css';

type GameScreenProps = {
  headingRef: RefObject<HTMLHeadingElement | null>;
  audio: GameAudio;
  soundEnabled: boolean;
  onToggleSound: () => void;
};

const finished = (phase: Phase) => ['win', 'lose', 'timeup'].includes(phase);
const targetColors = ['red', 'blue', 'yellow'];
const initialRound = () => transition(transition(initialGame, { type: 'start' }), { type: 'cue' });

function cueFor(game: Game) {
  switch (game.phase) {
    case 'defend': return { label: '守る', title: '剣で受けて！', hint: '自分の剣で、紙風船を守ろう。' };
    case 'success': return { label: '受け成功', title: '受けた！', hint: '次は、あなたの攻撃。' };
    case 'attack': return { label: '攻撃チャンス', title: '光ったところを叩いて！', hint: '目の前の、光っている弱点へ。' };
    case 'damage': return { label: '1ダメージ', title: '命中！', hint: `あと${game.hp}回で勝利。` };
    case 'win': return { label: '挑戦クリア', title: '勝利！', hint: 'ロボットに勝った！ 紙風船を守りきった。' };
    case 'lose': return { label: '挑戦終了', title: '惜しい！', hint: '紙風船を割られた…。もう一度挑戦しよう。' };
    case 'timeup': return { label: '挑戦終了', title: '時間切れ！', hint: `あと${game.hp}回だった！ もう一度挑戦しよう。` };
    case 'unknown': return { label: '確認中', title: '少し待ってね', hint: 'スタッフの案内を待とう。' };
    default: return { label: '構える', title: '次に備えよう', hint: 'ロボットの剣を見て、構え直そう。' };
  }
}

function CueMark({ phase }: { phase: Phase }) {
  if (['success', 'win'].includes(phase)) return <span className="cue-symbol" aria-hidden="true">✓</span>;
  if (phase === 'damage') return <span className="cue-symbol damage-symbol" aria-hidden="true">−1</span>;
  if (phase === 'attack') return <span className="cue-symbol attack-symbol" aria-hidden="true">↓</span>;
  if (phase === 'timeup') return <span className="cue-symbol" aria-hidden="true">0</span>;
  return <svg className="cue-swords" viewBox="0 0 80 80" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="5" strokeLinecap="round"><path d="M18 62L63 17M10 54l16 16M11 69l8-8M62 62L17 17M54 70l16-16M61 61l8 8" /></g></svg>;
}

export function GameScreen({ headingRef, audio, soundEnabled, onToggleSound }: GameScreenProps) {
  const [game, setGame] = useState<Game>(initialRound);
  const current = useRef(game);
  const lastTick = useRef(performance.now());
  const resumeRef = useRef<HTMLButtonElement>(null);
  const wasPaused = useRef(false);

  const send = useCallback((action: Action) => {
    const now = performance.now();
    // 入力の直前にも時間を進め、時間切れ後の命中を受け付けない。
    let next = transition(current.current, { type: 'tick', elapsed: now - lastTick.current });
    lastTick.current = now;
    next = transition(next, action);
    if (next !== current.current) {
      current.current = next;
      setGame(next);
    }
  }, []);

  const togglePause = useCallback(() => {
    send({ type: current.current.paused ? 'resume' : 'pause' });
  }, [send]);

  const receiveSword = useCallback(() => {
    send({ type: 'success', target: Math.floor(Math.random() * 3) as Target });
  }, [send]);

  useEffect(() => {
    lastTick.current = performance.now();
    const timer = window.setInterval(() => send({ type: 'tick', elapsed: 0 }), 50);
    return () => window.clearInterval(timer);
  }, [send]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Escape') { event.preventDefault(); togglePause(); return; }
      if (current.current.paused || finished(current.current.phase)) return;
      if (event.code === 'Space' && target instanceof HTMLElement && target.closest('button, a, summary')) return;
      if (event.code === 'KeyA') { event.preventDefault(); send({ type: 'cue' }); }
      if (event.code === 'Space') { event.preventDefault(); receiveSword(); }
      if (event.code === 'KeyF') { event.preventDefault(); send({ type: 'miss' }); }
      if (event.code === 'KeyB') { event.preventDefault(); send({ type: 'balloon' }); }
      const digit = /^(?:Digit|Numpad)([123])$/.exec(event.code);
      if (digit) { event.preventDefault(); send({ type: 'hit', target: (Number(digit[1]) - 1) as Target }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [send, receiveSword, togglePause]);

  useEffect(() => {
    audio.startMusic();
    return () => audio.stop();
  }, [audio]);

  useEffect(() => {
    if (soundEnabled && !current.current.paused && !finished(current.current.phase)) audio.startMusic();
  }, [audio, soundEnabled]);

  useEffect(() => {
    if (finished(game.phase)) audio.stop();
    const effects = { defend: 'cue', success: 'clash', attack: 'open', damage: 'hit', win: 'win', lose: 'lose', timeup: 'timeup' } as const;
    if (game.phase in effects) audio.play(effects[game.phase as keyof typeof effects]);
  }, [audio, game.phase]);

  useEffect(() => {
    if (game.paused) {
      audio.pause();
      resumeRef.current?.focus();
    } else if (wasPaused.current) {
      audio.resume();
      headingRef.current?.focus();
    }
    wasPaused.current = game.paused;
  }, [audio, game.paused, headingRef]);

  const result = finished(game.phase);
  const cue = cueFor(game);
  const seconds = Math.ceil(game.timeLeftMs / 1000);
  const canCue = ['ready', 'damage', 'miss'].includes(game.phase);
  const useMock = (action: () => void) => { action(); headingRef.current?.focus(); };

  return (
    <main className={`game-screen phase-${game.phase}`}>
      <div className="game-layout" inert={game.paused}>
        <header className="game-hud">
          <div className={`game-timer ${seconds <= 10 && !result ? 'time-low' : ''}`} role="timer" aria-label={`残り時間 ${seconds}秒`}>
            <span className="hud-label">残り時間</span>
            <div><strong className="game-time-value">{String(seconds).padStart(2, '0')}</strong><span className="time-unit">秒</span></div>
            <div className="round-time-track" aria-hidden="true"><span style={{ width: `${game.timeLeftMs / 600}%` }} /></div>
          </div>
          <div className="game-hp" aria-label={`ロボットのHP ${game.hp} / 3`}>
            <span className="hud-label">ロボットHP</span>
            <div className="game-hp-bars" aria-hidden="true">{[0, 1, 2].map(index => <span key={index} className={index < game.hp ? 'hp-filled' : ''} />)}</div>
            <span className="hp-count">{game.hp === 0 ? 'ロボット撃破！' : <>あと <strong>{game.hp}</strong> 回で勝利</>}</span>
          </div>
        </header>

        <section className="game-instruction" aria-live="polite" aria-atomic="true">
          <div className="cue-emblem"><CueMark phase={game.phase} /></div>
          <p className="cue-label">{cue.label}</p>
          <h1 ref={headingRef} tabIndex={-1} className={game.phase === 'attack' ? 'long-cue' : ''}>{cue.title}</h1>
          <p className="cue-hint">{cue.hint}</p>
          {result && <a className="play-again" href="#/play">もう一度挑戦する <span aria-hidden="true">→</span></a>}
        </section>

        <section className="game-targets" aria-label="弱点ライト">
          <div className="game-target-row">{targetNames.map((name, index) => {
            const lit = game.phase === 'attack' && game.target === index;
            const progress = lit ? game.remainingMs / targetWindows[levelOf(game.hp) - 1] : 0;
            return <div key={name} className={`game-target target-${targetColors[index]} ${lit ? 'is-lit' : ''}`} role="img" aria-label={`${name}のライト：${lit ? '点灯中' : '消灯'}`}>
              <div className="target-disc"><span>{lit ? 'ここ！' : name}</span></div>
              <div className="target-caption"><span>{name}</span><span className="target-position">{['左', '中央', '右'][index]}</span></div>
              <div className="target-window" aria-hidden="true" style={{ '--target-progress': `${progress * 100}%` } as CSSProperties}><span /></div>
            </div>;
          })}</div>
          <p className="targets-hint">{result ? '' : game.notice || (game.phase === 'attack' ? '点灯中に、実物のライトを叩こう。' : '攻撃チャンスになると、1つだけ光ります。')}</p>
        </section>

        <footer className="game-footer">
          <div className="game-tools">
            <a className="back-link" href="#/play">← プレイの準備に戻る</a>
            <div>
              <button type="button" aria-pressed={soundEnabled} onClick={() => useMock(onToggleSound)}>{soundEnabled ? '♪ 音 ON' : '♪ 音 OFF'}</button>
              <button type="button" disabled={result} onClick={togglePause}>一時停止 <kbd>Esc</kbd></button>
            </div>
          </div>
          <div className="game-mock-controls" aria-label="ゲームのモック操作">
            <span className="mock-caption">モック操作</span>
            <button disabled={!canCue || result} onClick={() => useMock(() => send({ type: 'cue' }))}><kbd>A</kbd> 次の打ち合い</button>
            <button disabled={game.phase !== 'defend'} onClick={() => useMock(receiveSword)}><kbd>Space</kbd> 受けた</button>
            {targetNames.map((name, index) => <button key={name} disabled={game.phase !== 'attack'} onClick={() => useMock(() => send({ type: 'hit', target: index as Target }))}><kbd>{index + 1}</kbd> {name}を叩く</button>)}
            <button disabled={game.phase !== 'defend'} onClick={() => useMock(() => send({ type: 'miss' }))}><kbd>F</kbd> 受け失敗</button>
            <button disabled={result} onClick={() => useMock(() => send({ type: 'balloon' }))}><kbd>B</kbd> 紙風船が割れた</button>
          </div>
        </footer>
      </div>

      {game.paused && <div className="game-pause-overlay" role="dialog" aria-modal="true" aria-labelledby="pause-title">
        <p className="setup-kicker">ひと休み</p>
        <h2 id="pause-title">一時停止中</h2>
        <p>時間を止めています。準備ができたら再開しよう。</p>
        <button type="button" ref={resumeRef} className="resume-game" onClick={togglePause}>再開する <kbd>Esc</kbd></button>
        <a className="back-link" href="#/play">終了してプレイの準備に戻る</a>
      </div>}
    </main>
  );
}
