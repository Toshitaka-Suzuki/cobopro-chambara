import {
  AbstractTransport,
  Ros,
  Topic,
  WebSocketTransportFactory,
  isRosbridgeServiceResponseMessage,
  isRosbridgeStatusMessage,
  type ITransport,
  type ITransportFactory,
  type RosbridgeMessage,
} from 'roslib';
import type { RosTransportFactory } from './ros.ts';

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function disconnectedError(): Error {
  return namedError('DisconnectedError', 'rosbridge との接続が切れました。');
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : 'rosbridge に接続できませんでした。URL と接続先を確認してください。');
}

// The library creates WebSockets asynchronously. This gate also owns transports
// that arrive after the user has disconnected, and drops all late events.
class GatedTransport extends AbstractTransport {
  private stopped = false;
  private readonly source: ITransport;

  constructor(source: ITransport) {
    super();
    this.source = source;
    source.on('open', (event) => { if (!this.stopped) this.emit('open', event); });
    source.on('close', (event) => { if (!this.stopped) this.emit('close', event); });
    source.on('error', (event) => { if (!this.stopped) this.emit('error', event); });
    source.on('message', (message) => { if (!this.stopped) this.emit('message', message); });
  }

  send(message: RosbridgeMessage): void {
    if (!this.isOpen()) throw disconnectedError();
    this.source.send(message);
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.removeAllListeners();
    if (!this.source.isClosed() && !this.source.isClosing()) this.source.close();
  }

  isConnecting(): boolean { return !this.stopped && this.source.isConnecting(); }
  isOpen(): boolean { return !this.stopped && this.source.isOpen(); }
  isClosing(): boolean { return this.source.isClosing(); }
  isClosed(): boolean { return this.stopped || this.source.isClosed(); }
}

// Ros normally queues outgoing messages until the next connection. Explorer
// operations are one-shot: reconnecting must never replay a service invocation.
class NonQueuingRos extends Ros {
  private readonly active: () => boolean;

  constructor(factory: ITransportFactory, active: () => boolean) {
    super({ transportFactory: factory });
    this.active = active;
  }

  override callOnConnection(message: RosbridgeMessage): void {
    if (!this.active() || !this.isConnected) throw disconnectedError();
    super.callOnConnection(message);
  }
}

/** The factory argument allows protocol tests to use the real Ros/Topic library. */
export function createRoslibTransportFactory(
  transportFactory: ITransportFactory = WebSocketTransportFactory,
): RosTransportFactory {
  return (url, handlers) => {
    let closed = false;
    let opened = false;
    let transport: GatedTransport | undefined;
    let requestId = 0;
    const pending = new Set<(error: Error) => void>();
    const subscriptions = new Set<() => void>();
    const ros = new NonQueuingRos(async (endpoint) => {
      if (closed) throw disconnectedError();
      const source = await transportFactory(endpoint);
      transport = new GatedTransport(source);
      if (closed) {
        transport.close();
        throw disconnectedError();
      }
      return transport;
    }, () => !closed);

    const connected = () => !closed && opened && ros.isConnected && transport?.isOpen() === true;

    function finish(error: Error, reason: 'close' | 'error'): void {
      if (closed) return;
      closed = true;
      opened = false;
      for (const reject of [...pending]) reject(error);
      for (const unsubscribe of [...subscriptions]) unsubscribe();
      ros.removeAllListeners();
      transport?.close();
      if (reason === 'error') handlers.onError(error);
      else handlers.onClose();
    }

    ros.on('connection', () => {
      if (closed || opened) return;
      opened = true;
      handlers.onOpen();
    });
    ros.on('close', () => finish(disconnectedError(), 'close'));
    ros.on('error', (error) => finish(asError(error), 'error'));

    // Defer even synchronous factory failures until the caller has its handle.
    void Promise.resolve().then(async () => {
      if (closed) return;
      await ros.connect(url);
      if (closed) transport?.close();
    }).catch((error: unknown) => finish(asError(error), 'error'));

    return {
      close: () => finish(disconnectedError(), 'close'),

      request(service, args, { signal, timeoutMs }) {
        if (signal.aborted) return Promise.reject(namedError('AbortError', 'リクエストを中断しました。'));
        if (!connected()) return Promise.reject(disconnectedError());
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          return Promise.reject(new Error('応答待ち時間は正の数で指定してください。'));
        }

        return new Promise<unknown>((resolve, reject) => {
          const id = `admin-service:${++requestId}`;
          const statusId = `status:${id}`;
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;

          function cleanup(): void {
            if (timer !== undefined) clearTimeout(timer);
            ros.off(id, onResponse);
            ros.off(statusId, onStatus);
            signal.removeEventListener('abort', onAbort);
            pending.delete(fail);
          }

          function fail(error: Error): void {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          }

          function onAbort(): void {
            fail(namedError('AbortError', 'リクエストを中断しました。'));
          }

          function onResponse(message: RosbridgeMessage): void {
            if (settled) return;
            if (!isRosbridgeServiceResponseMessage(message) || message.service !== service) {
              fail(new Error('サービス応答の形式が一致しません。'));
            } else if (message.result !== true) {
              fail(new Error(typeof message.values === 'string' ? message.values : 'rosbridge がサービス呼び出しを拒否しました。'));
            } else {
              settled = true;
              cleanup();
              resolve(message.values);
            }
          }

          function onStatus(message: RosbridgeMessage): void {
            if (isRosbridgeStatusMessage(message) && message.level === 'error') {
              fail(new Error(message.msg));
            }
          }

          pending.add(fail);
          ros.on(id, onResponse);
          ros.on(statusId, onStatus);
          signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => fail(namedError('TimeoutError', '応答待ちがタイムアウトしました。実行されたかどうかは確認できません。')), timeoutMs);
          try {
            ros.callOnConnection({ op: 'call_service', id, service, args, timeout: timeoutMs / 1000 });
          } catch (error) {
            fail(asError(error));
          }
        });
      },

      subscribe(name, type, onMessage, onError) {
        if (!connected()) {
          onError(disconnectedError());
          return () => {};
        }
        const topic = new Topic({
          ros, name, messageType: type,
          throttle_rate: 100, queue_length: 1, reconnect_on_close: false,
        });
        let stopped = false;
        let statusId: string | undefined;
        const receive = (message: unknown) => {
          if (!stopped && connected()) onMessage(message);
        };
        const stop = () => {
          if (stopped) return;
          stopped = true;
          if (statusId) ros.off(statusId, onStatus);
          subscriptions.delete(stop);
          try {
            topic.unsubscribe(receive);
          } catch {
            // Topic removes its Ros listener before sending unsubscribe. The
            // connection may already be gone; NonQueuingRos prevents replay.
            topic.subscribeId = null;
          }
          topic.removeAllListeners();
        };
        const onStatus = (message: RosbridgeMessage) => {
          if (!stopped && isRosbridgeStatusMessage(message) && message.level === 'error') {
            stop();
            onError(new Error(message.msg));
          }
        };

        // Register status correlation before sending (also useful with a local
        // transport that answers synchronously).
        topic.callForSubscribeAndAdvertise = (message) => {
          if (message.id) {
            statusId = `status:${message.id}`;
            ros.on(statusId, onStatus);
          }
          ros.callOnConnection(message);
        };
        subscriptions.add(stop);
        try {
          topic.subscribe(receive);
        } catch (error) {
          stop();
          onError(asError(error));
        }
        return stop;
      },
    };
  };
}

export const createRoslibTransport: RosTransportFactory = createRoslibTransportFactory();
