import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { RosListState, RosMonitor, RosSnapshot } from './ros';
import { createRosRequestTemplate, validateRosRequest } from './rosSchema';
import './ros-panel.css';

const URL_STORAGE_KEY = 'chambara.rosbridge-url';
const DEFAULT_URL = 'ws://localhost:9090';

function storedUrl(): string {
  try { return localStorage.getItem(URL_STORAGE_KEY) || DEFAULT_URL; } catch { return DEFAULT_URL; }
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

function timeLabel(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleTimeString('ja-JP', { hour12: false });
}

function useRosSnapshot(monitor: RosMonitor): RosSnapshot {
  const subscribe = useCallback((notify: () => void) => {
    let previous = monitor.getSnapshot();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const unsubscribe = monitor.subscribeState(next => {
      const messagesOnly = next.status === previous.status && next.error === previous.error
        && next.topics === previous.topics && next.services === previous.services
        && next.service === previous.service && next.call === previous.call
        && next.topic.name === previous.topic.name && next.topic.status === previous.topic.status
        && next.topic.receivedCount > previous.topic.receivedCount;
      previous = next;
      if (messagesOnly) {
        timer ??= setTimeout(() => { timer = null; notify(); }, 100);
      } else { cancel(); notify(); }
    });
    return () => { cancel(); unsubscribe(); };
  }, [monitor]);
  return useSyncExternalStore(subscribe, monitor.getSnapshot);
}

function DiscoveryList({ id, title, list, selected, connected, onSelect }: {
  id: string;
  title: string;
  list: RosListState<{ name: string }>;
  selected: string;
  connected: boolean;
  onSelect: (name: string) => void;
}) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => list.items.filter(item => item.name.toLowerCase().includes(search.toLowerCase())), [list.items, search]);
  const visibleSelection = filtered.some(item => item.name === selected) ? selected : '';
  return (
    <>
      <div className="ros-card-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        <span className="ros-count">{list.items.length.toLocaleString('ja-JP')} 件</span>
      </div>
      <div className="ros-field ros-search">
        <label htmlFor={`${id}-search`}>{title}を名前で検索</label>
        <input id={`${id}-search`} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="名前の一部を入力" />
      </div>
      <div className="ros-field ros-list">
        <label htmlFor={`${id}-list`}>{title}を選択</label>
        <select id={`${id}-list`} size={6} value={visibleSelection} disabled={!connected || list.items.length === 0} onChange={event => onSelect(event.target.value)}>
          <option value="" disabled>選択してください</option>
          {filtered.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
      </div>
      {list.status === 'loading' && <p className="ros-note" role="status">一覧を取得しています…</p>}
      {list.status === 'error' && <p className="ros-alert" role="alert">一覧を取得できませんでした。{list.error}</p>}
      {list.status === 'idle' && <p className="ros-empty">ROSに接続すると一覧を取得します。</p>}
      {list.status === 'ready' && list.items.length === 0 && <p className="ros-empty">この接続先から確認できる{title}はありません。</p>}
      {list.items.length > 0 && filtered.length === 0 && <p className="ros-empty">検索に一致する名前はありません。</p>}
      {list.updatedAt !== null && <p className="ros-note">一覧の最終取得：{timeLabel(list.updatedAt)}{!connected && '（切断前の情報）'}</p>}
    </>
  );
}

export function RosPanel({ monitor }: { monitor: RosMonitor }) {
  const snapshot = useRosSnapshot(monitor);
  const id = useId();
  const [url, setUrl] = useState(() => snapshot.status !== 'disconnected' || snapshot.url !== DEFAULT_URL ? snapshot.url : storedUrl());
  const [urlAttempted, setUrlAttempted] = useState(false);
  const [pausedTopic, setPausedTopic] = useState<RosSnapshot['topic'] | null>(null);
  const [historyId, setHistoryId] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [request, setRequest] = useState('{}');
  const [templateNotice, setTemplateNotice] = useState('');
  const connected = snapshot.status === 'connected';
  const busy = snapshot.status !== 'disconnected';
  const pending = snapshot.call.status === 'pending';
  const urlError = connectionUrlError(url);
  const requestError = validateRosRequest(request);
  const template = useMemo(() => createRosRequestTemplate(snapshot.service.requestTypeDefs), [snapshot.service.requestTypeDefs]);
  const topicView = pausedTopic?.name === snapshot.topic.name ? pausedTopic : snapshot.topic;
  const historicMessage = topicView.messages.find(message => String(message.id) === historyId);
  const displayedMessage = historicMessage ?? topicView.messages.at(-1);
  const refreshing = snapshot.topics.status === 'loading' || snapshot.services.status === 'loading';

  useEffect(() => () => monitor.stopTopic(), [monitor]);
  useEffect(() => {
    setPausedTopic(null);
    setHistoryId('');
    setCopyMessage('');
  }, [snapshot.topic.name, snapshot.topic.type]);
  useEffect(() => {
    setRequest('{}');
    setTemplateNotice('');
  }, [snapshot.service.name]);

  const connect = () => {
    setUrlAttempted(true);
    if (urlError) return;
    const normalized = url.trim();
    try { localStorage.setItem(URL_STORAGE_KEY, normalized); } catch { /* Persistence is optional. */ }
    setUrl(normalized);
    setPausedTopic(null);
    setHistoryId('');
    monitor.connect(normalized);
  };

  const selectTopic = (name: string) => {
    setPausedTopic(null);
    setHistoryId('');
    setCopyMessage('');
    monitor.selectTopic(name);
  };

  const clearMessages = () => {
    setPausedTopic(null);
    setHistoryId('');
    setCopyMessage('');
    monitor.clearMessages();
  };

  const copy = async () => {
    if (!displayedMessage) return;
    try {
      await navigator.clipboard.writeText(displayedMessage.text);
      setCopyMessage('表示中のメッセージをコピーしました。');
    } catch { setCopyMessage('コピーできませんでした。表示欄の文字列を選択してコピーしてください。'); }
  };

  const callLabel = {
    idle: '', pending: '応答待ち…', response: '応答受信', error: '実行要求のエラー',
    timeout: 'タイムアウト・実行結果は不明', disconnected: '切断・実行結果は不明',
  }[snapshot.call.status];
  const elapsed = snapshot.call.startedAt !== null && snapshot.call.finishedAt !== null
    ? `${((snapshot.call.finishedAt - snapshot.call.startedAt) / 1000).toFixed(2)} 秒` : null;

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
        <section className="ros-card" aria-labelledby={`${id}-topics-title`}>
          <DiscoveryList id={`${id}-topics`} title="topic" list={snapshot.topics} selected={snapshot.topic.name} connected={connected} onSelect={selectTopic} />
          {snapshot.topic.name && <div className="ros-selection">
            <p className="ros-selected-name">{snapshot.topic.name}</p>
            <span className="ros-type">型：{snapshot.topic.type || '不明'}</span>
            <div className="ros-actions">
              <button className="serial-button serial-connect-button" type="button" disabled={!connected || !snapshot.topic.type || snapshot.topic.status === 'subscribed'} onClick={() => monitor.startTopic()}>受信を開始</button>
              <button className="serial-button" type="button" disabled={snapshot.topic.status !== 'subscribed'} onClick={() => monitor.stopTopic()}>受信を停止</button>
              <span className="ros-status" role="status">{snapshot.topic.status === 'subscribed' ? snapshot.topic.receivedCount > 0 ? '購読中・受信あり' : '購読中・受信待ち' : snapshot.topic.status === 'error' ? '受信エラー' : '購読停止'}</span>
            </div>
            {snapshot.topic.error && <p className="ros-alert" role="alert">{snapshot.topic.error}</p>}
            <dl className="ros-receive-stats">
              <div><dt>受信数（クリアでリセット）</dt><dd>{snapshot.topic.receivedCount.toLocaleString('ja-JP')} 件</dd></div>
              <div><dt>最終受信</dt><dd>{timeLabel(snapshot.topic.lastReceivedAt)}</dd></div>
            </dl>
            {topicView.messages.length > 0 && <div className="ros-field ros-history-field">
              <label htmlFor={`${id}-history`}>表示するメッセージ</label>
              <select id={`${id}-history`} value={historicMessage ? historyId : ''} onChange={event => { setHistoryId(event.target.value); setCopyMessage(''); }}>
                <option value="">最新のメッセージ</option>
                {[...topicView.messages].reverse().map(message => <option key={message.id} value={message.id}>#{message.id} · {timeLabel(message.receivedAt)}</option>)}
              </select>
            </div>}
            <div className="ros-field">
              <label htmlFor={`${id}-topic-json`}>{historicMessage ? '選択したメッセージ' : '最新のメッセージ'}{pausedTopic && '（表示を一時停止中）'}</label>
              <textarea id={`${id}-topic-json`} className="ros-json" readOnly spellCheck={false} value={displayedMessage?.text ?? ''}
                placeholder={snapshot.topic.status === 'subscribed' ? 'メッセージの受信を待っています…' : '「受信を開始」でメッセージを確認できます。'} />
            </div>
            <div className="ros-actions">
              <label className="ros-check"><input type="checkbox" checked={!!pausedTopic} onChange={event => {
                setPausedTopic(event.target.checked ? snapshot.topic : null);
                setHistoryId('');
              }} />表示を一時停止</label>
              <button className="serial-button" type="button" disabled={!displayedMessage} onClick={() => { void copy(); }}>コピー</button>
              <button className="serial-button" type="button" disabled={snapshot.topic.receivedCount === 0} onClick={clearMessages}>履歴をクリア</button>
            </div>
            {copyMessage && <p className="ros-note" role="status">{copyMessage}</p>}
            {displayedMessage?.truncated && <p className="ros-note">長いメッセージのため、一部を省略して表示しています。</p>}
            <p className="ros-note">履歴は直近100件、1件16,000文字まで。bridgeに100ms間隔での配信を指定するため、全件の記録ではありません。表示の一時停止中も受信は続きます。受信件数は、topicの選択・接続・履歴のクリアでリセットされます。</p>
          </div>}
        </section>

        <section className="ros-card" aria-labelledby={`${id}-services-title`}>
          <DiscoveryList id={`${id}-services`} title="サービス" list={snapshot.services} selected={snapshot.service.name} connected={connected} onSelect={name => { void monitor.selectService(name); }} />
          {snapshot.service.name && <div className="ros-selection">
            <p className="ros-selected-name">{snapshot.service.name}</p>
            <span className="ros-type">型：{snapshot.service.type || '未取得'}</span>
            {snapshot.service.status === 'loading' && <p className="ros-note" role="status">型と入出力の定義を取得しています…</p>}
            {snapshot.service.error && <p className="ros-alert" role="alert">{snapshot.service.error}</p>}
            {snapshot.service.detailsError && <p className="ros-note">入出力の定義を取得できませんでした。リクエストのJSONを手動で入力できます。{snapshot.service.detailsError}</p>}
            <div className="ros-actions">
              <button className="serial-button" type="button" disabled={!connected || pending || snapshot.service.status === 'loading'}
                onClick={() => { void monitor.selectService(snapshot.service.name); }}>型を再取得</button>
            </div>
            {(snapshot.service.requestTypeDefs || snapshot.service.responseTypeDefs) && <details className="ros-schema">
              <summary>リクエスト・レスポンスの型定義を見る</summary>
              <pre>{JSON.stringify({ request: snapshot.service.requestTypeDefs, response: snapshot.service.responseTypeDefs }, null, 2)}</pre>
            </details>}
            <div className="ros-field ros-request-field">
              <label htmlFor={`${id}-request`}>リクエスト（JSON）</label>
              <textarea id={`${id}-request`} className="ros-json" spellCheck={false} value={request} disabled={pending}
                onChange={event => { setRequest(event.target.value); setTemplateNotice(''); }} aria-invalid={!!requestError}
                aria-describedby={requestError ? `${id}-request-error` : `${id}-request-hint`} />
            </div>
            {requestError && <p id={`${id}-request-error`} className="ros-validation">{requestError}</p>}
            <div className="ros-actions">
              <button className="serial-button" type="button" disabled={pending || !snapshot.service.requestTypeDefs?.length} onClick={() => {
                setRequest(template.text);
                setTemplateNotice(template.complete ? '型定義から雛形を入力しました。送信前に値を編集してください。' : '雛形の一部を生成できませんでした。空のオブジェクトや配列を確認し、値を補ってください。');
              }}>型から雛形を入力</button>
              <button className="serial-button serial-connect-button" type="button"
                disabled={!connected || pending || snapshot.service.status !== 'ready' || !snapshot.service.type || !!requestError}
                onClick={() => { void monitor.callService(request); }}>{pending ? '応答待ち…' : '1回実行'}</button>
            </div>
            {templateNotice && <p className="ros-note" role="status">{templateNotice}</p>}
            <p id={`${id}-request-hint`} className="ros-note">雛形の値は入力の参考です。「1回実行」で選択したサービスへ送信します。応答の待ち時間は10秒です。接続や選択だけでは実行しません。</p>
          </div>}
          {snapshot.call.status !== 'idle' && <section className="ros-result" aria-labelledby={`${id}-result-title`}>
            <h3 id={`${id}-result-title`}>直近の実行</h3>
            <p className={`ros-result-status${snapshot.call.status === 'response' ? ' is-response' : ''}`} role="status">{callLabel}{elapsed && ` · ${elapsed}`}</p>
            <p className="ros-selected-name">{snapshot.call.service}</p>
            <span className="ros-type">型：{snapshot.call.type}</span>
            <p className="ros-note">実行時の接続先：{snapshot.call.url}</p>
            <p className="ros-note">送信時刻：{timeLabel(snapshot.call.startedAt)}</p>
            {snapshot.call.error && <p className="ros-alert" role="alert">{snapshot.call.error}</p>}
            {(snapshot.call.status === 'timeout' || snapshot.call.status === 'disconnected') && <p className="ros-note">要求がROS側で実行された可能性があります。自動で再送しません。</p>}
            <details className="ros-schema"><summary>送信したリクエストを見る</summary><pre>{snapshot.call.requestText}</pre></details>
            {snapshot.call.status === 'response' && <>
              <div className="ros-field">
                <label htmlFor={`${id}-response`}>レスポンス</label>
                <textarea id={`${id}-response`} className="ros-json" readOnly spellCheck={false} value={snapshot.call.responseText} />
              </div>
              {snapshot.call.responseTruncated && <p className="ros-note">長いレスポンスのため、一部を省略して表示しています。</p>}
              <p className="ros-note">サービスから届いた応答です。処理の成否や完了は、応答の内容とROS側の仕様に沿って確認してください。</p>
            </>}
          </section>}
        </section>
      </div>
      <footer className="ros-footer">
        <p className="ros-note">画面移動でもROS接続は維持します。このROS画面を離れるとtopicの購読を停止します。サービス要求は1回だけ送信し、切断や再接続で再送しません。ゲームとはまだ連動していません。</p>
      </footer>
    </div>
  );
}
