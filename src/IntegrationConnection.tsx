import { useState, useSyncExternalStore } from 'react';
import { DEFAULT_APP_URL, appUrlError } from './integratedSession';
import type { IntegratedSession } from './integratedSession';
import './integration.css';

const STORAGE_KEY = 'chambara.integrated-url';
function initialUrl() {
  try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_APP_URL; } catch { return DEFAULT_APP_URL; }
}

export function IntegrationConnection({ session }: { session: IntegratedSession }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState('');
  const busy = snapshot.connection !== 'disconnected';
  return <section className="integration-connection" aria-labelledby="integration-title">
    <div className="integration-heading">
      <h2 id="integration-title">会話・BGMアプリに接続</h2>
      <span role="status">{snapshot.connection === 'connecting' ? '接続を確認中…'
        : session.ready ? '準備完了' : busy ? '終了処理中…' : '未接続'}</span>
    </div>
    <form onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      const validation = appUrlError(url, location.protocol === 'https:');
      setError(validation ?? '');
      if (validation) return;
      try { localStorage.setItem(STORAGE_KEY, url.trim()); } catch { /* 接続は続ける。 */ }
      session.connect(url);
    }}>
      <label htmlFor="integration-url">接続先</label>
      <div className="integration-connect-fields">
        <input id="integration-url" value={url} disabled={busy} type="text" inputMode="url"
          autoCapitalize="off" spellCheck={false} onChange={event => { setUrl(event.target.value); setError(''); }}
          aria-describedby="integration-url-help" />
        <button type="submit" disabled={busy}>接続する</button>
        {busy && <button type="button" onClick={session.disconnect}>切断</button>}
      </div>
    </form>
    <p id="integration-url-help">統合アプリを先に起動してください。別のPCなら、そのPCのIPアドレスを指定します。</p>
    <p>会話とBGMは統合アプリのPCで再生します。マイクもそのPCに接続します。</p>
    {snapshot.rhythmSupported && <p>タン・タン・タン・カン！ 3つの音で構えて、最後の高い音で受けます。画面の輪も同時に重なります。</p>}
    {busy && snapshot.conversationMode !== 'live' && <p className="integration-demo" role="status">
      {snapshot.conversationMode === 'mock_silent'
        ? '会話・BGM出力を模擬する無音テストです。' : '会話は模擬モードです。BGMとパリイ判定は実際に動作します。'}
    </p>}
    {(error || snapshot.error) && <p role="alert" className="setup-notice">{error || snapshot.error}</p>}
  </section>;
}
