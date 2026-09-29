import test from 'node:test';
import assert from 'node:assert/strict';
import { createRosRequestTemplate, validateRosRequest } from './rosSchema.ts';

test('builds editable ROS request JSON with nested messages and fixed / variable arrays', () => {
  const result = createRosRequestTemplate([
    { type: 'demo/srv/Move_Request', fieldnames: ['enabled', 'label', 'target', 'weights', 'tags'], fieldtypes: ['boolean', 'string<=20', 'demo/msg/Point', 'float64', 'string'], fieldarraylen: [-1, -1, -1, 2, 0] },
    { type: 'demo/Point', fieldnames: ['x', 'y'], fieldtypes: ['float64', 'float64'], fieldarraylen: [-1, -1] },
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual(JSON.parse(result.text), { enabled: false, label: '', target: { x: 0, y: 0 }, weights: [0, 0], tags: [] });
});

test('an empty request has a complete empty object, missing or partial metadata does not', () => {
  assert.deepEqual(createRosRequestTemplate([{ type: 'std_srvs/EmptyRequest', fieldnames: [], fieldtypes: [], fieldarraylen: [] }]), { text: '{}', complete: true });
  assert.deepEqual(createRosRequestTemplate(null), { text: '{}', complete: false });
  const result = createRosRequestTemplate([{ type: 'demo/Request', fieldnames: ['unknown'], fieldtypes: ['missing/Type'], fieldarraylen: [-1] }]);
  assert.equal(result.complete, false);
  assert.deepEqual(JSON.parse(result.text), { unknown: {} });
});

test('untrusted recursive metadata and huge arrays have bounded templates', () => {
  const result = createRosRequestTemplate([{ type: 'demo/Request', fieldnames: ['next', 'many'], fieldtypes: ['demo/Request', 'float64'], fieldarraylen: [-1, 1_000_000_000] }]);
  assert.equal(result.complete, false);
  assert.deepEqual(JSON.parse(result.text), { next: {}, many: [] });
});

test('field names remain data and cannot alter object prototypes', () => {
  const result = createRosRequestTemplate([{ type: 'demo/Request', fieldnames: ['__proto__'], fieldtypes: ['bool'], fieldarraylen: [-1] }]);
  assert.equal(result.text.includes('"__proto__": false'), true);
});

test('only JSON objects can be submitted as ROS request arguments', () => {
  for (const value of ['null', 'true', '4', '"hello"', '[]', '{ broken }', '']) assert.notEqual(validateRosRequest(value), null);
  for (const value of ['{}', '{"data":false}', '{"nested":{"values":[1,2]}}']) assert.equal(validateRosRequest(value), null);
  assert.notEqual(validateRosRequest(JSON.stringify({ text: 'a'.repeat(65536) })), null);
});
