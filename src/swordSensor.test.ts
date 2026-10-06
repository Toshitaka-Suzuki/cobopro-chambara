import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SerialMonitor } from './serial.ts';
import { SENSOR_QUIET_PERIOD_MS, SwordSensorInput } from './swordSensor.ts';
import { FakeSerialPort, waitUntil } from './testSupport/serial.ts';

function setup() {
  let now = 0;
  const ports: FakeSerialPort[] = [];
  const monitor = new SerialMonitor({ requestPort: async () => {
    const port = new FakeSerialPort();
    ports.push(port);
    return port;
  } });
  const sensor = new SwordSensorInput(monitor, () => now);
  const advance = (milliseconds: number) => { now += milliseconds; };
  const send = async (text: string) => {
    const bytesBefore = monitor.getSnapshot().bytesReceived;
    ports.at(-1)!.send(text);
    await waitUntil(() => monitor.getSnapshot().bytesReceived === bytesBefore + new TextEncoder().encode(text).length);
  };
  return { monitor, sensor, ports, send, advance };
}

test('ポートを開いただけではreadyにせず、完全な1の行を受信して確認する', async () => {
  const { monitor, sensor, send, advance } = setup();
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
  assert.equal(events, 1, 'multiple contact lines in one chunk represent a single contact');
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
  assert.equal(lateEvents, 0, 'clearing logs does not rearm a continuing contact');
  advance(SENSOR_QUIET_PERIOD_MS);
  await send('1\n');
  assert.equal(lateEvents, 1);
  unsubscribe();
  advance(SENSOR_QUIET_PERIOD_MS);
  await send('1\n');
  assert.equal(lateEvents, 1);
  assert.equal(events, 3);
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
  await waitUntil(() => monitor.getSnapshot().status === 'disconnected');
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

test('ゲーム境界で同じチャンクの残り配信を止め、次のチャンクも静穏期間が過ぎるまで抑制する', async () => {
  const { monitor, sensor, send, advance } = setup();
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
  assert.equal(firstEvents, 1, 'discarding pending input does not rearm the next chunk');
  assert.equal(laterEvents, 0);
  assert.equal(sensor.getSnapshot().clashesReceived, 4);

  advance(SENSOR_QUIET_PERIOD_MS);
  await send('1\n');
  assert.equal(firstEvents, 2);
  assert.equal(laterEvents, 1, 'a fresh contact after a quiet period resumes ordinary delivery');
  assert.equal(sensor.getSnapshot().clashesReceived, 5);
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
  sensor.stop();
  sensor.start();
  assert.equal(events, 1, 'restarting does not replay the previous contact');
  await send('1\n');
  assert.equal(events, 2, 'a new monitoring session resets the quiet-period state');
  await monitor.disconnect();
  sensor.stop();
});

test('継続する接触は毎回静穏期間を延長し、最後の1から249msでは抑制し250msで再開する', async () => {
  assert.equal(SENSOR_QUIET_PERIOD_MS, 250);
  const { monitor, sensor, send, advance } = setup();
  const counts: number[] = [];
  sensor.subscribeState((snapshot) => { counts.push(snapshot.clashesReceived); });
  let events = 0;
  sensor.subscribeClash(() => { events++; });
  sensor.start();
  await monitor.connect(115200);
  await send('1\n');
  assert.equal(events, 1, 'the first contact is delivered immediately');

  for (let index = 0; index < 10; index++) {
    advance(100);
    await send('1\n');
  }
  assert.equal(events, 1, 'a burst lasting beyond a fixed cooldown remains one contact');
  const continuing = sensor.getSnapshot();
  assert.equal(continuing.ready, true);
  assert.equal(continuing.clashesReceived, 11);
  assert.equal(typeof continuing.lastClashAt, 'number');

  advance(249);
  await send('1\n');
  assert.equal(events, 1);
  assert.notEqual(sensor.getSnapshot(), continuing, 'suppressed contacts still update receive state');
  advance(SENSOR_QUIET_PERIOD_MS);
  await send('1\n');
  assert.equal(events, 2);
  assert.equal(sensor.getSnapshot().clashesReceived, 13);
  assert.deepEqual(counts, Array.from({ length: 14 }, (_, index) => index));
  await monitor.disconnect();
  sensor.stop();
});

test('0や不正行は接触を即座に再開させず、静穏期間の経過も妨げない', async () => {
  const { monitor, sensor, send, advance } = setup();
  let events = 0;
  sensor.subscribeClash(() => { events++; });
  sensor.start();
  await monitor.connect(115200);
  await send('1\n');
  advance(1);
  await send('0\ninvalid\n');
  advance(248);
  await send('1\n');
  assert.equal(events, 1, 'a brief zero or malformed line must not rearm contact input');

  advance(249);
  await send('0\ninvalid\n');
  advance(1);
  await send('1\n');
  assert.equal(events, 2, 'only contact lines restart the quiet period');
  assert.equal(sensor.getSnapshot().clashesReceived, 3);
  await monitor.disconnect();
  sensor.stop();
});

test('静穏期間が経過しただけでは抑制した接触を再送しない', async () => {
  const { monitor, sensor, send, advance } = setup();
  let events = 0;
  sensor.subscribeClash(() => { events++; });
  sensor.start();
  await monitor.connect(115200);
  await send('1\n');
  advance(100);
  await send('1\n');
  assert.equal(events, 1);
  advance(1000);
  await send('0\n');
  assert.equal(events, 1, 'a quiet period never flushes a stale contact');
  await send('1\n');
  assert.equal(events, 2, 'only a newly received contact is delivered');
  await monitor.disconnect();
  sensor.stop();
});

test('購読者がいない間の接触も抑制に含め、購読を変更しても静穏期間を維持する', async () => {
  const { monitor, sensor, send, advance } = setup();
  let events = 0;
  sensor.start();
  await monitor.connect(115200);
  await send('1\n');
  const unsubscribe = sensor.subscribeClash(() => { events++; });
  await send('1\n');
  assert.equal(events, 0, 'subscribing does not rearm an ongoing contact');
  advance(SENSOR_QUIET_PERIOD_MS);
  await send('1\n');
  assert.equal(events, 1);
  unsubscribe();
  sensor.subscribeClash(() => { events++; });
  advance(100);
  await send('1\n');
  assert.equal(events, 1, 'replacing a subscriber preserves the last contact time');
  advance(SENSOR_QUIET_PERIOD_MS);
  await send('1\n');
  assert.equal(events, 2);
  assert.equal(sensor.getSnapshot().clashesReceived, 5);
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
