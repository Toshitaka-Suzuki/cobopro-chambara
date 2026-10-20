import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { Countdown } from './Countdown';
import { GameView } from './GameScreen';
import type { GameAudio } from './gameAudio';
import type { InputMode } from './inputMode';
import type { IntegratedSession } from './integratedSession';
import type { SwordSensorInput } from './swordSensor';
import { useGameInput } from './useGameInput';
import './integration.css';

type Props = {
  session: IntegratedSession;
  inputMode: InputMode;
  sensor: SwordSensorInput;
  audio: GameAudio;
  headingRef: RefObject<HTMLHeadingElement | null>;
  soundEnabled: boolean;
  onToggleSound: () => void;
};

export function IntegratedExperience({ session, inputMode, sensor, audio, headingRef, soundEnabled, onToggleSound }: Props) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const sensorState = useSyncExternalStore(sensor.subscribeState, sensor.getSnapshot);
  const gameRef = useRef(snapshot.game);
  const receiveSword = useCallback(() => {
    if (inputMode === 'sensor' && !sensor.getSnapshot().ready) return;
    session.action({ type: inputMode === 'sensor' ? 'contact' : 'swordClash' });
  }, [inputMode, sensor, session]);
  const cancel = useCallback(() => {
    session.cancel();
    window.location.hash = '#/play';
  }, [session]);
  useGameInput(gameRef, inputMode, session.action, receiveSword, cancel);

  useEffect(() => {
    let previous = session.getSnapshot();
    gameRef.current = previous.game;
    sensor.discardPending();
    // 状態変更と同じ受信処理内で部分入力を捨て、場面をまたいで接触を配信しない。
    const unsubscribeGame = session.subscribe(() => {
      const next = session.getSnapshot();
      gameRef.current = next.game;
      if (previous.phase !== next.phase || previous.game.phase !== next.game.phase) sensor.discardPending();
      previous = next;
    });
    const checkSensor = () => {
      if (inputMode === 'sensor' && !sensor.getSnapshot().ready) {
        session.cancel('センサの接続が切れたため、ゲームを中断しました。管理画面で接続と入力を確認してください。');
      }
    };
    const unsubscribeSensor = sensor.subscribeState(checkSensor);
    const unsubscribeClash = inputMode === 'sensor' ? sensor.subscribeClash(receiveSword) : () => {};
    checkSensor();
    return () => {
      unsubscribeGame();
      unsubscribeSensor();
      unsubscribeClash();
      sensor.discardPending();
      audio.stop();
    };
  }, [session, sensor, inputMode, receiveSword, audio]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [snapshot.phase, headingRef]);

  if (snapshot.phase === 'countdown') {
    return <Countdown headingRef={headingRef} audio={audio} inputMode={inputMode} onComplete={session.startBattle} />;
  }
  if (snapshot.phase === 'battle' || snapshot.phase === 'ending') {
    return <>
      {snapshot.conversationMode === 'mock_silent' && <p className="integration-demo-banner">無音テスト中：BGMは鳴りません。パリイは設定された時間帯で判定します。</p>}
      <GameView {...{ headingRef, audio, soundEnabled, onToggleSound, inputMode, sensor }}
        rhythmSupported={snapshot.rhythmSupported} rhythm={snapshot.rhythm} parryFeedback={snapshot.parryFeedback}
        integrated pendingParry={snapshot.pendingParry} onOpenSettings={() => {}}
        controller={{ game: snapshot.game, gameRef, sensorState, sendAction: session.action, receiveSword, togglePause: cancel }} />
    </>;
  }
  const pre = snapshot.phase === 'starting' || snapshot.phase === 'pre_interview';
  const post = snapshot.phase === 'post_interview';
  const complete = snapshot.phase === 'complete';
  const mock = snapshot.conversationMode !== 'live';
  const title = snapshot.error ? 'ゲームを中断しました'
    : pre ? 'どんな作戦で挑む？'
      : post ? 'やってみて、どうだった？'
        : complete ? 'お疲れさまでした！'
          : snapshot.phase === 'starting_battle' ? '対戦を準備しています'
            : snapshot.phase === 'cancelling' ? 'ゲームを終了しています' : 'ゲームを中断しました';
  const result = snapshot.game.phase === 'win' ? 'ロボットに勝利！'
    : snapshot.game.phase === 'lose' ? '惜しい！ 紙風船を割られた…'
      : snapshot.game.phase === 'timeup' ? '時間切れ！' : '';
  return <main className="setup-screen interview-screen">
    <nav className="setup-navigation"><a className="back-link" href="#/play">← プレイの準備に戻る</a></nav>
    <div className="interview-content">
      <ol className="experience-steps" aria-label="ゲームの流れ">
        <li aria-current={pre ? 'step' : undefined}>作戦の会話</li>
        <li aria-current={snapshot.phase === 'starting_battle' ? 'step' : undefined}>チャンバラ</li>
        <li aria-current={post || complete ? 'step' : undefined}>感想の会話</li>
      </ol>
      <p className="setup-kicker">{pre ? '対戦前のインタビュー' : post ? '対戦後のインタビュー' : '会話・BGM連携'}</p>
      {(post || complete) && result && <p className="interview-result">{result}</p>}
      <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
      {snapshot.error ? <p role="alert" className="setup-notice">{snapshot.error}</p>
        : (pre || post) ? <>
          <p>{mock ? '会話の模擬動作を確認中です。約3秒で次へ進みます。' : 'ロボットの質問を聞いてから、マイクに向かって話してください。'}</p>
          <p className="interview-help">{mock ? 'このモードでは録音・返答の生成・読み上げは行いません。'
            : '話し終えると自動で録音を終え、ロボットがコメントを返します。操作は不要です。'}</p>
          {pre && <p className="interview-help">会話中は制限時間を減らしません。</p>}
        </> : complete ? <p>次のプレイを始める準備ができました。</p>
          : snapshot.phase === 'starting_battle' ? <p role="status">統合アプリのBGM開始を確認しています…</p> : null}
      <div className="interview-actions">
        {snapshot.phase === 'pre_interview' && <button type="button" onClick={session.skipInterview}>会話をスキップして対戦へ</button>}
        {session.active ? <button type="button" onClick={cancel}>中断して準備に戻る</button>
          : <a className="start-game-button" href="#/play">{complete ? '次のプレイを準備する' : '接続と準備を確認する'} →</a>}
      </div>
    </div>
  </main>;
}
