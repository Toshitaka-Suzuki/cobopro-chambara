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

// 固定時間を待たずに非同期の受信ループを進め、未到達ならテストを終了する。
export async function waitUntil(predicate: () => boolean) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Expected state was not reached');
}
