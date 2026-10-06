// 暫定プロトコル: LF / CRLF で区切った ASCII の「1」を接触 1 回として扱う。
// 機器の形式変更が通信処理やゲームルールに波及しないよう、行の解釈をここに閉じ込める。
const MAX_LINE_LENGTH = 256;

export class SwordClashDecoder {
  private pendingLine = '';
  private discardingLine = false;

  /**
   * 受信断片を追加し、今回の改行で確定した接触数を返す。未完の行は次回に持ち越す。
   * 前後の空白を除いて「1」だけの行を採用し、長すぎる行は改行まで破棄する。
   */
  push(text: string): number {
    let clashes = 0;
    for (const character of text) {
      if (character === '\n') {
        if (!this.discardingLine && this.pendingLine.trim() === '1') clashes++;
        this.pendingLine = '';
        this.discardingLine = false;
      } else if (!this.discardingLine) {
        if (this.pendingLine.length >= MAX_LINE_LENGTH) {
          this.pendingLine = '';
          this.discardingLine = true;
        } else {
          this.pendingLine += character;
        }
      }
    }
    return clashes;
  }

  /** 未完の行があれば、その後の改行まで破棄する。古い行の末尾が新しい接触になるのを防ぐ。 */
  discardPending(): void {
    this.discardingLine ||= this.pendingLine.length > 0;
    this.pendingLine = '';
  }

  /** 接続の切り替え時に解析状態を初期化し、次の受信を新しい行の先頭として扱う。 */
  reset(): void {
    this.pendingLine = '';
    this.discardingLine = false;
  }
}
