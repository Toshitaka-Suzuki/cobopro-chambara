import { strict as assert } from 'node:assert';
import type { SerialPortApi } from '../serial.ts';

// 通信・入力・ゲームのテストで、同じストリームと切断順序を再現する。
export class FakeSerialPort implements SerialPortApi {
  readable: ReadableStream<Uint8Array> | null;
  controller!: ReadableStreamDefaultController<Uint8Array>;
  events: string[] = [];
  options: { baudRate: number } | null = null;
  openGate: Promise<void> | null = null;
  openError: Error | null = null;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      cancel: () => { this.events.push('cancel'); },
    });
  }

  async open(options: { baudRate: number }) {
    this.events.push('open');
    this.options = options;
    if (this.openGate) await this.openGate;
    if (this.openError) throw this.openError;
  }

  async close() {
    assert.equal(this.readable?.locked ?? false, false, 'release the reader before closing');
    this.events.push('close');
  }

  send(text: string) {
    this.controller.enqueue(new TextEncoder().encode(text));
  }
}

/** 読み取り専用の既存テストを保ち、送信・中断だけを追加で再現する。 */
export class FakeWritableSerialPort extends FakeSerialPort {
  writable: WritableStream<Uint8Array>;
  writes: string[] = [];
  writeGate: Promise<void> | null = null;
  writeError: Error | null = null;

  constructor() {
    super();
    this.writable = new WritableStream<Uint8Array>({
      write: async (bytes) => {
        this.writes.push(new TextDecoder().decode(bytes));
        if (this.writeGate) await this.writeGate;
        if (this.writeError) throw this.writeError;
      },
      abort: () => { this.events.push('abort-write'); },
    });
  }

  override async close() {
    assert.equal(this.writable.locked, false, 'release the writer before closing');
    await super.close();
  }
}

// 固定時間を待たずに非同期の受信ループを進め、未到達ならテストを終了する。
export async function waitUntil(predicate: () => boolean) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Expected state was not reached');
}
