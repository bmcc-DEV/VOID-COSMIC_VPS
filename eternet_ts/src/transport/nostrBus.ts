/**
 * VØID — NOSTR Message Bus
 *
 * Kinds do protocolo ETΞRNET:
 *   31214 — Transações UTXO
 *   31215 — Anúncios de mineração
 *   31216 — Atualizações de governança
 *   31217 — DEX orders
 *   31218 — QEL shards
 *   31219 — Heartbeat de rede
 *   31220 — PreKeyBundle (Double Ratchet)
 *
 * Health check a cada 30s. Relays insalubres são excluídos após 3 falhas consecutivas.
 */

import {
  SimplePool,
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  type Filter,
  type NostrEvent,
} from "nostr-tools";

export type { NostrEvent, Filter } from "nostr-tools";

// ─── Constantes ───────────────────────────────────────────────────────────────

export const ETERNET_KINDS = {
  UTXO_TX:          31214,
  MINING_ANNOUNCE:  31215,
  GOVERNANCE:       31216,
  DEX_ORDER:        31217,
  QEL_SHARD:        31218,
  HEARTBEAT:        31219,
  PREKEY_BUNDLE:    31220,
  VOID_TASK:        31222,
  VOID_TASK_RESULT: 31223,
  // Marketplace
  ASSET_RELEASE:       31224,
  ASSET_REVIEW:        31225,
  ASSET_UPDATE:        31226,
  MARKETPLACE_LISTING: 31227,
} as const;

export type EternetKind = (typeof ETERNET_KINDS)[keyof typeof ETERNET_KINDS];

import { VOID_DEV_RELAYS } from "./voidRelays.js";

const DEFAULT_RELAYS = [...VOID_DEV_RELAYS] as const;

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface RelayHealth {
  url: string;
  failures: number;
  lastCheck: number;
  healthy: boolean;
}

export interface PublishResult {
  relay: string;
  success: boolean;
  error?: string;
}

export interface NostrBusConfig {
  relays?: string[];
  privateKey?: Uint8Array;
}

// ─── NostrBus ─────────────────────────────────────────────────────────────────

export class NostrBus {
  private pool: SimplePool;
  private privateKey: Uint8Array;
  private publicKey: string;
  private relayHealth: Map<string, RelayHealth>;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Map<string, ReturnType<SimplePool["subscribeMany"]>> = new Map();

  constructor(config: NostrBusConfig = {}) {
    this.pool = new SimplePool();
    this.privateKey = config.privateKey ?? generateSecretKey();
    this.publicKey = getPublicKey(this.privateKey);

    const relays = config.relays ?? [...DEFAULT_RELAYS];
    this.relayHealth = new Map(
      relays.map((url) => [
        url,
        { url, failures: 0, lastCheck: 0, healthy: true },
      ])
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    this.healthTimer = setInterval(
      () => this.runHealthChecks(),
      HEALTH_CHECK_INTERVAL_MS
    );
  }

  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    for (const [, sub] of this.subscriptions) {
      sub.close();
    }
    this.subscriptions.clear();
    this.pool.close([...this.relayHealth.keys()]);
  }

  // ─── Healthy Relays ─────────────────────────────────────────────────────────

  get healthyRelays(): string[] {
    return [...this.relayHealth.values()]
      .filter((r) => r.healthy)
      .map((r) => r.url);
  }

  private async runHealthChecks(): Promise<void> {
    const checks = [...this.relayHealth.values()].map(async (relay) => {
      try {
        // Tenta um filtro vazio com timeout de 5s
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);

        await new Promise<void>((resolve, reject) => {
          const sub = this.pool.subscribeMany(
            [relay.url],
            { kinds: [ETERNET_KINDS.HEARTBEAT] as number[], limit: 1 } as Filter,
            {
              onevent: () => {
                clearTimeout(timeout);
                sub.close();
                resolve();
              },
              oneose: () => {
                clearTimeout(timeout);
                sub.close();
                resolve();
              },
            }
          );
          controller.signal.addEventListener("abort", () => {
            sub.close();
            reject(new Error("timeout"));
          });
        });

        relay.failures = 0;
        relay.healthy = true;
      } catch {
        relay.failures++;
        if (relay.failures >= MAX_CONSECUTIVE_FAILURES) {
          relay.healthy = false;
        }
      }
      relay.lastCheck = Date.now();
    });

    await Promise.allSettled(checks);
  }

  // ─── Publish ────────────────────────────────────────────────────────────────

  async publish(
    kind: EternetKind,
    content: string,
    tags: string[][] = []
  ): Promise<PublishResult[]> {
    const relays = this.healthyRelays;
    if (relays.length === 0) {
      throw new Error("NostrBus: nenhum relay saudável disponível");
    }

    const event = finalizeEvent(
      {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
      },
      this.privateKey
    );

    const results: PublishResult[] = [];

    await Promise.allSettled(
      relays.map(async (relay) => {
        try {
          // pool.publish devolve Promise[] (um por relay), não uma Promise única
          const publishJobs = this.pool.publish([relay], event);
          const settled = await Promise.race([
            Promise.allSettled(publishJobs),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("publish timeout")), 15_000),
            ),
          ]);
          const ok = settled.some(
            (s) => s.status === "fulfilled" && !String(s.value).startsWith("connection failure"),
          );
          if (!ok) {
            const err = settled
              .filter((s): s is PromiseRejectedResult => s.status === "rejected")
              .map((s) => s.reason)
              .join("; ");
            throw new Error(err || "publish falhou em todos os relays");
          }
          results.push({ relay, success: true });
          const health = this.relayHealth.get(relay);
          if (health) {
            health.failures = 0;
            health.healthy = true;
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          results.push({ relay, success: false, error });
          const health = this.relayHealth.get(relay);
          if (health) {
            health.failures++;
            if (health.failures >= MAX_CONSECUTIVE_FAILURES) {
              health.healthy = false;
            }
          }
        }
      })
    );

    return results;
  }

  // ─── Subscribe ──────────────────────────────────────────────────────────────

  subscribe(
    filter: Filter,
    onEvent: (event: NostrEvent) => void,
    subId?: string
  ): string {
    const id = subId ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const relays = this.healthyRelays;

    const sub = this.pool.subscribeMany(relays, filter, {
      onevent: onEvent,
    });

    this.subscriptions.set(id, sub);
    return id;
  }

  unsubscribe(subId: string): void {
    const sub = this.subscriptions.get(subId);
    if (sub) {
      sub.close();
      this.subscriptions.delete(subId);
    }
  }

  // ─── ETΞRNET específicos ─────────────────────────────────────────────────────

  /** Publica um QEL shard cifrado (kind 31218) */
  async publishQelShard(
    shardHex: string,
    recipientPubkey: string,
    shardIndex: number,
    totalShards: number
  ): Promise<PublishResult[]> {
    return this.publish(
      ETERNET_KINDS.QEL_SHARD,
      shardHex,
      [
        ["p", recipientPubkey],
        ["shard", shardIndex.toString(), totalShards.toString()],
        ["protocol", "eternet-v1"],
      ]
    );
  }

  /** Publica uma transação UTXO (kind 31214) */
  async publishUtxoTx(txJson: string): Promise<PublishResult[]> {
    return this.publish(ETERNET_KINDS.UTXO_TX, txJson, [
      ["protocol", "eternet-v1"],
    ]);
  }

  /** Publica um PreKeyBundle para Double Ratchet (kind 31220) */
  async publishPreKeyBundle(bundleJson: string): Promise<PublishResult[]> {
    return this.publish(ETERNET_KINDS.PREKEY_BUNDLE, bundleJson, [
      ["protocol", "eternet-v1"],
      ["pk-version", "1"],
    ]);
  }

  /** Envia heartbeat da rede (kind 31219) */
  async sendHeartbeat(nodeId: string): Promise<PublishResult[]> {
    return this.publish(
      ETERNET_KINDS.HEARTBEAT,
      JSON.stringify({ nodeId, ts: Date.now() }),
      [["protocol", "eternet-v1"]]
    );
  }

  /** Inscreve-se nos heartbeats da rede */
  onHeartbeat(callback: (event: NostrEvent) => void): string {
    return this.subscribe({ kinds: [ETERNET_KINDS.HEARTBEAT] }, callback);
  }

  /** Inscreve-se em shards destinados à nossa chave */
  onQelShard(callback: (event: NostrEvent) => void): string {
    return this.subscribe(
      {
        kinds: [ETERNET_KINDS.QEL_SHARD],
        "#p": [this.publicKey],
      },
      callback
    );
  }

  /** Chave pública NOSTR deste nó */
  get nodePubkey(): string {
    return this.publicKey;
  }

  /** Status de saúde de todos os relays */
  get relayStatus(): RelayHealth[] {
    return [...this.relayHealth.values()];
  }
}
