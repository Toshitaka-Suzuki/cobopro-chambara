import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRhythm, projectRhythm, parseParryFeedback } from './rhythm.ts';

const message = {
  ready: true, active: true, generation: 3, stage: 'easy', position_ms: 600,
  beats_ms: [0, 500, 1000, 1500], window_ms: 300,
};

test('往復時間の半分を補正し、音声位置から輪と拍を描画する', () => {
  const state = parseRhythm(message, 100, 140)!;
  assert.equal(state.positionMs, 620);
  const cue = projectRhythm(state, 540)!;
  assert.equal(cue.position, 1020);
  assert.equal(cue.beat, 3);
  assert.equal(cue.progress, 1020 / 1500);
  const impact = parseRhythm({ ...message, position_ms: 1490 }, 800, 820)!;
  assert.equal(projectRhythm(impact, 820)?.progress, 1);
  assert.equal(projectRhythm(impact, 820)?.inWindow, true);
});

test('通信遅延・同期の途絶・停止中・終了済みの拍では合図を出さない', () => {
  assert.equal(parseRhythm(message, 0, 181), null);
  assert.equal(parseRhythm({ ...message, ready: false }, 0, 10), null);
  const state = parseRhythm(message, 0, 10)!;
  assert.equal(projectRhythm(state, 761), null);
  assert.equal(projectRhythm({ ...state, active: false }, 100), null);
  const past = parseRhythm({ ...message, position_ms: 1640 }, 0, 10)!;
  assert.equal(projectRhythm(past, 30), null);
});

test('次の周回の絶対位置でも輪が重なり、不正な拍や数値は使わない', () => {
  const state = parseRhythm({ ...message, position_ms: 9350, beats_ms: [8000, 8500, 9000, 9500] }, 0, 10)!;
  assert.equal(projectRhythm(state, 155)?.position, 9500);
  assert.equal(projectRhythm(state, 155)?.beat, 4);
  for (const beats_ms of [[0, 500, 500, 1000], [0, 500, 1000], [0, 500, 1000, NaN]]) {
    assert.equal(parseRhythm({ ...message, beats_ms }, 0, 10), null);
  }
  assert.equal(parseParryFeedback({ timing: 'late', delta_ms: Infinity }), null);
  assert.deepEqual(parseParryFeedback({ timing: 'early', delta_ms: -180 }), { timing: 'early', deltaMs: -180 });
});
