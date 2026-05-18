/**
 * VØID·ΩMEGA — Acoustic Rendezvous Driver (Stratum 2/3)
 *
 * Implementa comunicação P2P baseada em áudio ultrassônico (18kHz - 20kHz).
 * Resolve o problema de descoberta de pares e transferência de shards em
 * sistemas restritivos (como o Safari no iOS) que bloqueiam a Web Bluetooth API.
 * 
 * Funciona emitindo e "escutando" frequências. É um modem FSK (Frequency-Shift Keying) 
 * implementado nativamente com a Web Audio API.
 */

export type AcousticMessageCallback = (sender: string, payload: string) => void;

export class AcousticDriver {
  private isListening = false;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private microphone: MediaStreamAudioSourceNode | null = null;
  private oscillator: OscillatorNode | null = null;
  private gainNode: GainNode | null = null;

  // FSK Config
  private readonly FREQ_SPACE = 18500; // Espaço (0)
  private readonly FREQ_MARK = 19500;  // Marca (1)
  private readonly BIT_DURATION = 1000 / 8; // ms por bit

  private onMessageReceived: AcousticMessageCallback | null = null;

  public isSupported(): boolean {
    return !!(window.AudioContext || (window as any).webkitAudioContext);
  }

  private initAudio() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx();
    }
  }

  /**
   * Transmite um payload via FSK (Frequency-Shift Keying).
   * @param data Payload em string (Idealmente hex pequeno de rendezvous)
   */
  public async transmit(data: string): Promise<void> {
    this.initAudio();
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }

    const ctx = this.audioContext!;
    
    // Converte string para array de bits com FEC (Forward Error Correction - Repetition x3)
    const bits: number[] = [];
    // Start bit (preamble mais longo para detecção)
    bits.push(1, 1, 1, 1, 0, 1);
    
    const encoder = new TextEncoder();
    const bytes = encoder.encode(data);
    
    for (const byte of bytes) {
      for (let i = 0; i < 8; i++) {
        const bit = (byte >> i) & 1;
        // FEC: Repete cada bit 3 vezes (ajuda a corrigir ruído FSK)
        bits.push(bit, bit, bit);
      }
    }
    
    // Stop bits
    bits.push(0, 0, 0);

    return new Promise((resolve) => {
      this.oscillator = ctx.createOscillator();
      this.gainNode = ctx.createGain();
      
      this.oscillator.type = 'sine';
      this.oscillator.connect(this.gainNode);
      this.gainNode.connect(ctx.destination);
      
      // Ramp up suave para evitar "clicks"
      this.gainNode.gain.setValueAtTime(0, ctx.currentTime);
      this.gainNode.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.05);

      this.oscillator.start();

      let bitIndex = 0;
      const transmitNextBit = () => {
        if (bitIndex >= bits.length) {
          // Terminou
          this.gainNode!.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.05);
          setTimeout(() => {
            this.oscillator?.stop();
            this.oscillator?.disconnect();
            this.gainNode?.disconnect();
            resolve();
          }, 50);
          return;
        }

        const bit = bits[bitIndex];
        const freq = bit === 1 ? this.FREQ_MARK : this.FREQ_SPACE;
        
        // Define a frequência para o bit atual
        this.oscillator!.frequency.setValueAtTime(freq, ctx.currentTime);
        
        bitIndex++;
        setTimeout(transmitNextBit, this.BIT_DURATION);
      };

      transmitNextBit();
    });
  }

  /**
   * Inicia a escuta passiva do microfone por sinais ultrassônicos.
   */
  public async listen(callback: AcousticMessageCallback): Promise<void> {
    if (!this.isSupported() || this.isListening) return;
    
    this.initAudio();
    this.onMessageReceived = callback;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } 
      });
      
      const ctx = this.audioContext!;
      if (ctx.state === 'suspended') await ctx.resume();

      this.microphone = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      
      // FFT size grande para melhor resolução de frequência
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.2;
      
      this.microphone.connect(this.analyser);
      this.isListening = true;
      
      this.startDemodulationLoop();
      console.log("[AcousticDriver] Escuta ultrassônica ativa (18kHz-20kHz)");

    } catch (e) {
      console.error("[AcousticDriver] Falha ao acessar microfone:", e);
      throw e;
    }
  }

  public stopListening() {
    this.isListening = false;
    if (this.microphone) {
      this.microphone.disconnect();
      this.microphone.mediaStream.getTracks().forEach(t => t.stop());
    }
    if (this.analyser) {
      this.analyser.disconnect();
    }
    console.log("[AcousticDriver] Escuta ultrassônica parada.");
  }

  private startDemodulationLoop() {
    if (!this.isListening || !this.analyser) return;

    const ctx = this.audioContext!;
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    const sampleRate = ctx.sampleRate;
    
    // Encontra os índices (bins) da FFT para as nossas frequências
    const getBinIndex = (freq: number) => Math.round(freq * bufferLength / (sampleRate / 2));
    
    const binSpace = getBinIndex(this.FREQ_SPACE);
    const binMark = getBinIndex(this.FREQ_MARK);

    let isReceiving = false;
    let bitBuffer: number[] = [];
    let lastBitTime = performance.now();

    // Limiar de magnitude (ajustar conforme teste real em hardware)
    const MAGNITUDE_THRESHOLD = -70; // dB

    const loop = () => {
      if (!this.isListening) return;
      
      this.analyser!.getFloatFrequencyData(dataArray);
      
      const magSpace = dataArray[binSpace];
      const magMark = dataArray[binMark];

      const now = performance.now();
      
      // Demodulador FSK muito primitivo
      if (magMark > MAGNITUDE_THRESHOLD || magSpace > MAGNITUDE_THRESHOLD) {
        if (!isReceiving) {
          // Detectou um possível preamble (sinal acordou)
          if (magMark > magSpace) {
            isReceiving = true;
            bitBuffer = [];
            lastBitTime = now;
            console.log("[AcousticDriver] SINAL ULTRASSÔNICO DETECTADO.");
          }
        } else {
          // Amostragem
          if (now - lastBitTime >= this.BIT_DURATION) {
            const bit = magMark > magSpace ? 1 : 0;
            bitBuffer.push(bit);
            lastBitTime = now;
          }
        }
      } else {
        if (isReceiving && (now - lastBitTime > this.BIT_DURATION * 5)) {
          // Sinal sumiu por tempo suficiente, tenta decodificar
          isReceiving = false;
          this.decodePayload(bitBuffer);
          bitBuffer = [];
        }
      }

      requestAnimationFrame(loop);
    };

    loop();
  }

  private decodePayload(bits: number[]) {
    // Procura a sequência de preamble: 1, 1, 1, 1, 0, 1
    let startIndex = -1;
    for (let i = 0; i < bits.length - 5; i++) {
      if (bits[i]===1 && bits[i+1]===1 && bits[i+2]===1 && bits[i+3]===1 && bits[i+4]===0 && bits[i+5]===1) {
        startIndex = i + 6;
        break;
      }
    }

    if (startIndex === -1 || bits.length - startIndex < 24) return; // Ruído
    
    const bytes: number[] = [];
    // Decodifica aplicando FEC: Tira a moda de cada 3 bits
    for (let i = startIndex; i < bits.length - 23; i += 24) { // 8 bits * 3 = 24
      let byte = 0;
      for (let j = 0; j < 8; j++) {
        const offset = i + (j * 3);
        const b1 = bits[offset] || 0;
        const b2 = bits[offset + 1] || 0;
        const b3 = bits[offset + 2] || 0;
        // FEC Voto Maioritário
        const bit = (b1 + b2 + b3) >= 2 ? 1 : 0;
        byte |= (bit << j);
      }
      bytes.push(byte);
    }
    
    if (bytes.length > 0) {
      try {
        const payload = new TextDecoder().decode(new Uint8Array(bytes));
        console.log(`[AcousticDriver] Payload Decodificado (com FEC): ${payload}`);
        if (this.onMessageReceived) {
          this.onMessageReceived("ACOUSTIC_PEER", payload);
        }
      } catch (e) {
        // Lixo sonoro
      }
    }
  }
}
