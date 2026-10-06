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

// WebSocket の生成は非同期なので、切断要求後に生成された接続も閉じる。
// 終了済みの接続から遅れて届くイベントは上位へ渡さない。
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

  /** イベント転送を止めて接続を閉じる。複数回呼んでも終了処理は一度だけ行う。 */
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

// roslib 標準の送信待ちキューを使わず、要求は接続中に一度だけ送信する。
// 再接続時にサービスが再実行されることを防ぐ。
class NonQueuingRos extends Ros {
  private readonly active: () => boolean;

  constructor(factory: ITransportFactory, active: () => boolean) {
    super({ transportFactory: factory });
    this.active = active;
  }

  /** 接続中に即時送信する。未接続なら例外にし、再接続後の送信予約を残さない。 */
  override callOnConnection(message: RosbridgeMessage): void {
    if (!this.active() || !this.isConnected) throw disconnectedError();
    super.callOnConnection(message);
  }
}

/**
 * roslib の通信を、要求の対応付け・中断・購読解除を備えたアプリ用APIへ変換する。
 * @param transportFactory WebSocket生成処理。テストでは通信だけを差し替える。
 * @returns URLと通知先を受け取って接続を開始するファクトリー。自動再接続はしない。
 */
export function createRoslibTransportFactory(
  transportFactory: ITransportFactory = WebSocketTransportFactory,
): RosTransportFactory {
  return (url, handlers) => {
    let closed = false;
    let opened = false;
    let transport: GatedTransport | undefined;
    let requestId = 0;
    const pendingRequestFailures = new Set<(error: Error) => void>();
    const subscriptionStops = new Set<() => void>();
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

    /** 未完了の要求と購読をすべて終了し、切断またはエラーを一度だけ通知する。 */
    function finish(error: Error, reason: 'close' | 'error'): void {
      if (closed) return;
      closed = true;
      opened = false;
      for (const reject of [...pendingRequestFailures]) reject(error);
      for (const unsubscribe of [...subscriptionStops]) unsubscribe();
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

    // 同期的な生成失敗も、呼び出し元が切断用ハンドルを受け取った後で通知する。
    void Promise.resolve().then(async () => {
      if (closed) return;
      await ros.connect(url);
      if (closed) transport?.close();
    }).catch((error: unknown) => finish(asError(error), 'error'));

    return {
      close: () => finish(disconnectedError(), 'close'),

      /**
       * サービスへ一度だけ送信し、要求IDに対応する応答の values を返す。
       * 中断・切断・期限切れはPromiseを失敗させるが、ROS側の実行取り消しは保証しない。
       * timeoutMs は正のミリ秒。失敗した要求を次の接続へ再送しない。
       */
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

          /** 成功・失敗のどちらでも、この要求に属する待機処理をすべて解除する。 */
          function cleanup(): void {
            if (timer !== undefined) clearTimeout(timer);
            ros.off(id, onResponse);
            ros.off(statusId, onStatus);
            signal.removeEventListener('abort', onAbort);
            pendingRequestFailures.delete(fail);
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

          /** 同じIDの応答でも形式とサービス名を検証し、bridgeが受理した内容だけを返す。 */
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

          pendingRequestFailures.add(fail);
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

      /**
       * topicを受信し、何度呼んでも安全な解除関数を返す。失敗は onError へ通知する。
       * bridgeに100ms間隔・待ち行列1件を指定するため、全メッセージの記録には使わない。
       */
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
          subscriptionStops.delete(stop);
          try {
            topic.unsubscribe(receive);
          } catch {
            // Topic は unsubscribe 送信前にリスナーを除去する。
            // 切断済みなら ID も破棄し、購読解除要求を次の接続へ持ち越さない。
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

        // 同期応答する通信実装でもエラーを取りこぼさないよう、送信前に ID を登録する。
        topic.callForSubscribeAndAdvertise = (message) => {
          if (message.id) {
            statusId = `status:${message.id}`;
            ros.on(statusId, onStatus);
          }
          ros.callOnConnection(message);
        };
        subscriptionStops.add(stop);
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
