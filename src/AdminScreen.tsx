import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode, Ref } from 'react';
import type { SerialMonitor } from './serial';
import type { SwordSensorSnapshot } from './swordSensor';
import { useSerialSnapshot } from './useSerialSnapshot';
import type { RosMonitor } from './ros';
import { RosPanel } from './RosPanel';
import './admin-screen.css';

type AdminScreenProps = {
  headingRef: Ref<HTMLHeadingElement>;
  monitor: SerialMonitor;
  rosMonitor: RosMonitor;
  connectionControls: ReactNode;
  sensorState: SwordSensorSnapshot;
  resumeGameHref?: string;
};

export function AdminScreen({ headingRef, monitor, rosMonitor, connectionControls, sensorState, resumeGameHref }: AdminScreenProps) {
  const { snapshot, now, refresh } = useSerialSnapshot(monitor);
  const rosStatus = useSyncExternalStore(rosMonitor.subscribeState, () => rosMonitor.getSnapshot().status);
  const [section, setSection] = useState<'usb' | 'ros'>('usb');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLTextAreaElement>(null);
  const connected = snapshot.status === 'connected';

  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [snapshot.text, autoScroll]);

  const clear = () => {
    monitor.clear();
    refresh();
  };

  return (
    <main className="admin-screen">
      <header className="admin-header">
        <nav className="admin-navigation" aria-label="画面の移動">
          <a className="back-link" href="#/"><span aria-hidden="true">←</span> 画面選択に戻る</a>
          <div className="admin-play-navigation">
            {resumeGameHref && <a className="admin-resume-link" href={resumeGameHref}>一時停止中のゲームに戻る <span aria-hidden="true">→</span></a>}
            <a className="back-link" href="#/play">{resumeGameHref ? 'ゲームを終了してプレイの準備へ' : 'プレイの準備へ'} <span aria-hidden="true">→</span></a>
          </div>
        </nav>
        <p className="admin-kicker">管理者画面</p>
        <h1 ref={headingRef} tabIndex={-1}>機器の設定</h1>
        <p className="admin-description">USBのゲーム入力と、ROSのtopic・サービスを確認できます。接続はそれぞれ独立して設定します。</p>
      </header>

      <div className="admin-tabs" role="tablist" aria-label="機器の種類">
        {(['usb', 'ros'] as const).map((value, index) => <button key={value} type="button"
          ref={element => { tabRefs.current[index] = element; }}
          role="tab" id={`admin-tab-${value}`} aria-controls={`admin-panel-${value}`}
          aria-selected={section === value} tabIndex={section === value ? 0 : -1}
          onClick={() => setSection(value)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
            setSection(next === 0 ? 'usb' : 'ros');
            tabRefs.current[next]?.focus();
          }}>
          {value === 'usb' ? 'USBシリアル' : 'ROS'}
          <span className={(value === 'usb' ? connected : rosStatus === 'connected') ? 'is-connected' : ''}>
            {value === 'usb' ? connected ? 'ポート接続中' : '未接続'
              : rosStatus === 'connected' ? 'WebSocket接続中' : rosStatus === 'connecting' ? '接続中…' : '未接続'}
          </span>
        </button>)}
      </div>

      <div id="admin-panel-ros" role="tabpanel" aria-labelledby="admin-tab-ros" hidden={section !== 'ros'}>
        {section === 'ros' && <RosPanel monitor={rosMonitor} />}
      </div>

      <div id="admin-panel-usb" role="tabpanel" aria-labelledby="admin-tab-usb" hidden={section !== 'usb'}>
      {section === 'usb' && <div className="admin-content">
        {connectionControls}

        <section className={`admin-input-check${sensorState.ready ? ' is-ready' : ''}`} aria-labelledby="admin-input-title">
          <div className="admin-input-heading">
            <h2 id="admin-input-title">ゲーム入力の確認</h2>
            <span className="admin-input-badge" aria-hidden="true">{sensorState.ready ? '確認済み' : sensorState.connected ? '入力待ち' : '未接続'}</span>
          </div>
          <p className="admin-input-status" role="status">
            {sensorState.ready
              ? 'この接続で有効なゲーム入力を確認しました。'
              : sensorState.connected ? '試しに剣を合わせてください。' : 'まずUSB機器に接続してください。'}
          </p>
          <p className="admin-input-description">
            {sensorState.ready
              ? resumeGameHref ? '一時停止中のゲームに戻り、手動で再開できます。' : 'センサ接続モードでゲームを開始できます。'
              : 'ポートを開いたあと、有効な入力を1回受信すると確認済みになります。'}
          </p>
          <p className="admin-input-format">暫定の入力形式：1行に <code>1</code> を送り、改行（LF / CRLF）で区切ります。</p>
        </section>

        <section className="serial-reception" aria-labelledby="serial-log-title">
          <div className="serial-log-heading">
            <div>
              <h2 id="serial-log-title">受信テキスト</h2>
              <p className="serial-hint">UTF-8 · 数値やJSONも、受信した文字列のまま表示</p>
            </div>
            <div className="serial-log-actions">
              <label className="serial-auto-scroll">
                <input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />
                自動スクロール
              </label>
              <button className="serial-button" type="button" disabled={snapshot.text.length === 0} onClick={clear}>表示をクリア</button>
            </div>
          </div>
          <textarea ref={logRef} className="serial-log" aria-labelledby="serial-log-title" readOnly spellCheck={false}
            value={snapshot.text} placeholder={connected ? 'シリアルポートを開きました。データの受信を待っています…' : 'USB機器に接続すると、ここに受信した文字列が表示されます。'} />
          <dl className="serial-receive-stats">
            <div><dt>受信量</dt><dd>{snapshot.bytesReceived.toLocaleString('ja-JP')} <span>bytes</span></dd></div>
            <div><dt>最終受信</dt><dd>{snapshot.lastReceivedAt === null ? '—' : `${Math.max(0, Math.floor((now - snapshot.lastReceivedAt) / 1000))}秒前`}</dd></div>
            <div><dt>通信設定</dt><dd>8N1 <span>/ フロー制御なし</span></dd></div>
          </dl>
          <p className="serial-log-note">
            {snapshot.truncated ? '表示上限に達したため、古いテキストを省略しています。' : '表示は直近約64,000文字まで。'}
            受信量は接続開始からの累計です。
          </p>
        </section>

        <footer className="serial-help">
          <p>接続前に、同じポートを使用する他のアプリを閉じてください。通信速度を変えるときは、一度切断します。</p>
          <p>画面移動やゲームテストへの切り替えでも接続を維持します。接続を終了する場合は「切断」を押してください。ページの再読み込みでも接続は終了します。再接続すると、受信テキストと受信量はリセットされます。</p>
        </footer>
      </div>}
      </div>
    </main>
  );
}
