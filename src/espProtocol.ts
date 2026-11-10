/** 共有資料に記載されたXIAOの確定ログだけを、ゲーム用イベントへ変換する。 */
export type EspEvent =
  | { type: 'parry_success' }
  | { type: 'weak_hit'; weakpoint: 'A' | 'B' | 'C' }
  | { type: 'weak_end'; weakpoint: 'A' | 'B' | 'C' };

const MAX_LINE_LENGTH = 512;

function parseLine(line: string): EspEvent | null {
  if (line === '[EVENT] PARRY SUCCESS (once)') return { type: 'parry_success' };
  const hit = /^\[EVENT\] WEAK ([ABC]) SUCCESS \(once\)$/.exec(line);
  if (hit) return { type: 'weak_hit', weakpoint: hit[1] as 'A' | 'B' | 'C' };
  const end = /^\[WEAK ([ABC])\] end state confirmed=1$/.exec(line);
  if (end) return { type: 'weak_end', weakpoint: end[1] as 'A' | 'B' | 'C' };
  return null;
}

export class EspLineDecoder {
  private pendingLine = '';
  private discardingLine = false;

  /** 分割されたLF / CRLF行を復元する。生の1や検出機側のデバッグ行は成功として扱わない。 */
  push(text: string): EspEvent[] {
    const events: EspEvent[] = [];
    for (const character of text) {
      if (character === '\n') {
        if (!this.discardingLine) {
          const line = this.pendingLine.endsWith('\r') ? this.pendingLine.slice(0, -1) : this.pendingLine;
          const event = parseLine(line);
          if (event) events.push(event);
        }
        this.pendingLine = '';
        this.discardingLine = false;
      } else if (!this.discardingLine) {
        if (this.pendingLine.length >= MAX_LINE_LENGTH) {
          this.pendingLine = '';
          this.discardingLine = true;
        } else this.pendingLine += character;
      }
    }
    return events;
  }

  /** 場面変更前の部分行は、その末尾まで破棄する。 */
  discardPending(): void {
    this.discardingLine ||= this.pendingLine.length > 0;
    this.pendingLine = '';
  }

  /** 新しい接続では、過去の部分行を持ち越さない。 */
  reset(): void {
    this.pendingLine = '';
    this.discardingLine = false;
  }
}
