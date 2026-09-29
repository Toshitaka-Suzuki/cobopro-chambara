import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test, { type TestContext } from 'node:test';
import {
  AbstractTransport,
  Ros,
  isRosbridgeCallServiceMessage,
  type ITransport,
  type RosbridgeMessage,
} from 'roslib';
import { createRoslibTransportFactory } from './roslibTransport.ts';

class FakeTransport extends AbstractTransport {
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  sent: RosbridgeMessage[] = [];
  closeCount = 0;
  sendError: Error | null = null;
  onSend?: (message: RosbridgeMessage) => void;

  send(message: RosbridgeMessage): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
    this.onSend?.(message);
  }

  open(): void { this.state = 'open'; this.emit('open', {}); }
  remoteClose(): void { this.state = 'closed'; this.emit('close', {}); }
  close(): void { this.closeCount++; this.remoteClose(); }
  isConnecting(): boolean { return this.state === 'connecting'; }
  isOpen(): boolean { return this.state === 'open'; }
  isClosing(): boolean { return false; }
  isClosed(): boolean { return this.state === 'closed'; }
  receive(message: RosbridgeMessage): void { this.emit('message', message); }

  calls() { return this.sent.filter(isRosbridgeCallServiceMessage); }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const options = (timeoutMs = 1000) => ({ signal: new AbortController().signal, timeoutMs });

async function harness(t: TestContext) {
  const source = new FakeTransport();
  const events = { open: 0, close: 0, errors: [] as Error[] };
  let ros: Ros | undefined;
  const originalConnect = Ros.prototype.connect;
  t.mock.method(Ros.prototype, 'connect', function (this: Ros, url: string) {
    ros = this;
    return originalConnect.call(this, url);
  });
  const client = createRoslibTransportFactory(async (url) => {
    assert.equal(url, 'ws://test.invalid:9090');
    return source;
  })('ws://test.invalid:9090', {
    onOpen: () => { events.open++; },
    onClose: () => { events.close++; },
    onError: (error) => { events.errors.push(error); },
  });
  t.after(() => client.close());
  assert.equal(events.open, 0);
  await flush();
  assert.ok(ros);
  return { source, client, events, ros };
}

test('operations before open are rejected instead of queued for connection', async (t) => {
  const { client, source, events } = await harness(t);
  await assert.rejects(client.request('/start', {}, options()), { name: 'DisconnectedError' });
  const failures: Error[] = [];
  client.subscribe('/contact', 'std_msgs/msg/Int32', () => assert.fail('not subscribed'), (error) => failures.push(error));
  assert.equal(failures[0].name, 'DisconnectedError');
  source.open();
  source.open();
  assert.equal(events.open, 1);
  assert.deepEqual(source.sent, []);
});

test('real Ros routes concurrent service calls by ID and preserves application payloads', async (t) => {
  const { client, source, ros } = await harness(t);
  source.open();
  const baseline = ros.eventNames();
  const one = client.request('/one', { enabled: true }, options(2500));
  const two = client.request('/two', {}, options());
  const [first, second] = source.calls();
  assert.equal(first.service, '/one');
  assert.deepEqual(first.args, { enabled: true });
  assert.equal(first.timeout, 2.5);
  assert.notEqual(first.id, second.id);
  source.receive({ op: 'service_response', id: second.id, service: '/two', result: true, values: { success: false, message: 'not ready' } });
  source.receive({ op: 'service_response', id: first.id, service: '/one', result: true, values: { done: true } });
  assert.deepEqual(await one, { done: true });
  assert.deepEqual(await two, { success: false, message: 'not ready' });
  assert.deepEqual(ros.eventNames(), baseline);
});

test('bridge rejection and error status reject only the correlated request', async (t) => {
  const { client, source, ros } = await harness(t);
  source.open();
  const baseline = ros.eventNames();
  const one = client.request('/missing', {}, options());
  const first = source.calls()[0];
  const rejection = assert.rejects(one, /service does not exist/);
  source.receive({ op: 'service_response', id: first.id, service: '/missing', result: false, values: 'service does not exist' });
  await rejection;

  const two = client.request('/denied', {}, options());
  const second = source.calls()[1];
  source.receive({ op: 'status', id: second.id, level: 'warning', msg: 'waiting' });
  assert.equal(ros.listenerCount(second.id!), 1);
  const statusFailure = assert.rejects(two, /not allowed/);
  source.receive({ op: 'status', id: second.id, level: 'error', msg: 'not allowed' });
  await statusFailure;
  assert.deepEqual(ros.eventNames(), baseline);
});

test('timeouts and aborts remove response, status, timer, and abort listeners', async (t) => {
  const { client, source, ros } = await harness(t);
  source.open();
  const baseline = ros.eventNames();
  const controller = new AbortController();
  const timedOut = client.request('/slow', {}, { signal: controller.signal, timeoutMs: 5 });
  const first = source.calls()[0];
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  await assert.rejects(timedOut, { name: 'TimeoutError' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(ros.eventNames(), baseline);
  source.receive({ op: 'service_response', id: first.id, service: '/slow', result: true, values: { late: true } });

  const abort = new AbortController();
  const aborted = client.request('/cancel_wait', {}, { signal: abort.signal, timeoutMs: 1000 });
  const failure = assert.rejects(aborted, { name: 'AbortError' });
  abort.abort();
  await failure;
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.deepEqual(ros.eventNames(), baseline);
  await assert.rejects(client.request('/never_send', {}, { signal: abort.signal, timeoutMs: 1000 }), { name: 'AbortError' });
  await assert.rejects(client.request('/never_send', {}, options(0)), /正の数/);
  assert.equal(source.calls().length, 2);
});

test('Topic sends bounded subscription options and unsubscribe exactly once', async (t) => {
  const { client, source, ros } = await harness(t);
  source.open();
  const baseline = ros.eventNames();
  const messages: unknown[] = [];
  const stop = client.subscribe('/contact', 'std_msgs/msg/Int32', (message) => messages.push(message), (error) => assert.fail(error.message));
  assert.equal(source.sent[0].op, 'subscribe');
  const subscribe = source.sent[0];
  assert.deepEqual(subscribe, {
    op: 'subscribe', id: 'id' in subscribe ? subscribe.id : undefined,
    topic: '/contact', type: 'std_msgs/msg/Int32', compression: 'none', throttle_rate: 100, queue_length: 1,
  });
  source.receive({ op: 'publish', topic: '/contact', msg: { data: 1 } });
  assert.deepEqual(messages, [{ data: 1 }]);
  stop();
  stop();
  source.receive({ op: 'publish', topic: '/contact', msg: { data: 2 } });
  assert.deepEqual(messages, [{ data: 1 }]);
  assert.equal(source.sent.filter((message) => message.op === 'unsubscribe').length, 1);
  assert.deepEqual(ros.eventNames(), baseline);
});

test('synchronous subscription errors stop reception and clean correlation listeners', async (t) => {
  const { client, source, ros } = await harness(t);
  source.open();
  const baseline = ros.eventNames();
  const failures: Error[] = [];
  source.onSend = (message) => {
    if (message.op === 'subscribe') source.receive({ op: 'status', id: message.id, level: 'error', msg: 'unknown topic type' });
  };
  const stop = client.subscribe('/unknown', 'example/Unknown', () => assert.fail('must be stopped'), (error) => failures.push(error));
  stop();
  source.receive({ op: 'publish', topic: '/unknown', msg: {} });
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /unknown topic type/);
  assert.deepEqual(ros.eventNames(), baseline);
});

test('closing rejects pending calls, removes subscriptions, and ignores every late event', async (t) => {
  const { client, source, ros, events } = await harness(t);
  source.open();
  const pending = client.request('/start', {}, options());
  const failure = assert.rejects(pending, { name: 'DisconnectedError' });
  const request = source.calls()[0];
  const stop = client.subscribe('/contact', 'std_msgs/msg/Int32', () => assert.fail('late topic message'), () => {});
  const sentCount = source.sent.length;
  client.close();
  client.close();
  stop();
  await failure;
  assert.equal(events.close, 1);
  assert.equal(source.closeCount, 1);
  assert.equal(ros.eventNames().length, 0);
  source.open();
  source.receive({ op: 'publish', topic: '/contact', msg: {} });
  source.receive({ op: 'service_response', id: request.id, service: '/start', result: true, values: {} });
  assert.equal(events.open, 1);
  assert.equal(source.sent.length, sentCount);
  await assert.rejects(client.request('/start', {}, options()), { name: 'DisconnectedError' });
});

test('remote closure and transport errors finish once without automatic reconnect', async (t) => {
  const { client, source, events } = await harness(t);
  source.open();
  const pending = client.request('/start', {}, options());
  const failure = assert.rejects(pending, /network failed/);
  source.emit('error', new Error('network failed'));
  await failure;
  source.remoteClose();
  source.open();
  assert.equal(events.errors.length, 1);
  assert.equal(events.close, 0);
  assert.equal(events.open, 1);
  assert.equal(source.calls().length, 1);
});

test('a transport arriving after disconnect is closed without late connection callbacks', async () => {
  const source = new FakeTransport();
  let deliver!: (transport: ITransport) => void;
  const events: string[] = [];
  const client = createRoslibTransportFactory(() => new Promise((resolve) => { deliver = resolve; }))('ws://delayed.invalid', {
    onOpen: () => events.push('open'),
    onClose: () => events.push('close'),
    onError: () => events.push('error'),
  });
  await flush();
  client.close();
  deliver(source);
  await flush();
  assert.equal(source.closeCount, 1);
  source.open();
  assert.deepEqual(events, ['close']);
  assert.deepEqual(source.sent, []);
});

test('a synchronous factory failure reports its error after the client is returned', async () => {
  let returned = false;
  const errors: Error[] = [];
  const client = createRoslibTransportFactory(() => { throw new Error('bad endpoint'); })('ws://bad.invalid', {
    onOpen: () => assert.fail('must not open'),
    onClose: () => assert.fail('error is the terminal event'),
    onError: (error) => { assert.equal(returned, true); errors.push(error); },
  });
  returned = true;
  await flush();
  client.close();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /bad endpoint/);
});

test('send failure cleans the request without scheduling a resend', async (t) => {
  const { client, source, ros } = await harness(t);
  source.open();
  const baseline = ros.eventNames();
  source.sendError = new Error('send failed');
  await assert.rejects(client.request('/start', {}, options()), /send failed/);
  assert.deepEqual(ros.eventNames(), baseline);
  source.sendError = null;
  source.open();
  assert.deepEqual(source.sent, []);
});
