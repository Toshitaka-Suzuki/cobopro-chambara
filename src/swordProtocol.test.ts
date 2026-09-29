import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SwordClashDecoder } from './swordProtocol.ts';

test('改行で確定した1だけをイベントにし、分割受信・LF・CRLFを扱う', () => {
  const decoder = new SwordClashDecoder();
  assert.equal(decoder.push('1'), 0);
  assert.equal(decoder.push('\r'), 0);
  assert.equal(decoder.push('\n1\n 1 \r\n'), 3);
  assert.equal(decoder.push('0\n11\n1.0\ntrue\n{"value":1}\n\n'), 0);
  assert.equal(decoder.push('１\n\0' + '1\n'), 0);
  assert.equal(decoder.push('1\n1\n'), 2);
});

test('長すぎる行は末尾が1でも改行まで破棄し、次の正常行から復帰する', () => {
  const decoder = new SwordClashDecoder();
  assert.equal(decoder.push(' '.repeat(4096)), 0);
  assert.equal(decoder.push('1\n1\n'), 1);
  assert.equal(decoder.push('x'.repeat(256) + '1\n'), 0);
});

test('準備や停止中の未完行は残りも破棄し、新しい完全な行だけを扱う', () => {
  const decoder = new SwordClashDecoder();
  decoder.push('old');
  decoder.discardPending();
  assert.equal(decoder.push('1\n1\n'), 1, 'old suffix must not become a new clash');
  decoder.push('1');
  decoder.discardPending();
  assert.equal(decoder.push('\n'), 0);
  decoder.discardPending();
  assert.equal(decoder.push('1\n'), 1, 'no pending line must not discard the next one');
  decoder.push('x'.repeat(4096));
  decoder.discardPending();
  assert.equal(decoder.push('1\n'), 0, 'overlong line remains discarded');
  decoder.reset();
  assert.equal(decoder.push('1\n'), 1);
});
