import assert from 'node:assert/strict';
import test from 'node:test';
import { RosMonitor, type RosTransport, type RosTransportFactory } from './ros.ts';

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const definition = { type: 'demo/Request', fieldnames: ['enabled'], fieldtypes: ['bool'], fieldarraylen: [-1] };

type Invocation = { service: string; args: Record<string, unknown>; signal: AbortSignal; timeoutMs: number };
function fixture(options: ConstructorParameters<typeof RosMonitor>[1] = {}) {
  const connections: Array<{
    handlers: Parameters<RosTransportFactory>[1];
    calls: Invocation[];
    subscriptions: Array<{ name: string; type: string; message: (value: unknown) => void; error: (error: Error) => void; stopped: boolean }>;
    closed: boolean;
  }> = [];
  let respond = (call: Invocation): Promise<unknown> => {
    switch (call.service) {
      case '/rosapi/topics': return Promise.resolve({ topics: ['/z', '/accel'], types: ['std_msgs/String', 'geometry_msgs/Vector3'] });
      case '/rosapi/services': return Promise.resolve({ services: ['/start', '/reset'] });
      case '/rosapi/service_type': return Promise.resolve({ type: 'demo/Action' });
      case '/rosapi/service_request_details':
      case '/rosapi/service_response_details': return Promise.resolve({ typedefs: [definition] });
      default: return Promise.resolve({ success: false, message: 'Robot refused' });
    }
  };
  const factory: RosTransportFactory = (_url, handlers): RosTransport => {
    const connection = { handlers, calls: [] as Invocation[], subscriptions: [] as typeof connections[number]['subscriptions'], closed: false };
    connections.push(connection);
    return {
      close: () => { connection.closed = true; },
      request: (service, args, requestOptions) => {
        const call = { service, args, ...requestOptions };
        connection.calls.push(call);
        return respond(call);
      },
      subscribe: (name, type, message, error) => {
        const subscription = { name, type, message, error, stopped: false };
        connection.subscriptions.push(subscription);
        return () => { subscription.stopped = true; };
      },
    };
  };
  const monitor = new RosMonitor(factory, options);
  return {
    monitor, connections,
    setRespond(next: typeof respond) { const previous = respond; respond = next; return previous; },
    async open() {
      monitor.connect('ws://localhost:9090');
      connections.at(-1)!.handlers.onOpen();
      await settle();
      return connections.at(-1)!;
    },
  };
}

test('WebSocket opening is separate from independently fetched ROS graph lists', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const previous = f.setRespond(async (call) => {
    if (call.service === '/rosapi/services') throw new Error('rosapi services unavailable');
    return previous(call);
  });
  f.monitor.connect('https://localhost:9090');
  assert.equal(f.connections.length, 0);
  assert.match(f.monitor.getSnapshot().error!, /ws:\/\//);
  f.monitor.connect('ws://localhost:9090');
  assert.equal(f.monitor.getSnapshot().status, 'connecting');
  f.monitor.connect('ws://another:9090');
  assert.equal(f.connections.length, 1);
  f.connections[0]!.handlers.onOpen();
  await settle();
  const snapshot = f.monitor.getSnapshot();
  assert.equal(snapshot.status, 'connected');
  assert.equal(snapshot.topics.status, 'ready');
  assert.deepEqual(snapshot.topics.items.map((item) => item.name), ['/accel', '/z']);
  assert.equal(snapshot.services.status, 'error');
  assert.match(snapshot.services.error!, /unavailable/);
});

test('new graph refresh cancels old requests and ignores late results', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  const delayed = deferred();
  let topicCalls = 0;
  const previous = f.setRespond((call) => call.service === '/rosapi/topics' && ++topicCalls === 1 ? delayed.promise : previous(call));
  const oldRefresh = f.monitor.refreshGraph();
  const oldCall = connection.calls.at(-2)!;
  await f.monitor.refreshGraph();
  assert.equal(oldCall.signal.aborted, true);
  delayed.resolve({ topics: ['/stale'], types: ['std_msgs/String'] });
  await oldRefresh;
  assert.equal(f.monitor.getSnapshot().topics.items.some((item) => item.name === '/stale'), false);
});

test('topic monitoring is explicit, bounded, and ignores stopped or previous subscription data', async (t) => {
  const f = fixture({ historyLimit: 2, messageTextLimit: 20, now: () => 1234 });
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  f.monitor.selectTopic('/accel');
  assert.equal(connection.subscriptions.length, 0);
  f.monitor.startTopic();
  f.monitor.startTopic();
  assert.equal(connection.subscriptions.length, 1);
  const subscription = connection.subscriptions[0]!;
  subscription.message({ x: 1 });
  subscription.message({ x: 2 });
  subscription.message({ x: 'a'.repeat(30) });
  const topic = f.monitor.getSnapshot().topic;
  assert.equal(topic.receivedCount, 3);
  assert.equal(topic.messages.length, 2);
  assert.equal(topic.messages[1]!.truncated, true);
  assert.equal(topic.messages[1]!.text.length, 20);
  assert.equal(topic.lastReceivedAt, 1234);
  f.monitor.stopTopic();
  subscription.message({ x: 'late' });
  assert.equal(f.monitor.getSnapshot().topic.receivedCount, 3);
  assert.equal(subscription.stopped, true);
  f.monitor.startTopic();
  f.monitor.selectTopic('/z');
  connection.subscriptions[1]!.message('another late message');
  assert.equal(f.monitor.getSnapshot().topic.receivedCount, 0);
  assert.equal(f.monitor.getSnapshot().topic.name, '/z');
  assert.equal(connection.subscriptions[1]!.stopped, true);
});

test('topic payload serialization tolerates unusual values and subscription errors stop monitoring', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  f.monitor.selectTopic('/accel');
  f.monitor.startTopic();
  const subscription = connection.subscriptions[0]!;
  const cyclic: Record<string, unknown> = { value: 2n };
  cyclic.self = cyclic;
  subscription.message(cyclic);
  assert.match(f.monitor.getSnapshot().topic.messages[0]!.text, /Circular/);
  subscription.error(new Error('not authorized'));
  assert.equal(f.monitor.getSnapshot().topic.status, 'error');
  assert.equal(subscription.stopped, true);
  subscription.message('ignored');
  assert.equal(f.monitor.getSnapshot().topic.receivedCount, 1);
  f.monitor.clearMessages();
  assert.equal(f.monitor.getSnapshot().topic.messages.length, 0);
  assert.equal(f.monitor.getSnapshot().topic.lastReceivedAt, null);
});

test('type detail failures still allow a service with a known type to accept JSON', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  await f.open();
  const previous = f.setRespond(async (call) => {
    if (call.service === '/rosapi/service_request_details') throw new Error('custom definitions unavailable');
    return previous(call);
  });
  await f.monitor.selectService('/start');
  const service = f.monitor.getSnapshot().service;
  assert.equal(service.status, 'ready');
  assert.equal(service.requestTypeDefs, null);
  assert.deepEqual(service.responseTypeDefs, [definition]);
  assert.match(service.detailsError!, /unavailable/);
  await f.monitor.callService('{"enabled":true}');
  assert.equal(f.monitor.getSnapshot().call.status, 'response');
  assert.match(f.monitor.getSnapshot().call.responseText, /"success": false/);
});

test('changing service selection aborts previous metadata and rejects stale definitions', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  const delayed = deferred();
  const previous = f.setRespond((call) => call.service === '/rosapi/service_type' && call.args.service === '/start' ? delayed.promise : previous(call));
  const firstSelection = f.monitor.selectService('/start');
  const oldCall = connection.calls.at(-1)!;
  await f.monitor.selectService('/reset');
  delayed.resolve({ type: 'stale/OldType' });
  await firstSelection;
  assert.equal(oldCall.signal.aborted, true);
  assert.equal(f.monitor.getSnapshot().service.name, '/reset');
  assert.equal(f.monitor.getSnapshot().service.type, 'demo/Action');
});

test('invalid JSON never sends a service request', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  await f.monitor.selectService('/start');
  const before = connection.calls.length;
  for (const text of ['{', 'null', '[]', '1', '"hello"']) {
    await f.monitor.callService(text);
    assert.equal(f.monitor.getSnapshot().call.status, 'error');
    assert.match(f.monitor.getSnapshot().call.error!, /送信していません/);
    assert.equal(f.monitor.getSnapshot().call.startedAt, null);
  }
  assert.equal(connection.calls.length, before);
});

test('one explicit call sends once and records the dispatched service across selection changes', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  await f.monitor.selectService('/start');
  const pending = deferred();
  const previous = f.setRespond((call) => call.service === '/start' ? pending.promise : previous(call));
  const call = f.monitor.callService('{"enabled":true}');
  await f.monitor.callService('{"enabled":false}');
  await f.monitor.selectService('/reset');
  assert.equal(connection.calls.filter((item) => item.service === '/start').length, 1);
  pending.resolve({ success: true });
  await call;
  assert.equal(f.monitor.getSnapshot().service.name, '/reset');
  assert.equal(f.monitor.getSnapshot().call.service, '/start');
  assert.equal(f.monitor.getSnapshot().call.url, 'ws://localhost:9090/');
  assert.equal(f.monitor.getSnapshot().call.requestText, '{"enabled":true}');
  assert.equal(f.monitor.getSnapshot().call.status, 'response');
});

test('a local deadline aborts transport and ignores a late service response without resending', async (t) => {
  const f = fixture({ requestTimeoutMs: 10 });
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  await f.monitor.selectService('/start');
  const pending = deferred();
  const previous = f.setRespond((call) => call.service === '/start' ? pending.promise : previous(call));
  await f.monitor.callService('{}');
  assert.equal(f.monitor.getSnapshot().call.status, 'timeout');
  assert.match(f.monitor.getSnapshot().call.error!, /実行されたかは不明/);
  const invocations = connection.calls.filter((item) => item.service === '/start');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]!.signal.aborted, true);
  pending.resolve({ late: true });
  await settle();
  assert.equal(f.monitor.getSnapshot().call.status, 'timeout');
});

test('disconnect marks an in-flight call uncertain, aborts it, and reconnect never replays it', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  await f.monitor.selectService('/start');
  const pending = deferred();
  const previous = f.setRespond((call) => call.service === '/start' ? pending.promise : previous(call));
  const call = f.monitor.callService('{}');
  connection.handlers.onClose();
  await call;
  assert.equal(f.monitor.getSnapshot().call.status, 'disconnected');
  assert.equal(connection.calls.at(-1)!.signal.aborted, true);
  const newer = await f.open();
  connection.handlers.onError(new Error('old error'));
  connection.handlers.onClose();
  pending.resolve({ late: true });
  await settle();
  assert.equal(f.monitor.getSnapshot().status, 'connected');
  assert.equal(f.monitor.getSnapshot().call.status, 'disconnected');
  assert.equal(newer.calls.some((item) => item.service === '/start'), false);
});

test('a connection deadline closes the transport and late open cannot resurrect it', async () => {
  const f = fixture({ connectTimeoutMs: 5 });
  f.monitor.connect('ws://localhost:9090');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.monitor.getSnapshot().status, 'disconnected');
  assert.equal(f.connections[0]!.closed, true);
  f.connections[0]!.handlers.onOpen();
  assert.equal(f.monitor.getSnapshot().status, 'disconnected');
  assert.equal(f.connections[0]!.calls.length, 0);
});

test('transport failures and malformed metadata are visible without treating them as ROS readiness', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const previous = f.setRespond((call) => call.service === '/rosapi/topics' ? Promise.resolve({ topics: ['/x'], types: [] }) : previous(call));
  const connection = await f.open();
  assert.equal(f.monitor.getSnapshot().topics.status, 'error');
  assert.equal(f.monitor.getSnapshot().status, 'connected');
  connection.handlers.onError(new Error('connection refused'));
  assert.equal(f.monitor.getSnapshot().status, 'disconnected');
  assert.equal(f.monitor.getSnapshot().error, 'connection refused');
});

test('graph refresh stops a changed topic and lets the same name subscribe with its new type', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  f.monitor.selectTopic('/accel');
  f.monitor.startTopic();
  connection.subscriptions[0]!.message({ x: 1 });
  let topics = { topics: ['/accel'], types: ['demo/NewAcceleration'] };
  const previous = f.setRespond((call) => call.service === '/rosapi/topics' ? Promise.resolve(topics) : previous(call));
  await f.monitor.refreshGraph();
  assert.equal(connection.subscriptions[0]!.stopped, true);
  assert.equal(f.monitor.getSnapshot().topic.name, '/accel');
  assert.equal(f.monitor.getSnapshot().topic.type, 'demo/NewAcceleration');
  assert.equal(f.monitor.getSnapshot().topic.status, 'stopped');
  assert.equal(f.monitor.getSnapshot().topic.messages.length, 0);
  f.monitor.selectTopic('/accel');
  f.monitor.startTopic();
  assert.equal(connection.subscriptions[1]!.type, 'demo/NewAcceleration');
  connection.subscriptions[0]!.message({ stale: true });
  assert.equal(f.monitor.getSnapshot().topic.receivedCount, 0);
  topics = { topics: [], types: [] };
  await f.monitor.refreshGraph();
  assert.equal(connection.subscriptions[1]!.stopped, true);
  assert.equal(f.monitor.getSnapshot().topic.name, '');
  assert.equal(f.monitor.getSnapshot().topic.type, '');
});

test('removing the selected service aborts metadata but preserves an already dispatched call', async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  const connection = await f.open();
  await f.monitor.selectService('/start');
  const pendingCall = deferred();
  const pendingMetadata = deferred();
  const previous = f.setRespond((call) => {
    if (call.service === '/start') return pendingCall.promise;
    if (call.service === '/rosapi/services') return Promise.resolve({ services: ['/start'] });
    if (call.service === '/rosapi/service_type' && call.args.service === '/reset') return pendingMetadata.promise;
    return previous(call);
  });
  const calling = f.monitor.callService('{}');
  const selecting = f.monitor.selectService('/reset');
  const metadataInvocation = connection.calls.at(-1)!;
  await f.monitor.refreshGraph();
  assert.equal(metadataInvocation.signal.aborted, true);
  assert.equal(f.monitor.getSnapshot().service.name, '');
  assert.equal(f.monitor.getSnapshot().service.status, 'idle');
  assert.equal(f.monitor.getSnapshot().call.status, 'pending');
  assert.equal(f.monitor.getSnapshot().call.service, '/start');
  pendingMetadata.resolve({ type: 'stale/RemovedService' });
  await selecting;
  assert.equal(f.monitor.getSnapshot().service.name, '');
  pendingCall.resolve({ accepted: true });
  await calling;
  assert.equal(f.monitor.getSnapshot().call.status, 'response');
  assert.equal(f.monitor.getSnapshot().call.service, '/start');
});
