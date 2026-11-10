import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SerialMonitor } from './serial.ts';
import type { SerialApi, SerialPortApi } from './serial.ts';
import { FakeSerialPort, FakeWritableSerialPort, waitUntil } from './testSupport/serial.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(port = new FakeSerialPort()) {
  let requests = 0;
  const api: SerialApi = { requestPort: () => { requests++; return Promise.resolve(port); } };
  return { monitor: new SerialMonitor(api), port, requests: () => requests };
}

test('ポート選択は同期で始まり、選択中・接続中の二重接続を防ぐ', async () => {
  const selected = deferred<SerialPortApi>();
  const port = new FakeSerialPort();
  let requests = 0;
  const monitor = new SerialMonitor({ requestPort: () => { requests++; return selected.promise; } });
  const connecting = monitor.connect(115200);
  assert.equal(requests, 1);
  assert.equal(monitor.getSnapshot().status, 'connecting');
  await monitor.connect(9600);
  selected.resolve(port);
  await connecting;
  assert.equal(monitor.getSnapshot().status, 'connected');
  assert.deepEqual(port.options, { baudRate: 115200 });
  await monitor.connect(9600);
  assert.equal(requests, 1);
  await monitor.disconnect();
});

test('UTF-8の分割受信を復元し、改行なしでも即時表示する', async () => {
  const { monitor, port } = setup();
  await monitor.connect(115200);
  const bytes = new TextEncoder().encode('あ');
  port.controller.enqueue(bytes.slice(0, 1));
  await waitUntil(() => monitor.getSnapshot().bytesReceived === 1);
  assert.equal(monitor.getSnapshot().text, '');
  port.controller.enqueue(bytes.slice(1));
  await waitUntil(() => monitor.getSnapshot().text === 'あ');
  port.send(' value=1.25\r\nnext');
  await waitUntil(() => monitor.getSnapshot().text.endsWith('next'));
  assert.equal(monitor.getSnapshot().text, 'あ value=1.25\r\nnext');
  assert.equal(monitor.getSnapshot().bytesReceived, new TextEncoder().encode('あ value=1.25\r\nnext').length);
  assert.equal(typeof monitor.getSnapshot().lastReceivedAt, 'number');
  assert.equal(monitor.getSnapshot(), monitor.getSnapshot(), 'stable reference between updates');
  await monitor.disconnect();
});

test('受信待機中の切断はcancel、ロック解放、closeの順で一度だけ行う', async () => {
  const { monitor, port } = setup();
  await monitor.connect(115200);
  assert.equal(port.readable?.locked, true);
  const first = monitor.disconnect();
  assert.equal(monitor.getSnapshot().status, 'disconnecting');
  await Promise.all([first, monitor.disconnect()]);
  assert.deepEqual(port.events, ['open', 'cancel', 'close']);
  assert.equal(monitor.getSnapshot().status, 'disconnected');
  assert.equal(monitor.getSnapshot().error, null);
});

test('ポート選択のキャンセルはエラーにせず再試行できる', async () => {
  let attempt = 0;
  const port = new FakeSerialPort();
  const monitor = new SerialMonitor({
    requestPort: () => ++attempt === 1
      ? Promise.reject(new DOMException('No port selected', 'NotFoundError'))
      : Promise.resolve(port),
  });
  await monitor.connect(115200);
  assert.equal(monitor.getSnapshot().status, 'disconnected');
  assert.equal(monitor.getSnapshot().error, null);
  await monitor.connect(115200);
  assert.equal(monitor.getSnapshot().status, 'connected');
  await monitor.disconnect();
});

test('ポート選択待ちに切断したら後から選ばれたポートを開かない', async () => {
  const selected = deferred<SerialPortApi>();
  const port = new FakeSerialPort();
  const monitor = new SerialMonitor({ requestPort: () => selected.promise });
  const connecting = monitor.connect(115200);
  const disconnecting = monitor.disconnect();
  selected.resolve(port);
  await Promise.all([connecting, disconnecting]);
  assert.deepEqual(port.events, []);
  assert.equal(monitor.getSnapshot().status, 'disconnected');
  assert.equal(monitor.getSnapshot().error, null);
});

test('遅いopen中に切断したらopen完了後に受信せずcloseする', async () => {
  const gate = deferred<void>();
  const { monitor, port, requests } = setup();
  port.openGate = gate.promise;
  const connecting = monitor.connect(115200);
  await waitUntil(() => port.events.includes('open'));
  const disconnecting = monitor.disconnect();
  await monitor.connect(9600);
  assert.equal(requests(), 1);
  gate.resolve();
  await Promise.all([connecting, disconnecting]);
  assert.deepEqual(port.events, ['open', 'close']);
  assert.equal(monitor.getSnapshot().status, 'disconnected');
  assert.equal(monitor.getSnapshot().bytesReceived, 0);
});

test('抜線相当の受信エラーでもロックを解放して再接続できる', async () => {
  const first = new FakeSerialPort();
  const second = new FakeSerialPort();
  const ports = [first, second];
  const monitor = new SerialMonitor({ requestPort: async () => ports.shift()! });
  await monitor.connect(115200);
  first.send('before unplug');
  await waitUntil(() => monitor.getSnapshot().text === 'before unplug');
  first.controller.error(new DOMException('Disconnected', 'NetworkError'));
  await waitUntil(() => monitor.getSnapshot().status === 'disconnected');
  assert.deepEqual(first.events, ['open', 'close']);
  assert.match(monitor.getSnapshot().error!, /受信中にエラー/);
  assert.equal(monitor.getSnapshot().text, 'before unplug');
  await monitor.connect(9600);
  assert.equal(monitor.getSnapshot().text, '');
  assert.equal(monitor.getSnapshot().bytesReceived, 0);
  assert.equal(monitor.getSnapshot().lastReceivedAt, null);
  assert.equal(monitor.getSnapshot().error, null);
  second.send('reconnected');
  await waitUntil(() => monitor.getSnapshot().text === 'reconnected');
  await monitor.disconnect();
});

test('予期しない受信終了でも接続済みのまま残らない', async () => {
  const { monitor, port } = setup();
  await monitor.connect(115200);
  port.controller.close();
  await waitUntil(() => monitor.getSnapshot().status === 'disconnected');
  assert.match(monitor.getSnapshot().error!, /受信が終了/);
  assert.deepEqual(port.events, ['open', 'close']);
});

test('末尾64Ki文字に制限し、表示クリアは累計受信量・時刻を保持する', async () => {
  const { monitor, port } = setup();
  await monitor.connect(115200);
  port.send('old' + 'a'.repeat(65536) + 'end');
  await waitUntil(() => monitor.getSnapshot().truncated);
  assert.equal(monitor.getSnapshot().text.length, 65536);
  assert.equal(monitor.getSnapshot().text, 'a'.repeat(65533) + 'end');
  const { bytesReceived, lastReceivedAt } = monitor.getSnapshot();
  monitor.clear();
  assert.equal(monitor.getSnapshot().text, '');
  assert.equal(monitor.getSnapshot().truncated, false);
  assert.equal(monitor.getSnapshot().bytesReceived, bytesReceived);
  assert.equal(monitor.getSnapshot().lastReceivedAt, lastReceivedAt);
  const cleared = monitor.getSnapshot();
  monitor.clear();
  assert.equal(monitor.getSnapshot(), cleared);
  port.send('fresh');
  await waitUntil(() => monitor.getSnapshot().text === 'fresh');
  assert.equal(monitor.getSnapshot().bytesReceived, bytesReceived + 5);
  await monitor.disconnect();
});

test('上限で絵文字のサロゲートペアを分断しない', async () => {
  const { monitor, port } = setup();
  await monitor.connect(115200);
  port.send('😀' + 'x'.repeat(65535));
  await waitUntil(() => monitor.getSnapshot().truncated);
  assert.equal(monitor.getSnapshot().text, 'x'.repeat(65535));
  await monitor.disconnect();
});

test('open失敗は接続エラーを表示して未接続へ戻す', async () => {
  const { monitor, port } = setup();
  port.openError = new DOMException('Busy', 'NetworkError');
  await monitor.connect(115200);
  assert.equal(monitor.getSnapshot().status, 'disconnected');
  assert.match(monitor.getSnapshot().error!, /開けません/);
  assert.deepEqual(port.events, ['open']);
  port.openError = null;
  await monitor.connect(115200);
  assert.equal(monitor.getSnapshot().status, 'connected');
  await monitor.disconnect();
});

test('非対応環境・不正なボーレート・選択権限エラーを安全に表示する', async () => {
  const unsupported = new SerialMonitor(undefined);
  await unsupported.connect(115200);
  assert.match(unsupported.getSnapshot().error!, /対応していません/);
  assert.equal(unsupported.getSnapshot().status, 'disconnected');
  await unsupported.disconnect();
  const { monitor, requests } = setup();
  await monitor.connect(0);
  assert.match(monitor.getSnapshot().error!, /正の整数/);
  assert.equal(requests(), 0);
  const denied = new SerialMonitor({ requestPort: () => { throw new DOMException('Blocked', 'SecurityError'); } });
  await denied.connect(115200);
  assert.match(denied.getSnapshot().error!, /権限/);
  assert.equal(denied.getSnapshot().status, 'disconnected');
});

test('状態を同期通知し、復元済みの新着テキストだけを購読できる', async () => {
  const { monitor, port } = setup();
  const { getSnapshot, subscribeState, subscribeText } = monitor;
  const statuses: string[] = [];
  const chunks: string[] = [];
  const stopState = subscribeState((snapshot) => {
    assert.equal(snapshot, getSnapshot());
    statuses.push(snapshot.status);
  });
  const stopText = subscribeText((text) => { chunks.push(text); });
  const connecting = monitor.connect(115200);
  assert.deepEqual(statuses, ['connecting']);
  await connecting;
  const bytes = new TextEncoder().encode('あ');
  port.controller.enqueue(bytes.slice(0, 1));
  await waitUntil(() => getSnapshot().bytesReceived === 1);
  assert.deepEqual(chunks, []);
  port.controller.enqueue(bytes.slice(1));
  port.send('1\n');
  await waitUntil(() => getSnapshot().text === 'あ1\n');
  assert.deepEqual(chunks, ['あ', '1\n']);
  monitor.clear();
  assert.deepEqual(chunks, ['あ', '1\n'], 'clearing is not new serial input');
  const later: string[] = [];
  const stopLater = subscribeText((text) => { later.push(text); });
  assert.deepEqual(later, [], 'subscriptions do not replay the display log');
  stopText();
  stopState();
  const statusCount = statuses.length;
  port.send('new');
  await waitUntil(() => getSnapshot().text === 'new');
  assert.deepEqual(chunks, ['あ', '1\n']);
  assert.deepEqual(later, ['new']);
  stopLater();
  await monitor.disconnect();
  assert.equal(statuses.length, statusCount);
});

test('購読者の例外で受信や他の購読者への配信を止めない', async () => {
  const { monitor, port } = setup();
  monitor.subscribeState(() => { throw new Error('broken state observer'); });
  monitor.subscribeText(() => { throw new Error('broken input observer'); });
  const received: string[] = [];
  monitor.subscribeText((text) => { received.push(text); });
  await monitor.connect(115200);
  port.send('first');
  await waitUntil(() => received.length === 1);
  port.send('second');
  await waitUntil(() => received.length === 2);
  assert.deepEqual(received, ['first', 'second']);
  assert.equal(monitor.getSnapshot().status, 'connected');
  assert.equal(monitor.getSnapshot().error, null);
  await monitor.disconnect();
  assert.deepEqual(port.events, ['open', 'cancel', 'close']);
});

test('読み取り専用・未接続のポートは送信できず、接続済みの読み取りは維持する', async () => {
  const { monitor, port } = setup();
  assert.equal(monitor.canWrite, false);
  await assert.rejects(monitor.writeLine('p 0'), /書き込み可能/);
  await monitor.connect(115200);
  assert.equal(monitor.canWrite, false);
  await assert.rejects(monitor.writeLine('p 0'), /書き込み可能/);
  port.send('read-only still works');
  await waitUntil(() => monitor.getSnapshot().text === 'read-only still works');
  assert.equal(monitor.getSnapshot().error, null);
  await monitor.disconnect();
});

test('現在開いているポートのボーレートだけを公開する', async () => {
  const first = new FakeSerialPort();
  const second = new FakeSerialPort();
  const ports = [first, second];
  const monitor = new SerialMonitor({ requestPort: async () => ports.shift()! });
  assert.equal(monitor.baudRate, null);
  const connecting = monitor.connect(9600);
  assert.equal(monitor.baudRate, null);
  await connecting;
  assert.equal(monitor.baudRate, 9600);
  const disconnecting = monitor.disconnect();
  assert.equal(monitor.baudRate, null);
  await disconnecting;
  assert.equal(monitor.baudRate, null);
  await monitor.connect(115200);
  assert.equal(monitor.baudRate, 115200);
  await monitor.disconnect();
});

test('指示をLF付きで順番に書き、送信中も受信を継続する', async () => {
  const port = new FakeWritableSerialPort();
  const { monitor } = setup(port);
  const gate = deferred<void>();
  port.writeGate = gate.promise;
  await monitor.connect(115200);
  assert.equal(monitor.canWrite, true);
  const writes = [monitor.writeLine('p 1'), monitor.writeLine('p 2'), monitor.writeLine('p 0')];
  await waitUntil(() => port.writes.length === 1);
  assert.deepEqual(port.writes, ['p 1\n']);
  port.send('[EVENT] PARRY SUCCESS (once)\n');
  await waitUntil(() => monitor.getSnapshot().text.includes('PARRY SUCCESS'));
  gate.resolve();
  await Promise.all(writes);
  assert.deepEqual(port.writes, ['p 1\n', 'p 2\n', 'p 0\n']);
  await monitor.disconnect();
  assert.equal(monitor.canWrite, false);
  assert.deepEqual(port.events, ['open', 'cancel', 'abort-write', 'close']);
});

test('改行の混入・制御文字・長すぎる指示を送信前に拒否する', async () => {
  const port = new FakeWritableSerialPort();
  const { monitor } = setup(port);
  await monitor.connect(115200);
  for (const command of ['', '  ', 'p 1\np 2', 'p 2\r', '\0', 'p\t2', 'x'.repeat(256), 'あ'.repeat(100)]) {
    await assert.rejects(monitor.writeLine(command));
  }
  assert.deepEqual(port.writes, []);
  await monitor.writeLine('r');
  assert.deepEqual(port.writes, ['r\n']);
  await monitor.disconnect();
});

test('切断すると送信待ちを破棄し、再接続したポートへ旧指示を流さない', async () => {
  const first = new FakeWritableSerialPort();
  const second = new FakeWritableSerialPort();
  const ports = [first, second];
  const monitor = new SerialMonitor({ requestPort: async () => ports.shift()! });
  const gate = deferred<void>();
  first.writeGate = gate.promise;
  await monitor.connect(115200);
  const writing = assert.rejects(monitor.writeLine('p 1'));
  const queued = assert.rejects(monitor.writeLine('p 2'), /未送信/);
  await waitUntil(() => first.writes.length === 1);
  const disconnecting = monitor.disconnect();
  assert.equal(monitor.canWrite, false);
  await assert.rejects(monitor.writeLine('w A'), /書き込み可能/);
  gate.resolve();
  await Promise.all([writing, queued, disconnecting]);
  assert.deepEqual(first.writes, ['p 1\n']);
  assert.equal(first.writable.locked, false);
  await monitor.connect(115200);
  await monitor.writeLine('r');
  assert.deepEqual(second.writes, ['r\n']);
  assert.equal(monitor.getSnapshot().error, null);
  await monitor.disconnect();
});

test('送信エラーでは後続指示を止め、両方のロックを解放して切断する', async () => {
  const port = new FakeWritableSerialPort();
  const { monitor } = setup(port);
  port.writeError = new Error('USB write failed');
  await monitor.connect(115200);
  const first = assert.rejects(monitor.writeLine('p 1'), /USB write failed/);
  const queued = assert.rejects(monitor.writeLine('p 2'), /未送信/);
  await Promise.all([first, queued]);
  await waitUntil(() => monitor.getSnapshot().status === 'disconnected');
  assert.deepEqual(port.writes, ['p 1\n']);
  assert.equal(port.readable?.locked, false);
  assert.equal(port.writable.locked, false);
  assert.match(monitor.getSnapshot().error!, /送信中にエラー/);
});

test('接続を維持して未送信指示だけ破棄し、進行中送信の後に停止指示を送る', async () => {
  const port = new FakeWritableSerialPort();
  const { monitor } = setup(port);
  const gate = deferred<void>();
  port.writeGate = gate.promise;
  await monitor.connect(115200);
  const inFlight = monitor.writeLine('p 1');
  const active = assert.rejects(monitor.writeLine('p 2'), /未送信/);
  const weak = assert.rejects(monitor.writeLine('w A'), /未送信/);
  await waitUntil(() => port.writes.length === 1);
  monitor.discardPendingWrites();
  const stop = monitor.writeLine('p 0');
  const reset = monitor.writeLine('r');
  gate.resolve();
  await Promise.all([inFlight, active, weak, stop, reset]);
  assert.deepEqual(port.writes, ['p 1\n', 'p 0\n', 'r\n']);
  assert.equal(monitor.getSnapshot().status, 'connected');
  assert.equal(monitor.getSnapshot().error, null);
  assert.equal(monitor.canWrite, true);
  await monitor.disconnect();
});

test('受信側の抜線でも送信待ちを停止してからポートを閉じる', async () => {
  const port = new FakeWritableSerialPort();
  const { monitor } = setup(port);
  const gate = deferred<void>();
  port.writeGate = gate.promise;
  await monitor.connect(115200);
  const writing = assert.rejects(monitor.writeLine('p 1'));
  const queued = assert.rejects(monitor.writeLine('p 2'), /未送信/);
  await waitUntil(() => port.writes.length === 1);
  port.controller.error(new Error('unplugged'));
  await waitUntil(() => monitor.getSnapshot().status === 'disconnecting');
  gate.resolve();
  await Promise.all([writing, queued]);
  await waitUntil(() => monitor.getSnapshot().status === 'disconnected');
  assert.deepEqual(port.writes, ['p 1\n']);
  assert.match(monitor.getSnapshot().error!, /受信中にエラー/);
});
