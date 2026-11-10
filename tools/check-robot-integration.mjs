// 実Python + ESP模擬機器 + ROS模擬ロボットを、実際の通信・進行クラスで接続する。
// ROS/USB機器・音声出力は模擬。実機の動作、安全性、音ずれの測定ではない。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AbstractTransport } from 'roslib';
import { IntegratedSession } from '../src/integratedSession.ts';
import { LegacyEspController } from '../src/legacyEsp.ts';
import { SerialMonitor } from '../src/serial.ts';
import { RosMonitor } from '../src/ros.ts';
import { createRoslibTransportFactory } from '../src/roslibTransport.ts';
import { RobotBattleController, ROBOT_STATUS_TOPIC, ROBOT_COMMAND_TOPIC, ROBOT_HEARTBEAT_TOPIC, ROBOT_PARRY_TOPIC } from '../src/robotBattle.ts';
import { RobotGameLink } from '../src/robotGameLink.ts';
import { projectRhythm } from '../src/rhythm.ts';

class EspPort {
  desired = 0;
  candidate = -1;
  count = 0;
  confirmed = 0;
  success = false;
  weakActive = false;
  timers = new Set();
  writes = [];
  readable = new ReadableStream({ start: c => { this.receiver = c; } });
  writable = new WritableStream({ write: bytes => {
    const command = new TextDecoder().decode(bytes).trim();
    this.writes.push(command);
    if (command === 'r') this.reset();
    else if (/^p [012]$/.test(command)) {
      this.desired = Number(command.at(-1));
      this.receiveState();
    } else if (command === 'w A') {
      this.weakActive = true;
      this.later(10_500, () => {
        if (!this.weakActive) return;
        this.weakActive = false;
        this.output('[WEAK A] end state confirmed=1');
      });
    } else throw new Error(`想定外のコマンド: ${command}`);
  } });
  async open(options) {
    assert.equal(options.baudRate, 115200);
    this.interval = setInterval(() => this.receiveState(), 100);
  }
  async close() { clearInterval(this.interval); this.reset(); }
  reset() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.desired = this.confirmed = this.count = 0;
    this.candidate = -1;
    this.success = this.weakActive = false;
  }
  receiveState() {
    if (this.candidate === this.desired) this.count++;
    else { this.candidate = this.desired; this.count = 1; }
    if (this.count >= 3) {
      this.confirmed = this.desired;
      if (this.confirmed === 0) this.success = false;
    }
  }
  later(ms, callback) {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, ms);
    this.timers.add(timer);
  }
  output(line) { this.receiver.enqueue(new TextEncoder().encode(line + '\r\n')); }
  parry() {
    assert.equal(this.confirmed, 2, 'カンの時点で3回確認済みの判定が有効');
    assert.equal(this.success, false);
    this.success = true;
    this.later(300, () => this.output('[EVENT] PARRY SUCCESS (once)'));
  }
  hitWeak() {
    assert.equal(this.weakActive, true);
    this.weakActive = false;
    this.later(500, () => this.output('[EVENT] WEAK A SUCCESS (once)'));
    this.later(1500, () => this.output('[WEAK A] end state confirmed=1'));
  }
}

/** 実roslibのWebSocket部分だけを置換し、ROSの状態通知と指示受付を模擬する。 */
class RobotTransport extends AbstractTransport {
  state = 'connecting';
  subscribed = false;
  wire = [];
  timers = new Set();
  status = { type: 'status', session: 'robot-test-session', round: 1, state: 'standby', human_result: null, event: 'state' };
  startAcceptedAt = null;
  fightingAt = null;
  returningAt = null;
  restoredAt = null;

  send(message) {
    assert.equal(this.state, 'open', '切断中の送信は許可しない');
    this.wire.push({ at: performance.now(), message: structuredClone(message) });
    if (message.op === 'call_service') {
      const values = message.service === '/rosapi/topics'
        ? { topics: [ROBOT_STATUS_TOPIC, ROBOT_COMMAND_TOPIC, ROBOT_HEARTBEAT_TOPIC, ROBOT_PARRY_TOPIC],
          types: ['std_msgs/msg/String', 'std_msgs/msg/String', 'std_msgs/msg/UInt8', 'std_msgs/msg/UInt8'] }
        : { services: [] };
      this.emit('message', { op: 'service_response', id: message.id, service: message.service, result: true, values });
    } else if (message.op === 'subscribe' && message.topic === ROBOT_STATUS_TOPIC) {
      this.subscribed = true;
      this.broadcast(); // 保持された1件に相当。これだけでは開始可能になってはいけない。
    } else if (message.op === 'unsubscribe' && message.topic === ROBOT_STATUS_TOPIC) this.subscribed = false;
    else if (message.op === 'publish' && message.topic === ROBOT_COMMAND_TOPIC) this.command(message.msg.data);
    else if (message.op === 'publish' && message.topic === ROBOT_HEARTBEAT_TOPIC) assert.equal(message.msg.data, 1);
    else if (message.op === 'publish' && message.topic === ROBOT_PARRY_TOPIC) assert.ok([0, 1].includes(message.msg.data));
  }

  command(value) {
    const [command, session, round, result] = value.split(' ');
    assert.equal(session, this.status.session);
    assert.equal(Number(round), this.status.round);
    if (command === 'start') {
      assert.equal(this.status.state, 'standby');
      this.startAcceptedAt = performance.now();
      this.broadcast('command_accepted');
      this.later(900, () => {
        this.fightingAt = performance.now();
        this.status.state = 'fighting';
        this.broadcast();
      });
    } else if (command === 'finish') {
      assert.ok(['fighting', 'holding'].includes(this.status.state));
      assert.ok(['0', '1'].includes(result));
      this.status.human_result = Number(result);
      this.broadcast('command_accepted');
      this.later(250, () => { this.status.state = 'stopping'; this.broadcast(); });
      this.later(700, () => {
        this.returningAt = performance.now();
        this.status.state = 'returning';
        this.broadcast();
      });
      // 感想会話（模擬3秒）が終わった後も復帰監視を続けることを確認する。
      this.later(6000, () => {
        this.restoredAt = performance.now();
        this.status.state = 'standby';
        this.status.round++;
        this.status.human_result = null;
        this.broadcast();
      });
    } else if (command === 'abort') {
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
      this.status.state = 'fault';
      this.broadcast('command_accepted');
    } else throw new Error(`不明なROSコマンド: ${value}`);
  }

  broadcast(event = 'state') {
    if (this.state === 'open' && this.subscribed) {
      this.emit('message', { op: 'publish', topic: ROBOT_STATUS_TOPIC, msg: { data: JSON.stringify({ ...this.status, event }) } });
    }
  }
  open() {
    this.state = 'open';
    this.emit('open', {});
    this.interval = setInterval(() => this.broadcast(), 500);
  }
  close() { this.remoteClose(); }
  remoteClose() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearInterval(this.interval);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.emit('close', {});
  }
  later(ms, callback) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (this.state === 'open') callback(); }, ms);
    this.timers.add(timer);
  }
  publications(topic) { return this.wire.filter(({ message }) => message.op === 'publish' && message.topic === topic); }
  isConnecting() { return this.state === 'connecting'; }
  isOpen() { return this.state === 'open'; }
  isClosing() { return false; }
  isClosed() { return this.state === 'closed'; }
}

const pythonRoot = resolve(process.env.CHAMBARA_APP_DIR || '../voice_recognition_and_bgm_app');
const python = process.env.CHAMBARA_PYTHON || 'python';
const reservation = createServer();
await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
const portNumber = reservation.address().port;
await new Promise(done => reservation.close(done));
const child = spawn(python, ['-m', 'chambara_app', '--mock-conversation', '--silent-audio', '--port', String(portNumber)], {
  cwd: pythonRoot,
  env: { ...process.env, PYTHONPATH: resolve(pythonRoot, 'src'), PYTHONUNBUFFERED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '', ready = false, exited = false;
child.on('error', error => { output += String(error); exited = true; });
child.on('exit', () => { exited = true; });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  output = (output + chunk).slice(-8000);
  if (output.includes('待ち受け')) ready = true;
});
const session = new IntegratedSession();
const port = new EspPort();
const serial = new SerialMonitor({ requestPort: async () => port });
const esp = new LegacyEspController(serial, session);
const transports = [];
const ros = new RosMonitor(createRoslibTransportFactory(async url => {
  assert.equal(url, 'ws://robot-test.invalid:9090/');
  const transport = new RobotTransport();
  transports.push(transport);
  // Ros.connectが生成したtransportへリスナーを登録してから開通させる。
  setTimeout(() => { if (transport.isConnecting()) transport.open(); }, 10);
  return transport;
}));
const robot = new RobotBattleController(ros);
const link = new RobotGameLink(robot, session);

async function until(predicate, label, { timeout = 15_000, allowErrors = false } = {}) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    const error = session.getSnapshot().error || esp.getSnapshot().error || robot.getSnapshot().error || link.getSnapshot().error;
    if (!allowErrors && error) throw new Error(error);
    if (exited) throw new Error(`Python終了: ${output}`);
    if (performance.now() > deadline) throw new Error(`待ち時間超過: ${label}`);
    await sleep(10);
  }
}

async function beginBattle() {
  assert.equal(link.beginGame(() => esp.startGame('hard')), true);
  await until(() => session.getSnapshot().phase === 'countdown', '事前会話完了');
  assert.equal(session.getSnapshot().game.roundRemainingMs, 60_000);
  const source = transports.at(-1);
  const startsBefore = source.publications(ROBOT_COMMAND_TOPIC).length;
  link.startBattle();
  assert.equal(source.publications(ROBOT_COMMAND_TOPIC).length, startsBefore + 1);
  assert.equal(link.getSnapshot().waitingForRobot, true);
  assert.equal(session.getSnapshot().phase, 'countdown', '受付通知だけではPython戦闘を始めない');
  assert.equal(session.getSnapshot().game.roundRemainingMs, 60_000);
  await sleep(350);
  assert.equal(source.status.state, 'standby');
  assert.equal(session.getSnapshot().phase, 'countdown');
  assert.equal(session.getSnapshot().game.roundRemainingMs, 60_000, 'ロボットの戦闘開始待ちでは時計を減らさない');
  assert.ok(source.publications(ROBOT_HEARTBEAT_TOPIC).length >= 2);
  await until(() => session.getSnapshot().phase === 'battle', 'fighting確認後のPython戦闘開始');
  assert.equal(robot.getSnapshot().phase, 'fighting');
  assert.ok(source.fightingAt !== null);
  assert.equal(session.getSnapshot().game.difficulty, 'hard');
}

try {
  await until(() => ready, 'Python起動');
  esp.start();
  robot.start();
  link.start();
  await serial.connect(115200);
  session.connect(`ws://127.0.0.1:${portNumber}`);
  ros.connect('ws://robot-test.invalid:9090');
  await until(() => ros.getSnapshot().status === 'connected', 'ROS開通');
  assert.equal(robot.getSnapshot().canStart, false, '保持された状態1件だけでは開始不可');
  await until(() => session.ready && robot.getSnapshot().canStart, 'Python準備と継続するstandby');
  assert.equal(link.setEnabled(true), true);
  await beginBattle();
  const source = transports[0];
  const firstHeartbeat = source.wire.findIndex(({ message }) => message.op === 'publish' && message.topic === ROBOT_HEARTBEAT_TOPIC);
  const firstCommand = source.wire.findIndex(({ message }) => message.op === 'publish' && message.topic === ROBOT_COMMAND_TOPIC);
  assert.ok(firstHeartbeat >= 0 && firstHeartbeat < firstCommand, 'startの前からheartbeatを送る');
  const subscribe = source.wire.find(({ message }) => message.op === 'subscribe' && message.topic === ROBOT_STATUS_TOPIC).message;
  assert.deepEqual(subscribe.qos, { history: 'keep_last', depth: 1, reliability: 'reliable', durability: 'transient_local' });
  for (const { message } of source.wire.filter(({ message }) => message.op === 'advertise')) {
    assert.deepEqual(message.qos, { history: 'keep_last', depth: 10, reliability: 'reliable', durability: 'volatile' });
  }
  console.log('PASS: 継続standby → heartbeat先行 → start受付だけでは待機 → fightingでBGM・時計開始');

  for (let hp = 2; hp >= 0; hp--) {
    await until(() => session.getSnapshot().game.phase === 'defend', '次の受け');
    await until(() => projectRhythm(session.getSnapshot().rhythm, performance.now())?.untilMs > 500, '4拍予定');
    const cue = projectRhythm(session.getSnapshot().rhythm, performance.now());
    await sleep(cue.untilMs);
    port.parry();
    await until(() => session.getSnapshot().game.phase === 'success', '遅れて届くESP成功');
    assert.equal(source.publications(ROBOT_PARRY_TOPIC).filter(({ message }) => message.msg.data === 1).length, 3 - hp);
    await until(() => session.getSnapshot().game.phase === 'attack' && port.weakActive, '弱点A有効化');
    port.hitWeak();
    await until(() => session.getSnapshot().game.hp === hp, '弱点命中');
  }
  assert.equal(session.getSnapshot().game.phase, 'win');
  assert.deepEqual(source.publications(ROBOT_COMMAND_TOPIC).map(({ message }) => message.msg.data), [
    'start robot-test-session 1', 'finish robot-test-session 1 1',
  ]);
  const parries = source.publications(ROBOT_PARRY_TOPIC).map(({ message }) => message.msg.data);
  assert.equal(parries.filter(value => value === 1).length, 3);
  for (let i = 0; i < parries.length; i++) if (parries[i] === 1) {
    assert.equal(parries[i - 1], 0, '各パルスの前に0');
    assert.equal(parries[i + 1], 0, '各パルスの後に0');
  }
  await until(() => source.status.state === 'returning', 'ロボット復帰中');
  const heartbeatCount = source.publications(ROBOT_HEARTBEAT_TOPIC).length;
  await sleep(600);
  assert.ok(source.publications(ROBOT_HEARTBEAT_TOPIC).length >= heartbeatCount + 2);
  assert.equal(robot.getSnapshot().busy, true);
  assert.equal(link.beginGame(() => assert.fail('復帰中の新規ゲームは禁止')), false);
  await until(() => session.getSnapshot().phase === 'complete', '感想会話終了');
  assert.equal(robot.getSnapshot().busy, true, '感想会話終了後もロボット復帰を監視する');
  assert.equal(robot.getSnapshot().heartbeat, true);
  await until(() => robot.getSnapshot().canStart && !link.getSnapshot().active, '次ラウンドのstandby');
  assert.equal(source.status.round, 2);
  const afterReturn = source.publications(ROBOT_HEARTBEAT_TOPIC).length;
  await sleep(600);
  assert.equal(source.publications(ROBOT_HEARTBEAT_TOPIC).length, afterReturn, '復帰完了でheartbeatを止める');
  console.log('PASS: ESP成功3回を各1パルス転送 → 3命中勝利 → finish 1は1回 → 感想後も復帰までheartbeat');

  await beginBattle();
  const sentBeforeDisconnect = source.wire.length;
  source.remoteClose();
  await until(() => session.getSnapshot().phase === 'standby', 'ROS切断によるゲーム中断', { allowErrors: true });
  assert.equal(link.getSnapshot().active, false);
  assert.equal(robot.getSnapshot().heartbeat, false);
  assert.equal(source.wire.length, sentBeforeDisconnect);
  ros.connect('ws://robot-test.invalid:9090');
  await until(() => transports.length === 2 && robot.getSnapshot().canStart, '明示再接続後のstandby', { allowErrors: true });
  await sleep(600);
  assert.equal(transports[1].wire.some(({ message }) => message.op === 'publish'), false, '再接続で旧指示・heartbeat・parryを再送しない');
  assert.equal(session.getSnapshot().phase, 'standby');
  assert.equal(link.getSnapshot().active, false);
  console.log('PASS: 次ゲームのROS切断 → Python・ESPの進行中断 → 再接続しても旧指示を再送しない');
} catch (error) {
  console.error(output);
  console.error('ESP:', esp.getSnapshot().log);
  console.error('Robot:', robot.getSnapshot().logs);
  throw error;
} finally {
  link.stop();
  robot.stop();
  ros.disconnect();
  for (const transport of transports) transport.close();
  esp.stop();
  session.disconnect();
  await serial.disconnect();
  child.kill('SIGINT');
  if (!exited) await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)]);
  if (!exited) child.kill('SIGTERM');
}
