import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { initialGame, sample, transition, transitionWithElapsed } from './game.ts';
import type { Game, Phase, Target } from './game.ts';

function attack(game: Game, target: Target = 1) {
  if (['damage', 'miss'].includes(game.phase)) game = transition(game, { type: 'tick', elapsed: 2400 });
  game = transition(game, { type: 'cue' });
  game = transition(game, { type: 'success' });
  return transition(game, { type: 'open', target });
}

test('モックの受け入力は受けの場面で一度だけ成功になり、命中とは区別する', () => {
  const defend = transition(transition(initialGame, { type: 'start' }), { type: 'cue' });
  const success = transition(defend, { type: 'swordClash', target: 2 });
  assert.equal(success.phase, 'success');
  assert.equal(success.hp, 3);
  assert.equal(success.pendingTarget, 2);
  assert.equal(transition(success, { type: 'swordClash', target: 0 }), success);
  const attack = transition(success, { type: 'tick', elapsed: 900 });
  assert.equal(attack.phase, 'attack');
  assert.equal(attack.target, 2);
  assert.equal(transition(attack, { type: 'swordClash' }), attack);
});

test('待機・結果・一時停止中と時間切れ後のモック受け入力は採用しない', () => {
  const phases: Phase[] = ['idle', 'ready', 'success', 'attack', 'damage', 'miss', 'unknown', 'win', 'lose', 'timeup'];
  for (const phase of phases) {
    const game = sample(phase);
    assert.equal(transition(game, { type: 'swordClash' }), game, phase);
  }
  const paused = transition(sample('defend'), { type: 'pause' });
  assert.equal(transition(paused, { type: 'swordClash' }), paused);
  const expired = transition(sample('defend'), { type: 'tick', elapsed: 60000 });
  assert.equal(transition(expired, { type: 'swordClash' }), expired);
});

test('位置不明の接触は受け・攻撃で意味が変わり、それ以外では採用しない', () => {
  const defend = transition(initialGame, { type: 'start' });
  assert.equal(defend.phase, 'defend');
  const success = transition(defend, { type: 'contact', target: 2 });
  assert.equal(success.phase, 'success');
  assert.equal(success.hp, 3);
  const attack = transition(success, { type: 'tick', elapsed: 900 });
  assert.equal(attack.target, 2);
  // contactのtargetは次の弱点用。攻撃時に位置の一致は要求しない。
  const damage = transition(attack, { type: 'contact', target: 0 });
  assert.equal(damage.phase, 'damage');
  assert.equal(damage.hp, 2);
  assert.equal(transition(damage, { type: 'contact' }), damage);

  const ignoredPhases: Phase[] = ['idle', 'ready', 'success', 'damage', 'miss', 'unknown', 'win', 'lose', 'timeup'];
  for (const phase of ignoredPhases) {
    const game = sample(phase);
    assert.equal(transition(game, { type: 'contact' }), game, phase);
  }
  for (const phase of ['defend', 'attack'] as const) {
    const paused = transition(sample(phase), { type: 'pause' });
    assert.equal(transitionWithElapsed(paused, { type: 'contact' }, 60000), paused);
  }
});

test('命中・失敗表示900msと構え直し1500ms後に、自動で次の受けを開始する', () => {
  for (const phase of ['damage', 'miss'] as const) {
    let game = sample(phase);
    assert.equal(transition(game, { type: 'cue' }), game);
    game = transition(game, { type: 'tick', elapsed: 899 });
    assert.equal(game.phase, phase);
    assert.equal(transition(game, { type: 'contact' }), game);
    game = transition(game, { type: 'tick', elapsed: 1 });
    assert.equal(game.phase, 'ready');
    assert.equal(game.phaseRemainingMs, 1500);
    game = transition(game, { type: 'tick', elapsed: 1499 });
    assert.equal(game.phase, 'ready');
    assert.equal(game.phaseRemainingMs, 1);
    assert.equal(transition(game, { type: 'contact' }), game);
    game = transition(game, { type: 'tick', elapsed: 1 });
    assert.equal(game.phase, 'defend');
    assert.equal(game.phaseRemainingMs, 0);
    assert.equal(game.timeLeftMs, 57600);
    assert.equal(transition(game, { type: 'contact' }).phase, 'success');
  }
});

test('判定待ちからの再試行も構え直しを挟み、その待ち時間は停止できる', () => {
  let game = transition(sample('unknown'), { type: 'retry' });
  assert.equal(game.phase, 'ready');
  assert.equal(game.phaseRemainingMs, 1500);
  game = transition(game, { type: 'tick', elapsed: 500 });
  game = transition(game, { type: 'pause' });
  assert.equal(transitionWithElapsed(game, { type: 'contact' }, 60000), game);
  game = transition(game, { type: 'resume' });
  game = transition(game, { type: 'tick', elapsed: 1000 });
  assert.equal(game.phase, 'defend');
  assert.equal(game.timeLeftMs, 58500);
});

test('接触を処理する直前に受け・攻撃へ切り替わった場合、古い接触を持ち込まない', () => {
  const attack = transitionWithElapsed(sample('success'), { type: 'contact' }, 900);
  assert.equal(attack.phase, 'attack');
  assert.equal(attack.hp, 3);
  assert.equal(attack.remainingMs, 8000);
  const defend = transitionWithElapsed(sample('ready'), { type: 'contact' }, 1500);
  assert.equal(defend.phase, 'defend');
  assert.equal(defend.hp, 3);
  assert.equal(transitionWithElapsed(defend, { type: 'contact' }, 1).phase, 'success');
});

test('攻撃期限内の接触だけが命中し、期限・総時間切れを先に処理する', () => {
  const attack = sample('attack');
  assert.equal(transitionWithElapsed(attack, { type: 'contact' }, 7999).hp, 2);
  const expired = transitionWithElapsed(attack, { type: 'contact' }, 8000);
  assert.equal(expired.phase, 'miss');
  assert.equal(expired.hp, 3);
  const nextDefend = transitionWithElapsed(attack, { type: 'contact' }, 12000);
  assert.equal(nextDefend.phase, 'defend');
  assert.equal(nextDefend.hp, 3);
  const ended = transitionWithElapsed(attack, { type: 'contact' }, 60000);
  assert.equal(ended.phase, 'timeup');
  assert.equal(ended.hp, 3);
  assert.equal(ended.timeLeftMs, 0);
});

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
  assert.equal(game.phase, 'defend');
  assert.equal(game.timeLeftMs, 50000);
  game = transition(game, { type: 'miss' });
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
  assert.equal(game.phaseRemainingMs, 1100);
  assert.equal(game.timeLeftMs, 49800);
  assert.equal(game.hp, 3);
  game = transition(game, { type: 'tick', elapsed: 1200 });
  assert.equal(game.phase, 'defend');
  assert.equal(game.phaseRemainingMs, 0);
  assert.equal(game.timeLeftMs, 48600);
});

test('接触入力と自動遷移だけで3命中して勝利し、結果後に時間やHPは変わらない', () => {
  let game = transition(initialGame, { type: 'start' });
  for (const target of [2, 0, 1] as const) {
    assert.equal(game.phase, 'defend');
    game = transition(game, { type: 'contact', target });
    const success = game;
    assert.equal(transition(game, { type: 'contact' }), success);
    game = transition(game, { type: 'tick', elapsed: 900 });
    game = transition(game, { type: 'contact' });
    assert.equal(transition(game, { type: 'contact' }), game);
    if (game.hp > 0) {
      assert.equal(game.phase, 'damage');
      game = transition(game, { type: 'tick', elapsed: 2400 });
    }
  }
  assert.equal(game.phase, 'win');
  assert.equal(game.hp, 0);
  assert.equal(game.timeLeftMs, 52500);
  const loss = transition(transition(initialGame, { type: 'start' }), { type: 'balloon' });
  const timeup = transition(transition(initialGame, { type: 'start' }), { type: 'tick', elapsed: 60000 });
  for (const result of [game, loss, timeup]) {
    assert.equal(transition(result, { type: 'tick', elapsed: 60000 }), result);
    assert.equal(transition(result, { type: 'hit', target: 1 }), result);
    assert.equal(transition(result, { type: 'balloon' }), result);
    assert.equal(transition(result, { type: 'cue' }), result);
    assert.equal(transition(result, { type: 'pause' }), result);
    assert.equal(transition(result, { type: 'contact' }), result);
  }
});
