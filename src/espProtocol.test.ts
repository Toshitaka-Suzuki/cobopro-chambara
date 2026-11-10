import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EspLineDecoder } from './espProtocol.ts';

test('XIAOの確定イベントだけを分割LF・CRLFから復元する', () => {
  const decoder = new EspLineDecoder();
  assert.deepEqual(decoder.push('[EVENT] PARRY SUC'), []);
  assert.deepEqual(decoder.push('CESS (once)\r'), []);
  assert.deepEqual(decoder.push('\n[EVENT] WEAK A SUCCESS (once)\n[WEAK A] end state confirmed=1\r\n'), [
    { type: 'parry_success' }, { type: 'weak_hit', weakpoint: 'A' }, { type: 'weak_end', weakpoint: 'A' },
  ]);
  assert.deepEqual(decoder.push('[EVENT] WEAK B SUCCESS (once)\n[WEAK C] end state confirmed=1\n'), [
    { type: 'weak_hit', weakpoint: 'B' }, { type: 'weak_end', weakpoint: 'C' },
  ]);
});

test('通常値・候補値・検出機側ログ・不正な接尾辞を成功と誤認しない', () => {
  const decoder = new EspLineDecoder();
  assert.deepEqual(decoder.push([
    '1', '[PARRY] confirmed result=1', '[PARRY] SUCCESS detected', '[WEAK A] ATTACK SUCCESS',
    '[WEAK A] TIMEOUT - finished', '[WEAK A] end state confirmed=0', '[EVENT] WEAK D SUCCESS (once)',
    '[EVENT] PARRY SUCCESS (once) extra', ' [EVENT] PARRY SUCCESS (once)', '[EVENT] PARRY SUCCESS (once)\0',
    '[EVENT] PARRY SUCCESS (once)\rgarbage', '',
  ].join('\n')), []);
});

test('長い行とその末尾を捨て、次の行から復帰する', () => {
  const decoder = new EspLineDecoder();
  assert.deepEqual(decoder.push('x'.repeat(4096)), []);
  assert.deepEqual(decoder.push('[EVENT] PARRY SUCCESS (once)\n[EVENT] PARRY SUCCESS (once)\n'), [
    { type: 'parry_success' },
  ]);
});

test('場面変更では未完行の末尾も捨て、新しい接続では状態を初期化する', () => {
  const decoder = new EspLineDecoder();
  decoder.push('[EVENT] PARRY');
  decoder.discardPending();
  assert.deepEqual(decoder.push(' SUCCESS (once)\n[EVENT] PARRY SUCCESS (once)\n'), [{ type: 'parry_success' }]);
  decoder.discardPending();
  assert.deepEqual(decoder.push('[EVENT] PARRY SUCCESS (once)\n'), [{ type: 'parry_success' }]);
  decoder.push('[EVENT] PARRY');
  decoder.reset();
  assert.deepEqual(decoder.push(' SUCCESS (once)\n'), []);
  assert.deepEqual(decoder.push('[EVENT] PARRY SUCCESS (once)\n'), [{ type: 'parry_success' }]);
});
