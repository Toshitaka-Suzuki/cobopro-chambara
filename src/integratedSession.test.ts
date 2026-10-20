import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegratedSession, appUrlError } from './integratedSession.ts';
import type { AppSocket } from './integratedSession.ts';

class Socket implements AppSocket {
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;
  sent: { name: string; request_id: string; count?: number }[] = [];
  closed = false;
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed = true; }
  receive(value: object) { this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent); }
  status(value: string) { this.receive({ type: 'status', value }); }
  ack() {
    const item = this.sent.at(-1)!;
    this.receive({ ...item, type: 'received' });
    return item;
  }
}

function fixture() {
  const sockets: Socket[] = [];
  let now = 0;
  const session = new IntegratedSession({
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    now: () => now, random: () => 0.5, autoTick: false,
  });
  session.connect('ws://localhost:8765');
  const socket = sockets[0];
  socket.receive({ type: 'connected', protocol_version: 2, conversation_mode: 'mock' });
  socket.status('standby');
  const advance = (ms: number) => { now += ms; session.tick(); };
  const battle = () => {
    assert.equal(session.start(), true);
    socket.ack();
    socket.status('pre_interview');
    socket.status('pre_interview_finished');
    session.startBattle();
    socket.ack();
    socket.status('battle_started');
  };
  return { session, socket, sockets, advance, battle };
}

test('会話・カウントダウン・BGM開始確認中はゲームの時計を進めない', () => {
  const { session, socket, advance } = fixture();
  session.start();
  socket.ack();
  socket.status('pre_interview');
  advance(4_000);
  assert.equal(session.getSnapshot().game.roundRemainingMs, 60_000);
  socket.status('pre_interview_finished');
  session.startBattle();
  socket.ack();
  advance(2_000);
  socket.ack(); // heartbeat
  assert.equal(session.getSnapshot().phase, 'starting_battle');
  socket.status('battle_started');
  advance(100);
  assert.equal(session.getSnapshot().game.roundRemainingMs, 59_900);
});

test('接触は成功とせず、対応するパリイ結果を一度だけ適用する', () => {
  const { session, socket, battle } = fixture();
  battle();
  session.action({ type: 'contact' });
  const request = socket.ack();
  session.action({ type: 'contact' });
  assert.equal(socket.sent.filter(x => x.name === 'parry').length, 1);
  assert.equal(session.getSnapshot().game.phase, 'defend');
  socket.receive({ type: 'parry_result', request_id: 'old', value: 'success' });
  assert.equal(session.getSnapshot().game.phase, 'defend');
  socket.receive({ type: 'parry_result', request_id: request.request_id, value: 'success' });
  assert.equal(session.getSnapshot().game.phase, 'success');
  socket.receive({ type: 'parry_result', request_id: request.request_id, value: 'success' });
  assert.equal(session.getSnapshot().game.hp, 3);
});

test('パリイ失敗と音声準備中を区別し、いずれも攻撃を開始しない', () => {
  const { session, socket, battle } = fixture();
  battle();
  session.action({ type: 'swordClash' });
  let request = socket.ack();
  socket.receive({ type: 'parry_result', request_id: request.request_id, value: 'failure', reason: 'not_ready' });
  assert.equal(session.getSnapshot().game.phase, 'defend');
  assert.match(session.getSnapshot().game.notice, /準備中/);
  session.action({ type: 'swordClash' });
  request = socket.ack();
  socket.receive({ type: 'parry_result', request_id: request.request_id, value: 'failure' });
  assert.equal(session.getSnapshot().game.phase, 'miss');
});

test('3回命中で残数2・1・0を送り、終了会話とstandbyまで次の開始を許可しない', () => {
  const { session, socket, advance, battle } = fixture();
  battle();
  for (let remaining = 2; remaining >= 0; remaining--) {
    session.action({ type: 'contact' });
    const request = socket.ack();
    socket.receive({ type: 'parry_result', request_id: request.request_id, value: 'success' });
    advance(900);
    session.action({ type: 'contact' });
    assert.equal(socket.sent.at(-1)?.count, remaining);
    socket.ack();
    if (remaining) {
      advance(2400);
      if (socket.sent.at(-1)?.name === 'heartbeat') socket.ack();
    }
  }
  assert.equal(session.getSnapshot().game.phase, 'win');
  assert.equal(session.getSnapshot().phase, 'ending');
  assert.deepEqual(socket.sent.filter(x => x.name === 'weak_point_count').map(x => x.count), [2, 1, 0]);
  assert.equal(socket.sent.some(x => x.name === 'battle_end'), false);
  socket.status('post_interview');
  assert.equal(session.start(), false);
  socket.status('post_interview_finished');
  assert.equal(session.start(), false);
  socket.status('standby');
  assert.equal(session.getSnapshot().phase, 'complete');
  assert.equal(session.start(), true);
});

test('紙風船の破損はbattle_endを一度送り、結果後の入力は無視する', () => {
  const { session, socket, battle } = fixture();
  battle();
  session.action({ type: 'balloon' });
  session.action({ type: 'balloon' });
  assert.equal(session.getSnapshot().game.phase, 'lose');
  assert.equal(socket.sent.filter(x => x.name === 'battle_end').length, 1);
});

test('判定待ち中に時間切れになっても遅い成功結果を反映しない', () => {
  const { session, socket, advance, battle } = fixture();
  battle();
  for (let i = 0; i < 11; i++) { advance(5_000); socket.ack(); }
  session.action({ type: 'swordClash' });
  const request = socket.ack();
  advance(5_000);
  socket.receive({ type: 'parry_result', request_id: request.request_id, value: 'success' });
  assert.equal(session.getSnapshot().game.phase, 'timeup');
  assert.equal(socket.sent.filter(x => x.name === 'battle_end').length, 1);
});

test('手動失敗で場面を離れたパリイ結果を次の受けに使わない', () => {
  const { session, socket, advance, battle } = fixture();
  battle();
  session.action({ type: 'contact' });
  const request = socket.ack();
  session.action({ type: 'miss' });
  advance(2400);
  socket.receive({ type: 'parry_result', request_id: request.request_id, value: 'success' });
  assert.equal(session.getSnapshot().game.phase, 'defend');
});

test('中断は会話完了と判定の遅着を無視し、standby確認後に再開始する', () => {
  const { session, socket, battle } = fixture();
  battle();
  session.action({ type: 'contact' });
  const request = socket.ack();
  session.cancel('センサ切断');
  session.cancel('重複した中断');
  assert.equal(socket.sent.at(-1)?.name, 'game_cancel');
  assert.equal(socket.sent.filter(x => x.name === 'game_cancel').length, 1);
  assert.equal(session.start(), false);
  socket.status('pre_interview_finished');
  socket.receive({ type: 'parry_result', request_id: request.request_id, value: 'success' });
  assert.equal(session.getSnapshot().phase, 'cancelling');
  socket.status('standby');
  assert.equal(session.ready, true);
  assert.equal(session.getSnapshot().error, 'センサ切断');
  session.start();
  assert.equal(session.getSnapshot().game.hp, 3);
  assert.equal(session.getSnapshot().error, '');
});

test('切断・再接続では進行と未送信要求を引き継がず、古い接続の応答を無視する', () => {
  const { session, socket, sockets, battle } = fixture();
  battle();
  const late = socket.onmessage!;
  session.disconnect();
  session.connect('ws://localhost:8765');
  late.call(socket as unknown as WebSocket, { data: JSON.stringify({ type: 'status', value: 'battle_started' }) } as MessageEvent);
  assert.equal(socket.closed, true);
  assert.equal(sockets[1].sent.length, 0);
  assert.equal(session.getSnapshot().phase, 'standby');
  assert.equal(session.getSnapshot().connection, 'connecting');
});

test('受領通知だけで結果が来ないパリイはタイムアウトで接続を閉じる', () => {
  const { session, socket, battle, advance } = fixture();
  battle();
  session.action({ type: 'contact' });
  socket.ack();
  advance(10_000);
  assert.equal(session.getSnapshot().connection, 'disconnected');
  assert.equal(socket.closed, true);
  assert.match(session.getSnapshot().error, /応答/);
});

test('古い統合アプリ・不正JSON・不正URLを表示し、開始を許可しない', () => {
  const { session, sockets } = fixture();
  session.connect('ws://localhost:8765');
  sockets[1].receive({ type: 'connected' });
  assert.match(session.getSnapshot().error, /v2/);
  assert.equal(session.start(), false);
  session.connect('ws://localhost:8765');
  sockets[2].onmessage!.call(sockets[2] as unknown as WebSocket, { data: '{' } as MessageEvent);
  assert.match(session.getSnapshot().error, /不正/);
  assert.ok(appUrlError('http://localhost:8765'));
  assert.ok(appUrlError('ws://localhost:8765', true));
  assert.ok(appUrlError('ws://name:secret@host'));
  assert.equal(appUrlError('wss://example.test/app', true), null);
});

test('開始前会話のスキップでも、カウントダウンとBGM開始確認を経る', () => {
  const { session, socket } = fixture();
  session.start();
  socket.ack();
  socket.status('pre_interview');
  session.skipInterview();
  assert.equal(session.getSnapshot().phase, 'countdown');
  session.startBattle();
  socket.status('pre_interview_finished');
  assert.equal(session.getSnapshot().phase, 'starting_battle');
  socket.status('battle_started');
  assert.equal(session.getSnapshot().phase, 'battle');
});

test('音楽同期を対応サーバーだけに要求し、早い判定と次の4拍への再準備を伝える', () => {
  const { session, socket, battle, advance } = fixture();
  socket.receive({ type: 'connected', protocol_version: 2, rhythm_guide: true });
  battle();
  advance(50);
  const sync = socket.sent.at(-1)!;
  assert.equal(sync.name, 'rhythm_sync');
  socket.receive({ type: 'rhythm_state', request_id: sync.request_id, ready: true,
    active: true, generation: 1, stage: 'easy', position_ms: 50,
    beats_ms: [0, 500, 1000, 1500], window_ms: 300 });
  assert.equal(session.getSnapshot().rhythm?.positionMs, 50);
  session.action({ type: 'swordClash' });
  const parry = socket.sent.at(-1)!;
  socket.receive({ type: 'parry_result', request_id: parry.request_id, value: 'failure',
    timing: 'early', delta_ms: -1450 });
  assert.equal(session.getSnapshot().game.phase, 'miss');
  assert.deepEqual(session.getSnapshot().parryFeedback, { timing: 'early', deltaMs: -1450 });
  assert.equal(socket.sent.at(-1)?.name, 'defense_pause');
  socket.ack();
  assert.equal(session.getSnapshot().rhythm, null);
  advance(2400);
  assert.ok(socket.sent.some(s => s.name === 'defense_ready'));
  assert.equal(session.getSnapshot().parryFeedback, null);
  session.cancel();
  socket.receive({ type: 'rhythm_state', request_id: sync.request_id, ...{ ready: true, active: true } });
  assert.equal(session.getSnapshot().rhythm, null);
});

test('命中による曲の変更後は古い同期応答を表示しない', () => {
  const { session, socket, battle, advance } = fixture();
  socket.receive({ type: 'connected', protocol_version: 2, rhythm_guide: true });
  battle();
  session.action({ type: 'swordClash' });
  const parry = socket.sent.at(-1)!;
  socket.receive({ type: 'parry_result', request_id: parry.request_id, value: 'success', timing: 'on_time', delta_ms: 12 });
  socket.ack();
  advance(900);
  const sync = socket.sent.at(-1)!;
  assert.equal(sync.name, 'rhythm_sync');
  session.action({ type: 'hit', target: session.getSnapshot().game.target! });
  socket.receive({ type: 'rhythm_state', request_id: sync.request_id, ready: true, active: true,
    generation: 1, stage: 'easy', position_ms: 1000, beats_ms: [0, 500, 1000, 1500], window_ms: 300 });
  assert.equal(session.getSnapshot().rhythm, null);
  assert.equal(session.getSnapshot().game.hp, 2);
});
