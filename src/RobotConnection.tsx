import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { DEFAULT_ROSBRIDGE_URL, type RosMonitor } from './ros';
import type { RobotBattleController } from './robotBattle';
import './robot.css';

const URL_STORAGE_KEY = 'chambara.rosbridge-url';
const STATE_LABELS = {
  initializing: '初期化・開始位置へ移動中',
  standby: '準備完了',
  fighting: '戦闘中',
  holding: '目標位置に到着・終了指示待ち',
  stopping: '停止処理中',
  returning: '開始位置へ復帰中',
  fault: '異常状態・機器の確認が必要',
} as const;

function storedUrl(): string {
  try { return localStorage.getItem(URL_STORAGE_KEY) || DEFAULT_ROSBRIDGE_URL; }
  catch { return DEFAULT_ROSBRIDGE_URL; }
}

function urlError(value: string): string | null {
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

type Props = {
  monitor: RosMonitor;
  robot: RobotBattleController;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  locked: boolean;
  eligible: boolean;
};

export function RobotConnection({ monitor, robot, enabled, onEnabledChange, locked, eligible }: Props) {
  const snapshot = useSyncExternalStore(robot.subscribe, robot.getSnapshot);
  const ros = useSyncExternalStore(monitor.subscribeState, monitor.getSnapshot);
  const [url, setUrl] = useState(() => ros.status !== 'disconnected' || ros.url !== DEFAULT_ROSBRIDGE_URL ? ros.url : storedUrl());
  const [attempted, setAttempted] = useState(false);
  const id = useId();
  const error = urlError(url);
  const connected = ros.status === 'connected';
  const busy = locked || snapshot.busy;
  const statusText = snapshot.canStart ? 'ロボット準備完了'
    : !connected ? ros.status === 'connecting' ? 'ROS接続中…' : 'ROS未接続'
      : !snapshot.online ? '状態通知を確認中'
        : snapshot.status ? STATE_LABELS[snapshot.status.state] : '状態通知待ち';

  useEffect(() => {
    if (ros.status !== 'disconnected') setUrl(ros.url);
  }, [ros.status, ros.url]);

  const connect = () => {
    setAttempted(true);
    if (error || busy || !eligible || ros.status !== 'disconnected') return;
    const normalized = url.trim();
    try { localStorage.setItem(URL_STORAGE_KEY, normalized); } catch { /* 保存なしでも接続できる。 */ }
    setUrl(normalized);
    monitor.connect(normalized);
  };

  return <section className="robot-connection" aria-labelledby={`${id}-title`}>
    <div className="robot-heading">
      <h2 id={`${id}-title`}>ロボットと連動する</h2>
      <span className={snapshot.canStart ? 'is-ready' : ''} role="status">{statusText}</span>
    </div>
    <label className="robot-enable">
      <input type="checkbox" checked={enabled} disabled={busy || !eligible} onChange={event => onEnabledChange(event.target.checked)} />
      <span>ゲームの開始・終了とESPのパリィ成功をロボットへ送る</span>
    </label>
    {!eligible && <p className="robot-help">ロボット連動は「会話・BGM連携」の「ESP連携（既存仕様）」で使用できます。</p>}
    {!enabled && <p className="robot-help">連動を有効にしてゲームを始めると、ロボットへ動作指示を送ります。</p>}

    <form className="robot-connect-form" onSubmit={event => { event.preventDefault(); connect(); }}>
      <div className="robot-url-field">
        <label htmlFor={`${id}-url`}>ROSの接続先</label>
        <input id={`${id}-url`} type="text" inputMode="url" autoCapitalize="off" spellCheck={false}
          value={ros.status !== 'disconnected' ? ros.url : url} disabled={busy || ros.status !== 'disconnected' || !eligible}
          onChange={event => { setUrl(event.target.value); setAttempted(false); }}
          aria-invalid={attempted && !!error} aria-describedby={`${id}-url-help${attempted && error ? ` ${id}-url-error` : ''}`} />
      </div>
      <button type="submit" disabled={busy || !eligible || ros.status !== 'disconnected'}>ROSに接続</button>
      {ros.status !== 'disconnected' && <button type="button" disabled={busy} onClick={() => monitor.disconnect()}>
        {ros.status === 'connecting' ? '接続を中止' : '切断'}
      </button>}
    </form>
    <p className="robot-help" id={`${id}-url-help`}>ROS側でrosbridgeを起動してください。管理画面のROS接続と共通です。</p>
    {attempted && error && <p className="setup-notice" id={`${id}-url-error`} role="alert">{error}</p>}
    {(snapshot.error || ros.error) && <p className="setup-notice" role="alert">{snapshot.error || ros.error}</p>}

    <dl className="robot-connection-state">
      <div><dt>接続</dt><dd>{connected ? 'WebSocket接続済み' : ros.status === 'connecting' ? '接続中' : '未接続'}</dd></div>
      <div><dt>状態通知</dt><dd>{snapshot.online ? '継続して受信中' : '継続受信を未確認'}</dd></div>
      <div><dt>ロボット</dt><dd>{snapshot.status ? STATE_LABELS[snapshot.status.state] : '未確認'}</dd></div>
      <div><dt>生存通知</dt><dd>{snapshot.heartbeat ? '送信中（250msごと）' : '停止中'}</dd></div>
    </dl>
    <p className="robot-help">新しい状態通知が続き、ロボットが準備完了になると開始できます。状態通知が2秒途絶えた場合や、停止・復帰中は開始できません。</p>
    {snapshot.status?.state === 'holding' && <p className="robot-help">目標位置への到着だけでは、ゲームの勝敗は確定しません。</p>}
    {(snapshot.status?.state === 'fault' || snapshot.phase === 'fault') && <p className="robot-help">機器側の状態と異常の原因を確認してください。この画面から異常解除や自動再開は行いません。</p>}
    <details className="robot-diagnostics">
      <summary>ロボットの通信記録</summary>
      {snapshot.status && <p>セッション：<code>{snapshot.status.session}</code> ／ ラウンド：{snapshot.status.round}</p>}
      <p>時刻はこのページを開いてからの経過秒です。送信記録だけでは、ロボットの受付・動作完了を意味しません。</p>
      {snapshot.logs.length ? <ol aria-label="ロボット連携ログ">
        {snapshot.logs.map((entry, index) => <li key={`${entry.at}-${index}`}><time>{(entry.at / 1000).toFixed(3)}s</time> {entry.text}</li>)}
      </ol> : <p>状態通知とゲームに伴う送信を、ここに記録します。</p>}
    </details>
    <p className="robot-safety-note">通信監視・異常中断は非常停止の代替ではありません。</p>
  </section>;
}

export function RobotBattleStatus({ robot, onAbort }: { robot: RobotBattleController; onAbort?: () => void }) {
  const snapshot = useSyncExternalStore(robot.subscribe, robot.getSnapshot);
  const text = snapshot.error ? 'ロボットの状態を確認してください'
    : snapshot.phase === 'starting' ? 'ロボットの戦闘開始を確認中'
      : snapshot.phase === 'finishing' || snapshot.phase === 'returning' ? 'ロボットの停止・復帰を確認中'
        : !snapshot.online ? 'ロボットの状態通知を確認中'
          : snapshot.status ? STATE_LABELS[snapshot.status.state] : 'ロボット未接続';
  return <aside className={`robot-battle-status${snapshot.error ? ' has-error' : ''}`} aria-label="ロボットの状態">
    <div>
      <p role="status"><strong>ロボット</strong><span>{text}</span></p>
      {snapshot.error && <p role="alert">{snapshot.error}</p>}
    </div>
    {snapshot.busy && onAbort && <button type="button" onClick={onAbort}>異常中断</button>}
  </aside>;
}
