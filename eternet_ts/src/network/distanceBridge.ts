/**
 * VØID Core — DistanceBridge (orquestração de transporte)
 *
 * Centraliza a seleção e o envio de shards por canais heterogêneos:
 * BLE, LoRa, malha local HCN (cross-tab) e WebRTC/NOSTR.
 */

import type { Shard } from "../crypto/qel";

export type DistanceBridgeChannel = "BLE" | "LoRa" | "HCN_MESH" | "WEBRTC";

export interface DistanceBridgeDeps {
  ble: {
    isSupported(): boolean;
    startAdvertising(shardData: Uint8Array): Promise<void>;
  };
  lora: {
    isSupported(): boolean;
    sendData(destAddress: number, payload: string): Promise<void>;
  };
  meshChannel: {
    postMessage(message: unknown): void;
  };
  broadcastWebRTC(shard: Shard): void;
  meshSender?(): string;
}

export interface DistanceBridgeRouteResult {
  preferred: DistanceBridgeChannel;
  channel: DistanceBridgeChannel;
  attempted: DistanceBridgeChannel[];
  fallbackUsed: boolean;
}

export interface DistanceBridgeChannelMetrics {
  attempts: number;
  successes: number;
  failures: number;
}

export interface DistanceBridgeRouteSample {
  timestamp: number;
  preferred: DistanceBridgeChannel;
  selected: DistanceBridgeChannel;
  fallbackUsed: boolean;
  attemptsCount: number;
  durationMs: number;
}

export interface DistanceBridgeMetrics {
  totalRouted: number;
  totalFallbacks: number;
  channels: Record<DistanceBridgeChannel, DistanceBridgeChannelMetrics>;
  recentRoutes: DistanceBridgeRouteSample[];
}

const CHANNEL_ORDER: DistanceBridgeChannel[] = ["BLE", "LoRa", "HCN_MESH", "WEBRTC"];

export class DistanceBridge {
  private metrics: DistanceBridgeMetrics = this.createEmptyMetrics();
  private readonly recentLimit = 40;

  constructor(private readonly deps: DistanceBridgeDeps) {}

  /**
   * Seleciona o canal "ideal" para um índice de shard.
   * Mantém comportamento determinístico para facilitar reconstrução e debug.
   */
  selectPreferredChannel(index: number): DistanceBridgeChannel {
    return CHANNEL_ORDER[index % CHANNEL_ORDER.length] ?? "HCN_MESH";
  }

  /**
   * Envia o shard usando canal preferido e fallback automático.
   */
  async routeShard(shard: Shard, shardIndex: number): Promise<DistanceBridgeRouteResult> {
    const startedAt = performance.now();
    const preferred = this.selectPreferredChannel(shardIndex);
    const order = this.getFallbackOrder(preferred);
    const attempted: DistanceBridgeChannel[] = [];
    let selectedChannel: DistanceBridgeChannel | null = null;

    for (const channel of order) {
      attempted.push(channel);
      this.metrics.channels[channel].attempts++;
      try {
        if (await this.tryChannel(channel, shard)) {
          this.metrics.channels[channel].successes++;
          selectedChannel = channel;
          break;
        }
        this.metrics.channels[channel].failures++;
      } catch {
        this.metrics.channels[channel].failures++;
        // Falha no canal atual; tenta o próximo fallback.
      }
    }

    if (!selectedChannel) {
      // HCN_MESH é canal de menor dependência externa; se tudo falhar, força fallback nele.
      this.metrics.channels.HCN_MESH.attempts++;
      this.sendViaMesh(shard);
      this.metrics.channels.HCN_MESH.successes++;
      attempted.push("HCN_MESH");
      selectedChannel = "HCN_MESH";
    }

    const fallbackUsed = attempted.length > 1 || selectedChannel !== preferred;
    this.metrics.totalRouted++;
    if (fallbackUsed) this.metrics.totalFallbacks++;
    this.pushRecentRoute({
      timestamp: Date.now(),
      preferred,
      selected: selectedChannel,
      fallbackUsed,
      attemptsCount: attempted.length,
      durationMs: performance.now() - startedAt,
    });

    return { preferred, channel: selectedChannel, attempted, fallbackUsed };
  }

  /**
   * Retorna métricas agregadas do roteamento.
   */
  getMetrics(): DistanceBridgeMetrics {
    return {
      totalRouted: this.metrics.totalRouted,
      totalFallbacks: this.metrics.totalFallbacks,
      channels: {
        BLE: { ...this.metrics.channels.BLE },
        LoRa: { ...this.metrics.channels.LoRa },
        HCN_MESH: { ...this.metrics.channels.HCN_MESH },
        WEBRTC: { ...this.metrics.channels.WEBRTC },
      },
      recentRoutes: this.metrics.recentRoutes.map((sample) => ({ ...sample })),
    };
  }

  /**
   * Limpa as métricas acumuladas.
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
  }

  private getFallbackOrder(preferred: DistanceBridgeChannel): DistanceBridgeChannel[] {
    const rest = CHANNEL_ORDER.filter(channel => channel !== preferred);
    return [preferred, ...rest];
  }

  private async tryChannel(channel: DistanceBridgeChannel, shard: Shard): Promise<boolean> {
    if (channel === "BLE") {
      if (!this.deps.ble.isSupported()) return false;
      await this.deps.ble.startAdvertising(shard.data);
      return true;
    }

    if (channel === "LoRa") {
      if (!this.deps.lora.isSupported()) return false;
      await this.deps.lora.sendData(0, btoa(JSON.stringify(shard)));
      return true;
    }

    if (channel === "HCN_MESH") {
      this.sendViaMesh(shard);
      return true;
    }

    this.deps.broadcastWebRTC(shard);
    return true;
  }

  private sendViaMesh(shard: Shard): void {
    this.deps.meshChannel.postMessage({
      type: "SHARD_BROADCAST",
      payload: shard,
      sender: this.deps.meshSender?.() ?? "anon_node",
    });
  }

  private createEmptyMetrics(): DistanceBridgeMetrics {
    return {
      totalRouted: 0,
      totalFallbacks: 0,
      channels: {
        BLE: { attempts: 0, successes: 0, failures: 0 },
        LoRa: { attempts: 0, successes: 0, failures: 0 },
        HCN_MESH: { attempts: 0, successes: 0, failures: 0 },
        WEBRTC: { attempts: 0, successes: 0, failures: 0 },
      },
      recentRoutes: [],
    };
  }

  private pushRecentRoute(sample: DistanceBridgeRouteSample): void {
    this.metrics.recentRoutes.push(sample);
    if (this.metrics.recentRoutes.length > this.recentLimit) {
      this.metrics.recentRoutes.splice(0, this.metrics.recentRoutes.length - this.recentLimit);
    }
  }
}

