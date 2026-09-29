import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { initialGame, transition, transitionWithElapsed } from './game.ts';
import type { Action } from './game.ts';
import { SerialMonitor } from './serial.ts';
import type { SerialPortApi } from './serial.ts';
import { SwordSensorInput } from './swordSensor.ts';

class FakePort implements SerialPortApi {
  controller!: ReadableStreamDefaultController<Uint8Array>;
  readable = new ReadableStream<Uint8Array>({
    start: controller => { this.controller = controller; },
  });
  async open() {}
  async close() {}
  send(text: string) { this.controller.enqueue(new TextEncoder().encode(text)); }
}

async function setup() {
  const port = new FakePort();
  const monitor = new SerialMonitor({ requestPort: async () => port });
  const sensor = new SwordSensorInput(monitor);
  let game = transition(initialGame, { type: 'start' });
  let now = 0;
  let lastTick = 0;
  // GameScreenと同じ入力経路。直前の経過時間を処理し、場面変更で古い入力を捨てる。
  const dispatch = (action: Action, elapsed = 0) => {
    now += elapsed;
    const next = transitionWithElapsed(game, action, now - lastTick);
    lastTick = now;
    if (next.phase !== game.phase || next.paused !== game.paused) sensor.discardPending();
    game = next;
  };
  sensor.start();
  await monitor.connect(115200);
  return {
    monitor, sensor,
    game: () => game,
    subscribeGame: () => sensor.subscribeClash(() => dispatch({ type: 'contact', target: 1 })),
    tick: (elapsed: number) => dispatch({ type: 'tick', elapsed: 0 }, elapsed),
    send: async (text: string, elapsed = 0) => {
      // 時間だけを進め、次の受信がタイマー通知より先に届く場合も再現できる。
      now += elapsed;
      const expectedBytes = monitor.getSnapshot().bytesReceived + new TextEncoder().encode(text).length;
      port.send(text);
      for (let attempts = 0; attempts < 100; attempts++) {
        if (monitor.getSnapshot().bytesReceived === expectedBytes) return;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.fail('Serial chunk was not consumed');
    },
    dispose: async () => { sensor.stop(); await monitor.disconnect(); },
  };
}

test('実際の受信経路で同じチャンクの重複を採用せず、接触だけで3命中して勝利する', async context => {
  const setupGame = await setup();
  context.after(setupGame.dispose);
  const unsubscribe = setupGame.subscribeGame();
  context.after(unsubscribe);
  for (let hp = 3; hp > 0; hp--) {
    assert.equal(setupGame.game().phase, 'defend');
    await setupGame.send('1\n1\n');
    assert.equal(setupGame.game().phase, 'success');
    assert.equal(setupGame.game().hp, hp, 'one chunk cannot both defend and hit');
    setupGame.tick(900);
    assert.equal(setupGame.game().phase, 'attack');
    await setupGame.send('1\n');
    assert.equal(setupGame.game().hp, hp - 1);
    if (hp > 1) {
      assert.equal(setupGame.game().phase, 'damage');
      setupGame.tick(2400);
    }
  }
  const won = setupGame.game();
  assert.equal(won.phase, 'win');
  assert.equal(setupGame.sensor.getSnapshot().clashesReceived, 9, 'received line counts include suppressed duplicates');
  setupGame.tick(60000);
  await setupGame.send('1\n');
  assert.equal(setupGame.game(), won);
});

test('未完の接触が成功表示の終端で完成しても、そのチャンク全体を攻撃の命中にしない', async context => {
  const setupGame = await setup();
  context.after(setupGame.dispose);
  context.after(setupGame.subscribeGame());
  await setupGame.send('1\n');
  assert.equal(setupGame.game().phase, 'success');
  await setupGame.send('1');
  await setupGame.send('\n1\n', 900);
  assert.equal(setupGame.game().phase, 'attack');
  assert.equal(setupGame.game().hp, 3);
  assert.equal(setupGame.sensor.getSnapshot().clashesReceived, 3);
  await setupGame.send('1\n');
  assert.equal(setupGame.game().phase, 'damage');
  assert.equal(setupGame.game().hp, 2);
});

test('ゲームの購読を解除しても接続と入力確認は維持し、再購読で過去の入力を再生しない', async context => {
  const setupGame = await setup();
  context.after(setupGame.dispose);
  const unsubscribe = setupGame.subscribeGame();
  unsubscribe();
  const before = setupGame.game();
  await setupGame.send('1\n');
  assert.equal(setupGame.game(), before);
  assert.equal(setupGame.monitor.getSnapshot().status, 'connected');
  assert.equal(setupGame.sensor.getSnapshot().ready, true);
  context.after(setupGame.subscribeGame());
  assert.equal(setupGame.game(), before, 'subscribing does not replay the ready-check input');
  await setupGame.send('1\n');
  assert.equal(setupGame.game().phase, 'success');
  assert.equal(setupGame.game().hp, 3);
});
