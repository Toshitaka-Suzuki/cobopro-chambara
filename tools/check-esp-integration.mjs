// 実際のPythonサーバー + Web側セッション + 3回受信待ちを持つESPの模擬ポート。
// 音声・衝撃センサそのものの精度は検証しない。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { IntegratedSession } from '../src/integratedSession.ts';
import { LegacyEspController } from '../src/legacyEsp.ts';
import { SerialMonitor } from '../src/serial.ts';
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
child.on('error', error => { output += error; exited = true; });
child.on('exit', () => { exited = true; });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  output = (output + chunk).slice(-8000);
  if (output.includes('待ち受け')) ready = true;
});
const session = new IntegratedSession();
const port = new EspPort();
const monitor = new SerialMonitor({ requestPort: async () => port });
const esp = new LegacyEspController(monitor, session);
async function until(predicate, label, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    const error = session.getSnapshot().error || esp.getSnapshot().error;
    if (error) throw new Error(error);
    if (exited) throw new Error(`Python終了: ${output}`);
    if (performance.now() > deadline) throw new Error(`待ち時間超過: ${label}`);
    await sleep(10);
  }
}
try {
  await until(() => ready, 'Python起動');
  esp.start();
  await monitor.connect(115200);
  session.connect(`ws://127.0.0.1:${portNumber}`);
  await until(() => session.ready, 'Python接続');
  assert.equal(session.getSnapshot().espSupported, true);
  assert.equal(esp.startGame('hard'), true);
  await until(() => session.getSnapshot().phase === 'countdown', '事前会話');
  session.startBattle();
  await until(() => session.getSnapshot().phase === 'battle', '対戦開始');
  await until(() => session.getSnapshot().game.phase === 'miss', '最初の成功無通知を待機後に処理');
  assert.ok(esp.getSnapshot().log.some(x => x.text.includes('通信欠落は区別できません')));
  console.log('PASS: ESP無通知の間は同じ予定を保持 → 待機後に次の機会へ');
  for (let hp = 2; hp >= 0; hp--) {
    await until(() => session.getSnapshot().game.phase === 'defend', '次の受け');
    await until(() => projectRhythm(session.getSnapshot().rhythm, performance.now())?.untilMs > 500, '予告予定');
    const cue = projectRhythm(session.getSnapshot().rhythm, performance.now());
    await sleep(cue.untilMs);
    port.parry();
    await until(() => session.getSnapshot().game.phase === 'success', '300ms遅れのESP成功通知');
    await until(() => session.getSnapshot().game.phase === 'attack', '弱点A');
    assert.equal(session.getSnapshot().game.target, 1);
    assert.ok(session.getSnapshot().game.attackRemainingMs > 9800);
    await until(() => port.weakActive, 'w A受信');
    port.hitWeak();
    await until(() => session.getSnapshot().game.hp === hp, '弱点Aの命中');
  }
  await until(() => session.getSnapshot().phase === 'complete', '終了会話');
  assert.equal(session.getSnapshot().game.phase, 'win');
  assert.ok(port.writes.includes('p 1') && port.writes.includes('p 2') && port.writes.includes('p 0'));
  assert.equal(port.writes.filter(x => x === 'w A').length, 3);
  console.log('PASS: 200ms前倒し＋3回受信確認 → 遅着成功を採用 → A・10秒 → 3命中勝利 → 感想');
} catch (error) {
  console.error(output);
  console.error(esp.getSnapshot().log);
  throw error;
} finally {
  esp.stop();
  session.disconnect();
  await monitor.disconnect();
  child.kill('SIGINT');
  await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)]);
  if (!exited) child.kill('SIGTERM');
}
