export type GameSoundEffect = 'cue' | 'clash' | 'open' | 'hit' | 'levelUp' | 'win' | 'lose' | 'timeup' | 'count' | 'go';
type SynthVoice = { oscillator: OscillatorNode; envelope: GainNode };

const MASTER_VOLUME = 0.25;
const MUSIC_BEAT_INTERVAL_MS = 375;

/** 敗北音はMP3、それ以外は仮の合成音。BGMの拍は成功判定とは同期しない。 */
export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Set<SynthVoice>();
  private samples = new Set<AudioBufferSourceNode>();
  private loseSound: Promise<AudioBuffer | null> | null = null;
  private soundGeneration = 0;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicWanted = false;
  private paused = false;
  private muted = false;
  private disposed = false;
  private beat = 0;

  /** ユーザー操作から呼び出し、音声出力を初期化・再開する。敗北音の先読みも開始する。 */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER_VOLUME;
      this.master.connect(this.context.destination);
    }
    // カウントダウンの間に読み込み、敗北時にすぐ再生できるようにする。
    void this.loadLoseSound();
    if (this.context.state === 'suspended') await this.context.resume();
  }

  /** 音声出力が準備済みなら BGM を開始する。繰り返し呼んでもタイマーを重複させない。 */
  startMusic(): void {
    if (!this.isReady()) return;
    this.musicWanted = true;
    this.paused = false;
    if (this.musicTimer !== null) return;
    this.musicBeat();
    this.musicTimer = setInterval(() => this.musicBeat(), MUSIC_BEAT_INTERVAL_MS);
  }

  /** BGM の再開要否と拍位置を保持し、再生中・予約済みの音を止める。 */
  pause(): void {
    this.paused = true;
    this.clearSounds();
  }

  /** 一時停止を解除し、停止前に必要だった BGM だけを再開する。効果音は再生し直さない。 */
  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    if (this.musicWanted) this.startMusic();
  }

  /** 全ての音を止め、次の BGM が先頭の拍から始まるように状態を戻す。 */
  stop(): void {
    this.musicWanted = false;
    this.paused = false;
    this.beat = 0;
    this.clearSounds();
  }

  /** 再生の進行を維持したまま出力音量を切り替える。初期化前の設定も保持する。 */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.context && this.master && this.context.state !== 'closed') {
      this.master.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, this.context.currentTime, 0.015);
    }
  }

  /** 指定の効果音を再生する。音声出力が未準備または一時停止中なら何もしない。 */
  play(effect: GameSoundEffect): void {
    if (!this.isReady() || this.paused) return;
    switch (effect) {
      case 'count':
        this.tone(440, 0.11, 0.22);
        break;
      case 'go':
        this.notes([523.25, 659.25, 783.99], 0.075, 0.22);
        break;
      case 'cue':
        this.tone(392, 0.13, 0.26, 0, 'triangle');
        this.tone(587.33, 0.2, 0.3, 0.17, 'triangle');
        break;
      case 'clash':
        // 接触の鋭い立ち上がりと、弾き返した金属音の短い余韻。
        this.tone(880, 0.38, 0.3);
        this.tone(1427, 0.28, 0.18);
        this.tone(2381, 0.14, 0.1);
        this.tone(3511, 0.055, 0.06);
        this.tone(1760, 0.32, 0.09, 0.035);
        break;
      case 'open':
        this.notes([523.25, 783.99], 0.11, 0.22);
        break;
      case 'hit':
        this.tone(145, 0.18, 0.4, 0, 'sine', 55);
        this.notes([659.25, 987.77], 0.065, 0.2);
        break;
      case 'levelUp':
        this.tone(145, 0.14, 0.3, 0, 'sine', 55);
        [659.25, 783.99, 1046.5, 1318.51].forEach((note, index) =>
          this.tone(note, 0.23, 0.2, 0.12 + index * 0.08, 'triangle'));
        break;
      case 'win':
        this.notes([523.25, 659.25, 783.99, 1046.5], 0.14, 0.25);
        break;
      case 'lose':
        void this.playLoseSound();
        break;
      case 'timeup':
        this.notes([392, 392, 261.63], 0.2, 0.23);
        break;
    }
  }

  /** 音源と AudioContext を解放する。呼び出したインスタンスは以降再利用しない。 */
  dispose(): void {
    this.stop();
    this.disposed = true;
    this.master?.disconnect();
    const context = this.context;
    this.master = null;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }

  private isReady(): boolean {
    return !this.disposed && this.context?.state === 'running' && this.master !== null;
  }

  /** 敗北音の読み込み結果を共有する。失敗時は null を返し、合成音へ切り替えられるようにする。 */
  private loadLoseSound(): Promise<AudioBuffer | null> {
    const context = this.context;
    if (!context || this.disposed) return Promise.resolve(null);
    if (!this.loseSound) {
      this.loseSound = fetch(`${import.meta.env.BASE_URL}audio/lose.mp3`)
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then(data => context.decodeAudioData(data))
        .catch(error => {
          console.warn('敗北音を読み込めなかったため、仮の効果音を使用します。', error);
          return null;
        });
    }
    return this.loseSound;
  }

  private async playLoseSound(): Promise<void> {
    const generation = this.soundGeneration;
    const buffer = await this.loadLoseSound();
    // 読み込み待ちの間に画面を離れたり停止した場合は鳴らさない。
    if (generation !== this.soundGeneration || !this.isReady() || this.paused) return;
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    if (!buffer) {
      this.notes([293.66, 246.94, 196], 0.2, 0.24);
      return;
    }
    const sample = context.createBufferSource();
    sample.buffer = buffer;
    sample.connect(master);
    this.samples.add(sample);
    sample.onended = () => {
      sample.disconnect();
      this.samples.delete(sample);
    };
    sample.start();
  }

  private musicBeat(): void {
    if (!this.isReady() || this.paused) return;
    const step = this.beat % 8;
    if (step % 2 === 0) {
      const bass = [110, 110, 130.81, 98][step / 2];
      this.tone(bass, 0.31, 0.075, 0, 'triangle');
      this.tone(76, 0.1, 0.13, 0, 'sine', 38);
    } else {
      this.tone([220, 293.66, 261.63, 196][(step - 1) / 2], 0.1, 0.04);
    }
    this.beat += 1;
  }

  /** 周波数列を gap 秒ずつずらして予約し、短い旋律として鳴らす。 */
  private notes(frequencies: number[], gap: number, volume: number): void {
    frequencies.forEach((frequency, index) => {
      this.tone(frequency, 0.24, volume, index * gap, 'triangle');
    });
  }

  /** Hz 単位の単音を予約する。duration と delay は秒で指定し、再生終了時に音源を解放する。 */
  private tone(
    frequency: number,
    duration: number,
    volume: number,
    delay = 0,
    type: OscillatorType = 'sine',
    endFrequency?: number,
  ): void {
    const context = this.context;
    const master = this.master;
    if (!this.isReady() || !context || !master) return;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const voice = { oscillator, envelope };
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(volume, start + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(master);
    this.voices.add(voice);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
      this.voices.delete(voice);
    };
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  }

  /** タイマー・音源を停止し、読み込み待ちの音も世代番号の更新で無効化する。 */
  private clearSounds(): void {
    this.soundGeneration += 1;
    if (this.musicTimer !== null) clearInterval(this.musicTimer);
    this.musicTimer = null;
    for (const { oscillator, envelope } of this.voices) {
      oscillator.onended = null;
      oscillator.stop();
      oscillator.disconnect();
      envelope.disconnect();
    }
    this.voices.clear();
    for (const sample of this.samples) {
      sample.onended = null;
      sample.stop();
      sample.disconnect();
    }
    this.samples.clear();
  }
}
