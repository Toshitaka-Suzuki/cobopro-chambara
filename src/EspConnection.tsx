import { useEffect, useId, useSyncExternalStore } from 'react';
import type { IntegratedSession } from './integratedSession';
import type { LegacyEspController } from './legacyEsp';
import type { SerialMonitor } from './serial';
import './esp.css';

const ADVANCE_STORAGE_KEY = 'chambara.esp-advance-ms';

type Props = {
  controller: LegacyEspController;
  monitor: SerialMonitor;
  supported: boolean;
  session: IntegratedSession;
};

export function EspConnection({ controller, monitor, supported, session }: Props) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const serial = useSyncExternalStore(monitor.subscribeState, monitor.getSnapshot);
  const integration = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const id = useId();
  const locked = session.active;
  const disconnected = serial.status === 'disconnected';
  const wrongBaud = snapshot.connected && monitor.baudRate !== 115200;

  useEffect(() => {
    try {
      const stored = localStorage.getItem(ADVANCE_STORAGE_KEY);
      if (stored === null) return;
      const value = Number(stored);
      if (Number.isInteger(value) && value >= 0 && value <= 500) controller.setAdvanceMs(value);
    } catch { /* 保存領域を使えなくても初期値で試せる。 */ }
  }, [controller]);

  const updateAdvance = (value: number) => {
    if (!Number.isInteger(value) || value < 0 || value > 500) return;
    controller.setAdvanceMs(value);
    try { localStorage.setItem(ADVANCE_STORAGE_KEY, String(value)); } catch { /* 調整は保存なしでも続ける。 */ }
  };

  return <section className="esp-connection" aria-labelledby={`${id}-title`}>
    <div className="esp-connection-heading">
      <h2 id={`${id}-title`}>XIAOと接続して試す</h2>
      <span role="status">{serial.status === 'connecting' ? 'USB接続中…'
        : serial.status === 'disconnecting' ? '切断中…'
          : snapshot.ready ? 'USB接続済み' : snapshot.connected ? '接続設定を確認してください' : 'USB未接続'}</span>
    </div>
    <p>現行のマイコン仕様を使います。弱点Aは画面中央の青に対応し、有効時間は10秒です。</p>
    <div className="esp-connect-actions">
      <button type="button" disabled={!supported || !disconnected || locked}
        onClick={() => { void monitor.connect(115200); }}>XIAOに接続（115200bps）</button>
      {!disconnected && <button type="button" disabled={locked || serial.status !== 'connected'}
        onClick={() => { void monitor.disconnect(); }}>切断</button>}
    </div>
    {!supported && <p className="setup-notice" role="alert">USB接続にはPC版ChromeまたはEdgeで、localhostかHTTPSから開いてください。</p>}
    {wrongBaud && <p className="setup-notice" role="alert">通信速度が115200bpsではありません。一度切断して、上のボタンから接続してください。</p>}
    <p className="esp-help">USB接続だけでは、無線側のパリィ・弱点検出機が動作しているかは確認できません。各機器を起動し、最初の試行で通知を確認してください。</p>

    <div className="esp-timing-field">
      <label htmlFor={`${id}-advance`}>指示を早める時間</label>
      <div>
        <input id={`${id}-advance`} type="number" min="0" max="500" step="10" value={snapshot.advanceMs}
          disabled={locked} onChange={event => updateAdvance(event.currentTarget.valueAsNumber)}
          aria-describedby={`${id}-advance-help`} />
        <span>ms</span>
      </div>
    </div>
    <p className="esp-help" id={`${id}-advance-help`}>0〜500msで調整できます。200msは実測前の初期値です。値を大きくすると、予告・判定開始・判定終了の指示を早く送ります。変更は次のゲームから試してください。</p>
    {integration.connection === 'connected' && (!integration.espSupported || !integration.rhythmSupported)
      && <p className="setup-notice" role="alert">ESP連携と4拍ガイドに対応したPythonアプリが必要です。更新して再起動し、接続し直してください。</p>}
    {(snapshot.error || serial.error) && <p className="setup-notice" role="alert">{snapshot.error || serial.error}</p>}
    <details className="esp-diagnostics">
      <summary>試行の送受信ログ</summary>
      <p>表示時刻はこのページを開いてからの経過秒です。機器の時計との比較値ではありません。</p>
      {snapshot.log.length ? <ol aria-label="ESP連携ログ">
        {snapshot.log.map((entry, index) => <li key={`${entry.at}-${index}`}><time>{(entry.at / 1000).toFixed(3)}s</time> {entry.text}</li>)}
      </ol> : <p>ゲームを始めると、指示の送信と受信した結果を表示します。</p>}
    </details>
  </section>;
}
