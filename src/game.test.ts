import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { initialGame, transition } from './game.ts';
import type { Game, Target } from './game.ts';

function attack(game: Game, target: Target = 1) {
  game = transition(game, { type: 'cue' });
  game = transition(game, { type: 'success' });
  return transition(game, { type: 'open', target });
}

test('受け成功と命中は別。3回の有効命中で勝利する', () => {
  let game = transition(initialGame, { type: 'start' });
  for (let hp = 3; hp > 0; hp--) {
    game = attack(game);
    assert.equal(game.hp, hp);
    game = transition(game, { type: 'hit', target: 1 });
    assert.equal(game.hp, hp - 1);
    const once = game;
    game = transition(game, { type: 'hit', target: 1 });
    assert.equal(game, once);
  }
  assert.equal(game.phase, 'win');
});
test('暗い弱点と時間外の命中ではHPが減らない', () => {
  let game = attack(transition(initialGame, { type: 'start' }), 2);
  game = transition(game, { type: 'hit', target: 0 });
  assert.equal(game.hp, 3);
  assert.equal(game.target, 2);
  game = transition(game, { type: 'tick', elapsed: 8000 });
  game = transition(game, { type: 'hit', target: 2 });
  assert.equal(game.hp, 3);
  assert.equal(game.phase, 'miss');
});
test('一時停止中はタイマーと命中を受け付けない', () => {
  let game = attack(transition(initialGame, { type: 'start' }));
  game = transition(game, { type: 'pause' });
  const paused = game;
  assert.equal(transition(game, { type: 'tick', elapsed: 10000 }), paused);
  assert.equal(transition(game, { type: 'hit', target: 1 }), paused);
  game = transition(game, { type: 'resume' });
  assert.equal(game.remainingMs, 8000);
  assert.equal(transition(game, { type: 'hit', target: 1 }).hp, 2);
});
test('受け失敗・判定不可は敗北と区別し、紙風船の破損で敗北する', () => {
  let game = transition(transition(initialGame, { type: 'start' }), { type: 'cue' });
  assert.equal(transition(game, { type: 'miss' }).phase, 'miss');
  game = transition(game, { type: 'unknown' });
  assert.equal(game.hp, 3);
  assert.equal(game.phase, 'unknown');
  assert.equal(transition(game, { type: 'success' }), game);
  assert.equal(transition(game, { type: 'balloon' }).phase, 'lose');
});
test('ダメージ後に難易度が上がり、時間切れだけでは上がらない', () => {
  let game = attack(transition(initialGame, { type: 'start' }));
  assert.equal(game.remainingMs, 8000);
  game = transition(game, { type: 'expire' });
  game = attack(game);
  assert.equal(game.remainingMs, 8000);
  game = transition(game, { type: 'hit', target: 1 });
  game = attack(game);
  assert.equal(game.remainingMs, 6000);
  game = transition(game, { type: 'hit', target: 1 });
  game = attack(game);
  assert.equal(game.remainingMs, 4000);
});
test('リセットすると前の場面から命中・成功しても進まない', () => {
  let game = attack(transition(initialGame, { type: 'start' }));
  game = transition(game, { type: 'reset' });
  assert.deepEqual(game, initialGame);
  assert.equal(transition(game, { type: 'hit', target: 1 }), game);
  assert.equal(transition(game, { type: 'success' }), game);
});

test('待機・受け・判定待ちも含め60秒で終了し、HPを保持して消灯する', () => {
  let game = transition(initialGame, { type: 'start' });
  game = transition(game, { type: 'tick', elapsed: 10000 });
  assert.equal(game.phase, 'ready');
  assert.equal(game.timeLeftMs, 50000);
  game = transition(game, { type: 'cue' });
  game = transition(game, { type: 'tick', elapsed: 10000 });
  assert.equal(game.phase, 'defend');
  game = transition(game, { type: 'unknown' });
  game = transition(game, { type: 'tick', elapsed: 10000 });
  assert.equal(game.timeLeftMs, 30000);
  game = transition(game, { type: 'retry' });
  game = attack(game, 0);
  game = transition(game, { type: 'tick', elapsed: 30000 });
  assert.equal(game.phase, 'timeup');
  assert.equal(game.timeLeftMs, 0);
  assert.equal(game.hp, 3);
  assert.equal(game.target, null);
  assert.equal(game.pendingTarget, null);
  assert.equal(transition(game, { type: 'start' }).timeLeftMs, 60000);
});

test('受けた表示中は消灯し、900ms後に指定された弱点を点灯する', () => {
  for (const target of [0, 1, 2] as const) {
    let game = transition(transition(initialGame, { type: 'start' }), { type: 'cue' });
    game = transition(game, { type: 'success', target });
    assert.equal(game.target, null);
    assert.equal(game.pendingTarget, target);
    assert.equal(transition(game, { type: 'hit', target }), game);
    game = transition(game, { type: 'tick', elapsed: 899 });
    assert.equal(game.phase, 'success');
    assert.equal(game.target, null);
    game = transition(game, { type: 'tick', elapsed: 1 });
    assert.equal(game.phase, 'attack');
    assert.equal(game.target, target);
    assert.equal(game.pendingTarget, null);
    assert.equal(game.remainingMs, 8000);
  }
});

test('一時停止は総時間と成功表示待ちを止める', () => {
  let game = transition(transition(initialGame, { type: 'start' }), { type: 'cue' });
  game = transition(game, { type: 'success', target: 2 });
  game = transition(game, { type: 'tick', elapsed: 300 });
  game = transition(game, { type: 'pause' });
  assert.equal(transition(game, { type: 'tick', elapsed: 60000 }), game);
  assert.equal(transition(game, { type: 'balloon' }), game);
  game = transition(game, { type: 'resume' });
  assert.equal(game.timeLeftMs, 59700);
  assert.equal(game.phaseRemainingMs, 600);
  game = transition(game, { type: 'tick', elapsed: 600 });
  assert.equal(game.phase, 'attack');
  assert.equal(game.timeLeftMs, 59100);
});

test('遅いtickは成功表示・点灯・消灯表示を跨いでも時間を延ばさない', () => {
  let game = transition(transition(initialGame, { type: 'start' }), { type: 'cue' });
  game = transition(game, { type: 'success', target: 0 });
  game = transition(game, { type: 'tick', elapsed: 1400 });
  assert.equal(game.phase, 'attack');
  assert.equal(game.remainingMs, 7500);
  assert.equal(game.timeLeftMs, 58600);
  game = transition(game, { type: 'tick', elapsed: 7800 });
  assert.equal(game.phase, 'miss');
  assert.equal(game.phaseRemainingMs, 600);
  game = transition(game, { type: 'tick', elapsed: 1000 });
  assert.equal(game.phase, 'ready');
  assert.equal(game.phaseRemainingMs, 0);
  assert.equal(game.timeLeftMs, 49800);
  assert.equal(game.hp, 3);
});

test('自動遷移でも3命中で勝利し、結果後に時間やHPは変わらない', () => {
  let game = transition(initialGame, { type: 'start' });
  for (const target of [2, 0, 1] as const) {
    assert.equal(game.phase, 'ready');
    game = transition(game, { type: 'cue' });
    game = transition(game, { type: 'success', target });
    game = transition(game, { type: 'tick', elapsed: 900 });
    game = transition(game, { type: 'hit', target });
    if (game.hp > 0) {
      assert.equal(game.phase, 'damage');
      game = transition(game, { type: 'tick', elapsed: 900 });
    }
  }
  assert.equal(game.phase, 'win');
  assert.equal(game.hp, 0);
  assert.equal(game.timeLeftMs, 55500);
  const loss = transition(transition(initialGame, { type: 'start' }), { type: 'balloon' });
  const timeup = transition(transition(initialGame, { type: 'start' }), { type: 'tick', elapsed: 60000 });
  for (const result of [game, loss, timeup]) {
    assert.equal(transition(result, { type: 'tick', elapsed: 60000 }), result);
    assert.equal(transition(result, { type: 'hit', target: 1 }), result);
    assert.equal(transition(result, { type: 'balloon' }), result);
    assert.equal(transition(result, { type: 'cue' }), result);
    assert.equal(transition(result, { type: 'pause' }), result);
  }
});
