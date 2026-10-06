import type { Ref } from 'react';

function ScreenIcon({ kind }: { kind: 'play' | 'admin' }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      {kind === 'play' ? (
        <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6" y="8" width="36" height="25" rx="3" />
          <path d="M18 40h12M24 33v7M21 15l9 5.5-9 5.5z" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M10 8v9m0 9v14M24 8v19m0 9v4M38 8v5m0 9v18" />
          <rect x="6" y="17" width="8" height="9" rx="3" />
          <rect x="20" y="27" width="8" height="9" rx="3" />
          <rect x="34" y="13" width="8" height="9" rx="3" />
        </g>
      )}
    </svg>
  );
}

type HomeScreenProps = {
  headingRef: Ref<HTMLHeadingElement>;
  serialConnected: boolean;
};

export function HomeScreen({ headingRef, serialConnected }: HomeScreenProps) {
  return (
    <main className="entry-screen">
      <div className="entry-content">
        <header className="entry-heading">
          <span className="brand-mark" aria-hidden="true">剣</span>
          <p className="brand-name">ロボットと、チャンバラ。</p>
          <h1 ref={headingRef} tabIndex={-1}>画面を選択</h1>
          <p className="entry-description">使用する画面を選んでください。</p>
        </header>

        <nav className="screen-choices" aria-label="画面選択">
          <a className="screen-choice play-choice" href="#/play" aria-labelledby="play-title">
            <span className="choice-icon"><ScreenIcon kind="play" /></span>
            <div className="choice-description">
              <h2 id="play-title">プレイ画面</h2>
              <p>プレイヤー用の画面を開きます。</p>
            </div>
            <span className="choice-action">開く <span aria-hidden="true">→</span></span>
          </a>
          <a className="screen-choice admin-choice" href="#/admin" aria-labelledby="admin-title">
            <span className="choice-icon"><ScreenIcon kind="admin" /></span>
            <div className="choice-description">
              <h2 id="admin-title">管理者画面</h2>
              <p>機器の接続設定と入力を確認します。</p>
            </div>
            <span className="choice-action">開く <span aria-hidden="true">→</span></span>
          </a>
        </nav>
        {serialConnected && <p className="entry-description" role="status">USBシリアル接続を保持しています。接続の操作は管理者画面から行えます。</p>}
      </div>
    </main>
  );
}
