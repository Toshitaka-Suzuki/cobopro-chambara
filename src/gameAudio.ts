type Effect = 'cue' | 'clash' | 'open' | 'hit' | 'win' | 'lose' | 'timeup' | 'count' | 'go';
type Voice = { oscillator: OscillatorNode; envelope: GainNode };

/** 敗北音はMP3、それ以外は仮の合成音。BGMの拍は成功判定とは同期しない。 */
export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Set<Voice>();
  private samples = new Set<AudioBufferSourceNode>();
  private loseSound: Promise<AudioBuffer | null> | null = null;
  private soundGeneration = 0;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicWanted = false;
  private paused = false;
  private muted = false;
  private disposed = false;
  private beat = 0;

  /** 必ずユーザーの開始クリックから呼ぶ。 */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : 0.25;
      this.master.connect(this.context.destination);
    }
    // カウントダウンの間に読み込み、敗北時にすぐ再生できるようにする。
    void this.loadLoseSound();
    if (this.context.state === 'suspended') await this.context.resume();
  }

  startMusic(): void {
    if (!this.ready()) return;
    this.musicWanted = true;
    this.paused = false;
    if (this.musicTimer !== null) return;
    this.musicBeat();
    this.musicTimer = setInterval(() => this.musicBeat(), 375);
  }

  pause(): void {
    this.paused = true;
    this.clearSounds();
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    if (this.musicWanted) this.startMusic();
  }

  stop(): void {
    this.musicWanted = false;
    this.paused = false;
    this.beat = 0;
    this.clearSounds();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.context && this.master && this.context.state !== 'closed') {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.25, this.context.currentTime, 0.015);
    }
  }

  play(effect: Effect): void {
    if (!this.ready() || this.paused) return;
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
        // 非整数倍の倍音を重ねて、短い金属的な響きを作る。
        this.tone(730, 0.23, 0.3);
        this.tone(1173, 0.17, 0.18);
        this.tone(1867, 0.11, 0.1);
        this.tone(2741, 0.065, 0.04);
        break;
      case 'open':
        this.notes([523.25, 783.99], 0.11, 0.22);
        break;
      case 'hit':
        this.tone(145, 0.18, 0.4, 0, 'sine', 55);
        this.notes([659.25, 987.77], 0.065, 0.2);
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

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.master?.disconnect();
    const context = this.context;
    this.master = null;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }

  private ready(): boolean {
    return !this.disposed && this.context?.state === 'running' && this.master !== null;
  }

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
    if (generation !== this.soundGeneration || !this.ready() || this.paused) return;
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
    if (!this.ready() || this.paused) return;
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

  private notes(frequencies: number[], gap: number, volume: number): void {
    frequencies.forEach((frequency, index) => {
      this.tone(frequency, 0.24, volume, index * gap, 'triangle');
    });
  }

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
    if (!this.ready() || !context || !master) return;
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
