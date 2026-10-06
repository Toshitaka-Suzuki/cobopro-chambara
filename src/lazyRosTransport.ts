import type { RosTransport, RosTransportFactory } from './ros.ts';

type RosTransportLoader = () => Promise<{ createRoslibTransport: RosTransportFactory }>;

/**
 * 呼び出し時にライブラリを読み込んで接続する生成関数を返す。この関数自体は通信を開始しない。
 * 読み込み中に閉じられた接続は開始せず、読み込み失敗は閉じられていない接続の onError へ通知する。
 */
export function lazyRosTransportFactory(load: RosTransportLoader = () => import('./roslibTransport')): RosTransportFactory {
  return (url, handlers) => {
    let closed = false;
    let transport: RosTransport | undefined;
    void Promise.resolve().then(load).then(module => {
      if (!closed) transport = module.createRoslibTransport(url, handlers);
    }).catch((error: unknown) => {
      if (!closed) handlers.onError(error instanceof Error ? error : new Error('ROS接続の準備に失敗しました。'));
    });
    const requireTransport = () => {
      if (!transport || closed) throw new Error('ROS接続の準備が完了していません。');
      return transport;
    };
    return {
      /** 読み込み後の接続開始を抑止し、生成済みの通信があれば閉じる。 */
      close() { closed = true; transport?.close(); },
      /** 生成済みの通信へ要求を渡す。準備前・切断後は送信せず reject する。 */
      request(service, args, options) {
        try { return requireTransport().request(service, args, options); }
        catch (error) { return Promise.reject(error); }
      },
      /** 生成済みの通信を購読する。準備前・切断後の呼び出しは例外にする。 */
      subscribe(topic, type, onMessage, onError) {
        return requireTransport().subscribe(topic, type, onMessage, onError);
      },
    };
  };
}

/** 本番用の接続生成関数。呼び出すまで roslib の読み込みと接続を遅延する。 */
export const createLazyRosTransport = lazyRosTransportFactory();
