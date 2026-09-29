import { useId } from 'react';
import type { SerialMonitor, SerialSnapshot } from './serial';
import { useSerialSnapshot } from './useSerialSnapshot';
import './admin-screen.css';

export type SerialConnectionProps = {
  monitor: SerialMonitor;
  supported: boolean;
  baudRate: string;
  customBaudRate: string;
  onBaudRateChange: (value: string) => void;
  onCustomBaudRateChange: (value: string) => void;
};

const baudRates = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function connectionLabel(snapshot: SerialSnapshot, now: number) {
  if (snapshot.status === 'connecting') return 'ポートの選択・準備中';
  if (snapshot.status === 'disconnecting') return '切断中';
  if (snapshot.status === 'disconnected') return '未接続';
  if (snapshot.lastReceivedAt === null) return 'ポートを開きました・未受信';
  return now - snapshot.lastReceivedAt < 2000 ? 'ポートを開きました・受信あり' : 'ポートを開きました・2秒以上受信なし';
}

export function SerialConnection({
  monitor, supported, baudRate, customBaudRate, onBaudRateChange, onCustomBaudRateChange,
}: SerialConnectionProps) {
  const { snapshot, now, refresh } = useSerialSnapshot(monitor);
  const id = useId();
  const baudId = `${id}-baud`;
  const customBaudId = `${id}-custom-baud`;
  const hintId = `${id}-baud-hint`;
  const validationId = `${id}-baud-validation`;
  const idle = snapshot.status === 'disconnected';
  const connected = snapshot.status === 'connected';
  const rate = Number(baudRate === 'custom' ? customBaudRate : baudRate);
  const validRate = Number.isInteger(rate) && rate > 0 && rate <= 4_000_000;

  const connect = () => {
    if (!validRate || !supported) return;
    void monitor.connect(rate);
    refresh();
  };

  const disconnect = () => {
    void monitor.disconnect();
    refresh();
  };

  return (
    <section className="serial-connection" aria-label="USBシリアル接続">
      <div className="serial-connection-heading">
        <h2>接続</h2>
        <span className={`serial-status${connected ? ' is-connected' : ''}`} role="status">
          <span aria-hidden="true" className="serial-status-dot" />
          {connectionLabel(snapshot, now)}
        </span>
      </div>
      {!supported && (
        <p className="serial-message serial-unsupported" role="alert">
          {window.isSecureContext
            ? 'このブラウザーはUSBシリアル接続に対応していません。PC版Chromeでこの画面を開いてください。'
            : 'USBシリアル接続には、localhost または HTTPS でこの画面を開いてください。'}
        </p>
      )}
      <div className="serial-connection-controls">
        <div className="serial-baud-field">
          <label htmlFor={baudId}>ボーレート（通信速度）</label>
          <div className="serial-baud-input">
            <select id={baudId}
              value={baudRate} disabled={!idle || !supported} onChange={event => onBaudRateChange(event.target.value)}
              aria-describedby={hintId}>
              {baudRates.map(value => <option key={value} value={value}>{value}</option>)}
              <option value="custom">カスタム</option>
            </select>
            <span>baud</span>
          </div>
        </div>
        {baudRate === 'custom' && <div className="serial-baud-field">
          <label htmlFor={customBaudId}>カスタムボーレート</label>
          <div className="serial-baud-input">
            <input id={customBaudId} type="number" min="1" max="4000000" step="1"
              value={customBaudRate} disabled={!idle || !supported} onChange={event => onCustomBaudRateChange(event.target.value)}
              aria-invalid={!validRate} aria-describedby={validRate ? hintId : `${hintId} ${validationId}`} />
            <span>baud</span>
          </div>
        </div>}
        <button className="serial-button serial-connect-button" type="button" disabled={!idle || !supported || !validRate} onClick={connect}>
          {snapshot.status === 'connecting' ? '接続準備中…' : 'USB機器に接続'}
        </button>
        <button className="serial-button" type="button" disabled={!connected} onClick={disconnect}>
          {snapshot.status === 'disconnecting' ? '切断中…' : '切断'}
        </button>
      </div>
      <p className="serial-hint" id={hintId}>接続先の機器と同じボーレートを選択してください。</p>
      {!validRate && <p className="serial-validation" id={validationId} role="alert">ボーレートは1〜4,000,000の整数で入力してください。</p>}
      {snapshot.error && <p className="serial-message" role="alert">{snapshot.error}</p>}
    </section>
  );
}
