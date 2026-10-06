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

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const MAX_BAUD_RATE = 4_000_000;
const RECENT_RECEPTION_MS = 2_000;

function connectionLabel(snapshot: SerialSnapshot, now: number) {
  if (snapshot.status === 'connecting') return 'ポートの選択・準備中';
  if (snapshot.status === 'disconnecting') return '切断中';
  if (snapshot.status === 'disconnected') return '未接続';
  if (snapshot.lastReceivedAt === null) return 'ポートを開きました・未受信';
  return now - snapshot.lastReceivedAt < RECENT_RECEPTION_MS ? 'ポートを開きました・受信あり' : 'ポートを開きました・2秒以上受信なし';
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
  const isDisconnected = snapshot.status === 'disconnected';
  const isConnected = snapshot.status === 'connected';
  const selectedBaudRate = Number(baudRate === 'custom' ? customBaudRate : baudRate);
  const isBaudRateValid = Number.isInteger(selectedBaudRate) && selectedBaudRate > 0 && selectedBaudRate <= MAX_BAUD_RATE;

  const connect = () => {
    if (!isBaudRateValid || !supported) return;
    void monitor.connect(selectedBaudRate);
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
        <span className={`serial-status${isConnected ? ' is-connected' : ''}`} role="status">
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
              value={baudRate} disabled={!isDisconnected || !supported} onChange={event => onBaudRateChange(event.target.value)}
              aria-describedby={hintId}>
              {BAUD_RATES.map(value => <option key={value} value={value}>{value}</option>)}
              <option value="custom">カスタム</option>
            </select>
            <span>baud</span>
          </div>
        </div>
        {baudRate === 'custom' && <div className="serial-baud-field">
          <label htmlFor={customBaudId}>カスタムボーレート</label>
          <div className="serial-baud-input">
            <input id={customBaudId} type="number" min="1" max={MAX_BAUD_RATE} step="1"
              value={customBaudRate} disabled={!isDisconnected || !supported} onChange={event => onCustomBaudRateChange(event.target.value)}
              aria-invalid={!isBaudRateValid} aria-describedby={isBaudRateValid ? hintId : `${hintId} ${validationId}`} />
            <span>baud</span>
          </div>
        </div>}
        <button className="serial-button serial-connect-button" type="button" disabled={!isDisconnected || !supported || !isBaudRateValid} onClick={connect}>
          {snapshot.status === 'connecting' ? '接続準備中…' : 'USB機器に接続'}
        </button>
        <button className="serial-button" type="button" disabled={!isConnected} onClick={disconnect}>
          {snapshot.status === 'disconnecting' ? '切断中…' : '切断'}
        </button>
      </div>
      <p className="serial-hint" id={hintId}>接続先の機器と同じボーレートを選択してください。</p>
      {!isBaudRateValid && <p className="serial-validation" id={validationId} role="alert">ボーレートは1〜4,000,000の整数で入力してください。</p>}
      {snapshot.error && <p className="serial-message" role="alert">{snapshot.error}</p>}
    </section>
  );
}
