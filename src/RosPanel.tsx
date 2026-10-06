import { useEffect, useId, useState } from 'react';
import { DEFAULT_ROSBRIDGE_URL, type RosMonitor } from './ros';
import { RosServiceExplorer, RosTopicExplorer } from './RosExplorers';
import { useRosSnapshot } from './useRosSnapshot';
import './ros-panel.css';

const URL_STORAGE_KEY = 'chambara.rosbridge-url';

function readStoredUrl(): string {
  try { return localStorage.getItem(URL_STORAGE_KEY) || DEFAULT_ROSBRIDGE_URL; } catch { return DEFAULT_ROSBRIDGE_URL; }
}

function connectionUrlError(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      return 'ws:// または wss:// で始まる、認証情報や # を含まないURLを入力してください。';
    }
    if (window.location.protocol === 'https:' && url.protocol === 'ws:') {
      return 'HTTPSの画面から接続する場合は、wss:// の接続先を指定してください。';
    }
    return null;
  } catch { return '接続先のURLを入力してください（例：ws://localhost:9090）。'; }
}

export function RosPanel({ monitor }: { monitor: RosMonitor }) {
  const snapshot = useRosSnapshot(monitor);
  const id = useId();
  const [url, setUrl] = useState(() => snapshot.status !== 'disconnected' || snapshot.url !== DEFAULT_ROSBRIDGE_URL ? snapshot.url : readStoredUrl());
  const [urlAttempted, setUrlAttempted] = useState(false);
  const connected = snapshot.status === 'connected';
  const busy = snapshot.status !== 'disconnected';
  const urlError = connectionUrlError(url);
  const refreshing = snapshot.topics.status === 'loading' || snapshot.services.status === 'loading';

  // 画面移動では接続を残し、表示していない topic の購読だけを止める。
  useEffect(() => () => monitor.stopTopic(), [monitor]);

  const connect = () => {
    setUrlAttempted(true);
    if (urlError) return;
    const normalized = url.trim();
    try { localStorage.setItem(URL_STORAGE_KEY, normalized); } catch { /* 保存できなくても接続は継続する。 */ }
    setUrl(normalized);
    monitor.connect(normalized);
  };

  return (
    <div className="ros-panel">
      <section className="ros-card" aria-labelledby={`${id}-connection-title`}>
        <div className="ros-card-heading">
          <h2 id={`${id}-connection-title`}>ROS接続</h2>
          <span className={`ros-status${connected ? ' is-connected' : ''}`} role="status">
            {connected ? 'WebSocket接続済み' : snapshot.status === 'connecting' ? '接続中…' : '未接続'}
          </span>
        </div>
        <form className="ros-connect-form" onSubmit={event => { event.preventDefault(); if (!busy) connect(); }}>
          <div className="ros-field ros-url-field">
            <label htmlFor={`${id}-url`}>rosbridgeの接続先</label>
            <input id={`${id}-url`} type="text" inputMode="url" autoCapitalize="off" spellCheck={false} value={url}
              disabled={busy} onChange={event => { setUrl(event.target.value); setUrlAttempted(false); }}
              aria-invalid={urlAttempted && !!urlError} aria-describedby={`${id}-url-hint${urlAttempted && urlError ? ` ${id}-url-error` : ''}`} />
          </div>
          <button type="submit" className="serial-button serial-connect-button" disabled={busy}>ROSに接続</button>
          <button type="button" className="serial-button" disabled={!busy} onClick={() => monitor.disconnect()}>
            {snapshot.status === 'connecting' ? '接続を中止' : '切断'}
          </button>
        </form>
        <p className="ros-note" id={`${id}-url-hint`}>ROS側でrosbridgeとrosapiを起動してください。別のPCなら、そのPCのホスト名またはIPアドレスを指定します。HTTPSで開く場合は <code>wss://</code> が必要です。</p>
        {urlAttempted && urlError && <p id={`${id}-url-error`} className="ros-validation" role="alert">{urlError}</p>}
        {snapshot.error && <p className="ros-alert" role="alert">{snapshot.error}</p>}
        <p className="ros-note">接続表示はWebSocketの状態です。ROSの一覧取得やtopicの受信は、それぞれの欄で確認できます。</p>
      </section>

      <div className="ros-graph-heading">
        <div>
          <h2>ROSの中を確認</h2>
          <p className="ros-note">この接続先から確認できるtopicとサービスを表示します。</p>
        </div>
        <button className="serial-button" type="button" disabled={!connected || refreshing} onClick={() => { void monitor.refreshGraph(); }}>
          {refreshing ? '一覧を取得中…' : '一覧を更新'}
        </button>
      </div>

      <div className="ros-explorers">
        <RosTopicExplorer id={id} monitor={monitor} snapshot={snapshot} />
        <RosServiceExplorer id={id} monitor={monitor} snapshot={snapshot} />
      </div>
      <footer className="ros-footer">
        <p className="ros-note">画面移動でもROS接続は維持します。このROS画面を離れるとtopicの購読を停止します。サービス要求は1回だけ送信し、切断や再接続で再送しません。ゲームとはまだ連動していません。</p>
      </footer>
    </div>
  );
}
