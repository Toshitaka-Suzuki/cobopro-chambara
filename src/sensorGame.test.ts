import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { INITIAL_GAME_STATE, transitionGame, transitionGameWithElapsed } from './game.ts';
import type { GameAction } from './game.ts';
import { SerialMonitor } from './serial.ts';
import { SENSOR_QUIET_PERIOD_MS, SwordSensorInput } from './swordSensor.ts';
import { FakeSerialPort, waitUntil } from './testSupport/serial.ts';

async function setup() {
  const port = new FakeSerialPort();
  const monitor = new SerialMonitor({ requestPort: async () => port });
  let nowMs = 0;
  const sensor = new SwordSensorInput(monitor, () => nowMs);
  let game = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
  let lastTickMs = 0;
  // useGameSessionと同じ入力経路。直前の経過時間を処理し、場面変更で古い入力を捨てる。
  const dispatch = (action: GameAction, elapsedMs = 0) => {
    nowMs += elapsedMs;
    const next = transitionGameWithElapsed(game, action, nowMs - lastTickMs);
    lastTickMs = nowMs;
    if (next.phase !== game.phase || next.paused !== game.paused) sensor.discardPending();
    game = next;
  };
  sensor.start();
  await monitor.connect(115200);
  return {
    monitor, sensor,
    game: () => game,
    subscribeGame: () => sensor.subscribeClash(() => dispatch({ type: 'contact', target: 1 })),
    tick: (elapsedMs: number) => dispatch({ type: 'tick', elapsedMs: 0 }, elapsedMs),
    send: async (text: string, elapsedMs = 0) => {
      // 時間だけを進め、次の受信がタイマー通知より先に届く場合も再現できる。
      nowMs += elapsedMs;
      const expectedBytes = monitor.getSnapshot().bytesReceived + new TextEncoder().encode(text).length;
      port.send(text);
      await waitUntil(() => monitor.getSnapshot().bytesReceived === expectedBytes);
    },
    dispose: async () => { sensor.stop(); await monitor.disconnect(); },
  };
}

test('剣受けの連続信号が攻撃開始を越えても命中にせず、静穏後の新しい接触を受け付ける', async context => {
  const setupGame = await setup();
  context.after(setupGame.dispose);
  context.after(setupGame.subscribeGame());
  await setupGame.send('1\n');
  assert.equal(setupGame.game().phase, 'success');

  for (let elapsedMs = 10; elapsedMs <= 1200; elapsedMs += 10) {
    setupGame.tick(10);
    await setupGame.send('1\n');
    assert.equal(setupGame.game().hp, 3, `residual contact at ${elapsedMs} ms must not hit`);
  }
  assert.equal(setupGame.game().phase, 'attack');
  assert.equal(setupGame.game().roundRemainingMs, 58800);
  assert.equal(setupGame.game().attackRemainingMs, 7700, 'suppressed contacts do not stop the game clock');
  assert.equal(setupGame.sensor.getSnapshot().clashesReceived, 121);
  assert.equal(setupGame.sensor.getSnapshot().ready, true);

  setupGame.tick(SENSOR_QUIET_PERIOD_MS - 1);
  await setupGame.send('1\n');
  assert.equal(setupGame.game().hp, 3, 'an insufficient quiet interval extends the suppression');
  setupGame.tick(SENSOR_QUIET_PERIOD_MS);
  await setupGame.send('1\n');
  assert.equal(setupGame.game().phase, 'damage');
  assert.equal(setupGame.game().hp, 2);
  assert.equal(setupGame.game().roundRemainingMs, 58800 - (SENSOR_QUIET_PERIOD_MS * 2 - 1));

  setupGame.tick(900);
  assert.equal(setupGame.game().phase, 'ready');
  setupGame.tick(1500);
  assert.equal(setupGame.game().phase, 'defend');
  await setupGame.send('1\n');
  assert.equal(setupGame.game().phase, 'success', 'the next defense still accepts a new contact');
  assert.equal(setupGame.game().hp, 2);
});

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
  await setupGame.send('1\n', SENSOR_QUIET_PERIOD_MS);
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
  await setupGame.send('1\n', 10);
  assert.equal(setupGame.game(), before, 'resubscribing does not turn residual contact into a new defense');
  await setupGame.send('1\n', SENSOR_QUIET_PERIOD_MS);
  assert.equal(setupGame.game().phase, 'success');
  assert.equal(setupGame.game().hp, 3);
});
