export type SerialSnapshot = {
  status: 'disconnected' | 'connecting' | 'connected' | 'disconnecting';
  text: string;
  bytesReceived: number;
  lastReceivedAt: number | null;
  truncated: boolean;
  error: string | null;
};

export type SerialPortApi = {
  readonly readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};

// Keep the small Web Serial surface local: TypeScript's DOM types do not
// include Web Serial in every version, and tests can supply an ordinary stream.
export type SerialApi = {
  requestPort(): Promise<SerialPortApi>;
};

const TEXT_LIMIT = 64 * 1024;

function completion() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type Session = {
  cancelled: boolean;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  cancellation: Promise<void> | null;
  ready: ReturnType<typeof completion>;
  done: ReturnType<typeof completion>;
};

export class SerialMonitor {
  private readonly serial: SerialApi | undefined;
  private session: Session | null = null;
  private readonly stateListeners = new Set<(snapshot: SerialSnapshot) => void>();
  private readonly textListeners = new Set<(text: string) => void>();
  private snapshot: SerialSnapshot = {
    status: 'disconnected', text: '', bytesReceived: 0,
    lastReceivedAt: null, truncated: false, error: null,
  };

  constructor(serial: SerialApi | undefined) {
    this.serial = serial;
  }

  getSnapshot = (): SerialSnapshot => this.snapshot;

  subscribeState = (listener: (snapshot: SerialSnapshot) => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  };

  // Subscribe to newly decoded text, independently of the bounded display log.
  // Connecting, clearing the log, and subscribing never replay previous data.
  subscribeText = (listener: (text: string) => void): (() => void) => {
    this.textListeners.add(listener);
    return () => { this.textListeners.delete(listener); };
  };

  connect(baudRate: number): Promise<void> {
    // A second click must not create another chooser or acquire another port.
    if (this.session) return Promise.resolve();
    if (!this.serial) {
      this.update({ error: 'この環境はWeb Serialに対応していません。PC版ChromeまたはEdgeで、localhostかHTTPSから開いてください。' });
      return Promise.resolve();
    }
    if (!Number.isSafeInteger(baudRate) || baudRate <= 0) {
      this.update({ error: 'ボーレートは正の整数で指定してください。' });
      return Promise.resolve();
    }

    const session: Session = {
      cancelled: false, reader: null, cancellation: null,
      ready: completion(), done: completion(),
    };
    this.session = session;
    this.update({ status: 'connecting', error: null });

    // requestPort must run in the button's user-activation call stack, before
    // any await. Its chooser cannot be programmatically dismissed.
    let selection: Promise<SerialPortApi>;
    try {
      selection = this.serial.requestPort();
    } catch (error) {
      selection = Promise.reject(error);
    }
    void this.run(session, selection, baudRate);
    return session.ready.promise;
  }

  async disconnect(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (!session.cancelled) {
      session.cancelled = true;
      this.update({ status: 'disconnecting' });
      if (session.reader) {
        // An errored stream (for example, after unplugging USB) can reject
        // cancellation. The read loop still releases its lock in finally.
        session.cancellation = session.reader.cancel().catch(() => {});
      }
    }
    await session.done.promise;
  }

  clear(): void {
    this.update({ text: '', truncated: false });
  }

  private update(changes: Partial<SerialSnapshot>): void {
    if (Object.entries(changes).some(([key, value]) => this.snapshot[key as keyof SerialSnapshot] !== value)) {
      this.snapshot = { ...this.snapshot, ...changes };
      for (const listener of [...this.stateListeners]) {
        try {
          listener(this.snapshot);
        } catch {
          // An observer must not interrupt another observer or USB cleanup.
        }
      }
    }
  }

  private append(text: string, bytes = 0): void {
    const combined = this.snapshot.text + text;
    let tail = combined.slice(-TEXT_LIMIT);
    // UTF-16 slicing must not leave half an emoji at the beginning of the log.
    if (tail.length && tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff) {
      tail = tail.slice(1);
    }
    this.update({
      text: tail,
      truncated: this.snapshot.truncated || combined.length > TEXT_LIMIT,
      ...(bytes > 0 ? {
        bytesReceived: this.snapshot.bytesReceived + bytes,
        lastReceivedAt: Date.now(),
      } : {}),
    });
    if (text) {
      for (const listener of [...this.textListeners]) {
        try {
          listener(text);
        } catch {
          // Input consumers cannot turn a valid USB read into a transport error.
        }
      }
    }
  }

  private async run(session: Session, selection: Promise<SerialPortApi>, baudRate: number): Promise<void> {
    let stage: 'select' | 'open' | 'read' = 'select';
    let port: SerialPortApi | null = null;
    let opened = false;
    let decoder: TextDecoder | null = null;
    try {
      port = await selection;
      if (session.cancelled) return;
      stage = 'open';
      await port.open({ baudRate });
      opened = true;
      if (session.cancelled) return;
      if (!port.readable) throw new Error('Readable stream unavailable');
      session.reader = port.readable.getReader();
      decoder = new TextDecoder('utf-8');
      this.update({
        status: 'connected', text: '', bytesReceived: 0,
        lastReceivedAt: null, truncated: false, error: null,
      });
      session.ready.resolve();
      stage = 'read';
      while (!session.cancelled) {
        const { value, done } = await session.reader.read();
        if (session.cancelled) break;
        if (done) {
          this.update({ error: 'シリアルの受信が終了しました。USB接続を確認して、再接続してください。' });
          break;
        }
        if (value?.byteLength) this.append(decoder.decode(value, { stream: true }), value.byteLength);
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const chooserCancelled = stage === 'select' && (name === 'NotFoundError' || name === 'AbortError');
      if (!session.cancelled && !chooserCancelled) {
        const messages = {
          select: 'ポートを選択できませんでした。ブラウザーのシリアル接続の権限を確認してください。',
          open: 'シリアルポートを開けませんでした。USB接続を確認し、同じポートを使用する他のアプリを閉じてください。',
          read: 'シリアルの受信中にエラーが発生しました。USB接続とボーレートを確認して、再接続してください。',
        };
        this.update({ error: messages[stage] });
      }
    } finally {
      this.update({ status: 'disconnecting' });
      if (decoder) this.append(decoder.decode());
      // One owner performs cleanup for normal disconnect, failed reads and
      // disconnects that arrived while open() or the chooser was pending.
      if (session.cancellation) await session.cancellation;
      session.reader?.releaseLock();
      session.reader = null;
      if (opened && port) {
        try {
          await port.close();
        } catch {
          if (!this.snapshot.error) {
            this.update({ error: 'シリアルポートを閉じられませんでした。USBケーブルを接続し直してください。' });
          }
        }
      }
      this.session = null;
      this.update({ status: 'disconnected' });
      session.ready.resolve();
      session.done.resolve();
    }
  }
}
