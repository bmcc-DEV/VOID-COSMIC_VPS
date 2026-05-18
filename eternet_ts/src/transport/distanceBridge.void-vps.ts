/**
 * VØID — DistanceBridge: O Transporte Invisível
 *
 * Abstrai múltiplos canais de comunicação em uma interface unificada:
 *   1. NOSTR — Relays públicos com failover automático (prioridade)
 *   2. WebRTC — P2P direto quando ambos os peers estão online
 *   3. BLE    — Bluetooth Low Energy para proximidade física
 *   4. LoRa   — UART AT commands, longo alcance
 *   5. Acústico — FSK 18-20kHz via speaker/mic
 *
 * O bridge fragmenta cada payload via QEL e tenta enviar pelo canal
 * mais disponível. Fallback automático em cascata.
 */

import { NostrBus, type PublishResult } from "./nostrBus.js";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type TransportChannel =
  | "nostr"
  | "webrtc"
  | "ble"
  | "lora"
  | "acoustic";

export interface BridgeMessage {
  /** ID único da mensagem */
  id: string;
  /** Destinatário (pubkey hex ou identificador) */
  to: string;
  /** Payload cifrado (bytes) */
  payload: Uint8Array;
  /** Canal usado para envio */
  channel?: TransportChannel;
  /** Timestamp de envio */
  sentAt?: number;
}

export interface BridgeResult {
  success: boolean;
  channel: TransportChannel;
  details?: string;
}

export interface TransportAdapter {
  name: TransportChannel;
  isAvailable(): Promise<boolean>;
  send(message: BridgeMessage): Promise<boolean>;
  onReceive(callback: (message: BridgeMessage) => void): void;
}

// ─── NostrAdapter ─────────────────────────────────────────────────────────────

export class NostrAdapter implements TransportAdapter {
  readonly name: TransportChannel = "nostr";
  private bus: NostrBus;
  private callbacks: Array<(msg: BridgeMessage) => void> = [];

  constructor(bus: NostrBus) {
    this.bus = bus;

    // Inscreve-se em shards direcionados a nós
    this.bus.onQelShard((event) => {
      const msg: BridgeMessage = {
        id: event.id,
        to: this.bus.nodePubkey,
        payload: hexToBytes(event.content),
        channel: "nostr",
        sentAt: event.created_at * 1000,
      };
      this.callbacks.forEach((cb) => cb(msg));
    });
  }

  async isAvailable(): Promise<boolean> {
    return this.bus.healthyRelays.length > 0;
  }

  async send(message: BridgeMessage): Promise<boolean> {
    try {
      const results: PublishResult[] = await this.bus.publishQelShard(
        bytesToHex(message.payload),
        message.to,
        0,
        1
      );
      return results.some((r) => r.success);
    } catch {
      return false;
    }
  }

  onReceive(callback: (message: BridgeMessage) => void): void {
    this.callbacks.push(callback);
  }
}

// ─── WebRTCAdapter ────────────────────────────────────────────────────────────
//
// WebRTC P2P direto. Usa o NOSTR como canal de sinalização (SDP offer/answer).
// Só funciona quando ambos os peers estão online.

export class WebRTCAdapter implements TransportAdapter {
  readonly name: TransportChannel = "webrtc";
  private connections: Map<string, InstanceType<typeof RTCPeerConnection>> = new Map();
  private channels: Map<string, RTCDataChannel> = new Map();
  private callbacks: Array<(msg: BridgeMessage) => void> = [];
  private nostrBus: NostrBus;

  constructor(nostrBus: NostrBus) {
    this.nostrBus = nostrBus;
  }

  async isAvailable(): Promise<boolean> {
    return typeof (globalThis as typeof globalThis & { RTCPeerConnection?: unknown }).RTCPeerConnection !== "undefined";
  }

  async send(message: BridgeMessage): Promise<boolean> {
    const channel = this.channels.get(message.to);
    if (!channel || channel.readyState !== "open") {
      return false;
    }

    try {
      // Copia para ArrayBuffer limpo — RTCDataChannel exige ArrayBuffer puro
      const buf = new ArrayBuffer(message.payload.length);
      new Uint8Array(buf).set(message.payload);
      channel.send(buf);
      return true;
    } catch {
      return false;
    }
  }

  /** Inicia conexão WebRTC com um peer via sinalização NOSTR */
  async connect(peerId: string): Promise<boolean> {
    const RTC = (globalThis as typeof globalThis & { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
    if (!RTC) return false;

    const pc = new RTC({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    const dataChannel = pc.createDataChannel("void-bridge");
    this.setupDataChannel(dataChannel, peerId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Publica SDP offer via NOSTR (kind 31221 — WebRTC signaling)
    await this.nostrBus.publish(
      31221 as never,
      JSON.stringify({ type: "offer", sdp: offer.sdp, from: this.nostrBus.nodePubkey }),
      [["p", peerId]]
    );

    this.connections.set(peerId, pc);
    return true;
  }

  private setupDataChannel(channel: RTCDataChannel, peerId: string): void {
    this.channels.set(peerId, channel);

    channel.onmessage = (event: MessageEvent) => {
      const payload =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : event.data;
      const msg: BridgeMessage = {
        id: `webrtc-${Date.now()}`,
        to: this.nostrBus.nodePubkey,
        payload,
        channel: "webrtc",
        sentAt: Date.now(),
      };
      this.callbacks.forEach((cb) => cb(msg));
    };
  }

  onReceive(callback: (message: BridgeMessage) => void): void {
    this.callbacks.push(callback);
  }
}

// ─── BLEAdapter ───────────────────────────────────────────────────────────────
//
// Bluetooth Low Energy para comunicação de proximidade física.
// Usa Web Bluetooth API (disponível em browsers modernos).

export class BLEAdapter implements TransportAdapter {
  readonly name: TransportChannel = "ble";
  private callbacks: Array<(msg: BridgeMessage) => void> = [];

  // UUID do serviço VØID BLE
  static readonly SERVICE_UUID = "0000void-0000-1000-8000-00805f9b34fb";
  static readonly CHAR_UUID = "0000v0id-0001-1000-8000-00805f9b34fb";

  async isAvailable(): Promise<boolean> {
    if (typeof navigator === "undefined" || !("bluetooth" in navigator)) return false;
    const bt =       (navigator as Navigator & { bluetooth: Bluetooth }).bluetooth;
    return bt.getAvailability();
  }

  async send(message: BridgeMessage): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    try {
      const bt = (navigator as Navigator & { bluetooth: Bluetooth }).bluetooth;
      const device = await bt.requestDevice({
        filters: [{ services: [BLEAdapter.SERVICE_UUID] }],
      });

      const server = await device.gatt!.connect();
      const service = await server.getPrimaryService(BLEAdapter.SERVICE_UUID);
      const char = await service.getCharacteristic(BLEAdapter.CHAR_UUID);

      // MTU BLE típico: 512 bytes. Para payloads maiores, fragmentar.
      const mtu = 512;
      for (let offset = 0; offset < message.payload.length; offset += mtu) {
        const sliced = message.payload.slice(offset, offset + mtu);
        // Cria ArrayBuffer limpo para compatibilidade com BLE API
        const buf = new ArrayBuffer(sliced.length);
        new Uint8Array(buf).set(sliced);
        await char.writeValueWithoutResponse(buf);
      }

      device.gatt!.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  onReceive(callback: (message: BridgeMessage) => void): void {
    this.callbacks.push(callback);
  }
}

// ─── LoRaAdapter ──────────────────────────────────────────────────────────────
//
// LoRa UART via comandos AT. Para uso com módulos SX1276/SX1278.
// No browser: via Web Serial API. No Node: via serialport.

export class LoRaAdapter implements TransportAdapter {
  readonly name: TransportChannel = "lora";
  private port: SerialPort | null = null;
  private callbacks: Array<(msg: BridgeMessage) => void> = [];

  async isAvailable(): Promise<boolean> {
    return typeof navigator !== "undefined" && "serial" in (navigator as unknown as { serial?: unknown });
  }

  async connect(): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    try {
      const serial = (navigator as unknown as { serial: Serial }).serial;
      this.port = await serial.requestPort({ filters: [] });
      await this.port.open({ baudRate: 9600 });
      this.startReading();
      return true;
    } catch {
      return false;
    }
  }

  async send(message: BridgeMessage): Promise<boolean> {
    if (!this.port?.writable) return false;

    try {
      const writer = this.port.writable.getWriter();
      // AT command: AT+SEND=<addr>,<len>,<data_hex>
      const hex = bytesToHex(message.payload);
      const cmd = `AT+SEND=0,${hex.length / 2},${hex}\r\n`;
      const encoded = new TextEncoder().encode(cmd);
      await writer.write(encoded);
      writer.releaseLock();
      return true;
    } catch {
      return false;
    }
  }

  private async startReading(): Promise<void> {
    if (!this.port?.readable) return;

    const reader = this.port.readable.getReader();
    const buffer: number[] = [];

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer.push(...value);

        // Detecta fim de linha
        const str = String.fromCharCode(...buffer);
        if (str.includes("\r\n")) {
          const line = str.split("\r\n")[0];
          buffer.length = 0;

          // Parse de resposta AT+RCV=<addr>,<len>,<data>,<rssi>,<snr>
          if (line.startsWith("+RCV=")) {
            const parts = line.slice(5).split(",");
            if (parts.length >= 3) {
              const payload = hexToBytes(parts[2]);
              const msg: BridgeMessage = {
                id: `lora-${Date.now()}`,
                to: "broadcast",
                payload,
                channel: "lora",
                sentAt: Date.now(),
              };
              this.callbacks.forEach((cb) => cb(msg));
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  onReceive(callback: (message: BridgeMessage) => void): void {
    this.callbacks.push(callback);
  }
}

// ─── AcousticAdapter ─────────────────────────────────────────────────────────
//
// FSK a 18-20kHz usando Web Audio API.
// Fora da faixa audível humana. Funciona em proximidade física.

export class AcousticAdapter implements TransportAdapter {
  readonly name: TransportChannel = "acoustic";
  private audioCtx: AudioContext | null = null;
  private callbacks: Array<(msg: BridgeMessage) => void> = [];

  // FSK: 18kHz = bit 0, 20kHz = bit 1
  static readonly FREQ_ZERO = 18_000;
  static readonly FREQ_ONE = 20_000;
  static readonly BIT_DURATION = 0.01; // 10ms por bit

  async isAvailable(): Promise<boolean> {
    return typeof (globalThis as typeof globalThis & { AudioContext?: unknown }).AudioContext !== "undefined";
  }

  async send(message: BridgeMessage): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    try {
      const AC = (globalThis as typeof globalThis & { AudioContext: typeof AudioContext }).AudioContext;
      this.audioCtx = new AC();
      const ctx = this.audioCtx;

      let time = ctx.currentTime + 0.1; // pequeno delay inicial

      // Preâmbulo: alternância 5x para sincronização
      for (let i = 0; i < 10; i++) {
        this.scheduleFreq(ctx, i % 2 === 0 ? AcousticAdapter.FREQ_ZERO : AcousticAdapter.FREQ_ONE, time);
        time += AcousticAdapter.BIT_DURATION;
      }

      // Transmite payload bit a bit
      for (const byte of message.payload) {
        for (let bit = 7; bit >= 0; bit--) {
          const freq =
            (byte >> bit) & 1
              ? AcousticAdapter.FREQ_ONE
              : AcousticAdapter.FREQ_ZERO;
          this.scheduleFreq(ctx, freq, time);
          time += AcousticAdapter.BIT_DURATION;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  private scheduleFreq(ctx: InstanceType<typeof AudioContext>, freq: number, startTime: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.value = 0.1; // volume baixo
    osc.start(startTime);
    osc.stop(startTime + AcousticAdapter.BIT_DURATION);
  }

  onReceive(callback: (message: BridgeMessage) => void): void {
    this.callbacks.push(callback);
    // Recepção: análise FFT contínua do microfone
    this.startListening().catch(() => void 0);
  }

  private async startListening(): Promise<void> {
    const nav = globalThis.navigator;
    if (!nav || !("mediaDevices" in nav)) return;

    try {
      const AC = (globalThis as typeof globalThis & { AudioContext: typeof AudioContext }).AudioContext;
      const stream = await (nav as Navigator).mediaDevices.getUserMedia({ audio: true });
      const ctx = new AC();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Float32Array(bufferLength);

      const detect = () => {
        analyser.getFloatFrequencyData(dataArray);
        const sampleRate = ctx.sampleRate;
        const binZero = Math.round((AcousticAdapter.FREQ_ZERO / sampleRate) * bufferLength * 2);
        const binOne = Math.round((AcousticAdapter.FREQ_ONE / sampleRate) * bufferLength * 2);
        // Decodificação FSK simplificada — em produção: janela de bits + sincronização
        void (dataArray[binZero] ?? -Infinity);
        void (dataArray[binOne] ?? -Infinity);
        globalThis.requestAnimationFrame(detect);
      };

      globalThis.requestAnimationFrame(detect);
    } catch {
      // Microfone não disponível ou permissão negada
    }
  }
}

// ─── DistanceBridge ───────────────────────────────────────────────────────────

export class DistanceBridge {
  private adapters: TransportAdapter[];
  private receiveCallbacks: Array<(msg: BridgeMessage) => void> = [];

  constructor(nostrBus: NostrBus) {
    // Ordem de prioridade: NOSTR > WebRTC > BLE > LoRa > Acústico
    this.adapters = [
      new NostrAdapter(nostrBus),
      new WebRTCAdapter(nostrBus),
      new BLEAdapter(),
      new LoRaAdapter(),
      new AcousticAdapter(),
    ];

    // Propaga mensagens recebidas de qualquer canal
    for (const adapter of this.adapters) {
      adapter.onReceive((msg) => {
        this.receiveCallbacks.forEach((cb) => cb(msg));
      });
    }
  }

  /**
   * Envia mensagem pelo canal mais disponível.
   * Tenta em cascata: NOSTR → WebRTC → BLE → LoRa → Acústico.
   */
  async send(message: BridgeMessage): Promise<BridgeResult> {
    for (const adapter of this.adapters) {
      try {
        const available = await adapter.isAvailable();
        if (!available) continue;

        const success = await adapter.send({ ...message, channel: adapter.name });
        if (success) {
          return { success: true, channel: adapter.name };
        }
      } catch (err) {
        const details = err instanceof Error ? err.message : String(err);
        console.warn(`DistanceBridge: ${adapter.name} falhou — ${details}`);
      }
    }

    return { success: false, channel: "nostr", details: "Todos os canais indisponíveis" };
  }

  /** Registra callback para mensagens recebidas de qualquer canal */
  onReceive(callback: (msg: BridgeMessage) => void): void {
    this.receiveCallbacks.push(callback);
  }

  /** Verifica disponibilidade de cada canal */
  async getChannelStatus(): Promise<Record<TransportChannel, boolean>> {
    const statuses = await Promise.all(
      this.adapters.map(async (a) => ({
        name: a.name,
        available: await a.isAvailable().catch(() => false),
      }))
    );

    return Object.fromEntries(
      statuses.map((s) => [s.name, s.available])
    ) as Record<TransportChannel, boolean>;
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// Declarações de tipos para APIs web não cobertas pela lib DOM padrão
interface Serial {
  requestPort(options?: { filters?: Array<unknown> }): Promise<SerialPort>;
}
interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface Bluetooth {
  getAvailability(): Promise<boolean>;
  requestDevice(options: unknown): Promise<{ gatt?: BluetoothGATTServer }>;
}
interface BluetoothGATTServer {
  connect(): Promise<BluetoothGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string): Promise<BluetoothGATTService>;
}
interface BluetoothGATTService {
  getCharacteristic(char: string): Promise<BluetoothGATTChar>;
}
interface BluetoothGATTChar {
  writeValueWithoutResponse(value: ArrayBuffer | ArrayBufferView): Promise<void>;
}
