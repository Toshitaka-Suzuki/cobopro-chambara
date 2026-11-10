import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { RosMonitor, RosPublisher, RosQos, RosSnapshot, RosSubscriptionOptions } from './ros.ts';
import { RobotBattleController, parseRobotStatus, ROBOT_COMMAND_TOPIC, ROBOT_HEARTBEAT_TOPIC,
  ROBOT_PARRY_TOPIC, ROBOT_STATUS_TOPIC, type RobotStatus } from './robotBattle.ts';

const status = (changes: Partial<RobotStatus> = {}): RobotStatus => ({ type: 'status', session: 'robot-123',
  round: 4, state: 'standby', human_result: null, event: 'state', ...changes });
const wire = (value: RobotStatus) => ({ data: JSON.stringify(value) });

class Monitor {
  connection: RosSnapshot['status'] = 'connected';
  listeners = new Set<(snapshot: RosSnapshot) => void>();
  receivers = new Set<(message: unknown) => void>();
  watches: { topic: string; type: string; options?: RosSubscriptionOptions; receive(message: unknown): void; error(error: Error): void }[] = [];
  publishers: { topic: string; type: string; qos: RosQos; closed: boolean; error(error: Error): void }[] = [];
  sent: { topic: string; message: Record<string, unknown> }[] = [];
  sendError: Error | null = null;
  onPublish: ((topic: string, message: Record<string, unknown>) => void) | null = null;
  onAdvertise: ((topic: string, error: (error: Error) => void) => void) | null = null;
  getSnapshot = () => ({ status: this.connection }) as RosSnapshot;
  subscribeState = (listener: (snapshot: RosSnapshot) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  setConnection(value: RosSnapshot['status']) {
    this.connection = value;
    for (const listener of this.listeners) listener(this.getSnapshot());
  }
  watchTopic(topic: string, type: string, receive: (message: unknown) => void, error: (error: Error) => void, options?: RosSubscriptionOptions) {
    this.watches.push({ topic, type, receive, error, options });
    this.receivers.add(receive);
    return () => { this.receivers.delete(receive); };
  }
  createPublisher(topic: string, type: string, qos: RosQos, error: (error: Error) => void): RosPublisher {
    const item = { topic, type, qos, closed: false, error };
    this.publishers.push(item);
    this.onAdvertise?.(topic, error);
    return {
      publish: message => {
        if (item.closed || this.connection !== 'connected') throw new Error('publisher closed');
        if (this.sendError) throw this.sendError;
        this.sent.push({ topic, message });
        this.onPublish?.(topic, message);
      },
      close: () => { item.closed = true; },
    };
  }
  receive(value: RobotStatus) { for (const receive of [...this.receivers]) receive(wire(value)); }
  commands() { return this.sent.filter(x => x.topic === ROBOT_COMMAND_TOPIC).map(x => x.message.data); }
  heartbeats() { return this.sent.filter(x => x.topic === ROBOT_HEARTBEAT_TOPIC); }
  parries() { return this.sent.filter(x => x.topic === ROBOT_PARRY_TOPIC).map(x => x.message.data); }
}

function fixture(t: TestContext) {
  const monitor = new Monitor();
  let now = 0;
  const controller = new RobotBattleController(monitor as unknown as RosMonitor, { now: () => now, autoTick: false });
  controller.start();
  t.after(() => controller.stop());
  const receive = (changes: Partial<RobotStatus> = {}) => monitor.receive(status(changes));
  const jump = (ms: number) => { now += ms; controller.tick(); };
  const receiveAfter = (ms: number, changes: Partial<RobotStatus> = {}) => { now += ms; receive(changes); controller.tick(); };
  const ready = () => { receive(); receiveAfter(500); assert.equal(controller.getSnapshot().canStart, true); };
  const fight = async () => {
    ready();
    const started = controller.startBattle();
    receiveAfter(100, { state: 'fighting' });
    await started;
  };
  const holdState = (ms: number, changes: Partial<RobotStatus>) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 250) receiveAfter(Math.min(250, ms - elapsed), changes);
  };
  return { monitor, controller, receive, receiveAfter, jump, ready, fight, holdState };
}

test('String.dataの状態だけを検証し、不正なsession・状態・結果を採用しない', () => {
  assert.deepEqual(parseRobotStatus(wire(status())), status());
  for (const invalid of [null, status(), { data: '{' }, { data: JSON.stringify([]) },
    wire(status({ session: 'robot\nstart bad 0' })), wire(status({ round: -1 })), wire(status({ round: 1.5 })),
    wire({ ...status(), state: 'ready' } as unknown as RobotStatus),
    wire({ ...status(), human_result: true } as unknown as RobotStatus),
    { data: JSON.stringify({ ...status(), event: undefined }) }]) assert.equal(parseRobotStatus(invalid), null);
});

test('保持済みの状態1件や同時刻の連続通知では開始不可、継続受信で準備完了にする', t => {
  const f = fixture(t);
  assert.equal(f.monitor.watches[0].topic, ROBOT_STATUS_TOPIC);
  assert.deepEqual(f.monitor.watches[0].options, { throttleRateMs: 0, queueLength: 10,
    qos: { history: 'keep_last', depth: 1, reliability: 'reliable', durability: 'transient_local' } });
  f.receive();
  f.receive();
  assert.equal(f.controller.getSnapshot().online, false);
  f.receiveAfter(250);
  assert.equal(f.controller.getSnapshot().canStart, true);
  assert.equal(f.monitor.sent.length, 0);
  f.jump(1900);
  f.monitor.watches[0].receive({ data: 'broken json' });
  f.jump(100);
  assert.equal(f.controller.getSnapshot().online, false);
  assert.equal(f.controller.getSnapshot().canStart, false);
  f.receive();
  assert.equal(f.controller.getSnapshot().online, false);
  f.receiveAfter(500);
  assert.equal(f.controller.getSnapshot().canStart, true);
});

test('heartbeat→parry初期化→startの順で送り、受付だけではゲーム開始を完了しない', async t => {
  const f = fixture(t);
  await assert.rejects(f.controller.startBattle(), /standby/);
  f.ready();
  let resolved = false;
  const started = f.controller.startBattle().then(() => { resolved = true; });
  assert.deepEqual(f.monitor.sent.map(x => [x.topic, x.message.data]), [
    [ROBOT_HEARTBEAT_TOPIC, 1], [ROBOT_PARRY_TOPIC, 0], [ROBOT_COMMAND_TOPIC, 'start robot-123 4'],
  ]);
  for (const pub of f.monitor.publishers) assert.deepEqual(pub.qos,
    { history: 'keep_last', depth: 10, reliability: 'reliable', durability: 'volatile' });
  assert.equal(f.controller.getSnapshot().phase, 'starting');
  f.receiveAfter(250, { event: 'command_accepted' });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(f.monitor.heartbeats().length, 2);
  await assert.rejects(f.controller.startBattle(), /standby/);
  f.receiveAfter(250, { state: 'fighting' });
  await started;
  assert.equal(f.controller.getSnapshot().phase, 'fighting');
  assert.equal(f.controller.getSnapshot().busy, true);
  assert.deepEqual(f.monitor.commands(), ['start robot-123 4']);
});

test('ESPのパリィは100msの1→0にし、重複を蓄積せずholding中は送らない', async t => {
  const f = fixture(t);
  await f.fight();
  assert.equal(f.controller.parry(), true);
  assert.equal(f.controller.parry(), false);
  f.jump(99);
  assert.deepEqual(f.monitor.parries(), [0, 1]);
  f.jump(1);
  assert.deepEqual(f.monitor.parries(), [0, 1, 0]);
  assert.equal(f.controller.parry(), true);
  f.receive({ state: 'holding' });
  f.jump(100);
  assert.equal(f.controller.parry(), false);
  assert.deepEqual(f.monitor.parries(), [0, 1, 0, 1, 0]);
  assert.equal(f.controller.getSnapshot().phase, 'fighting');
});

test('start受付でroundが一つ進む実装では新しいroundで以後のコマンドを送る', async t => {
  const f = fixture(t);
  f.ready();
  const started = f.controller.startBattle();
  f.receiveAfter(250, { round: 5, event: 'command_accepted' });
  assert.equal(f.controller.getSnapshot().phase, 'starting');
  f.receiveAfter(250, { round: 5, state: 'fighting' });
  await started;
  assert.equal(f.controller.finish(false), true);
  assert.deepEqual(f.monitor.commands(), ['start robot-123 4', 'finish robot-123 5 0']);
  f.receiveAfter(250, { round: 6 });
});

test('開始時のround更新は+1を一度だけ認め、飛び越しや繰り返し変更は拒否する', async t => {
  const f = fixture(t);
  f.ready();
  const failure = assert.rejects(f.controller.startBattle(), /round/);
  f.receiveAfter(250, { round: 5, event: 'command_accepted' });
  f.receiveAfter(250, { round: 6, state: 'fighting' });
  await failure;
  assert.equal(f.controller.getSnapshot().phase, 'fault');
  assert.deepEqual(f.monitor.commands(), ['start robot-123 4']);
});

test('状態通知だけで開始を確認する場合も、同sessionのfightingで一度だけround更新を認める', async t => {
  const f = fixture(t);
  f.ready();
  const started = f.controller.startBattle();
  f.receiveAfter(250, { round: 5, state: 'fighting' });
  await started;
  f.controller.abort();
  assert.deepEqual(f.monitor.commands(), ['start robot-123 4', 'abort robot-123 5']);
});

test('勝利finishは一度だけ送り、停止・復帰中もheartbeatを続け、次roundのstandbyで終了する', async t => {
  const f = fixture(t);
  await f.fight();
  f.controller.parry();
  assert.equal(f.controller.finish(true), true);
  assert.equal(f.controller.finish(true), false);
  assert.deepEqual(f.monitor.parries(), [0, 1, 0]);
  assert.deepEqual(f.monitor.commands(), ['start robot-123 4', 'finish robot-123 4 1']);
  f.receiveAfter(250, { state: 'fighting', event: 'command_accepted', human_result: 1 });
  assert.equal(f.controller.getSnapshot().phase, 'finishing');
  f.receiveAfter(250, { state: 'stopping', human_result: 1 });
  f.receiveAfter(250, { state: 'returning', human_result: 1 });
  assert.equal(f.controller.getSnapshot().phase, 'returning');
  const beats = f.monitor.heartbeats().length;
  f.holdState(12_000, { state: 'returning', human_result: 1 });
  assert.ok(f.monitor.heartbeats().length > beats);
  assert.equal(f.controller.getSnapshot().heartbeat, true);
  assert.equal(f.controller.getSnapshot().canStart, false);
  f.receiveAfter(250, { round: 5, human_result: 1 });
  assert.equal(f.controller.getSnapshot().phase, 'idle');
  assert.equal(f.controller.getSnapshot().canStart, true);
  assert.equal(f.controller.getSnapshot().heartbeat, false);
  const finishedBeats = f.monitor.heartbeats().length;
  f.receiveAfter(500, { round: 5, human_result: 1 });
  assert.equal(f.monitor.heartbeats().length, finishedBeats);
});

test('holdingは勝敗ではなく、敗北finish 0を受け付ける戦闘状態として扱う', async t => {
  const f = fixture(t);
  await f.fight();
  f.receive({ state: 'holding' });
  assert.equal(f.controller.getSnapshot().busy, true);
  assert.equal(f.controller.finish(false), true);
  assert.equal(f.monitor.commands().at(-1), 'finish robot-123 4 0');
  f.receiveAfter(250);
  assert.equal(f.controller.getSnapshot().busy, false);
});

test('開始拒否ではheartbeatを停止し、新しいstandbyの継続受信まで再開不可にする', async t => {
  const f = fixture(t);
  f.ready();
  const failure = assert.rejects(f.controller.startBattle(), /拒否/);
  f.receive({ event: 'command_rejected' });
  await failure;
  assert.equal(f.controller.getSnapshot().phase, 'fault');
  assert.equal(f.controller.getSnapshot().heartbeat, false);
  assert.equal(f.controller.getSnapshot().canStart, false);
  f.receiveAfter(500);
  assert.equal(f.controller.getSnapshot().canStart, true);
  assert.equal(f.monitor.commands().length, 1);
});

test('2秒の通知途絶でheartbeatを止め、古い状態へのfinish/parry/abortは送らない', async t => {
  const f = fixture(t);
  await f.fight();
  for (let i = 0; i < 7; i++) f.jump(250);
  assert.equal(f.controller.getSnapshot().heartbeat, true);
  f.jump(250);
  assert.equal(f.controller.getSnapshot().phase, 'fault');
  assert.equal(f.controller.getSnapshot().online, false);
  const count = f.monitor.sent.length;
  assert.equal(f.controller.finish(false), false);
  assert.equal(f.controller.parry(), false);
  f.controller.abort();
  assert.equal(f.monitor.sent.length, count);
  f.receive({ state: 'fighting' });
  f.receiveAfter(500, { state: 'fighting' });
  assert.equal(f.controller.getSnapshot().canStart, false);
  assert.equal(f.controller.getSnapshot().heartbeat, false);
  f.receiveAfter(500);
  assert.equal(f.controller.getSnapshot().canStart, false);
  f.receiveAfter(500);
  assert.equal(f.controller.getSnapshot().canStart, true);
  assert.equal(f.monitor.sent.length, count);
});

test('開始待ちで切断したらrejectし、再接続時に過去の指示や古い購読結果を持ち越さない', async t => {
  const f = fixture(t);
  f.ready();
  const oldReceiver = f.monitor.watches[0].receive;
  const failure = assert.rejects(f.controller.startBattle(), /接続/);
  f.monitor.setConnection('disconnected');
  await failure;
  assert.equal(f.controller.getSnapshot().heartbeat, false);
  assert.ok(f.monitor.publishers.every(x => x.closed));
  const count = f.monitor.sent.length;
  f.monitor.setConnection('connected');
  oldReceiver(wire(status({ state: 'fighting' })));
  assert.equal(f.controller.getSnapshot().status, null);
  f.receive();
  assert.equal(f.controller.getSnapshot().canStart, false);
  f.receiveAfter(500);
  assert.equal(f.controller.getSnapshot().canStart, true);
  assert.equal(f.monitor.sent.length, count);
});

test('戦闘中のsession/round変更では新しいゲームへ中断指示を送らない', async t => {
  const f = fixture(t);
  await f.fight();
  f.receiveAfter(250, { session: 'new-session', round: 0 });
  assert.equal(f.controller.getSnapshot().phase, 'fault');
  assert.equal(f.controller.getSnapshot().heartbeat, false);
  assert.equal(f.controller.finish(true), false);
  f.controller.abort();
  assert.deepEqual(f.monitor.commands(), ['start robot-123 4']);
  f.receiveAfter(500, { session: 'new-session', round: 0 });
  assert.equal(f.controller.getSnapshot().canStart, true);
  const newStart = f.controller.startBattle();
  f.receiveAfter(250, { session: 'new-session', round: 0, state: 'fighting' });
  await newStart;
  assert.equal(f.monitor.commands().at(-1), 'start new-session 0');
});

test('明示中断は同じsessionへabortを一度送り、finishや自動復帰指示は送らない', async t => {
  const f = fixture(t);
  await f.fight();
  f.controller.parry();
  f.controller.abort('利用者が中断しました。');
  f.controller.abort();
  assert.deepEqual(f.monitor.commands(), ['start robot-123 4', 'abort robot-123 4']);
  assert.deepEqual(f.monitor.parries(), [0, 1, 0]);
  assert.equal(f.controller.getSnapshot().heartbeat, false);
  assert.equal(f.controller.getSnapshot().phase, 'fault');
  f.receiveAfter(500, { state: 'fault' });
  assert.equal(f.controller.getSnapshot().canStart, false);
});

test('受付済みでもfightingが10秒届かなければ中断し、startを再送しない', async t => {
  const f = fixture(t);
  f.ready();
  const failure = assert.rejects(f.controller.startBattle(), /10秒/);
  f.receive({ event: 'command_accepted' });
  f.holdState(10_000, {});
  await failure;
  assert.deepEqual(f.monitor.commands(), ['start robot-123 4', 'abort robot-123 4']);
  assert.equal(f.controller.getSnapshot().phase, 'fault');
  assert.equal(f.controller.getSnapshot().heartbeat, false);
});

test('送信ループが2秒止まった後は、溜まったheartbeatを追送して再開しない', async t => {
  const f = fixture(t);
  await f.fight();
  // タイマーを動かさず、受信だけ継続する状態を作る。
  const originalTick = f.controller.tick;
  f.controller.tick = () => {};
  f.receiveAfter(1000, { state: 'fighting' });
  f.receiveAfter(1000, { state: 'fighting' });
  f.controller.tick = originalTick;
  const count = f.monitor.sent.length;
  f.controller.tick();
  assert.equal(f.controller.getSnapshot().phase, 'fault');
  assert.equal(f.monitor.sent.length, count);
});

test('ROS発行元の同期エラーで開始を拒否し、通信確立後の予約送信を残さない', async t => {
  const f = fixture(t);
  f.ready();
  f.monitor.onAdvertise = (_topic, fail) => fail(new Error('QoS not supported'));
  await assert.rejects(f.controller.startBattle(), /QoS not supported/);
  assert.equal(f.controller.getSnapshot().phase, 'fault');
  assert.equal(f.controller.getSnapshot().online, false);
  assert.equal(f.monitor.sent.length, 0);
  assert.ok(f.monitor.publishers.every(x => x.closed));
});

test('送信準備中にstandbyが失われた場合はstartを送らない', async t => {
  const f = fixture(t);
  f.ready();
  f.monitor.onAdvertise = () => f.receive({ state: 'initializing' });
  await assert.rejects(f.controller.startBattle(), /準備状態/);
  assert.equal(f.monitor.sent.length, 0);
});

test('開始コマンド送信中のエラーでは待機をrejectし、heartbeatや旧送信を残さない', async t => {
  const f = fixture(t);
  f.ready();
  f.monitor.onPublish = (topic) => {
    if (topic === ROBOT_COMMAND_TOPIC) f.monitor.publishers[0].error(new Error('command denied'));
  };
  await assert.rejects(f.controller.startBattle(), /command denied/);
  assert.equal(f.controller.getSnapshot().phase, 'fault');
  assert.equal(f.controller.getSnapshot().heartbeat, false);
  const count = f.monitor.sent.length;
  f.jump(1000);
  assert.equal(f.monitor.sent.length, count);
  assert.ok(f.monitor.publishers.every(x => x.closed));
});

test('同期的にfightingや復帰完了が返っても、後続処理で古い状態へ戻さない', async t => {
  const f = fixture(t);
  f.ready();
  f.monitor.onPublish = (topic, message) => {
    if (topic !== ROBOT_COMMAND_TOPIC) return;
    if ((message.data as string).startsWith('start ')) f.receive({ state: 'fighting', event: 'command_accepted' });
    if ((message.data as string).startsWith('finish ')) f.receive({ round: 5, human_result: 1 });
  };
  await f.controller.startBattle();
  assert.equal(f.controller.getSnapshot().phase, 'fighting');
  assert.equal(f.controller.finish(true), true);
  assert.equal(f.controller.getSnapshot().phase, 'idle');
  assert.equal(f.controller.getSnapshot().heartbeat, false);
});
