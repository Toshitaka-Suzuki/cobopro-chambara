import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SerialMonitor } from './serial.ts';
import type { SerialPortApi } from './serial.ts';
import { SwordSensorInput } from './swordSensor.ts';

class FakePort implements SerialPortApi {
  controller!: ReadableStreamDefaultController<Uint8Array>;
  readable = new ReadableStream<Uint8Array>({
    start: (controller) => { this.controller = controller; },
  });
  async open() {}
  async close() {}
  send(text: string) {
    this.controller.enqueue(new TextEncoder().encode(text));
  }
}

async function until(predicate: () => boolean) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Expected state was not reached');
}

function setup() {
  const ports: FakePort[] = [];
  const monitor = new SerialMonitor({ requestPort: async () => {
    const port = new FakePort();
    ports.push(port);
    return port;
  } });
  const sensor = new SwordSensorInput(monitor);
  const send = async (text: string) => {
    const bytesBefore = monitor.getSnapshot().bytesReceived;
    ports.at(-1)!.send(text);
    await until(() => monitor.getSnapshot().bytesReceived === bytesBefore + new TextEncoder().encode(text).length);
  };
  return { monitor, sensor, ports, send };
}

test('ポートを開いただけではreadyにせず、完全な1の行を受信して確認する', async () => {
  const { monitor, sensor, send } = setup();
  const { getSnapshot, subscribeState, subscribeClash, start } = sensor;
  let events = 0;
  const listener = () => { events++; };
  subscribeClash(listener);
  subscribeClash(listener);
  const snapshots: boolean[] = [];
  subscribeState((snapshot) => {
    assert.equal(snapshot, getSnapshot());
    snapshots.push(snapshot.ready);
  });
  start();
  start();
  await monitor.connect(115200);
  assert.deepEqual(getSnapshot(), { connected: true, ready: false, clashesReceived: 0, lastClashAt: null });
  const connected = getSnapshot();
  await send('0\ninvalid\n');
  assert.equal(getSnapshot(), connected, 'irrelevant input preserves snapshot reference');
  await send('1');
  assert.equal(events, 0);
  await send('\r\n1\n');
  assert.equal(events, 2);
  assert.equal(getSnapshot().ready, true);
  assert.equal(getSnapshot().clashesReceived, 2);
  assert.equal(typeof getSnapshot().lastClashAt, 'number');
  assert.deepEqual(snapshots, [false, true, true]);
  let lateEvents = 0;
  const unsubscribe = subscribeClash(() => { lateEvents++; });
  assert.equal(lateEvents, 0, 'subscribing does not replay history');
  const received = getSnapshot();
  monitor.clear();
  assert.equal(getSnapshot(), received);
  await send('1\n');
  assert.equal(lateEvents, 1);
  unsubscribe();
  await send('1\n');
  assert.equal(lateEvents, 1);
  assert.equal(events, 4);
  await monitor.disconnect();
  sensor.stop();
});

test('切断時にreadyと履歴をすぐリセットし、再接続へ未完の入力を持ち越さない', async () => {
  const { monitor, sensor, send, ports } = setup();
  sensor.start();
  let events = 0;
  sensor.subscribeClash(() => { events++; });
  await monitor.connect(115200);
  await send('1\n1');
  const disconnecting = monitor.disconnect();
  assert.deepEqual(sensor.getSnapshot(), { connected: false, ready: false, clashesReceived: 0, lastClashAt: null });
  await disconnecting;
  await monitor.connect(9600);
  await send('\n');
  assert.equal(events, 1);
  assert.equal(sensor.getSnapshot().ready, false);
  await send('1\n');
  assert.equal(events, 2);
  assert.equal(sensor.getSnapshot().clashesReceived, 1);
  ports.at(-1)!.controller.error(new DOMException('Unplugged', 'NetworkError'));
  await until(() => monitor.getSnapshot().status === 'disconnected');
  assert.equal(sensor.getSnapshot().connected, false);
  assert.equal(sensor.getSnapshot().ready, false);
  assert.equal(sensor.getSnapshot().clashesReceived, 0);
  sensor.stop();
});

test('準備中の部分行の破棄はログ消去から独立している', async () => {
  const { monitor, sensor, send } = setup();
  sensor.start();
  await monitor.connect(115200);
  await send('old');
  sensor.discardPending();
  monitor.clear();
  await send('1\n');
  assert.equal(sensor.getSnapshot().clashesReceived, 0);
  await send('1');
  monitor.clear();
  await send('\n');
  assert.equal(sensor.getSnapshot().clashesReceived, 1, 'clear does not reset protocol framing');
  sensor.discardPending();
  await send('1\n');
  assert.equal(sensor.getSnapshot().clashesReceived, 2);
  await monitor.disconnect();
  sensor.stop();
});

test('ゲーム境界で同じチャンクの残り配信を止め、受信数は保持して次のチャンクから再開する', async () => {
  const { monitor, sensor, send } = setup();
  let firstEvents = 0;
  let laterEvents = 0;
  sensor.subscribeClash(() => {
    firstEvents++;
    if (firstEvents === 1) sensor.discardPending();
  });
  sensor.subscribeClash(() => { laterEvents++; });
  sensor.start();
  await monitor.connect(115200);
  await send('1\n1\n1\n');
  assert.equal(firstEvents, 1, 'remaining lines must not reach the next game phase');
  assert.equal(laterEvents, 0, 'remaining listeners must not receive the current event');
  assert.equal(sensor.getSnapshot().clashesReceived, 3, 'delivery suppression does not change valid receive counts');
  assert.equal(sensor.getSnapshot().connected, true);
  assert.equal(sensor.getSnapshot().ready, true);
  assert.equal(typeof sensor.getSnapshot().lastClashAt, 'number');

  await send('1\n');
  assert.equal(firstEvents, 2);
  assert.equal(laterEvents, 1, 'a new complete chunk resumes ordinary delivery');
  assert.equal(sensor.getSnapshot().clashesReceived, 4);
  await monitor.disconnect();
  sensor.stop();
});

test('start/stopを繰り返しても購読を重複させず、停止中や過去のログを再送しない', async () => {
  const { monitor, sensor, send } = setup();
  await monitor.connect(115200);
  await send('1\n');
  assert.equal(sensor.getSnapshot().connected, false, 'constructor does not subscribe');
  let events = 0;
  sensor.subscribeClash(() => { events++; });
  sensor.start();
  assert.equal(sensor.getSnapshot().ready, false);
  await send('1');
  sensor.stop();
  sensor.stop();
  await send('\n1\n');
  assert.equal(events, 0);
  sensor.start();
  sensor.start();
  await send('\n');
  assert.equal(events, 0);
  await send('1\n');
  assert.equal(events, 1);
  await monitor.disconnect();
  sensor.stop();
});

test('購読例外を分離し、イベント処理中の停止後に残りの行を配信しない', async () => {
  const { monitor, sensor, send } = setup();
  sensor.subscribeState(() => { throw new Error('broken UI'); });
  sensor.subscribeClash(() => { throw new Error('broken consumer'); });
  let events = 0;
  sensor.subscribeClash(() => { events++; sensor.stop(); });
  sensor.start();
  await monitor.connect(115200);
  await send('1\n1\n1\n');
  assert.equal(events, 1);
  assert.equal(sensor.getSnapshot().connected, false);
  assert.equal(monitor.getSnapshot().status, 'connected');
  assert.equal(monitor.getSnapshot().error, null);
  await monitor.disconnect();
});
