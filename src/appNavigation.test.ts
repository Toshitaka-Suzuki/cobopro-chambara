import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveScreen, screenFromHash, sessionPhaseAfterNavigation } from './appNavigation.ts';

test('既存のURLを画面へ対応付け、不明なURLは画面選択へ戻す', () => {
  assert.equal(screenFromHash('#/'), 'home');
  assert.equal(screenFromHash('#/play'), 'play');
  assert.equal(screenFromHash('#/admin'), 'admin');
  assert.equal(screenFromHash('#/play/countdown'), 'countdown');
  assert.equal(screenFromHash('#/play/game'), 'game');
  assert.equal(screenFromHash(''), 'home');
  assert.equal(screenFromHash('#/invalid'), 'home');
});

test('直リンク・再読み込みではカウントダウンとゲームを開始しない', () => {
  assert.equal(resolveScreen('countdown', 'idle'), 'play');
  assert.equal(resolveScreen('game', 'idle'), 'play');
  assert.equal(resolveScreen('game', 'countdown'), 'play');
  assert.equal(resolveScreen('countdown', 'playing'), 'play');
  assert.equal(resolveScreen('countdown', 'countdown'), 'countdown');
  assert.equal(resolveScreen('game', 'playing'), 'game');
});

test('管理画面からの復帰は保存したゲームがある場合だけ許可する', () => {
  const suspended = sessionPhaseAfterNavigation('admin', 'settings', true);
  assert.equal(suspended, 'settings');
  const resumed = sessionPhaseAfterNavigation('game', suspended, true);
  assert.equal(resolveScreen('game', resumed), 'game');
  const withoutSavedGame = sessionPhaseAfterNavigation('game', 'settings', false);
  assert.equal(resolveScreen('game', withoutSavedGame), 'play');
});

test('準備・画面選択への移動は中断中のゲームやカウントダウンを終了する', () => {
  for (const phase of ['countdown', 'playing', 'settings'] as const) {
    assert.equal(sessionPhaseAfterNavigation('play', phase, true), 'idle');
    assert.equal(sessionPhaseAfterNavigation('home', phase, true), 'idle');
  }
  assert.equal(sessionPhaseAfterNavigation('admin', 'countdown', false), 'idle');
  assert.equal(sessionPhaseAfterNavigation('admin', 'playing', false), 'idle');
  assert.equal(sessionPhaseAfterNavigation('game', 'idle', true), 'idle');
});
