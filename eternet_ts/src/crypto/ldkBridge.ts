/**
 * VØID-LN — LDK Bridge (LND REST API Client)
 *
 * Conecta ao nó Lightning próprio via LND REST API (HTTPS + Macaroon).
 * Substitui o stub `declare class LDKNode` por chamadas reais ao LND.
 *
 * Configuração:
 *   ldkBridge.configure("https://lnd.seu-no.com:8080", "macaroon_hex_aqui");
 *
 * Quando não configurado opera em modo stub e lança erros descritivos.
 * Chaves privadas permanecem no nó LND — nunca no browser.
 *
 * Referência: https://lightning.engineering/api-docs/api/lnd/
 */

import { channelStore } from "../storage/channelStore";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LDKChannel {
  channelId: string;
  peerPubkey: string;
  capacitySat: number;
  localBalanceSat: number;
  remoteBalanceSat: number;
  isActive: boolean;
  isPublic: boolean;
}

export interface LDKInvoice {
  bolt11: string;
  paymentHash: string;
  amountMsats: number;
  description: string;
  expiresAt: number;
}

export interface LDKPaymentResult {
  success: boolean;
  preimage: string | undefined;
  feeMsats: number | undefined;
  error: string | undefined;
}

export interface LDKNodeInfo {
  pubkey: string;
  alias: string;
  network: string;
  blockHeight: number;
  synced: boolean;
  numActiveChannels: number;
  numPeers: number;
}

export type LDKEventType =
  | "funding_generated"
  | "funding_broadcast"
  | "funding_locked"
  | "payment_received"
  | "payment_sent"
  | "payment_failed"
  | "channel_closed"
  | "channel_pending";

export interface LDKEvent {
  type: LDKEventType;
  channelId: string | undefined;
  paymentHash: string | undefined;
  preimage: string | undefined;
  amountMsats: number | undefined;
  error: string | undefined;
}

export type LDKEventListener = (event: LDKEvent) => void;

interface LNDConfig {
  restUrl: string;   // ex: "https://127.0.0.1:8080"
  macaroon: string;  // hex-encoded invoice/admin macaroon
}

// ─── LND REST helpers ─────────────────────────────────────────────────────────

async function lndFetch<T>(
  config: LNDConfig,
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const url = `${config.restUrl}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Grpc-Metadata-Macaroon": config.macaroon,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LND REST ${path} → HTTP ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
  return btoa(String.fromCharCode(...bytes));
}

// ─── LDK Bridge ──────────────────────────────────────────────────────────────

export class LDKBridge {
  private config: LNDConfig | null = null;
  private initialized = false;
  private listeners: Set<LDKEventListener> = new Set();
  private subscriptionController: AbortController | null = null;

  /**
   * Configura o bridge com a URL e macaroon do nó LND.
   * Substitui o antigo `init(seed)` — aqui as chaves ficam no nó, nunca no browser.
   */
  configure(lndRestUrl: string, macaroonHex: string): void {
    this.config = {
      restUrl: lndRestUrl.replace(/\/$/, ""),
      macaroon: macaroonHex.trim(),
    };
    this.initialized = true;
    console.log(`[LDK] Configurado: ${this.config.restUrl}`);
  }

  /**
   * Mantém compatibilidade com a API antiga (seed ignorada — chaves ficam no LND).
   * @deprecated Use configure(url, macaroon) em produção.
   */
  async init(_seed: Uint8Array, _network: string = "regtest"): Promise<void> {
    if (!this.config) {
      console.warn(
        "[LDK] init() chamado sem configure(). " +
        "Defina LND_REST_URL e LND_MACAROON_HEX e chame configure() primeiro.",
      );
    }
  }

  private assertConfigured(): LNDConfig {
    if (!this.config) {
      throw new Error(
        "LDK Bridge não configurado. " +
        "Chame ldkBridge.configure(lndUrl, macaroonHex) antes de usar.",
      );
    }
    return this.config;
  }

  // ─── Informações do nó ─────────────────────────────────────────────────────

  /**
   * Retorna informações do nó LND (getinfo).
   */
  async getNodeInfo(): Promise<LDKNodeInfo> {
    const cfg = this.assertConfigured();
    const info = await lndFetch<{
      identity_pubkey: string;
      alias: string;
      chains: Array<{ network: string }>;
      block_height: number;
      synced_to_chain: boolean;
      num_active_channels: number;
      num_peers: number;
    }>(cfg, "/v1/getinfo");

    return {
      pubkey:            info.identity_pubkey,
      alias:             info.alias,
      network:           info.chains[0]?.network ?? "unknown",
      blockHeight:       info.block_height,
      synced:            info.synced_to_chain,
      numActiveChannels: info.num_active_channels,
      numPeers:          info.num_peers,
    };
  }

  /**
   * Retorna a pubkey do nó Lightning (hex).
   */
  getNodePubkey(): string | null {
    return null; // use getNodeInfo() para pubkey real
  }

  async fetchNodePubkey(): Promise<string | null> {
    try {
      const info = await this.getNodeInfo();
      return info.pubkey;
    } catch {
      return null;
    }
  }

  // ─── Canais ────────────────────────────────────────────────────────────────

  /**
   * Lista canais Lightning ativos.
   */
  async listChannels(): Promise<LDKChannel[]> {
    const cfg = this.assertConfigured();
    const data = await lndFetch<{
      channels: Array<{
        channel_point: string;
        remote_pubkey: string;
        capacity: string;
        local_balance: string;
        remote_balance: string;
        active: boolean;
        private: boolean;
      }>;
    }>(cfg, "/v1/channels");

    return (data.channels ?? []).map(ch => ({
      channelId:        ch.channel_point,
      peerPubkey:       ch.remote_pubkey,
      capacitySat:      parseInt(ch.capacity, 10),
      localBalanceSat:  parseInt(ch.local_balance, 10),
      remoteBalanceSat: parseInt(ch.remote_balance, 10),
      isActive:         ch.active,
      isPublic:         !ch.private,
    }));
  }

  /**
   * Número de canais ativos (compatibilidade com API antiga).
   */
  getChannelCount(): number {
    return 0; // use listChannels() para contagem real
  }

  /**
   * Abre um canal com um peer.
   */
  async openChannel(
    peerPubkey: string,
    localSat: number,
    pushSat = 0,
    isPrivate = false,
  ): Promise<{ fundingTxid: string; outputIndex: number }> {
    const cfg = this.assertConfigured();
    const res = await lndFetch<{ funding_txid_bytes: string; output_index: number }>(
      cfg,
      "/v1/channels",
      {
        method: "POST",
        body: JSON.stringify({
          node_pubkey_string: peerPubkey,
          local_funding_amount: localSat.toString(),
          push_sat: pushSat.toString(),
          private: isPrivate,
          spend_unconfirmed: false,
        }),
      },
    );

    await this.persistChannelEvent("channel_opened", peerPubkey, {
      fundingTxid:   res.funding_txid_bytes,
      outputIndex:   res.output_index,
      localSat,
      pushSat,
    });

    return {
      fundingTxid:  res.funding_txid_bytes,
      outputIndex:  res.output_index,
    };
  }

  /**
   * Fecha um canal.
   */
  async closeChannel(
    channelPoint: string,
    force = false,
  ): Promise<void> {
    const cfg = this.assertConfigured();
    const [txid, outputIndex] = channelPoint.split(":");
    const path = `/v1/channels/${txid}/${outputIndex}?force=${force}`;
    await lndFetch(cfg, path, { method: "DELETE" });
    console.log(`[LDK] Canal fechado: ${channelPoint}`);
  }

  // ─── Invoices / Pagamentos ─────────────────────────────────────────────────

  /**
   * Cria uma invoice BOLT11 real via LND.
   */
  async createInvoice(
    amountMsats: number,
    description: string,
    expirySecs = 3600,
  ): Promise<LDKInvoice> {
    const cfg = this.assertConfigured();
    const res = await lndFetch<{
      payment_request: string;
      r_hash: string;
      add_index: string;
    }>(cfg, "/v1/invoices", {
      method: "POST",
      body: JSON.stringify({
        value_msat:  amountMsats.toString(),
        memo:        description,
        expiry:      expirySecs.toString(),
      }),
    });

    return {
      bolt11:       res.payment_request,
      paymentHash:  res.r_hash,
      amountMsats,
      description,
      expiresAt:    Math.floor(Date.now() / 1000) + expirySecs,
    };
  }

  /**
   * Paga uma invoice BOLT11 real via LND.
   */
  async payInvoice(
    bolt11: string,
    maxFeeSat = 10,
  ): Promise<LDKPaymentResult> {
    const cfg = this.assertConfigured();
    try {
      const res = await lndFetch<{
        payment_preimage?: string;
        payment_error?: string;
        fee_sat?: string;
      }>(cfg, "/v1/channels/transactions", {
        method: "POST",
        body: JSON.stringify({
          payment_request: bolt11,
          fee_limit: { fixed: maxFeeSat.toString() },
        }),
      });

      if (res.payment_error && res.payment_error !== "") {
        return { success: false, error: res.payment_error, preimage: undefined, feeMsats: undefined };
      }

      const preimageHex = res.payment_preimage
        ? hexToBase64(res.payment_preimage)
        : undefined;

      this.emit({
        type:        "payment_sent",
        preimage:    preimageHex ?? undefined,
        amountMsats: undefined,
        channelId:   undefined,
        paymentHash: undefined,
        error:       undefined,
      });

      return {
        success:   true,
        preimage:  preimageHex ?? undefined,
        feeMsats:  res.fee_sat ? parseInt(res.fee_sat, 10) * 1000 : undefined,
        error:     undefined,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ type: "payment_failed", error: msg, preimage: undefined, amountMsats: undefined, channelId: undefined, paymentHash: undefined });
      return { success: false, error: msg, preimage: undefined, feeMsats: undefined };
    }
  }

  /**
   * Consulta o status de uma invoice pelo payment hash (hex ou base64).
   */
  async lookupInvoice(rHashHex: string): Promise<{
    settled: boolean;
    amountMsats: number;
    settledAt?: number;
  }> {
    const cfg = this.assertConfigured();
    const b64 = hexToBase64(rHashHex);
    const encoded = encodeURIComponent(b64);
    const res = await lndFetch<{
      settled: boolean;
      value_msat: string;
      settle_date: string;
    }>(cfg, `/v1/invoice/${encoded}`);

    const settledAt = res.settled ? parseInt(res.settle_date, 10) : undefined;
    return {
      settled:    res.settled,
      amountMsats: parseInt(res.value_msat, 10),
      ...(settledAt !== undefined ? { settledAt } : {}),
    };
  }

  /**
   * Saldo disponível nos canais (local + remote).
   */
  async getChannelBalance(): Promise<{ localSat: number; remoteSat: number }> {
    const cfg = this.assertConfigured();
    const res = await lndFetch<{
      local_balance: { sat: string };
      remote_balance: { sat: string };
    }>(cfg, "/v1/balance/channels");
    return {
      localSat:  parseInt(res.local_balance?.sat ?? "0", 10),
      remoteSat: parseInt(res.remote_balance?.sat ?? "0", 10),
    };
  }

  // ─── Eventos / SSE ────────────────────────────────────────────────────────

  /**
   * Inscreve em atualizações de invoice via Server-Sent Events (LND /v1/invoices/subscribe).
   * Notifica listeners quando uma invoice for paga.
   */
  subscribeToInvoices(): void {
    if (!this.config || this.subscriptionController) return;

    this.subscriptionController = new AbortController();
    const { signal } = this.subscriptionController;
    const cfg = this.config;

    fetch(`${cfg.restUrl}/v1/invoices/subscribe`, {
      headers: { "Grpc-Metadata-Macaroon": cfg.macaroon },
      signal,
    }).then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        try {
          const line = dec.decode(value).trim();
          if (!line.startsWith("{")) continue;
          const data = JSON.parse(line) as {
            result?: { settled?: boolean; r_preimage?: string; value_msat?: string };
          };
          if (data.result?.settled) {
            this.emit({
              type:        "payment_received",
              preimage:    data.result.r_preimage ?? undefined,
              amountMsats: data.result.value_msat
                ? parseInt(data.result.value_msat, 10)
                : undefined,
              channelId:   undefined,
              paymentHash: undefined,
              error:       undefined,
            });
          }
        } catch { /* parse error — ignora */ }
      }
    }).catch((err) => {
      if (!signal.aborted) {
        console.warn("[LDK] Invoice subscription error:", err);
      }
    });
  }

  unsubscribe(): void {
    this.subscriptionController?.abort();
    this.subscriptionController = null;
  }

  // ─── Listeners ─────────────────────────────────────────────────────────────

  onEvent(listener: LDKEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: LDKEvent): void {
    for (const l of this.listeners) {
      try { l(event); } catch { /* ignore */ }
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  // ─── Persistência de estado de canal ──────────────────────────────────────

  private async persistChannelEvent(
    action: string,
    channelId: string,
    data: object,
  ): Promise<void> {
    try {
      const encoded = new TextEncoder().encode(JSON.stringify(data));
      await channelStore.saveMonitor({
        id:        channelId,
        data:      encoded,
        updatedAt: Date.now(),
        channelId,
      });
      console.log(`[LDK] Persistido ${action} para ${channelId.slice(0, 8)}...`);
    } catch (err) {
      console.warn(`[LDK] Falha ao persistir ${action}:`, err);
    }
  }

  /** @deprecated use subscribeToInvoices() + onEvent() */
  processMessage(_peerPubkey: Uint8Array, _message: Uint8Array): Uint8Array | null {
    return null;
  }
}

// Singleton
export const ldkBridge = new LDKBridge();
