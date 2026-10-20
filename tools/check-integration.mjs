// 実際のPythonサーバーと画面で使用するセッションクラスを接続する。
// 会話・音声出力のみ模擬し、JSON・状態遷移・BGM判定エンジンは実装を通す。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { IntegratedSession } from '../src/integratedSession.ts';
import { projectRhythm } from '../src/rhythm.ts';

const pythonRoot = resolve(process.env.CHAMBARA_APP_DIR || '../voice_recognition_and_bgm_app');
const python = process.env.CHAMBARA_PYTHON || 'python';
const reservation = createServer();
await new Promise((done, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', done);
});
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
const child = spawn(python, ['-m', 'chambara_app', '--mock-conversation', '--silent-audio', '--port', String(port)], {
  cwd: pythonRoot,
  env: { ...process.env, PYTHONPATH: resolve(pythonRoot, 'src'), PYTHONUNBUFFERED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let ready = false;
let exited = false;
child.on('error', error => { output += String(error); exited = true; });
child.on('exit', () => { exited = true; });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  output = (output + chunk).slice(-8000);
  if (output.includes('待ち受け')) ready = true;
});
const session = new IntegratedSession();
async function until(predicate, label, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (session.getSnapshot().error) throw new Error(session.getSnapshot().error);
    if (exited) throw new Error(`Pythonサーバー終了: ${output}`);
    if (performance.now() > deadline) throw new Error(`待ち時間超過: ${label}`);
    await sleep(15);
  }
}
async function beginBattle() {
  assert.equal(session.start(), true);
  await until(() => session.getSnapshot().phase === 'countdown', '戦闘前会話の完了');
  assert.equal(session.getSnapshot().game.roundRemainingMs, 60_000);
  session.startBattle();
  await until(() => session.getSnapshot().phase === 'battle', '戦闘開始の完了通知');
}
try {
  await until(() => ready, 'Python起動');
  session.connect(`ws://127.0.0.1:${port}`);
  await until(() => session.ready, '接続とstandby');
  assert.equal(session.getSnapshot().conversationMode, 'mock_silent');
  assert.equal(session.getSnapshot().rhythmSupported, true);
  await beginBattle();
  await until(() => projectRhythm(session.getSnapshot().rhythm, performance.now())?.untilMs > 500, '予告の受信');
  session.action({ type: 'swordClash' });
  await until(() => !session.getSnapshot().pendingParry, '早い入力の判定');
  assert.equal(session.getSnapshot().parryFeedback?.timing, 'early');
  assert.equal(session.getSnapshot().game.phase, 'miss');
  console.log('PASS: 実際の音声時計を同期 → 予告中の入力は「早い」');
  for (let count = 2; count >= 0; count--) {
    let succeeded = false;
    for (let attempt = 0; attempt < 8 && !succeeded; attempt++) {
      await until(() => session.getSnapshot().game.phase === 'defend', '次の受け');
      await until(() => projectRhythm(session.getSnapshot().rhythm, performance.now())?.untilMs > 200, '次の4拍の同期');
      const cue = projectRhythm(session.getSnapshot().rhythm, performance.now());
      await sleep(Math.max(0, cue.untilMs));
      session.action({ type: 'swordClash' });
      await until(() => !session.getSnapshot().pendingParry, 'パリイ結果');
      succeeded = session.getSnapshot().game.phase === 'success';
    }
    assert.equal(succeeded, true, 'BGMの有効区間で受け成功');
    assert.equal(session.getSnapshot().parryFeedback?.timing, 'on_time');
    await until(() => session.getSnapshot().game.phase === 'attack', '弱点点灯');
    session.action({ type: 'hit', target: session.getSnapshot().game.target });
    assert.equal(session.getSnapshot().game.hp, count);
  }
  await until(() => session.getSnapshot().phase === 'complete', '勝利後の感想とstandby');
  assert.equal(session.getSnapshot().game.phase, 'win');
  console.log('PASS: 会話 → 3段階のパリイと命中 → 勝利 → 感想 → 待機');

  await beginBattle();
  session.action({ type: 'balloon' });
  await until(() => session.getSnapshot().phase === 'complete', '敗北後の感想とstandby');
  assert.equal(session.getSnapshot().game.phase, 'lose');
  console.log('PASS: 連続ゲーム → 紙風船破損 → 感想 → 待機');

  session.start();
  await until(() => session.getSnapshot().phase === 'pre_interview', '会話開始');
  session.cancel();
  await until(() => session.getSnapshot().phase === 'standby', '会話中断');
  await sleep(100);
  assert.equal(session.getSnapshot().phase, 'standby');
  console.log('PASS: 会話中断 → 遅い会話完了を破棄 → 待機');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  session.disconnect();
  child.kill('SIGINT');
  await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)]);
  if (!exited) child.kill('SIGTERM');
}
