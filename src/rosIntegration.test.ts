import test from 'node:test';
import assert from 'node:assert/strict';
import { AbstractTransport, type RosbridgeMessage } from 'roslib';
import { RosMonitor } from './ros.ts';
import { createRoslibTransportFactory } from './roslibTransport.ts';

// In-memory bridge: real roslib decoding and protocol, no network or robot.
class Bridge extends AbstractTransport {
  sent: RosbridgeMessage[] = [];
  state = 'connecting';
  holdCalls = false;

  open() { this.state = 'open'; this.emit('open', {}); }
  close() { this.state = 'closed'; this.emit('close', {}); }
  isConnecting() { return this.state === 'connecting'; }
  isOpen() { return this.state === 'open'; }
  isClosing() { return false; }
  isClosed() { return this.state === 'closed'; }
  receive(message: object) { this.handleRawMessage(JSON.stringify(message)); }

  send(message: RosbridgeMessage) {
    this.sent.push(message);
    if (message.op !== 'call_service') return;
    if (this.holdCalls && message.service === '/lights/set') return;
    const metadata: Record<string, unknown> = {
      '/rosapi/topics': { topics: ['/sword/contact'], types: ['std_msgs/msg/Bool'] },
      '/rosapi/services': { services: ['/lights/set'] },
      '/rosapi/service_type': { type: 'std_srvs/srv/SetBool' },
      '/rosapi/service_request_details': { typedefs: [{ type: 'std_srvs/SetBool_Request', fieldnames: ['data'], fieldtypes: ['bool'], fieldarraylen: [-1] }] },
      '/rosapi/service_response_details': { typedefs: [{ type: 'std_srvs/SetBool_Response', fieldnames: ['success', 'message'], fieldtypes: ['bool', 'string'], fieldarraylen: [-1, -1] }] },
    };
    queueMicrotask(() => this.receive({
      op: 'service_response', id: message.id, service: message.service, result: true,
      values: metadata[message.service] ?? { success: false, message: 'lamp unavailable' },
    }));
  }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('ROS discovery, selected topic and service response pass through the actual roslib protocol', async t => {
  const bridges: Bridge[] = [];
  const monitor = new RosMonitor(createRoslibTransportFactory(async () => {
    const bridge = new Bridge();
    bridges.push(bridge);
    return bridge;
  }));
  t.after(() => monitor.disconnect());
  monitor.connect('ws://localhost:9090');
  await flush();
  const bridge = bridges[0]!;
  bridge.open();
  await flush();
  assert.equal(monitor.getSnapshot().status, 'connected');
  assert.deepEqual(monitor.getSnapshot().topics.items, [{ name: '/sword/contact', type: 'std_msgs/msg/Bool' }]);
  assert.equal(bridge.sent.some(message => message.op === 'subscribe'), false);

  monitor.selectTopic('/sword/contact');
  monitor.startTopic();
  bridge.receive({ op: 'publish', topic: '/sword/contact', msg: { data: true } });
  assert.equal(monitor.getSnapshot().topic.receivedCount, 1);
  assert.deepEqual(JSON.parse(monitor.getSnapshot().topic.messages[0]!.text), { data: true });
  monitor.stopTopic();
  bridge.receive({ op: 'publish', topic: '/sword/contact', msg: { data: false } });
  assert.equal(monitor.getSnapshot().topic.receivedCount, 1);
  assert.equal(monitor.getSnapshot().status, 'connected');

  await monitor.selectService('/lights/set');
  assert.equal(monitor.getSnapshot().service.type, 'std_srvs/srv/SetBool');
  assert.equal(monitor.getSnapshot().service.requestTypeDefs?.[0]?.fieldnames[0], 'data');
  await monitor.callService('{"data":true}');
  assert.equal(monitor.getSnapshot().call.status, 'response');
  assert.deepEqual(JSON.parse(monitor.getSnapshot().call.responseText), { success: false, message: 'lamp unavailable' });
  const invocations = bridge.sent.filter(message => message.op === 'call_service' && message.service === '/lights/set');
  assert.equal(invocations.length, 1);

  bridge.holdCalls = true;
  const pending = monitor.callService('{"data":false}');
  bridge.close();
  await pending;
  assert.equal(monitor.getSnapshot().call.status, 'disconnected');
  monitor.connect('ws://localhost:9091');
  await flush();
  bridges[1]!.open();
  await flush();
  assert.equal(monitor.getSnapshot().status, 'connected');
  assert.equal(bridges[1]!.sent.some(message => message.op === 'call_service' && message.service === '/lights/set'), false);
  assert.equal(bridges[1]!.sent.some(message => message.op === 'subscribe'), false);
});
