import test from 'node:test';
import assert from 'node:assert/strict';
import { lazyRosTransportFactory } from './lazyRosTransport.ts';
import type { RosQos, RosTransportFactory } from './ros.ts';

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

test('lazy transports forward control QoS and publishers only after loading', async () => {
  const qos: RosQos = { history: 'keep_last', depth: 10, reliability: 'reliable', durability: 'volatile' };
  const received: unknown[] = [];
  const subscriptionOptions = { throttleRateMs: 0, queueLength: 10, qos };
  const factory = lazyRosTransportFactory(async () => ({ createRoslibTransport: () => ({
    close() {}, request: async () => ({}),
    subscribe(topic, type, _message, _error, options) { received.push({ topic, type, options }); return () => {}; },
    advertise(topic, type, settings) {
      received.push({ topic, type, qos: settings });
      return { publish: message => { received.push(message); }, close() {} };
    },
  }) }));
  const transport = factory('ws://localhost:9090', { onOpen() {}, onClose() {}, onError: error => assert.fail(error.message) });
  assert.throws(() => transport.advertise!('/command', 'std_msgs/msg/String', qos, () => {}), /準備/);
  await flush();
  transport.subscribe('/status', 'std_msgs/msg/String', () => {}, () => {}, subscriptionOptions);
  const publisher = transport.advertise!('/command', 'std_msgs/msg/String', qos, () => {});
  publisher.publish({ data: 'start session 1' });
  assert.deepEqual(received, [
    { topic: '/status', type: 'std_msgs/msg/String', options: subscriptionOptions },
    { topic: '/command', type: 'std_msgs/msg/String', qos },
    { data: 'start session 1' },
  ]);
  transport.close();
  assert.throws(() => transport.advertise!('/command', 'std_msgs/msg/String', qos, () => {}), /準備/);
});
