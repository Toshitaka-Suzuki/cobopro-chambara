import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RosListState, RosMonitor, RosSnapshot } from './ros';
import { createRosRequestTemplate, validateRosRequest } from './rosSchema';

type ExplorerProps = { id: string; monitor: RosMonitor; snapshot: RosSnapshot };

function timeLabel(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleTimeString('ja-JP', { hour12: false });
}

function topicStatusLabel(topic: RosSnapshot['topic']): string {
  if (topic.status === 'error') return '受信エラー';
  if (topic.status !== 'subscribed') return '購読停止';
  return topic.receivedCount > 0 ? '購読中・受信あり' : '購読中・受信待ち';
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

/** 表示の一時停止は受信を止めず、その時点の履歴だけを固定する。 */
export function RosTopicExplorer({ id, monitor, snapshot }: ExplorerProps) {
  const topic = snapshot.topic;
  const connected = snapshot.status === 'connected';
  const [pausedTopic, setPausedTopic] = useState<RosSnapshot['topic'] | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const topicView = pausedTopic?.name === topic.name ? pausedTopic : topic;
  const selectedMessage = topicView.messages.find(message => String(message.id) === selectedMessageId);
  const displayedMessage = selectedMessage ?? topicView.messages.at(-1);

  const resetMessageView = useCallback(() => {
    setPausedTopic(null);
    setSelectedMessageId('');
    setCopyNotice('');
  }, []);

  useEffect(resetMessageView, [resetMessageView, topic.name, topic.type]);

  const selectTopic = (name: string) => {
    resetMessageView();
    monitor.selectTopic(name);
  };

  const clearMessages = () => {
    resetMessageView();
    monitor.clearMessages();
  };

  const copyMessage = async () => {
    if (!displayedMessage) return;
    try {
      await navigator.clipboard.writeText(displayedMessage.text);
      setCopyNotice('表示中のメッセージをコピーしました。');
    } catch { setCopyNotice('コピーできませんでした。表示欄の文字列を選択してコピーしてください。'); }
  };

  return (
    <section className="ros-card" aria-labelledby={`${id}-topics-title`}>
      <DiscoveryList id={`${id}-topics`} title="topic" list={snapshot.topics} selected={topic.name} connected={connected} onSelect={selectTopic} />
      {topic.name && <div className="ros-selection">
        <p className="ros-selected-name">{topic.name}</p>
        <span className="ros-type">型：{topic.type || '不明'}</span>
        <div className="ros-actions">
          <button className="serial-button serial-connect-button" type="button" disabled={!connected || !topic.type || topic.status === 'subscribed'} onClick={() => monitor.startTopic()}>受信を開始</button>
          <button className="serial-button" type="button" disabled={topic.status !== 'subscribed'} onClick={() => monitor.stopTopic()}>受信を停止</button>
          <span className="ros-status" role="status">{topicStatusLabel(topic)}</span>
        </div>
        {topic.error && <p className="ros-alert" role="alert">{topic.error}</p>}
        <dl className="ros-receive-stats">
          <div><dt>受信数（クリアでリセット）</dt><dd>{topic.receivedCount.toLocaleString('ja-JP')} 件</dd></div>
          <div><dt>最終受信</dt><dd>{timeLabel(topic.lastReceivedAt)}</dd></div>
        </dl>
        {topicView.messages.length > 0 && <div className="ros-field ros-history-field">
          <label htmlFor={`${id}-history`}>表示するメッセージ</label>
          <select id={`${id}-history`} value={selectedMessage ? selectedMessageId : ''} onChange={event => { setSelectedMessageId(event.target.value); setCopyNotice(''); }}>
            <option value="">最新のメッセージ</option>
            {[...topicView.messages].reverse().map(message => <option key={message.id} value={message.id}>#{message.id} · {timeLabel(message.receivedAt)}</option>)}
          </select>
        </div>}
        <div className="ros-field">
          <label htmlFor={`${id}-topic-json`}>{selectedMessage ? '選択したメッセージ' : '最新のメッセージ'}{pausedTopic && '（表示を一時停止中）'}</label>
          <textarea id={`${id}-topic-json`} className="ros-json" readOnly spellCheck={false} value={displayedMessage?.text ?? ''}
            placeholder={topic.status === 'subscribed' ? 'メッセージの受信を待っています…' : '「受信を開始」でメッセージを確認できます。'} />
        </div>
        <div className="ros-actions">
          <label className="ros-check"><input type="checkbox" checked={!!pausedTopic} onChange={event => {
            setPausedTopic(event.target.checked ? topic : null);
            setSelectedMessageId('');
          }} />表示を一時停止</label>
          <button className="serial-button" type="button" disabled={!displayedMessage} onClick={() => { void copyMessage(); }}>コピー</button>
          <button className="serial-button" type="button" disabled={topic.receivedCount === 0} onClick={clearMessages}>履歴をクリア</button>
        </div>
        {copyNotice && <p className="ros-note" role="status">{copyNotice}</p>}
        {displayedMessage?.truncated && <p className="ros-note">長いメッセージのため、一部を省略して表示しています。</p>}
        <p className="ros-note">履歴は直近100件、1件16,000文字まで。bridgeに100ms間隔での配信を指定するため、全件の記録ではありません。表示の一時停止中も受信は続きます。受信件数は、topicの選択・接続・履歴のクリアでリセットされます。</p>
      </div>}
    </section>
  );
}

/** 選択中の型情報と、送信時点で確定した直近の実行結果は別々に保持する。 */
export function RosServiceExplorer({ id, monitor, snapshot }: ExplorerProps) {
  const { service, call } = snapshot;
  const connected = snapshot.status === 'connected';
  const pending = call.status === 'pending';
  const [requestText, setRequestText] = useState('{}');
  const [templateNotice, setTemplateNotice] = useState('');
  const requestError = validateRosRequest(requestText);
  const template = useMemo(() => createRosRequestTemplate(service.requestTypeDefs), [service.requestTypeDefs]);

  useEffect(() => {
    setRequestText('{}');
    setTemplateNotice('');
  }, [service.name]);

  const callLabel = {
    idle: '', pending: '応答待ち…', response: '応答受信', error: '実行要求のエラー',
    timeout: 'タイムアウト・実行結果は不明', disconnected: '切断・実行結果は不明',
  }[call.status];
  const elapsed = call.startedAt !== null && call.finishedAt !== null
    ? `${((call.finishedAt - call.startedAt) / 1000).toFixed(2)} 秒` : null;

  return (
    <section className="ros-card" aria-labelledby={`${id}-services-title`}>
      <DiscoveryList id={`${id}-services`} title="サービス" list={snapshot.services} selected={service.name} connected={connected} onSelect={name => { void monitor.selectService(name); }} />
      {service.name && <div className="ros-selection">
        <p className="ros-selected-name">{service.name}</p>
        <span className="ros-type">型：{service.type || '未取得'}</span>
        {service.status === 'loading' && <p className="ros-note" role="status">型と入出力の定義を取得しています…</p>}
        {service.error && <p className="ros-alert" role="alert">{service.error}</p>}
        {service.detailsError && <p className="ros-note">入出力の定義を取得できませんでした。リクエストのJSONを手動で入力できます。{service.detailsError}</p>}
        <div className="ros-actions">
          <button className="serial-button" type="button" disabled={!connected || pending || service.status === 'loading'}
            onClick={() => { void monitor.selectService(service.name); }}>型を再取得</button>
        </div>
        {(service.requestTypeDefs || service.responseTypeDefs) && <details className="ros-schema">
          <summary>リクエスト・レスポンスの型定義を見る</summary>
          <pre>{JSON.stringify({ request: service.requestTypeDefs, response: service.responseTypeDefs }, null, 2)}</pre>
        </details>}
        <div className="ros-field ros-request-field">
          <label htmlFor={`${id}-request`}>リクエスト（JSON）</label>
          <textarea id={`${id}-request`} className="ros-json" spellCheck={false} value={requestText} disabled={pending}
            onChange={event => { setRequestText(event.target.value); setTemplateNotice(''); }} aria-invalid={!!requestError}
            aria-describedby={requestError ? `${id}-request-error` : `${id}-request-hint`} />
        </div>
        {requestError && <p id={`${id}-request-error`} className="ros-validation">{requestError}</p>}
        <div className="ros-actions">
          <button className="serial-button" type="button" disabled={pending || !service.requestTypeDefs?.length} onClick={() => {
            setRequestText(template.text);
            setTemplateNotice(template.complete ? '型定義から雛形を入力しました。送信前に値を編集してください。' : '雛形の一部を生成できませんでした。空のオブジェクトや配列を確認し、値を補ってください。');
          }}>型から雛形を入力</button>
          <button className="serial-button serial-connect-button" type="button"
            disabled={!connected || pending || service.status !== 'ready' || !service.type || !!requestError}
            onClick={() => { void monitor.callService(requestText); }}>{pending ? '応答待ち…' : '1回実行'}</button>
        </div>
        {templateNotice && <p className="ros-note" role="status">{templateNotice}</p>}
        <p id={`${id}-request-hint`} className="ros-note">雛形の値は入力の参考です。「1回実行」で選択したサービスへ送信します。応答の待ち時間は10秒です。接続や選択だけでは実行しません。</p>
      </div>}
      {call.status !== 'idle' && <section className="ros-result" aria-labelledby={`${id}-result-title`}>
        <h3 id={`${id}-result-title`}>直近の実行</h3>
        <p className={`ros-result-status${call.status === 'response' ? ' is-response' : ''}`} role="status">{callLabel}{elapsed && ` · ${elapsed}`}</p>
        <p className="ros-selected-name">{call.service}</p>
        <span className="ros-type">型：{call.type}</span>
        <p className="ros-note">実行時の接続先：{call.url}</p>
        <p className="ros-note">送信時刻：{timeLabel(call.startedAt)}</p>
        {call.error && <p className="ros-alert" role="alert">{call.error}</p>}
        {(call.status === 'timeout' || call.status === 'disconnected') && <p className="ros-note">要求がROS側で実行された可能性があります。自動で再送しません。</p>}
        <details className="ros-schema"><summary>送信したリクエストを見る</summary><pre>{call.requestText}</pre></details>
        {call.status === 'response' && <>
          <div className="ros-field">
            <label htmlFor={`${id}-response`}>レスポンス</label>
            <textarea id={`${id}-response`} className="ros-json" readOnly spellCheck={false} value={call.responseText} />
          </div>
          {call.responseTruncated && <p className="ros-note">長いレスポンスのため、一部を省略して表示しています。</p>}
          <p className="ros-note">サービスから届いた応答です。処理の成否や完了は、応答の内容とROS側の仕様に沿って確認してください。</p>
        </>}
      </section>}
    </section>
  );
}
