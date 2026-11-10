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
  readonly writable?: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};

// Web Serial の型が DOM 定義にない環境でも使える最小限の API。
// テストでは通常の ReadableStream を持つポートに置き換えられる。
export type SerialApi = {
  requestPort(): Promise<SerialPortApi>;
};

const MAX_LOG_LENGTH = 64 * 1024;
const MAX_COMMAND_BYTES = 256;
const MAX_PENDING_WRITES = 64;

function createCompletionSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type SerialSession = {
  disconnectRequested: boolean;
  baudRate: number | null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  readerCancellation: Promise<void> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  writerCancellation: Promise<void> | null;
  writeTail: Promise<void>;
  writeGeneration: number;
  pendingWrites: number;
  connectionReady: ReturnType<typeof createCompletionSignal>;
  closed: ReturnType<typeof createCompletionSignal>;
};

/** 画面から独立してシリアル接続を所有し、接続状態と新着テキストを通知する。 */
export class SerialMonitor {
  private readonly serial: SerialApi | undefined;
  private session: SerialSession | null = null;
  private readonly stateListeners = new Set<(snapshot: SerialSnapshot) => void>();
  private readonly textListeners = new Set<(text: string) => void>();
  private snapshot: SerialSnapshot = {
    status: 'disconnected', text: '', bytesReceived: 0,
    lastReceivedAt: null, truncated: false, error: null,
  };

  constructor(serial: SerialApi | undefined) {
    this.serial = serial;
  }

  /** 現在の状態を返す。変更がない間は同じ参照を返すため、呼び出し側では書き換えない。 */
  getSnapshot = (): SerialSnapshot => this.snapshot;

  /** 読み取り専用のポートも接続できるが、指示送信は書き込み可能な接続だけで行う。 */
  get canWrite(): boolean {
    return this.snapshot.status === 'connected' && this.session !== null
      && !this.session.disconnectRequested && this.session.writer !== null;
  }

  /** 開いている接続の設定値。選択中・切断中・未接続では取得できない。 */
  get baudRate(): number | null {
    return this.snapshot.status === 'connected' && this.session && !this.session.disconnectRequested
      ? this.session.baudRate : null;
  }

  /**
   * 同じ接続の未送信指示を無効化する。停止指示はこの呼び出しの後に送る。
   * すでにwriterへ渡した送信は取り消せないため、その完了後に停止指示が続く。
   */
  discardPendingWrites(): void {
    if (this.session) this.session.writeGeneration++;
  }

  /**
   * 1行の指示をLF付きで順番に送信する。完了はUSBへの書き込み完了であり、ESPの受領確認ではない。
   * 接続をまたいで再送せず、切断時に未送信のキューを破棄する。
   */
  writeLine(command: string): Promise<void> {
    if (typeof command !== 'string' || !command.trim() || /[\x00-\x1f\x7f]/.test(command)) {
      return Promise.reject(new Error('シリアル指示は改行・制御文字を含まない1行で指定してください。'));
    }
    const bytes = new TextEncoder().encode(command + '\n');
    if (bytes.byteLength > MAX_COMMAND_BYTES) {
      return Promise.reject(new Error('シリアル指示が長すぎます。'));
    }
    const session = this.session;
    if (!session || !this.canWrite) {
      return Promise.reject(new Error('シリアル指示を送信できません。書き込み可能なポートに接続してください。'));
    }
    if (session.pendingWrites >= MAX_PENDING_WRITES) {
      return Promise.reject(new Error('シリアル指示の送信待ちが多すぎます。'));
    }
    const generation = session.writeGeneration;
    session.pendingWrites++;
    const write = session.writeTail.then(async () => {
      if (generation !== session.writeGeneration) {
        throw new Error('取り消された未送信のシリアル指示を破棄しました。');
      }
      if (this.session !== session || session.disconnectRequested || !session.writer) {
        throw new Error('接続が終了したため、未送信のシリアル指示を破棄しました。');
      }
      try {
        await session.writer.write(bytes);
        if (this.session !== session || session.disconnectRequested) {
          throw new Error('シリアル指示の送信中に接続が終了しました。');
        }
      } catch (error) {
        if (this.session === session && !session.disconnectRequested) {
          this.update({ error: 'シリアルの送信中にエラーが発生しました。USB接続を確認して、再接続してください。' });
          this.requestDisconnect(session);
        }
        throw error;
      }
    }).finally(() => { session.pendingWrites--; });
    // キュー自身は失敗を処理し、呼び出し側には元の失敗を返す。
    session.writeTail = write.catch(() => {});
    return write;
  }

  /** 以後の状態変更を同期通知する。初期状態は再送せず、返した関数で購読を解除する。 */
  subscribeState = (listener: (snapshot: SerialSnapshot) => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  };

  /**
   * 表示ログと独立した新着テキストを同期通知し、購読解除関数を返す。
   * 接続・ログ消去・購読開始では過去の入力を再送しない。
   */
  subscribeText = (listener: (text: string) => void): (() => void) => {
    this.textListeners.add(listener);
    return () => { this.textListeners.delete(listener); };
  };

  /**
   * ユーザー操作から呼び出し、正の整数のボーレートでポート選択と受信を開始する。
   * Promise は接続成功、または失敗・中止時の後始末後に解決する。成否は状態で確認する。
   * 接続済み・処理中の呼び出しは何もせず即座に解決する。
   */
  connect(baudRate: number): Promise<void> {
    // 連打されてもポート選択画面や接続処理を二重に起動しない。
    if (this.session) return Promise.resolve();
    if (!this.serial) {
      this.update({ error: 'この環境はWeb Serialに対応していません。PC版ChromeまたはEdgeで、localhostかHTTPSから開いてください。' });
      return Promise.resolve();
    }
    if (!Number.isSafeInteger(baudRate) || baudRate <= 0) {
      this.update({ error: 'ボーレートは正の整数で指定してください。' });
      return Promise.resolve();
    }

    const session: SerialSession = {
      disconnectRequested: false, baudRate: null, reader: null, readerCancellation: null,
      writer: null, writerCancellation: null, writeTail: Promise.resolve(), writeGeneration: 0, pendingWrites: 0,
      connectionReady: createCompletionSignal(), closed: createCompletionSignal(),
    };
    this.session = session;
    this.update({ status: 'connecting', error: null });

    // ブラウザーのユーザー操作判定を保つため、最初の await より前に呼ぶ。
    // ポート選択画面はプログラムから閉じられないので、切断時は選択完了を待つ。
    let selection: Promise<SerialPortApi>;
    try {
      selection = this.serial.requestPort();
    } catch (error) {
      selection = Promise.reject(error);
    }
    void this.run(session, selection, baudRate);
    return session.connectionReady.promise;
  }

  /**
   * 受信の停止を要求し、ポートの解放まで待つ。繰り返し呼んでも切断は一度だけ行う。
   * ポート選択画面が開いている場合は、ユーザーによる選択または中止も待つ。
   */
  async disconnect(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.requestDisconnect(session);
    await session.closed.promise;
  }

  private requestDisconnect(session: SerialSession): void {
    session.disconnectRequested = true;
    this.update({ status: 'disconnecting' });
    if (session.reader && !session.readerCancellation) {
      // USB 抜線後は cancel / abort が失敗し得る。ロック解放は run の finally が担う。
      session.readerCancellation = session.reader.cancel().catch(() => {});
    }
    if (session.writer && !session.writerCancellation) {
      session.writerCancellation = session.writer.abort().catch(() => {});
    }
  }

  /** 表示ログだけを消去する。累計受信量・受信時刻・入力側の解析状態は維持する。 */
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
          // 購読者の例外で他の購読者への通知や USB の後始末を止めない。
        }
      }
    }
  }

  /** 表示ログは上限内に切り詰め、新着テキストの購読者には切り詰め前の受信内容を渡す。 */
  private append(text: string, bytes = 0): void {
    const combined = this.snapshot.text + text;
    let tail = combined.slice(-MAX_LOG_LENGTH);
    // UTF-16 の途中で切り詰めても、先頭に絵文字の片側だけを残さない。
    if (tail.length && tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff) {
      tail = tail.slice(1);
    }
    this.update({
      text: tail,
      truncated: this.snapshot.truncated || combined.length > MAX_LOG_LENGTH,
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
          // 入力処理側の例外を USB の受信エラーとして扱わない。
        }
      }
    }
  }

  private async run(session: SerialSession, selection: Promise<SerialPortApi>, baudRate: number): Promise<void> {
    let stage: 'select' | 'open' | 'read' = 'select';
    let port: SerialPortApi | null = null;
    let opened = false;
    let decoder: TextDecoder | null = null;
    try {
      port = await selection;
      if (session.disconnectRequested) return;
      stage = 'open';
      await port.open({ baudRate });
      opened = true;
      session.baudRate = baudRate;
      if (session.disconnectRequested) return;
      if (!port.readable) throw new Error('Readable stream unavailable');
      session.reader = port.readable.getReader();
      if (port.writable) session.writer = port.writable.getWriter();
      decoder = new TextDecoder('utf-8');
      this.update({
        status: 'connected', text: '', bytesReceived: 0,
        lastReceivedAt: null, truncated: false, error: null,
      });
      session.connectionReady.resolve();
      stage = 'read';
      while (!session.disconnectRequested) {
        const { value, done } = await session.reader.read();
        if (session.disconnectRequested) break;
        if (done) {
          this.update({ error: 'シリアルの受信が終了しました。USB接続を確認して、再接続してください。' });
          break;
        }
        if (value?.byteLength) this.append(decoder.decode(value, { stream: true }), value.byteLength);
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const chooserCancelled = stage === 'select' && (name === 'NotFoundError' || name === 'AbortError');
      if (!session.disconnectRequested && !chooserCancelled) {
        const messages = {
          select: 'ポートを選択できませんでした。ブラウザーのシリアル接続の権限を確認してください。',
          open: 'シリアルポートを開けませんでした。USB接続を確認し、同じポートを使用する他のアプリを閉じてください。',
          read: 'シリアルの受信中にエラーが発生しました。USB接続とボーレートを確認して、再接続してください。',
        };
        this.update({ error: messages[stage] });
      }
    } finally {
      // 自然な受信終了・抜線でも、この接続に残った送信を止める。
      this.requestDisconnect(session);
      if (decoder) this.append(decoder.decode());
      // 通常切断・受信エラー・接続準備中の切断をここに集約する。
      // cancel → ロック解放 → close の順序を守り、各処理を一度だけ実行する。
      if (session.readerCancellation) await session.readerCancellation;
      session.reader?.releaseLock();
      session.reader = null;
      if (session.writerCancellation) await session.writerCancellation;
      await session.writeTail;
      session.writer?.releaseLock();
      session.writer = null;
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
      session.connectionReady.resolve();
      session.closed.resolve();
    }
  }
}
