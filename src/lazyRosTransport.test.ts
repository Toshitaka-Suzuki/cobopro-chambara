import test from 'node:test';
import assert from 'node:assert/strict';
import { lazyRosTransportFactory } from './lazyRosTransport.ts';
import type { RosTransportFactory } from './ros.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('closing while the library loads prevents a delayed connection or error', async () => {
  let finish!: (module: { createRoslibTransport: RosTransportFactory }) => void;
  let connections = 0;
  const factory = lazyRosTransportFactory(() => new Promise(resolve => { finish = resolve; }));
  const transport = factory('ws://localhost:9090', {
    onOpen: () => assert.fail('cancelled connection opened'),
    onClose: () => {},
    onError: () => assert.fail('cancelled connection reported an error'),
  });
  await flush();
  transport.close();
  finish({ createRoslibTransport: () => { connections++; throw new Error('must not connect'); } });
  await flush();
  assert.equal(connections, 0);
});

test('load failures are reported and a later connection can retry', async () => {
  let loads = 0;
  let closed = 0;
  let endpoint = '';
  const errors: string[] = [];
  const factory = lazyRosTransportFactory(async () => {
    if (++loads === 1) throw new Error('load failed');
    return { createRoslibTransport: url => {
      endpoint = url;
      return { close() { closed++; }, request: async (_service, args) => args, subscribe: () => () => {} };
    } };
  });
  assert.equal(loads, 0);
  const handlers = { onOpen() {}, onClose() {}, onError(error: Error) { errors.push(error.message); } };
  const first = factory('ws://localhost:9090', handlers);
  await flush();
  assert.deepEqual(errors, ['load failed']);
  first.close();
  const second = factory('ws://localhost:9091', handlers);
  await flush();
  assert.equal(endpoint, 'ws://localhost:9091');
  assert.deepEqual(await second.request('/test', { value: 1 }, { signal: new AbortController().signal, timeoutMs: 100 }), { value: 1 });
  second.close();
  assert.equal(closed, 1);
});
