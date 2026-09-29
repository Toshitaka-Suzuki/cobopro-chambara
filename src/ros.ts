export type RosTopicInfo = { name: string; type: string };
export type RosTypeDef = {
  type: string;
  fieldnames: string[];
  fieldtypes: string[];
  fieldarraylen: number[];
  examples?: string[];
};
export type RosTransport = {
  close(): void;
  request(service: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs: number }): Promise<unknown>;
  subscribe(topic: string, type: string, onMessage: (message: unknown) => void, onError: (error: Error) => void): () => void;
};
export type RosTransportFactory = (
  url: string,
  handlers: { onOpen(): void; onClose(): void; onError(error: Error): void },
) => RosTransport;
export type RosListState<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: T[];
  error: string | null;
  updatedAt: number | null;
};
export type RosMessage = { id: number; receivedAt: number; text: string; truncated: boolean };
export type RosSnapshot = {
  status: 'disconnected' | 'connecting' | 'connected';
  url: string;
  error: string | null;
  topics: RosListState<RosTopicInfo>;
  services: RosListState<{ name: string }>;
  topic: {
    name: string;
    type: string;
    status: 'stopped' | 'subscribed' | 'error';
    messages: RosMessage[];
    receivedCount: number;
    lastReceivedAt: number | null;
    error: string | null;
  };
  service: {
    name: string;
    type: string;
    status: 'idle' | 'loading' | 'ready' | 'error';
    requestTypeDefs: RosTypeDef[] | null;
    responseTypeDefs: RosTypeDef[] | null;
    detailsError: string | null;
    error: string | null;
  };
  call: {
    status: 'idle' | 'pending' | 'response' | 'error' | 'timeout' | 'disconnected';
    service: string;
    type: string;
    url: string;
    requestText: string;
    responseText: string;
    responseTruncated: boolean;
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
  };
};

type Session = {
  transport: RosTransport | null;
  controller: AbortController;
  graphController: AbortController | null;
  serviceController: AbortController | null;
  unsubscribe: (() => void) | null;
  topicGeneration: number;
  connectTimer: ReturnType<typeof setTimeout> | null;
};
type RosMonitorOptions = {
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  historyLimit?: number;
  messageTextLimit?: number;
  now?: () => number;
};

const emptyList = <T>(): RosListState<T> => ({ status: 'idle', items: [], error: null, updatedAt: null });
const emptyTopic = (): RosSnapshot['topic'] => ({ name: '', type: '', status: 'stopped', messages: [], receivedCount: 0, lastReceivedAt: null, error: null });
const emptyService = (): RosSnapshot['service'] => ({ name: '', type: '', status: 'idle', requestTypeDefs: null, responseTypeDefs: null, detailsError: null, error: null });
const emptyCall = (): RosSnapshot['call'] => ({ status: 'idle', service: '', type: '', url: '', requestText: '', responseText: '', responseTruncated: false, error: null, startedAt: null, finishedAt: null });
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const abortError = () => new DOMException('操作は中止されました。', 'AbortError');
const timeoutError = () => new DOMException('応答が制限時間内に届きませんでした。', 'TimeoutError');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rosapiの応答形式を確認できませんでした。');
  return value as Record<string, unknown>;
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('rosapiの応答形式を確認できませんでした。');
  return value;
}
function typeDefs(value: unknown): RosTypeDef[] {
  const defs = object(value).typedefs;
  if (!Array.isArray(defs)) throw new Error('型の情報を確認できませんでした。');
  return defs.map((item) => {
    const def = object(item);
    const fieldnames = stringArray(def.fieldnames);
    const fieldtypes = stringArray(def.fieldtypes);
    if (typeof def.type !== 'string' || fieldnames.length !== fieldtypes.length || !Array.isArray(def.fieldarraylen) || def.fieldarraylen.length !== fieldnames.length || def.fieldarraylen.some((length) => !Number.isInteger(length))) {
      throw new Error('型の情報を確認できませんでした。');
    }
    return { type: def.type, fieldnames, fieldtypes, fieldarraylen: def.fieldarraylen as number[], ...(Array.isArray(def.examples) ? { examples: stringArray(def.examples) } : {}) };
  });
}
function jsonText(value: unknown, limit: number): { text: string; truncated: boolean } {
  const seen = new WeakSet<object>();
  let text: string;
  try {
    text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString();
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }, 2) ?? String(value);
  } catch {
    text = '受信データをJSONとして表示できませんでした。';
  }
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

/** A ROS explorer session. The transport is injected so no robot is needed in tests. */
export class RosMonitor {
  private readonly factory: RosTransportFactory;
  private readonly options: Required<RosMonitorOptions>;
  private readonly listeners = new Set<(snapshot: RosSnapshot) => void>();
  private session: Session | null = null;
  private messageId = 0;
  private snapshot: RosSnapshot = {
    status: 'disconnected', url: 'ws://localhost:9090', error: null,
    topics: emptyList(), services: emptyList(), topic: emptyTopic(), service: emptyService(), call: emptyCall(),
  };

  constructor(factory: RosTransportFactory, options: RosMonitorOptions = {}) {
    this.factory = factory;
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? 10000,
      connectTimeoutMs: options.connectTimeoutMs ?? 10000,
      historyLimit: Math.max(1, options.historyLimit ?? 100),
      messageTextLimit: Math.max(1, options.messageTextLimit ?? 16000),
      now: options.now ?? Date.now,
    };
  }

  getSnapshot = (): RosSnapshot => this.snapshot;
  subscribeState = (listener: (snapshot: RosSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  connect(url: string): void {
    if (this.session) return;
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
      if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.hash || parsed.username || parsed.password) throw new Error();
    } catch {
      this.update({ error: '接続先をws://またはwss://で指定してください（認証情報・フラグメントは指定できません）。' });
      return;
    }
    const session: Session = {
      transport: null, controller: new AbortController(), graphController: null,
      serviceController: null, unsubscribe: null, topicGeneration: 0, connectTimer: null,
    };
    this.session = session;
    this.update({
      status: 'connecting', url: parsed.href, error: null,
      topics: emptyList(), services: emptyList(), topic: emptyTopic(), service: emptyService(),
    });
    session.connectTimer = setTimeout(() => {
      if (this.session !== session) return;
      this.endSession(session, 'WebSocket接続が制限時間内に開きませんでした。');
    }, this.options.connectTimeoutMs);
    try {
      session.transport = this.factory(parsed.href, {
        onOpen: () => {
          if (this.session !== session || this.snapshot.status !== 'connecting') return;
          if (session.connectTimer) clearTimeout(session.connectTimer);
          session.connectTimer = null;
          this.update({ status: 'connected', error: null });
          void this.refreshGraph();
        },
        onClose: () => { if (this.session === session) this.endSession(session, 'WebSocket接続が閉じられました。'); },
        onError: (error) => { if (this.session === session) this.endSession(session, errorText(error)); },
      });
    } catch (error) {
      this.endSession(session, errorText(error));
    }
  }

  disconnect(): void {
    if (this.session) this.endSession(this.session, null);
  }

  async refreshGraph(): Promise<void> {
    const session = this.connectedSession();
    if (!session) return;
    session.graphController?.abort();
    const controller = new AbortController();
    session.graphController = controller;
    this.update({
      topics: { ...this.snapshot.topics, status: 'loading', error: null },
      services: { ...this.snapshot.services, status: 'loading', error: null },
    });
    const current = () => this.session === session && session.graphController === controller && !controller.signal.aborted;
    await Promise.all([
      this.request(session, '/rosapi/topics', {}, controller.signal).then((value) => {
        if (!current()) return;
        const response = object(value);
        const topics = stringArray(response.topics);
        const types = stringArray(response.types);
        if (topics.length !== types.length) throw new Error('topic名と型の対応を確認できませんでした。');
        const items = topics.map((name, index) => ({ name, type: types[index]! })).sort((a, b) => a.name.localeCompare(b.name));
        const selected = this.snapshot.topic;
        const refreshed = items.find((item) => item.name === selected.name);
        if (selected.name && (!refreshed || refreshed.type !== selected.type)) {
          this.stopTopic();
          this.update({ topic: refreshed ? { ...emptyTopic(), ...refreshed } : emptyTopic() });
        }
        this.update({ topics: { status: 'ready', items, error: null, updatedAt: this.options.now() } });
      }).catch((error: unknown) => {
        if (current()) this.update({ topics: { ...this.snapshot.topics, status: 'error', error: errorText(error) } });
      }),
      this.request(session, '/rosapi/services', {}, controller.signal).then((value) => {
        if (!current()) return;
        const items = stringArray(object(value).services).map((name) => ({ name })).sort((a, b) => a.name.localeCompare(b.name));
        if (this.snapshot.service.name && !items.some((item) => item.name === this.snapshot.service.name)) {
          session.serviceController?.abort();
          session.serviceController = null;
          this.update({ service: emptyService() });
        }
        this.update({ services: { status: 'ready', items, error: null, updatedAt: this.options.now() } });
      }).catch((error: unknown) => {
        if (current()) this.update({ services: { ...this.snapshot.services, status: 'error', error: errorText(error) } });
      }),
    ]);
  }

  selectTopic(name: string): void {
    if (this.snapshot.topic.name === name) return;
    this.stopTopic();
    const selected = this.snapshot.topics.items.find((topic) => topic.name === name);
    this.update({ topic: selected ? { ...emptyTopic(), ...selected } : emptyTopic() });
  }

  startTopic(): void {
    const session = this.connectedSession();
    const { name, type, status } = this.snapshot.topic;
    if (!session || !name || !type || status === 'subscribed') return;
    this.stopTopic();
    const generation = ++session.topicGeneration;
    const current = () => this.session === session && session.topicGeneration === generation;
    this.update({ topic: { ...this.snapshot.topic, status: 'subscribed', error: null } });
    try {
      const unsubscribe = session.transport!.subscribe(name, type, (message) => {
        if (!current()) return;
        const receivedAt = this.options.now();
        const entry: RosMessage = { id: ++this.messageId, receivedAt, ...jsonText(message, this.options.messageTextLimit) };
        const topic = this.snapshot.topic;
        this.update({ topic: { ...topic, messages: [...topic.messages, entry].slice(-this.options.historyLimit), receivedCount: topic.receivedCount + 1, lastReceivedAt: receivedAt } });
      }, (error) => {
        if (!current()) return;
        this.stopTopic();
        this.update({ topic: { ...this.snapshot.topic, status: 'error', error: errorText(error) } });
      });
      if (current()) session.unsubscribe = unsubscribe;
      else unsubscribe();
    } catch (error) {
      if (current()) {
        this.stopTopic();
        this.update({ topic: { ...this.snapshot.topic, status: 'error', error: errorText(error) } });
      }
    }
  }

  stopTopic(): void {
    const session = this.session;
    if (session) {
      ++session.topicGeneration;
      const unsubscribe = session.unsubscribe;
      session.unsubscribe = null;
      try { unsubscribe?.(); } catch { /* The session may already be closed. */ }
    }
    if (this.snapshot.topic.status === 'subscribed') this.update({ topic: { ...this.snapshot.topic, status: 'stopped' } });
  }

  clearMessages(): void {
    this.update({ topic: { ...this.snapshot.topic, messages: [], receivedCount: 0, lastReceivedAt: null } });
  }

  async selectService(name: string): Promise<void> {
    const session = this.connectedSession();
    if (!session) return;
    session.serviceController?.abort();
    const controller = new AbortController();
    session.serviceController = controller;
    if (!name || !this.snapshot.services.items.some((service) => service.name === name)) {
      this.update({ service: emptyService() });
      return;
    }
    this.update({ service: { ...emptyService(), name, status: 'loading' } });
    const current = () => this.session === session && session.serviceController === controller && !controller.signal.aborted;
    try {
      const response = object(await this.request(session, '/rosapi/service_type', { service: name }, controller.signal));
      if (!current()) return;
      if (typeof response.type !== 'string' || !response.type) throw new Error('サービスの型を確認できませんでした。');
      const type = response.type;
      this.update({ service: { ...this.snapshot.service, type } });
      const [request, responseDetails] = await Promise.allSettled([
        this.request(session, '/rosapi/service_request_details', { type }, controller.signal).then(typeDefs),
        this.request(session, '/rosapi/service_response_details', { type }, controller.signal).then(typeDefs),
      ]);
      if (!current()) return;
      const errors = [request, responseDetails].flatMap((result) => result.status === 'rejected' ? [errorText(result.reason)] : []);
      this.update({ service: {
        ...this.snapshot.service, status: 'ready',
        requestTypeDefs: request.status === 'fulfilled' ? request.value : null,
        responseTypeDefs: responseDetails.status === 'fulfilled' ? responseDetails.value : null,
        detailsError: errors.length ? [...new Set(errors)].join(' / ') : null,
      } });
    } catch (error) {
      if (current()) this.update({ service: { ...this.snapshot.service, status: 'error', error: errorText(error) } });
    }
  }

  async callService(requestText: string): Promise<void> {
    const session = this.connectedSession();
    if (!session || this.snapshot.call.status === 'pending') return;
    const service = this.snapshot.service;
    if (service.status !== 'ready' || !service.name || !service.type) return;
    let args: Record<string, unknown>;
    try {
      if (requestText.length > 65536) throw new Error('リクエストは65,536文字以内にしてください。');
      const parsed: unknown = JSON.parse(requestText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('リクエストにはJSONオブジェクトを入力してください。');
      args = parsed as Record<string, unknown>;
    } catch (error) {
      this.update({ call: { ...emptyCall(), status: 'error', service: service.name, type: service.type, url: this.snapshot.url, requestText, error: `送信していません: ${errorText(error)}` } });
      return;
    }
    const call: RosSnapshot['call'] = { ...emptyCall(), status: 'pending', service: service.name, type: service.type, url: this.snapshot.url, requestText, startedAt: this.options.now() };
    this.update({ call });
    try {
      const response = await this.request(session, service.name, args);
      if (this.session !== session || this.snapshot.call !== call) return;
      const rendered = jsonText(response, 65536);
      this.update({ call: { ...call, status: 'response', responseText: rendered.text, responseTruncated: rendered.truncated, finishedAt: this.options.now() } });
    } catch (error) {
      if (this.session !== session || this.snapshot.call !== call) return;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      this.update({ call: { ...call, status: timedOut ? 'timeout' : 'error', error: timedOut ? '応答が制限時間内に届きませんでした。実行されたかは不明です。自動で再送しません。' : errorText(error), finishedAt: this.options.now() } });
    }
  }

  private connectedSession(): Session | null {
    return this.snapshot.status === 'connected' && this.session?.transport ? this.session : null;
  }

  private request(session: Session, service: string, args: Record<string, unknown>, parentSignal?: AbortSignal): Promise<unknown> {
    if (this.session !== session || this.snapshot.status !== 'connected' || !session.transport) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let finished = false;
      const finish = (error: unknown, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        session.controller.signal.removeEventListener('abort', abort);
        parentSignal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => {
        finish(abortError());
        controller.abort();
      };
      const timer = setTimeout(() => {
        finish(timeoutError());
        controller.abort();
      }, this.options.requestTimeoutMs);
      session.controller.signal.addEventListener('abort', abort, { once: true });
      parentSignal?.addEventListener('abort', abort, { once: true });
      if (session.controller.signal.aborted || parentSignal?.aborted) {
        abort();
        return;
      }
      try {
        session.transport!.request(service, args, { signal: controller.signal, timeoutMs: this.options.requestTimeoutMs }).then((value) => finish(null, value), (error: unknown) => finish(error));
      } catch (error) { finish(error); }
    });
  }

  private endSession(session: Session, error: string | null): void {
    if (this.session !== session) return;
    this.stopTopic();
    this.session = null;
    if (session.connectTimer) clearTimeout(session.connectTimer);
    session.controller.abort();
    session.graphController?.abort();
    session.serviceController?.abort();
    try { session.transport?.close(); } catch { /* The connection may already be closed. */ }
    const call = this.snapshot.call.status === 'pending' ? {
      ...this.snapshot.call, status: 'disconnected' as const, finishedAt: this.options.now(),
      error: '応答を待っている間に接続が切れました。実行されたかは不明です。自動で再送しません。',
    } : this.snapshot.call;
    const topics = this.snapshot.topics.status === 'loading' ? { ...this.snapshot.topics, status: 'error' as const, error: '取得中に接続が切れました。' } : this.snapshot.topics;
    const services = this.snapshot.services.status === 'loading' ? { ...this.snapshot.services, status: 'error' as const, error: '取得中に接続が切れました。' } : this.snapshot.services;
    const service = this.snapshot.service.status === 'loading' ? { ...this.snapshot.service, status: 'error' as const, error: '型情報の取得中に接続が切れました。' } : this.snapshot.service;
    this.update({ status: 'disconnected', error, call, topics, services, service });
  }

  private update(update: Partial<RosSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) {
      try { listener(this.snapshot); } catch { /* One view cannot prevent the remaining views from updating. */ }
    }
  }
}
