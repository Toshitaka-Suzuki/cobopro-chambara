import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SerialMonitor } from './serial.ts';
import type { SerialApi, SerialPortApi } from './serial.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Expected state was not reached');
}

class FakePort implements SerialPortApi {
  readable: ReadableStream<Uint8Array> | null;
  controller!: ReadableStreamDefaultController<Uint8Array>;
  events: string[] = [];
  options: { baudRate: number } | null = null;
  openGate: Promise<void> | null = null;
  openError: Error | null = null;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      cancel: () => { this.events.push('cancel'); },
    });
  }

  async open(options: { baudRate: number }) {
    this.events.push('open');
    this.options = options;
    if (this.openGate) await this.openGate;
    if (this.openError) throw this.openError;
  }

  async close() {
    assert.equal(this.readable?.locked ?? false, false, 'release the reader before closing');
    this.events.push('close');
  }

  send(text: string) {
    this.controller.enqueue(new TextEncoder().encode(text));
  }
}

function setup(port = new FakePort()) {
  let requests = 0;
  const api: SerialApi = { requestPort: () => { requests++; return Promise.resolve(port); } };
  return { monitor: new SerialMonitor(api), port, requests: () => requests };
}

test('ポート選択は同期で始まり、選択中・接続中の二重接続を防ぐ', async () => {
  const selected = deferred<SerialPortApi>();
  const port = new FakePort();
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
  await until(() => monitor.getSnapshot().bytesReceived === 1);
  assert.equal(monitor.getSnapshot().text, '');
  port.controller.enqueue(bytes.slice(1));
  await until(() => monitor.getSnapshot().text === 'あ');
  port.send(' value=1.25\r\nnext');
  await until(() => monitor.getSnapshot().text.endsWith('next'));
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
  const port = new FakePort();
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
  const port = new FakePort();
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
  await until(() => port.events.includes('open'));
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
  const first = new FakePort();
  const second = new FakePort();
  const ports = [first, second];
  const monitor = new SerialMonitor({ requestPort: async () => ports.shift()! });
  await monitor.connect(115200);
  first.send('before unplug');
  await until(() => monitor.getSnapshot().text === 'before unplug');
  first.controller.error(new DOMException('Disconnected', 'NetworkError'));
  await until(() => monitor.getSnapshot().status === 'disconnected');
  assert.deepEqual(first.events, ['open', 'close']);
  assert.match(monitor.getSnapshot().error!, /受信中にエラー/);
  assert.equal(monitor.getSnapshot().text, 'before unplug');
  await monitor.connect(9600);
  assert.equal(monitor.getSnapshot().text, '');
  assert.equal(monitor.getSnapshot().bytesReceived, 0);
  assert.equal(monitor.getSnapshot().lastReceivedAt, null);
  assert.equal(monitor.getSnapshot().error, null);
  second.send('reconnected');
  await until(() => monitor.getSnapshot().text === 'reconnected');
  await monitor.disconnect();
});

test('予期しない受信終了でも接続済みのまま残らない', async () => {
  const { monitor, port } = setup();
  await monitor.connect(115200);
  port.controller.close();
  await until(() => monitor.getSnapshot().status === 'disconnected');
  assert.match(monitor.getSnapshot().error!, /受信が終了/);
  assert.deepEqual(port.events, ['open', 'close']);
});

test('末尾64Ki文字に制限し、表示クリアは累計受信量・時刻を保持する', async () => {
  const { monitor, port } = setup();
  await monitor.connect(115200);
  port.send('old' + 'a'.repeat(65536) + 'end');
  await until(() => monitor.getSnapshot().truncated);
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
  await until(() => monitor.getSnapshot().text === 'fresh');
  assert.equal(monitor.getSnapshot().bytesReceived, bytesReceived + 5);
  await monitor.disconnect();
});

test('上限で絵文字のサロゲートペアを分断しない', async () => {
  const { monitor, port } = setup();
  await monitor.connect(115200);
  port.send('😀' + 'x'.repeat(65535));
  await until(() => monitor.getSnapshot().truncated);
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
  await until(() => getSnapshot().bytesReceived === 1);
  assert.deepEqual(chunks, []);
  port.controller.enqueue(bytes.slice(1));
  port.send('1\n');
  await until(() => getSnapshot().text === 'あ1\n');
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
  await until(() => getSnapshot().text === 'new');
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
  await until(() => received.length === 1);
  port.send('second');
  await until(() => received.length === 2);
  assert.deepEqual(received, ['first', 'second']);
  assert.equal(monitor.getSnapshot().status, 'connected');
  assert.equal(monitor.getSnapshot().error, null);
  await monitor.disconnect();
  assert.deepEqual(port.events, ['open', 'cancel', 'close']);
});
