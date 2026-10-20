import { useEffect, useRef } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { MAX_ROBOT_HP, ROUND_DURATION_MS, TARGETS, getAttackWindowMs, getGameLevel, isGameFinished } from './game';
import type { GamePhase, GameState } from './game';
import { INPUT_MODE_LABELS } from './inputMode';
import type { InputMode } from './inputMode';
import { useGameSession } from './useGameSession';
import type { GameAudio, GameSoundEffect } from './gameAudio';
import type { SwordSensorInput } from './swordSensor';
import { RhythmCue } from './RhythmCue';
import { LevelMeter, LevelUpCue } from './BattleFeedback';
import type { RhythmSnapshot, ParryFeedback } from './rhythm';
import './game-screen.css';

type GameScreenProps = {
  headingRef: RefObject<HTMLHeadingElement | null>;
  audio: GameAudio;
  soundEnabled: boolean;
  onToggleSound: () => void;
  inputMode: InputMode;
  sensor: SwordSensorInput;
  initialState: GameState | null;
  onOpenSettings: (game: GameState) => void;
};

const PHASE_SOUND_EFFECTS: Partial<Record<GamePhase, GameSoundEffect>> = {
  defend: 'cue', success: 'clash', attack: 'open', damage: 'levelUp', win: 'win', lose: 'lose', timeup: 'timeup',
};
const PHASE_ENGLISH: Record<GamePhase, string> = {
  idle: 'READY', ready: 'READY', defend: 'PARRY', success: 'BLOCKED',
  attack: 'HIT THE LIT TARGET', damage: 'HIT!', miss: 'TRY AGAIN',
  win: 'YOU WIN', lose: 'TRY AGAIN', timeup: 'TIME UP',
};

function getGameCue(game: GameState) {
  switch (game.phase) {
    case 'defend': return { label: '守る', title: '剣で受けて！', hint: '自分の剣で、紙風船を守ろう。' };
    case 'success': return { label: '受け成功', title: '受けた！', hint: '次は、あなたの攻撃。' };
    case 'attack': return { label: '攻撃チャンス', title: '光ったところを叩いて！', hint: '目の前の、光っている弱点へ。' };
    case 'damage': return { label: '1ダメージ', title: '命中！', hint: `あと${game.hp}回で勝利。` };
    case 'win': return { label: '挑戦クリア', title: '勝利！', hint: 'ロボットに勝った！ 紙風船を守りきった。' };
    case 'lose': return { label: '挑戦終了', title: '惜しい！', hint: '紙風船を割られた…。もう一度挑戦しよう。' };
    case 'timeup': return { label: '挑戦終了', title: '時間切れ！', hint: `あと${game.hp}回だった！ もう一度挑戦しよう。` };
    default: return { label: '構える', title: '次に備えよう', hint: '構え直そう。まもなく次の受けが始まります。' };
  }
}

function CueMark({ phase }: { phase: GamePhase }) {
  if (['success', 'win'].includes(phase)) return <span className="cue-symbol" aria-hidden="true">✓</span>;
  if (phase === 'damage') return <span className="cue-symbol damage-symbol" aria-hidden="true">−1</span>;
  if (phase === 'attack') return <span className="cue-symbol" aria-hidden="true">↓</span>;
  if (phase === 'timeup') return <span className="cue-symbol" aria-hidden="true">0</span>;
  return <svg className="cue-swords" viewBox="0 0 80 80" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="5" strokeLinecap="round"><path d="M18 62L63 17M10 54l16 16M11 69l8-8M62 62L17 17M54 70l16-16M61 61l8 8" /></g></svg>;
}

export function GameScreen({ headingRef, audio, soundEnabled, onToggleSound, inputMode, sensor, initialState, onOpenSettings }: GameScreenProps) {
  const controller = useGameSession({ inputMode, sensor, initialState });
  return <GameView {...{ headingRef, audio, soundEnabled, onToggleSound, inputMode, sensor, onOpenSettings, controller }} />;
}

type GameViewProps = Omit<GameScreenProps, 'initialState'> & {
  controller: ReturnType<typeof useGameSession>;
  integrated?: boolean;
  pendingParry?: boolean;
  rhythmSupported?: boolean;
  rhythm?: RhythmSnapshot | null;
  parryFeedback?: ParryFeedback | null;
};

export function GameView({ headingRef, audio, soundEnabled, onToggleSound, inputMode, sensor, onOpenSettings,
  controller, integrated = false, pendingParry = false,
  rhythmSupported = false, rhythm = null, parryFeedback = null }: GameViewProps) {
  const { game, gameRef, sensorState, sendAction, receiveSword, togglePause } = controller;
  const resumeRef = useRef<HTMLButtonElement>(null);
  const pauseTitleRef = useRef<HTMLHeadingElement>(null);
  const wasPaused = useRef(false);

  useEffect(() => {
    if (!integrated && !gameRef.current.paused) audio.startMusic();
    return () => audio.stop();
  }, [audio, gameRef, integrated]);

  useEffect(() => {
    if (!integrated && soundEnabled && !gameRef.current.paused && !isGameFinished(gameRef.current.phase)) audio.startMusic();
  }, [audio, gameRef, soundEnabled, integrated]);

  useEffect(() => {
    if (gameRef.current.paused) return;
    if (isGameFinished(game.phase)) audio.stop();
    const effect = PHASE_SOUND_EFFECTS[game.phase];
    if (effect && !(rhythmSupported && effect === 'cue')) audio.play(effect);
  }, [audio, gameRef, game.phase, rhythmSupported]);

  useEffect(() => {
    if (game.paused) {
      audio.pause();
      if (inputMode === 'sensor' && !sensor.getSnapshot().ready) pauseTitleRef.current?.focus();
      else resumeRef.current?.focus();
    } else if (wasPaused.current) {
      audio.resume();
      audio.startMusic();
      headingRef.current?.focus();
    }
    wasPaused.current = game.paused;
  }, [audio, game.paused, headingRef, inputMode, sensor]);

  const result = isGameFinished(game.phase);
  const cue = getGameCue(game);
  const seconds = Math.ceil(game.roundRemainingMs / 1000);
  const runManualAction = (action: () => void) => {
    action();
    headingRef.current?.focus();
  };
  const modeLabel = INPUT_MODE_LABELS[inputMode];
  const needsConnection = inputMode === 'sensor' && !sensorState.ready;
  const showRhythm = rhythmSupported && ['defend', 'miss', 'ready', 'success'].includes(game.phase);
  const level = getGameLevel(game.hp);

  return (
    <main className={`game-screen phase-${game.phase} ${rhythmSupported ? 'has-rhythm-guide' : ''}`}>
      <div className="game-layout" inert={game.paused}>
        <p className="game-input-mode">{integrated ? `会話・BGM連携 ／ ${modeLabel}` : modeLabel}</p>
        <header className="game-hud">
          <div className={`game-timer ${seconds <= 10 && !result ? 'time-low' : ''}`} role="timer" aria-label={`残り時間 ${seconds}秒`}>
            <span className="hud-label">残り時間</span>
            <div><strong className="game-time-value">{String(seconds).padStart(2, '0')}</strong><span className="time-unit">秒</span></div>
            <div className="round-time-track" aria-hidden="true"><span style={{ width: `${game.roundRemainingMs / ROUND_DURATION_MS * 100}%` }} /></div>
          </div>
          <LevelMeter level={level} />
          <div className="game-hp" aria-label={`ロボットのHP ${game.hp} / ${MAX_ROBOT_HP}`}>
            <span className="hud-label">ロボットHP</span>
            <div className="game-hp-bars" aria-hidden="true">{Array.from({ length: MAX_ROBOT_HP }, (_, index) => <span key={index} className={index < game.hp ? 'hp-filled' : ''} />)}</div>
            <span className="hp-count">{game.hp === 0 ? 'ロボット撃破！' : <>あと <strong>{game.hp}</strong> 回で勝利</>}</span>
          </div>
        </header>

        <section className="game-instruction" aria-live={showRhythm ? 'off' : 'polite'} aria-atomic="true">
          {game.phase === 'damage' ? <LevelUpCue level={level} integrated={integrated} headingRef={headingRef} />
          : showRhythm ? <RhythmCue rhythm={rhythm} feedback={parryFeedback} phase={game.phase} headingRef={headingRef}
            inputMode={inputMode} onParry={() => runManualAction(receiveSword)} pendingParry={pendingParry} /> : <>
          <div className="cue-emblem"><CueMark phase={game.phase} /></div>
          <p className="cue-label">{cue.label}</p>
          <h1 ref={headingRef} tabIndex={-1} className={game.phase === 'attack' ? 'long-cue' : ''}>{cue.title}</h1>
          {rhythmSupported && <p className="cue-english" lang="en">{PHASE_ENGLISH[game.phase]}</p>}
          <p className="cue-hint">{cue.hint}</p>
          {result && !integrated && <a className="play-again" href="#/play">もう一度挑戦する <span aria-hidden="true">→</span></a>}
          </>}
          {pendingParry && !showRhythm && <p role="status">受けのタイミングを確認中…</p>}
        </section>

        <section className="game-targets" aria-label="弱点ライト">
          <div className="game-target-row">{TARGETS.map(({ id, name, color, position }) => {
            const lit = game.phase === 'attack' && game.target === id;
            const progress = lit ? game.attackRemainingMs / getAttackWindowMs(game.hp) : 0;
            const clickable = rhythmSupported && inputMode === 'mock';
            const targetMark = rhythmSupported ? <span className="target-picture">
              {lit && <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
                <circle cx="20" cy="20" r="11" /><circle cx="20" cy="20" r="4" />
                <path d="M20 3v8m0 18v8M3 20h8m18 0h8" />
              </svg>}
              <span>{id + 1}</span>
            </span> : <span>{lit ? 'ここ！' : name}</span>;
            return <div key={name} className={`game-target target-${color} ${lit ? 'is-lit' : ''}`}
              role={clickable ? 'group' : 'img'} aria-label={`${name}のライト：${lit ? '点灯中' : '消灯'}`}>
              {clickable ? <button type="button" className="target-disc" disabled={game.phase !== 'attack'}
                aria-label={`${id + 1} ${name}を叩く / Hit ${color} target`}
                onClick={() => runManualAction(() => sendAction({ type: 'hit', target: id }))}>{targetMark}</button>
                : <div className="target-disc">{targetMark}</div>}
              <div className="target-caption"><span>{name}</span><span className="target-position">{position}</span></div>
              <div className="target-window" aria-hidden="true" style={{ '--target-progress': `${progress * 100}%` } as CSSProperties}><span /></div>
            </div>;
          })}</div>
          <p className="targets-hint">{result ? '' : game.notice || (game.phase === 'attack' ? '点灯中に、実物のライトを叩こう。' : '攻撃チャンスになると、1つだけ光ります。')}</p>
        </section>

        <footer className="game-footer">
          <div className="game-tools">
            <a className="back-link" href="#/play">← プレイの準備に戻る</a>
            <div>
              <button type="button" aria-pressed={soundEnabled} onClick={() => runManualAction(onToggleSound)}>{integrated ? '効果音 ' : '♪ 音 '}{soundEnabled ? 'ON' : 'OFF'}</button>
              <button type="button" disabled={result} onClick={togglePause}>{integrated ? '中断する' : '一時停止'} <kbd>Esc</kbd></button>
            </div>
          </div>
          <div className="game-mock-controls" aria-label={inputMode === 'sensor' ? 'ゲームの手動補助' : 'ゲームのモック操作'}>
            <span className="mock-caption">{inputMode === 'sensor' ? '手動補助' : 'モック操作'}</span>
            {inputMode === 'mock' && <button disabled={game.phase !== 'defend' || pendingParry} onClick={() => runManualAction(receiveSword)}><kbd>Space</kbd> 受けた</button>}
            {inputMode === 'mock' && TARGETS.map(({ id, name }) => <button key={name} disabled={game.phase !== 'attack'} onClick={() => runManualAction(() => sendAction({ type: 'hit', target: id }))}><kbd>{id + 1}</kbd> {name}を叩く</button>)}
            <button disabled={game.phase !== 'defend'} onClick={() => runManualAction(() => sendAction({ type: 'miss' }))}><kbd>F</kbd> 受け失敗</button>
            <button disabled={result} onClick={() => runManualAction(() => sendAction({ type: 'balloon' }))}><kbd>B</kbd> 紙風船が割れた</button>
          </div>
          {integrated && <p className="game-input-help">{rhythmSupported
            ? '3つの予告音で構えて、最後の高い「カン！」で受けよう。BGMと予告音は統合アプリのPCから流れます。'
            : '音楽に合わせて受けよう。BGMは統合アプリのPCから流れます。'} 中断すると、このゲームは終了します。</p>}
          {inputMode === 'sensor' && <p className="game-input-help">{integrated ? '受けはBGMのタイミングで判定し、点灯中の接触を命中とします。' : '受け・命中はセンサの信号で判定します。'}今は叩いたランプの色を判定しません。次の受けは自動で始まります。</p>}
        </footer>
      </div>

      {game.paused && <div className="game-pause-overlay" role="dialog" aria-modal="true" aria-labelledby="pause-title">
        <p className="setup-kicker">{modeLabel}</p>
        <h2 id="pause-title" ref={pauseTitleRef} tabIndex={-1}>一時停止中</h2>
        <p>{needsConnection
          ? '時間を止めています。管理画面で接続と入力を確認してから、このゲームへ戻ってください。'
          : '時間を止めています。準備ができたら再開しよう。'}</p>
        {inputMode === 'sensor' && <button className="game-settings-button" type="button" onClick={() => onOpenSettings(gameRef.current)}>管理画面で接続を確認</button>}
        <button type="button" ref={resumeRef} className="resume-game" disabled={needsConnection} onClick={togglePause}>再開する <kbd>Esc</kbd></button>
        <a className="back-link" href="#/play">終了してプレイの準備に戻る</a>
      </div>}
    </main>
  );
}
