import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { INITIAL_GAME_STATE, getGameLevel, transitionGame, transitionGameWithElapsed } from './game.ts';
import type { GameState, GamePhase, TargetId } from './game.ts';

// UIプレビュー用の状態生成は本番コードに持ち込まず、テストの準備に閉じ込める。
function createGameState(phase: GamePhase): GameState {
  return {
    ...INITIAL_GAME_STATE,
    phase,
    hp: phase === 'win' ? 0 : phase === 'damage' ? 2 : 3,
    target: phase === 'attack' ? 1 : null,
    attackRemainingMs: phase === 'attack' ? 8000 : 0,
    roundRemainingMs: phase === 'timeup' ? 0 : 60000,
    phaseRemainingMs: phase === 'ready' ? 1500 : ['success', 'damage', 'miss'].includes(phase) ? 900 : 0,
    pendingTarget: phase === 'success' ? 1 : null,
  };
}

function attack(game: GameState, target: TargetId = 1) {
  if (['damage', 'miss'].includes(game.phase)) game = transitionGame(game, { type: 'tick', elapsedMs: 2400 });
  game = transitionGame(game, { type: 'swordClash', target });
  return transitionGame(game, { type: 'tick', elapsedMs: 900 });
}

test('モックの受け入力は受けの場面で一度だけ成功になり、命中とは区別する', () => {
  const defend = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
  const success = transitionGame(defend, { type: 'swordClash', target: 2 });
  assert.equal(success.phase, 'success');
  assert.equal(success.hp, 3);
  assert.equal(getGameLevel(success.hp), 1);
  assert.equal(success.pendingTarget, 2);
  assert.equal(transitionGame(success, { type: 'swordClash', target: 0 }), success);
  const attack = transitionGame(success, { type: 'tick', elapsedMs: 900 });
  assert.equal(attack.phase, 'attack');
  assert.equal(attack.target, 2);
  assert.equal(transitionGame(attack, { type: 'swordClash' }), attack);
});

test('待機・結果・一時停止中と時間切れ後のモック受け入力は採用しない', () => {
  const phases: GamePhase[] = ['idle', 'ready', 'success', 'attack', 'damage', 'miss', 'win', 'lose', 'timeup'];
  for (const phase of phases) {
    const game = createGameState(phase);
    assert.equal(transitionGame(game, { type: 'swordClash' }), game, phase);
  }
  const paused = transitionGame(createGameState('defend'), { type: 'pause' });
  assert.equal(transitionGame(paused, { type: 'swordClash' }), paused);
  const expired = transitionGame(createGameState('defend'), { type: 'tick', elapsedMs: 60000 });
  assert.equal(transitionGame(expired, { type: 'swordClash' }), expired);
});

test('位置不明の接触は受け・攻撃で意味が変わり、それ以外では採用しない', () => {
  const defend = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
  assert.equal(defend.phase, 'defend');
  const success = transitionGame(defend, { type: 'contact', target: 2 });
  assert.equal(success.phase, 'success');
  assert.equal(success.hp, 3);
  const attack = transitionGame(success, { type: 'tick', elapsedMs: 900 });
  assert.equal(attack.target, 2);
  // contactのtargetは次の弱点用。攻撃時に位置の一致は要求しない。
  const damage = transitionGame(attack, { type: 'contact', target: 0 });
  assert.equal(damage.phase, 'damage');
  assert.equal(damage.hp, 2);
  assert.equal(transitionGame(damage, { type: 'contact' }), damage);

  const ignoredPhases: GamePhase[] = ['idle', 'ready', 'success', 'damage', 'miss', 'win', 'lose', 'timeup'];
  for (const phase of ignoredPhases) {
    const game = createGameState(phase);
    assert.equal(transitionGame(game, { type: 'contact' }), game, phase);
  }
  for (const phase of ['defend', 'attack'] as const) {
    const paused = transitionGame(createGameState(phase), { type: 'pause' });
    assert.equal(transitionGameWithElapsed(paused, { type: 'contact' }, 60000), paused);
  }
});

test('命中・失敗表示900msと構え直し1500ms後に、自動で次の受けを開始する', () => {
  for (const phase of ['damage', 'miss'] as const) {
    let game = createGameState(phase);
    game = transitionGame(game, { type: 'tick', elapsedMs: 899 });
    assert.equal(game.phase, phase);
    assert.equal(transitionGame(game, { type: 'contact' }), game);
    game = transitionGame(game, { type: 'tick', elapsedMs: 1 });
    assert.equal(game.phase, 'ready');
    assert.equal(game.phaseRemainingMs, 1500);
    game = transitionGame(game, { type: 'tick', elapsedMs: 1499 });
    assert.equal(game.phase, 'ready');
    assert.equal(game.phaseRemainingMs, 1);
    assert.equal(transitionGame(game, { type: 'contact' }), game);
    game = transitionGame(game, { type: 'tick', elapsedMs: 1 });
    assert.equal(game.phase, 'defend');
    assert.equal(game.phaseRemainingMs, 0);
    assert.equal(game.roundRemainingMs, 57600);
    assert.equal(transitionGame(game, { type: 'contact' }).phase, 'success');
  }
});

test('構え直しの待ち時間も一時停止できる', () => {
  let game = createGameState('ready');
  game = transitionGame(game, { type: 'tick', elapsedMs: 500 });
  game = transitionGame(game, { type: 'pause' });
  assert.equal(transitionGameWithElapsed(game, { type: 'contact' }, 60000), game);
  game = transitionGame(game, { type: 'resume' });
  game = transitionGame(game, { type: 'tick', elapsedMs: 1000 });
  assert.equal(game.phase, 'defend');
  assert.equal(game.roundRemainingMs, 58500);
});

test('接触を処理する直前に受け・攻撃へ切り替わった場合、古い接触を持ち込まない', () => {
  const attack = transitionGameWithElapsed(createGameState('success'), { type: 'contact' }, 900);
  assert.equal(attack.phase, 'attack');
  assert.equal(attack.hp, 3);
  assert.equal(attack.attackRemainingMs, 8000);
  const defend = transitionGameWithElapsed(createGameState('ready'), { type: 'contact' }, 1500);
  assert.equal(defend.phase, 'defend');
  assert.equal(defend.hp, 3);
  assert.equal(transitionGameWithElapsed(defend, { type: 'contact' }, 1).phase, 'success');
});

test('攻撃期限内の接触だけが命中し、期限・総時間切れを先に処理する', () => {
  const attack = createGameState('attack');
  assert.equal(transitionGameWithElapsed(attack, { type: 'contact' }, 7999).hp, 2);
  const expired = transitionGameWithElapsed(attack, { type: 'contact' }, 8000);
  assert.equal(expired.phase, 'miss');
  assert.equal(expired.hp, 3);
  const nextDefend = transitionGameWithElapsed(attack, { type: 'contact' }, 12000);
  assert.equal(nextDefend.phase, 'defend');
  assert.equal(nextDefend.hp, 3);
  const ended = transitionGameWithElapsed(attack, { type: 'contact' }, 60000);
  assert.equal(ended.phase, 'timeup');
  assert.equal(ended.hp, 3);
  assert.equal(ended.roundRemainingMs, 0);
});

test('受け成功と命中は別。3回の有効命中で勝利する', () => {
  let game = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
  for (let hp = 3; hp > 0; hp--) {
    game = attack(game);
    assert.equal(game.hp, hp);
    game = transitionGame(game, { type: 'hit', target: 1 });
    assert.equal(game.hp, hp - 1);
    const once = game;
    game = transitionGame(game, { type: 'hit', target: 1 });
    assert.equal(game, once);
  }
  assert.equal(game.phase, 'win');
  assert.equal(getGameLevel(game.hp), 3);
});
test('暗い弱点と時間外の命中ではHPが減らない', () => {
  let game = attack(transitionGame(INITIAL_GAME_STATE, { type: 'start' }), 2);
  game = transitionGame(game, { type: 'hit', target: 0 });
  assert.equal(game.hp, 3);
  assert.equal(game.target, 2);
  game = transitionGame(game, { type: 'tick', elapsedMs: 8000 });
  game = transitionGame(game, { type: 'hit', target: 2 });
  assert.equal(game.hp, 3);
  assert.equal(game.phase, 'miss');
});
test('一時停止中はタイマーと命中を受け付けない', () => {
  let game = attack(transitionGame(INITIAL_GAME_STATE, { type: 'start' }));
  game = transitionGame(game, { type: 'pause' });
  const paused = game;
  assert.equal(transitionGame(game, { type: 'tick', elapsedMs: 10000 }), paused);
  assert.equal(transitionGame(game, { type: 'hit', target: 1 }), paused);
  game = transitionGame(game, { type: 'resume' });
  assert.equal(game.attackRemainingMs, 8000);
  assert.equal(getGameLevel(game.hp), 1);
  assert.equal(transitionGame(game, { type: 'hit', target: 1 }).hp, 2);
});
test('受け失敗は敗北と区別し、紙風船の破損で敗北する', () => {
  const game = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
  const missed = transitionGame(game, { type: 'miss' });
  assert.equal(missed.phase, 'miss');
  assert.equal(missed.hp, 3);
  assert.equal(transitionGame(missed, { type: 'balloon' }).phase, 'lose');
});
test('ダメージ後に難易度が上がり、時間切れだけでは上がらない', () => {
  let game = attack(transitionGame(INITIAL_GAME_STATE, { type: 'start' }));
  assert.equal(game.attackRemainingMs, 8000);
  game = transitionGame(game, { type: 'tick', elapsedMs: 8000 });
  game = attack(game);
  assert.equal(game.attackRemainingMs, 8000);
  assert.equal(getGameLevel(game.hp), 1);
  game = transitionGame(game, { type: 'hit', target: 1 });
  game = attack(game);
  assert.equal(game.attackRemainingMs, 6000);
  assert.equal(getGameLevel(game.hp), 2);
  game = transitionGame(game, { type: 'hit', target: 1 });
  game = attack(game);
  assert.equal(game.attackRemainingMs, 4000);
  assert.equal(getGameLevel(game.hp), 3);
});
test('開始前は命中・受け入力では進まない', () => {
  assert.equal(transitionGame(INITIAL_GAME_STATE, { type: 'hit', target: 1 }), INITIAL_GAME_STATE);
  assert.equal(transitionGame(INITIAL_GAME_STATE, { type: 'swordClash' }), INITIAL_GAME_STATE);
});

test('受け・構え直しも含め60秒で終了し、HPを保持して消灯する', () => {
  let game = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
  game = transitionGame(game, { type: 'tick', elapsedMs: 10000 });
  assert.equal(game.phase, 'defend');
  assert.equal(game.roundRemainingMs, 50000);
  game = transitionGame(game, { type: 'miss' });
  game = transitionGame(game, { type: 'tick', elapsedMs: 10000 });
  assert.equal(game.phase, 'defend');
  game = transitionGame(game, { type: 'swordClash', target: 0 });
  game = transitionGame(game, { type: 'tick', elapsedMs: 40000 });
  assert.equal(game.phase, 'timeup');
  assert.equal(game.roundRemainingMs, 0);
  assert.equal(game.hp, 3);
  assert.equal(game.target, null);
  assert.equal(game.pendingTarget, null);
  assert.equal(transitionGame(game, { type: 'start' }).roundRemainingMs, 60000);
});

test('受けた表示中は消灯し、900ms後に指定された弱点を点灯する', () => {
  for (const target of [0, 1, 2] as const) {
    let game = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
    game = transitionGame(game, { type: 'swordClash', target });
    assert.equal(game.target, null);
    assert.equal(game.pendingTarget, target);
    assert.equal(transitionGame(game, { type: 'hit', target }), game);
    game = transitionGame(game, { type: 'tick', elapsedMs: 899 });
    assert.equal(game.phase, 'success');
    assert.equal(game.target, null);
    game = transitionGame(game, { type: 'tick', elapsedMs: 1 });
    assert.equal(game.phase, 'attack');
    assert.equal(game.target, target);
    assert.equal(game.pendingTarget, null);
    assert.equal(game.attackRemainingMs, 8000);
  }
});

test('一時停止は総時間と成功表示待ちを止める', () => {
  let game = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
  game = transitionGame(game, { type: 'swordClash', target: 2 });
  game = transitionGame(game, { type: 'tick', elapsedMs: 300 });
  game = transitionGame(game, { type: 'pause' });
  assert.equal(transitionGame(game, { type: 'tick', elapsedMs: 60000 }), game);
  assert.equal(transitionGame(game, { type: 'balloon' }), game);
  game = transitionGame(game, { type: 'resume' });
  assert.equal(game.roundRemainingMs, 59700);
  assert.equal(game.phaseRemainingMs, 600);
  game = transitionGame(game, { type: 'tick', elapsedMs: 600 });
  assert.equal(game.phase, 'attack');
  assert.equal(game.roundRemainingMs, 59100);
});

test('遅いtickは成功表示・点灯・消灯表示を跨いでも時間を延ばさない', () => {
  let game = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
  game = transitionGame(game, { type: 'swordClash', target: 0 });
  game = transitionGame(game, { type: 'tick', elapsedMs: 1400 });
  assert.equal(game.phase, 'attack');
  assert.equal(game.attackRemainingMs, 7500);
  assert.equal(game.roundRemainingMs, 58600);
  game = transitionGame(game, { type: 'tick', elapsedMs: 7800 });
  assert.equal(game.phase, 'miss');
  assert.equal(game.phaseRemainingMs, 600);
  game = transitionGame(game, { type: 'tick', elapsedMs: 1000 });
  assert.equal(game.phase, 'ready');
  assert.equal(game.phaseRemainingMs, 1100);
  assert.equal(game.roundRemainingMs, 49800);
  assert.equal(game.hp, 3);
  game = transitionGame(game, { type: 'tick', elapsedMs: 1200 });
  assert.equal(game.phase, 'defend');
  assert.equal(game.phaseRemainingMs, 0);
  assert.equal(game.roundRemainingMs, 48600);
});

test('接触入力と自動遷移だけで3命中して勝利し、結果後に時間やHPは変わらない', () => {
  let game = transitionGame(INITIAL_GAME_STATE, { type: 'start' });
  for (const target of [2, 0, 1] as const) {
    assert.equal(game.phase, 'defend');
    game = transitionGame(game, { type: 'contact', target });
    const success = game;
    assert.equal(transitionGame(game, { type: 'contact' }), success);
    game = transitionGame(game, { type: 'tick', elapsedMs: 900 });
    game = transitionGame(game, { type: 'contact' });
    assert.equal(transitionGame(game, { type: 'contact' }), game);
    if (game.hp > 0) {
      assert.equal(game.phase, 'damage');
      game = transitionGame(game, { type: 'tick', elapsedMs: 2400 });
    }
  }
  assert.equal(game.phase, 'win');
  assert.equal(game.hp, 0);
  assert.equal(game.roundRemainingMs, 52500);
  const loss = transitionGame(transitionGame(INITIAL_GAME_STATE, { type: 'start' }), { type: 'balloon' });
  const timeup = transitionGame(transitionGame(INITIAL_GAME_STATE, { type: 'start' }), { type: 'tick', elapsedMs: 60000 });
  for (const result of [game, loss, timeup]) {
    assert.equal(transitionGame(result, { type: 'tick', elapsedMs: 60000 }), result);
    assert.equal(transitionGame(result, { type: 'hit', target: 1 }), result);
    assert.equal(transitionGame(result, { type: 'balloon' }), result);
    assert.equal(transitionGame(result, { type: 'pause' }), result);
    assert.equal(transitionGame(result, { type: 'contact' }), result);
  }
});
