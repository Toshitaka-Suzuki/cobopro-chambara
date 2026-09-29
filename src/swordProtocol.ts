// Temporary wire format: one ASCII "1" per LF/CRLF-delimited line.
// Keep framing and interpretation here so a future device format can replace it
// without leaking serial syntax into game rules or the serial transport.
const MAX_LINE_LENGTH = 256;

export class SwordClashDecoder {
  private pending = '';
  private discarding = false;

  push(text: string): number {
    let clashes = 0;
    for (const character of text) {
      if (character === '\n') {
        if (!this.discarding && this.pending.trim() === '1') clashes++;
        this.pending = '';
        this.discarding = false;
      } else if (!this.discarding) {
        if (this.pending.length >= MAX_LINE_LENGTH) {
          this.pending = '';
          this.discarding = true;
        } else {
          this.pending += character;
        }
      }
    }
    return clashes;
  }

  discardPending(): void {
    // A mode/phase change must not reinterpret the rest of an old line as a
    // new event. Keep discarding until its delimiter has actually arrived.
    this.discarding ||= this.pending.length > 0;
    this.pending = '';
  }

  reset(): void {
    this.pending = '';
    this.discarding = false;
  }
}
