import test from 'node:test';
import assert from 'node:assert/strict';
import { LegacyEspController, ESP_RESULT_WAIT_MS } from './legacyEsp.ts';
import { IntegratedSession } from './integratedSession.ts';
import type { AppSocket } from './integratedSession.ts';
import { SerialMonitor } from './serial.ts';
import { FakeWritableSerialPort, waitUntil } from './testSupport/serial.ts';

class Socket implements AppSocket {
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;
  sent: Record<string, unknown>[] = [];
  rhythms: Record<string, unknown>[] = [];
  send(raw: string) {
    const value = JSON.parse(raw);
    this.sent.push(value);
    if (value.name === 'rhythm_sync') this.rhythms.push(value);
    else this.receive({ ...value, type: 'received' });
  }
  close() {}
  receive(value: object) {
    this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent);
  }
  status(value: string) { this.receive({ type: 'status', value }); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(advanceMs = 200, baudRate = 115200, capability = true) {
  let now = 0;
  let cue = [1000, 1500, 2000, 2500];
  let generation = 1;
  const socket = new Socket();
  const session = new IntegratedSession({ socketFactory: () => socket, now: () => now, autoTick: false });
  session.connect('ws://localhost:8765');
  socket.receive({ type: 'connected', protocol_version: 3, rhythm_guide: true, esp_legacy: capability });
  socket.status('standby');
  const port = new FakeWritableSerialPort();
  const monitor = new SerialMonitor({ requestPort: async () => port });
  const esp = new LegacyEspController(monitor, session, { now: () => now, autoTick: false });
  esp.start();
  esp.setAdvanceMs(advanceMs);
  await monitor.connect(baudRate);
  function sync() {
    for (const request of socket.rhythms.splice(0)) socket.receive({
      type: 'rhythm_state', request_id: request.request_id, ready: true, active: true,
      stage: 'hard', generation, position_ms: now, beats_ms: cue, window_ms: 300,
    });
  }
  function tick() { session.tick(); sync(); esp.tick(); }
  async function advance(ms: number) {
    const until = now + ms;
    while (now < until) {
      now = Math.min(until, now + 50);
      tick();
      await flush();
    }
  }
  async function battle() {
    assert.equal(esp.startGame('hard'), true);
    socket.status('pre_interview');
    socket.status('pre_interview_finished');
    session.startBattle();
    socket.status('battle_started');
    tick();
    await waitUntil(() => port.writes.length >= 2);
  }
  async function emit(line: string) { port.send(line + '\n'); await flush(); }
  async function cleanup() { esp.stop(); session.disconnect(); await monitor.disconnect(); }
  return { session, socket, port, esp, monitor, battle, advance, emit, cleanup,
    now: () => now, jump: (ms: number) => { now += ms; tick(); },
    nextCue: (delay = 0) => { cue = [now + delay + 1000, now + delay + 1500, now + delay + 2000, now + delay + 2500]; },
    changeGeneration: () => { generation++; },
  };
}

test('予告・有効化・解除を音声予定から同じ200msだけ早め、状態の受付幅は300msを保つ', async () => {
  const f = await fixture();
  try {
    await f.battle();
    assert.deepEqual(f.port.writes, ['r\n', 'p 0\n']);
    assert.equal(f.socket.sent.find(x => x.name === 'game_start')?.parry_source, 'esp_legacy');
    await f.advance(750);
    assert.equal(f.port.writes.length, 2);
    await f.advance(50);
    assert.equal(f.port.writes.at(-1), 'p 1\n');
    await f.advance(1350);
    assert.equal(f.port.writes.at(-1), 'p 2\n');
    await f.advance(300);
    assert.equal(f.port.writes.at(-1), 'p 0\n');
    const commandLog = f.esp.getSnapshot().log.filter(x => x.text.startsWith('送信要求：p') && x.text.includes('予定との差'));
    assert.deepEqual(commandLog.map(x => x.at), [800, 2150, 2450]);
  } finally { await f.cleanup(); }
});

test('0msにも調整でき、ゲーム中の設定変更や不正値は採用しない', async () => {
  const f = await fixture(0);
  try {
    f.esp.setAdvanceMs(-1);
    f.esp.setAdvanceMs(501);
    assert.equal(f.esp.getSnapshot().advanceMs, 0);
    await f.battle();
    f.esp.setAdvanceMs(400);
    await f.advance(1000);
    assert.equal(f.port.writes.at(-1), 'p 1\n');
    assert.equal(f.esp.getSnapshot().advanceMs, 0);
  } finally { await f.cleanup(); }
});

test('遅着したESP成功を時刻で判定し直さず、Aだけの10秒受付から3回命中で勝利する', async () => {
  const f = await fixture();
  try {
    await f.battle();
    for (let hp = 2; hp >= 0; hp--) {
      await f.advance(2900); // カンから400ms後。Pythonの±150ms窓は過ぎている。
      await f.emit('[PARRY] confirmed result=1');
      await f.emit('1');
      assert.equal(f.session.getSnapshot().game.phase, 'defend');
      await f.emit('[EVENT] PARRY SUCCESS (once)');
      assert.equal(f.session.getSnapshot().game.phase, 'success');
      await f.emit('[EVENT] PARRY SUCCESS (once)');
      await f.advance(900);
      assert.equal(f.session.getSnapshot().game.phase, 'attack');
      assert.equal(f.session.getSnapshot().game.target, 1);
      assert.equal(f.session.getSnapshot().game.attackRemainingMs, 10000);
      assert.equal(f.port.writes.at(-1), 'w A\n');
      await f.emit('[EVENT] WEAK B SUCCESS (once)');
      f.session.action({ type: 'contact' });
      f.session.action({ type: 'hit', target: 1 });
      assert.equal(f.session.getSnapshot().game.hp, hp + 1);
      await f.emit('[EVENT] WEAK A SUCCESS (once)');
      await f.emit('[EVENT] WEAK A SUCCESS (once)');
      await f.emit('[WEAK A] end state confirmed=1');
      assert.equal(f.session.getSnapshot().game.hp, hp);
      if (hp) { f.nextCue(2400); await f.advance(2400); }
    }
    assert.equal(f.session.getSnapshot().game.phase, 'win');
    assert.equal(f.socket.sent.some(x => x.name === 'parry'), false);
    assert.deepEqual(f.socket.sent.filter(x => x.name === 'weak_point_count').map(x => x.count), [2, 1, 0]);
    await flush();
    assert.equal(f.port.writes.at(-1), 'r\n');
  } finally { await f.cleanup(); }
});

test('成功通知がない場合は待ってから未確認として進み、通信欠落と失敗を断定しない', async () => {
  const f = await fixture();
  try {
    await f.battle();
    await f.advance(2650 + ESP_RESULT_WAIT_MS - 50);
    assert.equal(f.session.getSnapshot().game.phase, 'defend');
    await f.advance(50);
    assert.equal(f.session.getSnapshot().game.phase, 'miss');
    assert.match(f.session.getSnapshot().game.notice, /成功通知を確認できません/);
    assert.ok(f.esp.getSnapshot().log.some(x => x.text.includes('通信欠落は区別できません')));
    await f.emit('[EVENT] PARRY SUCCESS (once)');
    assert.equal(f.session.getSnapshot().game.phase, 'miss');
  } finally { await f.cleanup(); }
});

test('画面の10秒経過だけでは弱点失敗にせず、遅れて届いた命中を採用する', async () => {
  const f = await fixture();
  try {
    await f.battle();
    await f.advance(2800);
    await f.emit('[EVENT] PARRY SUCCESS (once)');
    await f.advance(900 + 10200);
    assert.equal(f.session.getSnapshot().game.phase, 'attack');
    assert.equal(f.session.getSnapshot().game.attackRemainingMs, 0);
    await f.emit('[EVENT] WEAK A SUCCESS (once)');
    assert.equal(f.session.getSnapshot().game.hp, 2);
  } finally { await f.cleanup(); }
});

test('弱点終了通知を受けて次へ進み、終了通知も来ない場合は通信エラーで中断する', async () => {
  for (const sendEnd of [true, false]) {
    const f = await fixture();
    try {
      await f.battle();
      await f.advance(2800);
      await f.emit('[EVENT] PARRY SUCCESS (once)');
      await f.advance(900 + 10500);
      if (sendEnd) {
        await f.emit('[WEAK A] end state confirmed=1');
        await f.advance(300);
        assert.equal(f.session.getSnapshot().game.phase, 'miss');
      } else {
        await f.advance(700);
        assert.equal(f.session.getSnapshot().phase, 'cancelling');
        assert.match(f.esp.getSnapshot().error, /終了通知が届きません/);
      }
    } finally { await f.cleanup(); }
  }
});

test('タイマー停止で予定を飛ばした場合、p1・p2・p0を一度に流さず中断する', async () => {
  const f = await fixture();
  try {
    await f.battle();
    await f.advance(700);
    f.jump(500);
    await flush();
    assert.equal(f.session.getSnapshot().phase, 'cancelling');
    assert.match(f.esp.getSnapshot().error, /送信予定/);
    assert.equal(f.port.writes.includes('p 2\n'), false);
    assert.equal(f.port.writes.at(-1), 'r\n');
  } finally { await f.cleanup(); }
});

test('中断後のタイマー・古い成功通知を破棄し、USB切断もゲームを中断する', async () => {
  for (const disconnect of [false, true]) {
    const f = await fixture();
    try {
      await f.battle();
      await f.advance(2200);
      if (disconnect) await f.monitor.disconnect();
      else {
        f.session.cancel();
        await f.emit('[EVENT] PARRY SUCCESS (once)');
      }
      assert.equal(f.session.getSnapshot().phase, 'cancelling');
      assert.equal(f.session.getSnapshot().game.hp, 3);
      await f.advance(2000);
      assert.equal(f.port.writes.includes('w A\n'), false);
    } finally { await f.cleanup(); }
  }
});

test('通信速度が違う接続とESP非対応Pythonでは開始しない', async () => {
  const wrongBaud = await fixture(200, 9600);
  try { assert.equal(wrongBaud.esp.startGame('easy'), false); }
  finally { await wrongBaud.cleanup(); }
  const oldPython = await fixture(200, 115200, false);
  try {
    assert.equal(oldPython.esp.startGame('easy'), false);
    assert.match(oldPython.esp.getSnapshot().error, /更新/);
    await flush();
    assert.deepEqual(oldPython.port.writes, []);
  } finally { await oldPython.cleanup(); }
});
