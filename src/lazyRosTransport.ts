import type { RosTransport, RosTransportFactory } from './ros.ts';

type Loader = () => Promise<{ createRoslibTransport: RosTransportFactory }>;

/** Load the ROS library only when connecting, while allowing cancellation. */
export function lazyRosTransportFactory(load: Loader = () => import('./roslibTransport')): RosTransportFactory {
  return (url, handlers) => {
    let closed = false;
    let transport: RosTransport | undefined;
    void Promise.resolve().then(load).then(module => {
      if (!closed) transport = module.createRoslibTransport(url, handlers);
    }).catch((error: unknown) => {
      if (!closed) handlers.onError(error instanceof Error ? error : new Error('ROS接続の準備に失敗しました。'));
    });
    const ready = () => {
      if (!transport || closed) throw new Error('ROS接続の準備が完了していません。');
      return transport;
    };
    return {
      close() { closed = true; transport?.close(); },
      request(service, args, options) {
        try { return ready().request(service, args, options); }
        catch (error) { return Promise.reject(error); }
      },
      subscribe(topic, type, onMessage, onError) {
        return ready().subscribe(topic, type, onMessage, onError);
      },
    };
  };
}

export const createLazyRosTransport = lazyRosTransportFactory();
