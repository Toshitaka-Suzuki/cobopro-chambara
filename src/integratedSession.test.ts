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

function fixture(mode: 'live' | 'mock' | 'mock_silent' = 'mock') {
  const sockets: Socket[] = [];
  let now = 0;
  const session = new IntegratedSession({
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    now: () => now, random: () => 0.5, autoTick: false,
  });
  session.connect('ws://localhost:8765');
  const socket = sockets[0];
  socket.receive({ type: 'connected', protocol_version: 2, conversation_mode: mode });
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

function interviewFixture() {
  const context = fixture('live');
  context.session.start();
  context.socket.ack();
  context.socket.status('pre_interview');
  return context;
}

function progress(socket: Socket, event: Record<string, unknown>) {
  socket.receive({ type: 'conversation_progress', phase: 'strategy', ...event });
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

test('会話の質問・聞き取り・返答を保持し、重複通知で発言や経過時刻を増やさない', () => {
  const { session, socket, advance } = interviewFixture();
  progress(socket, { stage: 'question', text: 'どんな作戦で挑む？' });
  assert.deepEqual(session.getSnapshot().conversation, {
    phase: 'strategy', stage: 'question', startedAt: 0,
    messages: [{ id: 1, role: 'assistant', text: 'どんな作戦で挑む？' }],
  });
  progress(socket, { stage: 'preparing' });
  advance(100);
  progress(socket, { stage: 'listening' });
  assert.equal(session.getSnapshot().conversation?.startedAt, 100);
  advance(200);
  progress(socket, { stage: 'recognizing' });
  progress(socket, { stage: 'thinking', text: '頑張ります' });
  const thinking = session.getSnapshot().conversation;
  advance(300);
  progress(socket, { stage: 'thinking', text: '頑張ります' });
  assert.equal(session.getSnapshot().conversation, thinking);
  assert.equal(session.getSnapshot().conversation?.startedAt, 300);
  progress(socket, { stage: 'thinking', text: '落ち着いて頑張ります' });
  assert.equal(session.getSnapshot().conversation?.startedAt, 600);
  progress(socket, { stage: 'speaking', text: 'その意気でござる！' });
  assert.deepEqual(session.getSnapshot().conversation?.messages.map(({ role, text }) => ({ role, text })), [
    { role: 'assistant', text: 'どんな作戦で挑む？' },
    { role: 'user', text: '頑張ります' },
    { role: 'user', text: '落ち着いて頑張ります' },
    { role: 'assistant', text: 'その意気でござる！' },
  ]);
  assert.equal(session.getSnapshot().phase, 'pre_interview');
  assert.equal(session.getSnapshot().game.roundRemainingMs, 60_000);
});

test('会話の再試行は接続を保ち、直前の発言を残して次の聞き取りへ進む', () => {
  const { session, socket, advance } = interviewFixture();
  progress(socket, { stage: 'question', text: '意気込みを聞かせて！' });
  progress(socket, { stage: 'retry', reason: 'no_speech' });
  assert.equal(session.getSnapshot().conversation?.reason, 'no_speech');
  assert.equal(session.getSnapshot().conversation?.messages.length, 1);
  progress(socket, { stage: 'listening' });
  assert.equal(session.getSnapshot().conversation?.reason, undefined);
  progress(socket, { stage: 'thinking', text: '頑張ります' });
  progress(socket, { stage: 'retry', reason: 'reply_failed' });
  advance(100);
  progress(socket, { stage: 'listening' });
  progress(socket, { stage: 'thinking', text: ' 頑張ります ' });
  assert.equal(session.getSnapshot().conversation?.startedAt, 100);
  assert.equal(session.getSnapshot().conversation?.messages.length, 2);
  assert.equal(session.getSnapshot().connection, 'connected');
  assert.equal(session.getSnapshot().error, '');
  assert.equal(socket.closed, false);
});

test('不正な会話進捗・本文・理由は現在の表示と接続に影響しない', () => {
  const { session, socket } = interviewFixture();
  progress(socket, { stage: 'question', text: '質問です' });
  const baseline = session.getSnapshot().conversation;
  const invalid = [
    { stage: 'unknown' }, { stage: null }, { stage: ['listening'] },
    { stage: 'question' }, { stage: 'speaking' }, { stage: 'thinking' },
    { stage: 'thinking', text: '' }, { stage: 'thinking', text: '   ' },
    { stage: 'thinking', text: 3 }, { stage: 'thinking', text: null },
    { stage: 'thinking', text: ['頑張る'] }, { stage: 'thinking', text: 'あ'.repeat(4_001) },
    { stage: 'listening', text: { value: 'hello' } },
    { stage: 'retry', reason: 'unexpected' }, { stage: 'retry', reason: null },
    { stage: 'retry', reason: ['no_speech'] }, { stage: 'listening', reason: 'no_speech' },
    { phase: null, stage: 'listening' }, { phase: ['strategy'], stage: 'listening' },
  ];
  for (const event of invalid) {
    progress(socket, event);
    assert.equal(session.getSnapshot().conversation, baseline, JSON.stringify(event));
  }
  assert.equal(session.getSnapshot().connection, 'connected');
  assert.equal(session.getSnapshot().error, '');
});

test('別フェーズやスキップ後の会話進捗を反映しない', () => {
  const { session, socket } = interviewFixture();
  progress(socket, { phase: 'feedback', stage: 'question', text: '感想は？' });
  assert.equal(session.getSnapshot().conversation, null);
  progress(socket, { stage: 'thinking', text: '頑張る' });
  session.skipInterview();
  assert.equal(session.getSnapshot().conversation, null);
  progress(socket, { stage: 'speaking', text: '遅れて届いた返答' });
  assert.equal(session.getSnapshot().conversation, null);
  session.startBattle();
  socket.ack();
  socket.status('battle_started');
  session.action({ type: 'balloon' });
  socket.ack();
  socket.status('post_interview');
  progress(socket, { stage: 'question', text: '古い作戦質問' });
  assert.equal(session.getSnapshot().conversation, null);
  progress(socket, { phase: 'feedback', stage: 'question', text: '感想は？' });
  assert.equal(session.getSnapshot().conversation?.phase, 'feedback');
});

test('会話中断と切断で発言を消し、古い接続の進捗を新しい会話へ持ち越さない', () => {
  const { session, socket, sockets } = interviewFixture();
  progress(socket, { stage: 'question', text: '質問です' });
  session.cancel();
  assert.equal(session.getSnapshot().conversation, null);
  progress(socket, { stage: 'speaking', text: '遅れた返答' });
  assert.equal(session.getSnapshot().conversation, null);
  socket.ack();
  socket.status('standby');
  session.start();
  socket.ack();
  socket.status('pre_interview');
  progress(socket, { stage: 'question', text: '次の質問です' });
  assert.equal(session.getSnapshot().conversation?.messages.length, 1);
  const late = socket.onmessage!;
  session.connect('ws://localhost:8765');
  assert.equal(session.getSnapshot().conversation, null);
  const replacement = sockets[1];
  replacement.receive({ type: 'connected', protocol_version: 2, conversation_mode: 'live' });
  replacement.status('standby');
  session.start();
  replacement.ack();
  replacement.status('pre_interview');
  late.call(socket as unknown as WebSocket, { data: JSON.stringify({
    type: 'conversation_progress', phase: 'strategy', stage: 'thinking', text: '以前の参加者',
  }) } as MessageEvent);
  assert.equal(session.getSnapshot().conversation, null);
});

test('感想の返答は完了画面に残り、次のゲーム開始で消える', () => {
  const { session, socket, battle } = fixture('live');
  battle();
  session.action({ type: 'balloon' });
  socket.ack();
  socket.status('post_interview');
  progress(socket, { phase: 'feedback', stage: 'question', text: 'どうだった？' });
  progress(socket, { phase: 'feedback', stage: 'thinking', text: '楽しかった' });
  progress(socket, { phase: 'feedback', stage: 'speaking', text: 'また挑戦してくだされ！' });
  const conversation = session.getSnapshot().conversation;
  socket.status('post_interview_finished');
  socket.status('standby');
  assert.equal(session.getSnapshot().phase, 'complete');
  assert.equal(session.getSnapshot().conversation, conversation);
  progress(socket, { phase: 'feedback', stage: 'retry', reason: 'reply_failed' });
  assert.equal(session.getSnapshot().conversation, conversation);
  assert.equal(session.start(), true);
  assert.equal(session.getSnapshot().conversation, null);
});

test('会話履歴は直近12件だけ保持し、各発言を安定したIDで区別する', () => {
  const { session, socket } = interviewFixture();
  for (let i = 0; i < 10; i++) {
    progress(socket, { stage: 'thinking', text: `発言${i}` });
    progress(socket, { stage: 'speaking', text: `返答${i}` });
  }
  const messages = session.getSnapshot().conversation!.messages;
  assert.equal(messages.length, 12);
  assert.equal(messages[0].text, '発言4');
  assert.equal(messages.at(-1)?.text, '返答9');
  assert.equal(new Set(messages.map(message => message.id)).size, 12);
  const lastId = messages.at(-1)!.id;
  progress(socket, { stage: 'speaking', text: '返答9' });
  assert.equal(session.getSnapshot().conversation?.messages, messages);
  progress(socket, { stage: 'thinking', text: '次の発言' });
  assert.equal(session.getSnapshot().conversation?.messages.at(-1)?.id, lastId + 1);
});

test('接続確認前・模擬会話では進捗を表示せず、未対応の従来サーバーでも進行できる', () => {
  const { session, socket, sockets } = fixture('live');
  assert.equal(session.getSnapshot().conversation, null);
  session.start();
  socket.ack();
  socket.status('pre_interview');
  assert.equal(session.getSnapshot().conversation, null);
  socket.status('pre_interview_finished');
  assert.equal(session.getSnapshot().phase, 'countdown');
  session.connect('ws://localhost:8765');
  progress(sockets[1], { stage: 'question', text: '接続前の質問' });
  assert.equal(session.getSnapshot().conversation, null);
  assert.equal(session.getSnapshot().connection, 'connecting');
  for (const mode of ['mock', 'mock_silent'] as const) {
    const mock = fixture(mode);
    mock.session.start();
    mock.socket.ack();
    mock.socket.status('pre_interview');
    progress(mock.socket, { stage: 'question', text: '模擬質問' });
    assert.equal(mock.session.getSnapshot().conversation, null);
  }
});
