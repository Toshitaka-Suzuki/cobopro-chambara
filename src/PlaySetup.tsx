import type { ReactNode, Ref } from 'react';
import type { SwordSensorSnapshot } from './swordSensor';
import { INPUT_MODE_LABELS } from './inputMode';
import type { InputMode } from './inputMode';
import type { ExperienceMode } from './integratedSession';
import { DIFFICULTIES, DIFFICULTY_LABELS, getAttackWindowMs } from './game';
import type { Difficulty } from './game';

type PlaySetupProps = {
  headingRef: Ref<HTMLHeadingElement>;
  inputMode: InputMode;
  onModeChange: (mode: InputMode) => void;
  sensorState: SwordSensorSnapshot;
  notice: string;
  onStart: () => void;
  experienceMode: ExperienceMode;
  onExperienceModeChange: (mode: ExperienceMode) => void;
  difficulty: Difficulty;
  onDifficultyChange: (difficulty: Difficulty) => void;
  integrationReady: boolean;
  connectionControls: ReactNode;
  espReady: boolean;
  espControls: ReactNode;
};

export function PlaySetup({ headingRef, inputMode, onModeChange, sensorState, notice, onStart,
  experienceMode, onExperienceModeChange, difficulty, onDifficultyChange, integrationReady, connectionControls,
  espReady, espControls }: PlaySetupProps) {
  const integrated = experienceMode === 'integrated';
  const esp = integrated && inputMode === 'esp';
  const inputReady = inputMode === 'mock' || (inputMode === 'sensor' && sensorState.ready) || (esp && espReady);
  const canStart = inputReady && (!integrated || integrationReady);
  return (
    <main className="setup-screen">
      <nav className="setup-navigation" aria-label="画面移動">
        <a className="back-link" href="#/"><span aria-hidden="true">←</span> 画面選択に戻る</a>
        <a className="back-link" href="#/admin">機器の設定 <span aria-hidden="true">→</span></a>
      </nav>
      <div className="setup-content">
        <header className="setup-heading">
          <p className="setup-kicker">ロボットと、チャンバラ。</p>
          <h1 ref={headingRef} tabIndex={-1}>プレイの準備</h1>
          <p>遊び方・難易度・入力方法を選んで、ゲームを始めましょう。</p>
        </header>

        <fieldset className="input-mode-picker">
          <legend>遊び方</legend>
          <label className={`input-mode-choice${integrated ? ' is-selected' : ''}`}>
            <input type="radio" name="experience" checked={integrated} onChange={() => onExperienceModeChange('integrated')} />
            <span><strong>会話・BGM連携</strong><small>作戦の会話から、音楽に合わせた対戦、感想まで</small></span>
          </label>
          <label className={`input-mode-choice${!integrated ? ' is-selected' : ''}`}>
            <input type="radio" name="experience" checked={!integrated} onChange={() => onExperienceModeChange('standalone')} />
            <span><strong>画面単独テスト</strong><small>統合アプリなしで、画面と入力を確認</small></span>
          </label>
        </fieldset>
        {integrated && connectionControls}

        <fieldset className="input-mode-picker difficulty-picker">
          <legend>難易度</legend>
          {DIFFICULTIES.map(option => <label key={option} className={`input-mode-choice${difficulty === option ? ' is-selected' : ''}`}>
            <input type="radio" name="difficulty" value={option} checked={difficulty === option} onChange={() => onDifficultyChange(option)} />
            <span><strong>{DIFFICULTY_LABELS[option]}</strong><small>
              {integrated && `${option === 'easy' ? 'ゆっくり' : option === 'normal' ? '標準の速さ' : 'はやい'} ／ `}
              攻撃チャンス {esp ? 10 : getAttackWindowMs(option) / 1000}秒
            </small></span>
          </label>)}
          <p className="difficulty-help">この難易度で最後まで遊びます。命中しても難しくなりません。</p>
          {esp && <p className="difficulty-help">ESP連携では現行機器に合わせ、弱点Aの有効時間は全難易度で10秒です。</p>}
        </fieldset>

        <fieldset className="input-mode-picker">
          <legend>入力方法</legend>
          <label className={inputMode === 'mock' ? 'input-mode-choice is-selected' : 'input-mode-choice'}>
            <input type="radio" name="input-mode" value="mock" checked={inputMode === 'mock'} onChange={() => onModeChange('mock')} />
            <span><strong>{INPUT_MODE_LABELS.mock}</strong><small>機器なしで、キーとボタンで操作</small></span>
          </label>
          <label className={inputMode === 'sensor' ? 'input-mode-choice is-selected' : 'input-mode-choice'}>
            <input type="radio" name="input-mode" value="sensor" checked={inputMode === 'sensor'} onChange={() => onModeChange('sensor')} />
            <span><strong>{INPUT_MODE_LABELS.sensor}</strong><small>USBの信号で受けと命中を判定</small></span>
          </label>
          {integrated && <label className={esp ? 'input-mode-choice is-selected' : 'input-mode-choice'}>
            <input type="radio" name="input-mode" value="esp" checked={esp} onChange={() => onModeChange('esp')} />
            <span><strong>{INPUT_MODE_LABELS.esp}</strong><small>XIAO経由で予告と判定を連携。機器の成功通知で進行</small></span>
          </label>}
        </fieldset>

        {notice && <p className="setup-notice" role="alert">{notice}</p>}
        {inputMode === 'mock' ? (
          <section className="setup-input-check is-ready" aria-label="ゲームテストの準備">
            <span className="setup-check-mark" aria-hidden="true">✓</span>
            <div>
              <h2>キーとボタンで入力します</h2>
              <p>剣を受ける操作は <kbd>Space</kbd>。命中は画面のボタンで試せます。次の受け待ちへは自動で進みます。</p>
              {sensorState.connected && <p>USB接続は保持中です。このモードではゲームの入力に使いません。</p>}
            </div>
          </section>
        ) : esp ? espControls : inputMode === 'sensor' ? (
          <div className="sensor-preparation">
            <section className={`setup-input-check${sensorState.ready ? ' is-ready' : ''}`} aria-label="センサ入力の確認">
              <span className="setup-check-mark" aria-hidden="true">{sensorState.ready ? '✓' : '…'}</span>
              <div>
                <h2 role="status">{sensorState.ready ? '入力確認済み・開始できます' : sensorState.connected ? '接続中・入力は未確認です' : '機器が接続されていません'}</h2>
                <p>{sensorState.ready ? '管理画面で設定した接続を使います。接続が続いていれば、次のプレイもそのまま開始できます。' : '管理画面で機器を設定し、入力を確認してから戻ってきてください。'}</p>
                {!sensorState.ready && <a className="setup-settings-link" href="#/admin">管理画面で設定する <span aria-hidden="true">→</span></a>}
              </div>
            </section>
            <p className="setup-assistance">{integrated ? '受け待ちの信号をBGMのタイミングで判定します。' : '受け待ちの信号でパリィ成功とします。'}ランプ点灯中の信号は命中とします。叩いたランプの色は、今は判定しません。次の受け待ちへは自動で進みます。</p>
          </div>
        ) : <p className="setup-notice">ESP連携は「会話・BGM連携」で使用できます。</p>}

        <div className="start-game-area">
          <button className="start-game-button" disabled={!canStart} onClick={onStart} aria-describedby="start-game-hint">
            ゲーム開始 <span aria-hidden="true">→</span>
          </button>
          <p id="start-game-hint">{integrated && !integrationReady ? '統合アプリに接続して、準備完了になるまでお待ちください。'
            : canStart ? integrated ? 'まず作戦を話しましょう。会話の後、カウントダウンで対戦が始まります。'
              : '3秒のカウントダウン後に始まります。' : esp ? '上の接続状態を確認し、ESP対応の統合アプリとXIAOに接続してください。'
                : '管理画面で接続と入力を確認すると、開始できます。'}</p>
        </div>
        {inputMode === 'sensor' && <p className="setup-assistance">画面移動やモックへの切り替えでも接続を保ちます。USBを抜く・切断する・ページを再読み込みした場合は、再接続が必要です。</p>}
      </div>
    </main>
  );
}
