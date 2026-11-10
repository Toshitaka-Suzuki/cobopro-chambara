import assert from 'node:assert/strict';
import test from 'node:test';
import { IntegratedSession } from './integratedSession.ts';
import type { AppSocket } from './integratedSession.ts';
import type { RobotBattleSnapshot } from './robotBattle.ts';
import { RobotGameLink } from './robotGameLink.ts';

class Socket implements AppSocket {
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;
  sent: { name: string; request_id: string; count?: number }[] = [];
  send(raw: string) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    this.receive({ ...message, type: 'received' });
  }
  close() {}
  receive(value: object) { this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent); }
  status(value: string) { this.receive({ type: 'status', value }); }
}

class Robot {
  snapshot: RobotBattleSnapshot = {
    connection: 'connected', online: true, phase: 'idle', busy: false, canStart: true,
    heartbeat: false, error: '', logs: [],
    status: { type: 'status', session: 'robot-session', round: 1, state: 'standby', human_result: null, event: 'state' },
  };
  calls: string[] = [];
  listeners = new Set<() => void>();
  resolveStart: (() => void) | null = null;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  change(changes: Partial<RobotBattleSnapshot>) {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
  startBattle = () => {
    this.calls.push('start');
    this.change({ phase: 'starting', busy: true, canStart: false, heartbeat: true });
    return new Promise<void>(resolve => { this.resolveStart = resolve; });
  };
  fighting() {
    this.change({ phase: 'fighting', status: { ...this.snapshot.status!, state: 'fighting' } });
    this.resolveStart?.();
  }
  finish = (win: boolean) => {
    this.calls.push(`finish ${win ? 1 : 0}`);
    this.change({ phase: 'finishing', busy: true });
    return true;
  };
  abort = () => {
    this.calls.push('abort');
    this.change({ phase: 'fault', busy: false, canStart: false, heartbeat: false, error: '中断' });
  };
  parry = () => { this.calls.push('parry'); return true; };
  returned() { this.change({ phase: 'idle', busy: false, canStart: true, heartbeat: false,
    status: { ...this.snapshot.status!, state: 'standby', round: 2 } }); }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  let now = 0;
  const socket = new Socket();
  const session = new IntegratedSession({ socketFactory: () => socket, now: () => now, autoTick: false });
  const robot = new Robot();
  const link = new RobotGameLink(robot, session);
  link.start();
  session.connect('ws://localhost:8765');
  socket.receive({ type: 'connected', protocol_version: 3, conversation_mode: 'mock', esp_legacy: true, rhythm_guide: true });
  socket.status('standby');
  const begin = () => {
    link.setEnabled(true);
    assert.equal(link.beginGame(() => session.start('easy', 'esp_legacy')), true);
    socket.status('pre_interview');
    socket.status('pre_interview_finished');
  };
  const battle = async () => {
    begin(); link.startBattle(); robot.fighting(); await flush(); socket.status('battle_started');
  };
  const advance = (ms: number) => { now += ms; session.tick(); };
  const post = () => { socket.status('post_interview'); socket.status('post_interview_finished'); socket.status('standby'); };
  return { session, socket, robot, link, begin, battle, advance, post };
}

test('連動OFFでは従来のゲームを開始し、ロボットへ何も送らない', () => {
  const f = fixture();
  assert.equal(f.link.beginGame(() => f.session.start()), true);
  f.socket.status('pre_interview'); f.socket.status('pre_interview_finished');
  f.link.startBattle(); f.socket.status('battle_started');
  f.session.action({ type: 'balloon' });
  assert.equal(f.session.getSnapshot().game.phase, 'lose');
  assert.deepEqual(f.robot.calls, []);
});

test('会話中は動作指示なし、fighting確認後にだけBGM開始を要求する', async () => {
  const f = fixture(); f.begin();
  assert.deepEqual(f.robot.calls, []);
  f.link.startBattle(); f.link.startBattle();
  assert.deepEqual(f.robot.calls, ['start']);
  assert.equal(f.link.getSnapshot().waitingForRobot, true);
  assert.equal(f.socket.sent.some(m => m.name === 'battle_start'), false);
  f.advance(1000);
  assert.equal(f.session.getSnapshot().game.roundRemainingMs, 60_000);
  assert.equal(f.link.setEnabled(false), false);
  f.robot.fighting(); await flush();
  assert.equal(f.socket.sent.filter(m => m.name === 'battle_start').length, 1);
  assert.equal(f.link.getSnapshot().waitingForRobot, false);
});

test('ESP成功を1回ずつ送り、勝利後もロボット復帰まで次を開始しない', async () => {
  const f = fixture(); await f.battle();
  for (let hp = 2; hp >= 0; hp--) {
    f.session.espParrySuccess(); f.session.espParrySuccess();
    f.advance(900); f.session.espWeakHit(); f.session.espWeakHit();
    assert.equal(f.session.getSnapshot().game.hp, hp);
    if (hp) f.advance(2400);
  }
  assert.equal(f.robot.calls.filter(x => x === 'parry').length, 3);
  assert.deepEqual(f.robot.calls.filter(x => x.startsWith('finish')), ['finish 1']);
  f.post();
  assert.equal(f.link.getSnapshot().active, true);
  assert.equal(f.link.beginGame(() => f.session.start()), false);
  f.robot.returned();
  assert.equal(f.link.getSnapshot().active, false);
  assert.equal(f.link.setEnabled(false), true);
});

test('紙風船破損と時間切れは正常終了の人間敗北を送る', async () => {
  for (const ending of ['balloon', 'timeup']) {
    const f = fixture(); await f.battle();
    if (ending === 'balloon') f.session.action({ type: 'balloon' });
    else f.advance(60_000);
    assert.equal(f.robot.calls.filter(x => x === 'finish 0').length, 1);
    assert.equal(f.robot.calls.includes('abort'), false);
  }
});

test('会話中に接続やsessionが変われば開始せず、別ゲームへabortしない', () => {
  for (const change of ['offline', 'session']) {
    const f = fixture(); f.begin();
    if (change === 'offline') f.robot.change({ online: false, canStart: false });
    else f.robot.change({ status: { ...f.robot.snapshot.status!, session: 'different' } });
    f.link.startBattle();
    assert.equal(f.session.getSnapshot().phase, 'cancelling');
    assert.deepEqual(f.robot.calls, []);
  }
});

test('開始待ちで中断した後のfightingではBGMを開始しない', async () => {
  const f = fixture(); f.begin(); f.link.startBattle();
  f.session.cancel();
  assert.deepEqual(f.robot.calls, ['start', 'abort']);
  f.robot.fighting(); await flush();
  assert.equal(f.socket.sent.some(m => m.name === 'battle_start'), false);
  assert.equal(f.link.getSnapshot().active, false);
});

test('戦闘中のPython切断を中断し、正常終了後の切断では復帰を妨げない', async () => {
  const f = fixture(); await f.battle();
  f.session.disconnect();
  assert.equal(f.robot.calls.at(-1), 'abort');
  const g = fixture(); await g.battle();
  g.session.action({ type: 'balloon' });
  g.session.disconnect();
  assert.equal(g.robot.calls.at(-1), 'finish 0');
  assert.equal(g.robot.snapshot.heartbeat, true);
  g.robot.returned();
  assert.equal(g.link.getSnapshot().active, false);
});

test('ロボット異常でゲームを中断し、ESP以外での連動開始を拒否する', async () => {
  const f = fixture(); await f.battle();
  f.robot.change({ phase: 'fault', online: false, busy: false, canStart: false, error: '状態途絶' });
  assert.equal(f.session.getSnapshot().phase, 'cancelling');
  assert.match(f.link.getSnapshot().error, /状態途絶/);
  const g = fixture(); g.link.setEnabled(true);
  assert.equal(g.link.beginGame(() => g.session.start()), false);
  assert.deepEqual(g.robot.calls, []);
});

test('復帰を確認済みなら、その後のROS切断で感想会話を中断しない', async () => {
  const f = fixture(); await f.battle();
  f.session.action({ type: 'balloon' });
  f.socket.status('post_interview');
  f.robot.returned();
  assert.equal(f.link.getSnapshot().active, false);
  f.robot.change({ online: false, connection: 'disconnected', canStart: false });
  assert.equal(f.session.getSnapshot().phase, 'post_interview');
  assert.equal(f.link.beginGame(() => f.session.start()), false);
});
