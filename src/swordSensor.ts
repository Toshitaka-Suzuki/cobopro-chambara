import { SerialMonitor } from './serial.ts';
import type { SerialSnapshot } from './serial.ts';
import { SwordClashDecoder } from './swordProtocol.ts';

export type SwordSensorSnapshot = {
  connected: boolean;
  ready: boolean;
  clashesReceived: number;
  lastClashAt: number | null;
};

export class SwordSensorInput {
  private readonly monitor: SerialMonitor;
  private readonly decoder = new SwordClashDecoder();
  private readonly stateListeners = new Set<(snapshot: SwordSensorSnapshot) => void>();
  private readonly clashListeners = new Set<() => void>();
  private subscriptions: (() => void)[] | null = null;
  private generation = 0;
  private deliveryEpoch = 0;
  private snapshot: SwordSensorSnapshot = {
    connected: false, ready: false, clashesReceived: 0, lastClashAt: null,
  };

  constructor(monitor: SerialMonitor) {
    this.monitor = monitor;
  }

  getSnapshot = (): SwordSensorSnapshot => this.snapshot;

  subscribeState = (listener: (snapshot: SwordSensorSnapshot) => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  };

  subscribeClash = (listener: () => void): (() => void) => {
    this.clashListeners.add(listener);
    return () => { this.clashListeners.delete(listener); };
  };

  start = (): void => {
    if (this.subscriptions) return;
    this.decoder.reset();
    this.subscriptions = [
      this.monitor.subscribeState(this.handleSerialState),
      this.monitor.subscribeText(this.handleText),
    ];
    this.handleSerialState(this.monitor.getSnapshot());
  };

  stop = (): void => {
    this.subscriptions?.forEach((unsubscribe) => unsubscribe());
    this.subscriptions = null;
    this.generation++;
    this.decoder.reset();
    this.update({ connected: false, ready: false, clashesReceived: 0, lastClashAt: null });
  };

  discardPending = (): void => {
    // A game phase/pause boundary also invalidates the remainder of the current
    // decoded batch. Conservatively prevent one USB chunk crossing that boundary,
    // while still counting every valid received line and accepting the next chunk.
    this.deliveryEpoch++;
    this.decoder.discardPending();
  };

  private handleSerialState = (serial: SerialSnapshot): void => {
    const connected = serial.status === 'connected';
    if (connected === this.snapshot.connected) return;
    this.generation++;
    this.decoder.reset();
    this.update({ connected, ready: false, clashesReceived: 0, lastClashAt: null });
  };

  private handleText = (text: string): void => {
    if (!this.subscriptions || !this.snapshot.connected) return;
    const generation = this.generation;
    const deliveryEpoch = this.deliveryEpoch;
    const count = this.decoder.push(text);
    for (let index = 0; index < count; index++) {
      if (!this.subscriptions || !this.snapshot.connected || this.generation !== generation) break;
      this.update({
        ...this.snapshot,
        ready: true,
        clashesReceived: this.snapshot.clashesReceived + 1,
        lastClashAt: Date.now(),
      });
      // State observers may have stopped or disconnected the input.
      if (!this.subscriptions || !this.snapshot.connected || this.generation !== generation) break;
      for (const listener of [...this.clashListeners]) {
        // A previous observer can change the game phase or pause during delivery.
        if (!this.subscriptions || !this.snapshot.connected || this.generation !== generation || this.deliveryEpoch !== deliveryEpoch) break;
        try {
          listener();
        } catch {
          // A consumer failure must not prevent the other consumers receiving it.
        }
      }
    }
  };

  private update(next: SwordSensorSnapshot): void {
    if (Object.entries(next).every(([key, value]) => this.snapshot[key as keyof SwordSensorSnapshot] === value)) return;
    this.snapshot = next;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(this.snapshot);
      } catch {
        // UI observers cannot break event decoding or connection cleanup.
      }
    }
  }
}
