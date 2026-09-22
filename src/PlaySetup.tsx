import type { Ref } from 'react';

type PlaySetupProps = {
  headingRef: Ref<HTMLHeadingElement>;
  recognized: boolean;
  onRecognitionChange: (recognized: boolean) => void;
  onStart: () => void;
};

function SwordGuide() {
  return (
    <svg className="sword-guide" viewBox="0 0 320 220" fill="none" aria-hidden="true">
      <path className="guide-corners" d="M95 24H65V54M225 24H255V54M65 166V196H95M225 196H255V166" strokeWidth="2" strokeLinecap="round" />
      <g transform="rotate(28 160 110)">
        <rect className="recognition-outline" x="135" y="24" width="50" height="177" rx="12" strokeWidth="1.5" strokeDasharray="5 6" />
        <path className="sword-blade" d="M160 43V137" strokeWidth="18" strokeLinecap="round" />
        <path className="sword-handle" d="M141 150H179M160 162V182" strokeWidth="9" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function PlaySetup({ headingRef, recognized, onRecognitionChange, onStart }: PlaySetupProps) {
  return (
    <main className="setup-screen">
      <nav className="setup-navigation" aria-label="戻る">
        <a className="back-link" href="#/"><span aria-hidden="true">←</span> 画面選択に戻る</a>
      </nav>
      <div className="setup-content">
        <header className="setup-heading">
          <p className="setup-kicker">プレイの準備</p>
          <h1 ref={headingRef} tabIndex={-1}>{recognized ? '準備ができました' : '剣をカメラに見せてください'}</h1>
          <p>{recognized ? '剣を構えて、ゲームを始めましょう。' : '剣全体が見えるように、カメラへ向けて構えてください。'}</p>
        </header>

        <section className={recognized ? 'recognition-preview is-recognized' : 'recognition-preview'} aria-label="剣の認識状態">
          <span className="preview-demo-label">カメラ認識のデモ</span>
          <SwordGuide />
          <div className="recognition-status" role="status">
            <span className="recognition-status-icon" aria-hidden="true">{recognized ? '✓' : '…'}</span>
            <span>{recognized ? '剣を認識しました' : '剣を探しています'}</span>
          </div>
        </section>

        <div className="start-game-area">
          <button className="start-game-button" disabled={!recognized} onClick={onStart} aria-describedby="start-game-hint">
            ゲーム開始 <span aria-hidden="true">→</span>
          </button>
          <p id="start-game-hint">{recognized ? '3秒のカウントダウン後に始まります。' : '剣が認識されると、開始できるようになります。'}</p>
        </div>

        <aside className="mock-controls" aria-label="認識モックの操作">
          <div className="mock-controls-heading">
            <span>モック操作</span>
            <p>今はボタンで認識状態を切り替えます。</p>
          </div>
          <div className="mock-controls-actions">
            <button type="button" disabled={recognized} onClick={() => onRecognitionChange(true)}>剣を認識させる</button>
            <button type="button" disabled={!recognized} onClick={() => onRecognitionChange(false)}>認識を解除</button>
          </div>
        </aside>
      </div>
    </main>
  );
}
