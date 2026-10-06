import { parseRosRequest } from './rosSchema.ts';

export const DEFAULT_ROSBRIDGE_URL = 'ws://localhost:9090';

const SERVICE_RESPONSE_TEXT_LIMIT = 65_536;

export type RosTopicInfo = { name: string; type: string };
export type RosTypeDef = {
  type: string;
  fieldnames: string[];
  fieldtypes: string[];
  fieldarraylen: number[];
  examples?: string[];
};
export type RosTransport = {
  /** 接続と進行中の通信を終了する。終了後の要求を再接続時に再送しない。 */
  close(): void;
  /** サービスへ一度だけ送信し、応答を返す。切断・中断・待ち時間超過は reject する。 */
  request(service: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs: number }): Promise<unknown>;
  /** topic の受信を開始し、購読解除関数を返す。受信の失敗は onError へ通知する。 */
  subscribe(topic: string, type: string, onMessage: (message: unknown) => void, onError: (error: Error) => void): () => void;
};
/** 通信ハンドルを直ちに返す。接続イベントは呼び出し元がハンドルを受け取った後に通知する。 */
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
function requireResponseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rosapiの応答形式を確認できませんでした。');
  return value as Record<string, unknown>;
}
function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('rosapiの応答形式を確認できませんでした。');
  return value;
}
/** rosapi の型定義を検証し、フィールド名・型・配列長の対応が不正なら例外にする。 */
function parseRosTypeDefs(value: unknown): RosTypeDef[] {
  const defs = requireResponseObject(value).typedefs;
  if (!Array.isArray(defs)) throw new Error('型の情報を確認できませんでした。');
  return defs.map((item) => {
    const def = requireResponseObject(item);
    const fieldnames = requireStringArray(def.fieldnames);
    const fieldtypes = requireStringArray(def.fieldtypes);
    if (typeof def.type !== 'string' || fieldnames.length !== fieldtypes.length || !Array.isArray(def.fieldarraylen) || def.fieldarraylen.length !== fieldnames.length || def.fieldarraylen.some((length) => !Number.isInteger(length))) {
      throw new Error('型の情報を確認できませんでした。');
    }
    return { type: def.type, fieldnames, fieldtypes, fieldarraylen: def.fieldarraylen as number[], ...(Array.isArray(def.examples) ? { examples: requireStringArray(def.examples) } : {}) };
  });
}
/** 循環参照や bigint を表示用に変換し、文字数上限で省略する。省略後の文字列は JSON とは限らない。 */
function formatJsonPreview(value: unknown, limit: number): { text: string; truncated: boolean } {
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

/** ROS の接続・探索状態を管理する。通信を注入できるため、実機なしでも検証できる。 */
export class RosMonitor {
  private readonly factory: RosTransportFactory;
  private readonly options: Required<RosMonitorOptions>;
  private readonly listeners = new Set<(snapshot: RosSnapshot) => void>();
  private session: Session | null = null;
  private messageId = 0;
  private snapshot: RosSnapshot = {
    status: 'disconnected', url: DEFAULT_ROSBRIDGE_URL, error: null,
    topics: emptyList(), services: emptyList(), topic: emptyTopic(), service: emptyService(), call: emptyCall(),
  };

  /** 通信の生成方法と待ち時間・履歴上限を設定する。この時点では接続を開始しない。 */
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

  /** 現在の状態を参照で返す。変更通知まで同じ参照を保つため、呼び出し元では書き換えない。 */
  getSnapshot = (): RosSnapshot => this.snapshot;
  /** 今後の状態変更を購読し、解除関数を返す。登録時には現在の状態を再通知しない。 */
  subscribeState = (listener: (snapshot: RosSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /**
   * ws / wss 接続を開始し、開通後に topic・サービス一覧を取得する。接続中の再要求は無視する。
   * URL 不正や接続失敗は状態へ記録する。接続済み表示は WebSocket の開通だけを表す。
   */
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

  /** 接続と購読を終了し、応答待ちを解除する。送信済みサービスの ROS 側での実行は取り消せない。 */
  disconnect(): void {
    if (this.session) this.endSession(this.session, null);
  }

  /**
   * 接続中の一覧を並列取得し、結果やエラーを各一覧の状態へ反映する。未接続なら何もしない。
   * 前回の取得を中断し、消えた選択や型が変わった topic の購読も解除する。
   */
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
    // 更新要求を出し直した後は、前の一覧応答を採用しない。
    const current = () => this.session === session && session.graphController === controller && !controller.signal.aborted;
    await Promise.all([
      this.requestService(session, '/rosapi/topics', {}, controller.signal).then((value) => {
        if (!current()) return;
        const response = requireResponseObject(value);
        const topics = requireStringArray(response.topics);
        const types = requireStringArray(response.types);
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
      this.requestService(session, '/rosapi/services', {}, controller.signal).then((value) => {
        if (!current()) return;
        const items = requireStringArray(requireResponseObject(value).services).map((name) => ({ name })).sort((a, b) => a.name.localeCompare(b.name));
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

  /** 別の topic を選ぶと購読と履歴をリセットする。一覧にない名前は選択解除として扱い、自動購読はしない。 */
  selectTopic(name: string): void {
    if (this.snapshot.topic.name === name) return;
    this.stopTopic();
    const selected = this.snapshot.topics.items.find((topic) => topic.name === name);
    this.update({ topic: selected ? { ...emptyTopic(), ...selected } : emptyTopic() });
  }

  /** 接続中の選択 topic を購読し、上限付きの履歴へ受信を追加する。購読済みなら何もしない。 */
  startTopic(): void {
    const session = this.connectedSession();
    const { name, type, status } = this.snapshot.topic;
    if (!session || !name || !type || status === 'subscribed') return;
    this.stopTopic();
    // 購読停止後に遅れて届くメッセージを、次の購読履歴へ混ぜない。
    const generation = ++session.topicGeneration;
    const current = () => this.session === session && session.topicGeneration === generation;
    this.update({ topic: { ...this.snapshot.topic, status: 'subscribed', error: null } });
    try {
      const unsubscribe = session.transport!.subscribe(name, type, (message) => {
        if (!current()) return;
        const receivedAt = this.options.now();
        const entry: RosMessage = { id: ++this.messageId, receivedAt, ...formatJsonPreview(message, this.options.messageTextLimit) };
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

  /** topic の購読だけを止め、選択と履歴は残す。停止前の購読から遅れて届く通知も無効化する。 */
  stopTopic(): void {
    const session = this.session;
    if (session) {
      ++session.topicGeneration;
      const unsubscribe = session.unsubscribe;
      session.unsubscribe = null;
      try { unsubscribe?.(); } catch { /* 切断済みの場合も購読状態の後処理は続ける。 */ }
    }
    if (this.snapshot.topic.status === 'subscribed') this.update({ topic: { ...this.snapshot.topic, status: 'stopped' } });
  }

  /** 購読状態を保ったまま、履歴・受信件数・最終受信時刻をリセットする。 */
  clearMessages(): void {
    this.update({ topic: { ...this.snapshot.topic, messages: [], receivedCount: 0, lastReceivedAt: null } });
  }

  /**
   * 接続中にサービスを選び、型と入出力定義を取得する。前の選択の取得は中断する。
   * 取得失敗は状態へ記録し、送信済みの呼び出しとその結果は維持する。サービス自体は実行しない。
   */
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
      const response = requireResponseObject(await this.requestService(session, '/rosapi/service_type', { service: name }, controller.signal));
      if (!current()) return;
      if (typeof response.type !== 'string' || !response.type) throw new Error('サービスの型を確認できませんでした。');
      const type = response.type;
      this.update({ service: { ...this.snapshot.service, type } });
      const [requestDetails, responseDetails] = await Promise.allSettled([
        this.requestService(session, '/rosapi/service_request_details', { type }, controller.signal).then(parseRosTypeDefs),
        this.requestService(session, '/rosapi/service_response_details', { type }, controller.signal).then(parseRosTypeDefs),
      ]);
      if (!current()) return;
      const errors = [requestDetails, responseDetails].flatMap((result) => result.status === 'rejected' ? [errorText(result.reason)] : []);
      this.update({ service: {
        ...this.snapshot.service, status: 'ready',
        requestTypeDefs: requestDetails.status === 'fulfilled' ? requestDetails.value : null,
        responseTypeDefs: responseDetails.status === 'fulfilled' ? responseDetails.value : null,
        detailsError: errors.length ? [...new Set(errors)].join(' / ') : null,
      } });
    } catch (error) {
      if (current()) this.update({ service: { ...this.snapshot.service, status: 'error', error: errorText(error) } });
    }
  }

  /**
   * 型が判明した選択サービスへ JSON を一度送信し、応答や失敗を call の状態へ保存する。
   * 未接続・型未取得・応答待ち中は何もしない。不正 JSON は送信せず、結果不明時も再送しない。
   */
  async callService(requestText: string): Promise<void> {
    const session = this.connectedSession();
    if (!session || this.snapshot.call.status === 'pending') return;
    const service = this.snapshot.service;
    if (service.status !== 'ready' || !service.name || !service.type) return;
    let args: Record<string, unknown>;
    try {
      args = parseRosRequest(requestText);
    } catch (error) {
      this.update({ call: { ...emptyCall(), status: 'error', service: service.name, type: service.type, url: this.snapshot.url, requestText, error: `送信していません: ${errorText(error)}` } });
      return;
    }
    // 選択サービスが変わっても、送信済み要求の宛先と結果はこの記録に残す。
    const call: RosSnapshot['call'] = { ...emptyCall(), status: 'pending', service: service.name, type: service.type, url: this.snapshot.url, requestText, startedAt: this.options.now() };
    this.update({ call });
    try {
      const response = await this.requestService(session, service.name, args);
      if (this.session !== session || this.snapshot.call !== call) return;
      const rendered = formatJsonPreview(response, SERVICE_RESPONSE_TEXT_LIMIT);
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

  /** 通信実装に依存せず待ち時間を制限する。切断・親の中断・タイムアウトで待機を解除し、通信も中断する。 */
  private requestService(session: Session, service: string, args: Record<string, unknown>, parentSignal?: AbortSignal): Promise<unknown> {
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

  /** 現在の接続だけを片付け、途中の取得を失敗状態、応答待ちの要求を結果不明として残す。 */
  private endSession(session: Session, error: string | null): void {
    if (this.session !== session) return;
    this.stopTopic();
    this.session = null;
    if (session.connectTimer) clearTimeout(session.connectTimer);
    session.controller.abort();
    session.graphController?.abort();
    session.serviceController?.abort();
    try { session.transport?.close(); } catch { /* 切断済みの場合も画面状態の更新は続ける。 */ }
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
      try { listener(this.snapshot); } catch { /* 一つの画面で例外が出ても、他の購読先には変更を通知する。 */ }
    }
  }
}
