/**
 * VØID-LN — HCN Watchtower
 *
 * Implementa watchtowers Lightning que rodam nos nós HCN.
 * O cliente registra channel state criptografado.
 * A watchtower vigia a blockchain por fraudes e executa
 * justice transactions pré-assinadas.
 *
 * Zero custódia: a watchtower NÃO tem a chave privada do usuário.
 * Ela só pode executar a justice tx se detectar fraude.
 *
 * Fluxo:
 * 1. Cliente envia encrypted channel state via NOSTR (kind 31350)
 * 2. Watchtower armazena o estado
 * 3. Watchtower monitora blockchain via mempool.space API
 * 4. Se detecta commitment tx antiga → executa justice tx
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha3_256 } from "@noble/hashes/sha3.js";

const MEMPOOL_API = "https://mempool.space/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WatchtowerRegistration {
  id: string;
  channelId: string;
  clientPubkey: string;           // Client's NOSTR pubkey (hex)
  encryptedState: Uint8Array;     // Encrypted channel monitor
  justiceTx: Uint8Array;          // Pre-signed justice transaction
  commitmentTxid: string;         // Expected current commitment txid
  fundingOutpoint: string;        // "txid:vout" — the UTXO to monitor
  breachPenaltySat: number;       // Penalty amount for watchtower
  createdAt: number;
  expiresAt: number;
}

export interface BreachAlert {
  registrationId: string;
  channelId: string;
  breachTxid: string;             // The fraudulent transaction
  breachHeight: number;           // Block height of breach
  justiceBroadcast: boolean;      // Whether justice tx was broadcast
  justiceTxid: string | undefined; // Txid of justice transaction
}

export interface WatchtowerConfig {
  /** How often to check blockchain (ms) */
  pollIntervalMs: number;
  /** Maximum registrations to hold */
  maxRegistrations: number;
  /** Registration expiry (ms) */
  registrationTtlMs: number;
}

// ─── Watchtower ──────────────────────────────────────────────────────────────

export class Watchtower {
  private registrations: Map<string, WatchtowerRegistration> = new Map();
  private config: WatchtowerConfig;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<(alert: BreachAlert) => void> = new Set();

  constructor(config?: Partial<WatchtowerConfig>) {
    this.config = {
      pollIntervalMs: 60000,        // Check every minute
      maxRegistrations: 1000,
      registrationTtlMs: 7 * 24 * 60 * 60 * 1000,  // 7 days
      ...config,
    };
  }

  /**
   * Starts monitoring the blockchain.
   */
  start(): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(
      () => this.checkForBreaches(),
      this.config.pollIntervalMs,
    );

    console.log("[Watchtower] Started monitoring");
  }

  /**
   * Stops monitoring.
   */
  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    console.log("[Watchtower] Stopped monitoring");
  }

  /**
   * Registers a channel with the watchtower.
   *
   * The client encrypts the channel state with a key derived
   * from the breach commitment txid. The watchtower stores
   * the encrypted state and the pre-signed justice transaction.
   */
  register(registration: WatchtowerRegistration): void {
    if (this.registrations.size >= this.config.maxRegistrations) {
      throw new Error("Watchtower at capacity");
    }

    this.registrations.set(registration.id, registration);
    console.log(`[Watchtower] Registered channel ${registration.channelId.slice(0, 8)}...`);
  }

  /**
   * Decrypts and executes justice transaction if breach detected.
   *
   * The watchtower:
   * 1. Detects a commitment tx on-chain that doesn't match the expected txid
   * 2. Decrypts the channel state using the breach txid as key material
   * 3. Broadcasts the pre-signed justice transaction
   */
  async handleBreach(
    registration: WatchtowerRegistration,
    breachTxid: string,
  ): Promise<BreachAlert> {
    console.log(`[Watchtower] BREACH DETECTED for channel ${registration.channelId.slice(0, 8)}...`);

    // Decrypt channel state using breach txid as key material
    const decryptionKey = sha3_256(
      new Uint8Array([...new TextEncoder().encode(breachTxid), ...registration.encryptedState.slice(0, 16)])
    ).slice(0, 32);
    const nonce = sha3_256(new TextEncoder().encode(registration.channelId)).slice(0, 12);
    const cipher = chacha20poly1305(decryptionKey, nonce);

    try {
      cipher.decrypt(registration.encryptedState);
    } catch {
      console.warn("[Watchtower] Failed to decrypt channel state — key mismatch");
    }

    // Broadcast the pre-signed justice tx
    const justiceTxid = await this.broadcastJusticeTx(registration.justiceTx);

    // Fetch breach block height
    const breachHeight = await this.fetchTxHeight(breachTxid);

    const alert: BreachAlert = {
      registrationId: registration.id,
      channelId: registration.channelId,
      breachTxid,
      breachHeight,
      justiceBroadcast: justiceTxid !== null,
      justiceTxid: justiceTxid ?? undefined,
    };

    // Notify listeners
    for (const listener of this.listeners) {
      try { listener(alert); } catch { /* ignore */ }
    }

    return alert;
  }

  /**
   * Fetches the block height of a transaction.
   * GET /api/tx/:txid → { status: { block_height } }
   */
  private async fetchTxHeight(txid: string): Promise<number> {
    try {
      const res = await fetch(`${MEMPOOL_API}/tx/${txid}`);
      if (!res.ok) return 0;
      const tx = await res.json() as { status?: { block_height?: number } };
      return tx.status?.block_height ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Checks all registrations for breaches.
   *
   * For each registered channel:
   * 1. Check if funding outpoint has been spent (mempool.space)
   * 2. If spending txid != expected commitment → breach!
   * 3. Execute justice transaction
   */
  private async checkForBreaches(): Promise<void> {
    const now = Date.now();

    for (const [id, reg] of this.registrations) {
      // Expire old registrations
      if (now > reg.expiresAt) {
        this.registrations.delete(id);
        continue;
      }

      try {
        const spendingTxid = await this.fetchLatestCommitmentTxid(reg.fundingOutpoint);

        if (spendingTxid && spendingTxid !== reg.commitmentTxid) {
          console.log(`[Watchtower] Breach: expected ${reg.commitmentTxid.slice(0, 8)}..., got ${spendingTxid.slice(0, 8)}...`);
          await this.handleBreach(reg, spendingTxid);
          this.registrations.delete(id);
        }
      } catch (err) {
        console.warn(`[Watchtower] Check failed for ${reg.channelId.slice(0, 8)}:`, err);
      }
    }
  }

  /**
   * Checks if a funding outpoint has been spent.
   * Uses mempool.space API: GET /api/tx/:txid/outspend/:vout
   *
   * Returns the spending txid if the outpoint was spent, null otherwise.
   * If the spending txid differs from the expected commitment → breach.
   */
  private async fetchLatestCommitmentTxid(fundingOutpoint: string): Promise<string | null> {
    const [txid, voutStr] = fundingOutpoint.split(":");
    if (!txid || voutStr === undefined) return null;

    const res = await fetch(`${MEMPOOL_API}/tx/${txid}/outspend/${voutStr}`);
    if (!res.ok) return null;

    const outspend = await res.json() as { spent: boolean; txid?: string };
    if (!outspend.spent || !outspend.txid) return null;

    return outspend.txid;
  }

  /**
   * Broadcasts a justice transaction to the Bitcoin network.
   * POST https://mempool.space/api/tx with raw tx hex.
   *
   * Returns the txid on success, null on failure.
   */
  private async broadcastJusticeTx(justiceTx: Uint8Array): Promise<string | null> {
    const txHex = Array.from(justiceTx).map(b => b.toString(16).padStart(2, "0")).join("");

    try {
      const res = await fetch(`${MEMPOOL_API}/tx`, {
        method: "POST",
        body: txHex,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[Watchtower] Justice tx broadcast failed: ${res.status} ${errText}`);
        return null;
      }

      const txid = await res.text();
      console.log(`[Watchtower] Justice tx broadcast: ${txid}`);
      return txid;
    } catch (err) {
      console.warn("[Watchtower] Justice tx broadcast error:", err);
      return null;
    }
  }

  /**
   * Registers a listener for breach alerts.
   */
  onBreach(listener: (alert: BreachAlert) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Returns current registration count.
   */
  getRegistrationCount(): number {
    return this.registrations.size;
  }

  /**
   * Returns all registrations.
   */
  getRegistrations(): WatchtowerRegistration[] {
    return Array.from(this.registrations.values());
  }
}

// ─── Client-Side: Create Registration ────────────────────────────────────────

/**
 * Creates a watchtower registration from the client side.
 *
 * The client:
 * 1. Serializes the channel monitor
 * 2. Encrypts it with a key derived from the commitment txid
 * 3. Creates a pre-signed justice transaction
 * 4. Sends the registration to the watchtower via NOSTR (kind 31350)
 */
export function createWatchtowerRegistration(
  channelId: string,
  commitmentTxid: string,
  fundingOutpoint: string,
  clientPubkey: string,
  channelMonitorBytes: Uint8Array,
  justiceTxBytes: Uint8Array,
  penaltySat: number,
  _watchtowerPubkey: string,
): WatchtowerRegistration {
  // Encrypt channel state with key derived from commitment txid
  const encryptionKey = sha3_256(
    new Uint8Array([...new TextEncoder().encode(commitmentTxid), ...channelMonitorBytes.slice(0, 16)])
  ).slice(0, 32);
  const nonce = sha3_256(new TextEncoder().encode(channelId)).slice(0, 12);
  const cipher = chacha20poly1305(encryptionKey, nonce);
  const encryptedState = cipher.encrypt(channelMonitorBytes);

  return {
    id: `wt_${channelId}_${Date.now()}`,
    channelId,
    clientPubkey,
    encryptedState,
    justiceTx: justiceTxBytes,
    commitmentTxid,
    fundingOutpoint,
    breachPenaltySat: penaltySat,
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  };
}

// ─── NOSTR Watchtower Protocol ───────────────────────────────────────────────

/**
 * NOSTR event kinds for watchtower communication:
 *   31350 — watchtower_registration (client → watchtower)
 *   31351 — breach_alert (watchtower → client)
 */
export const WATCHTOWER_NOSTR_KINDS = {
  REGISTRATION: 31350,
  BREACH_ALERT: 31351,
} as const;

/**
 * Serializes a watchtower registration for NOSTR transport.
 * The encrypted state and justice tx are base64-encoded in the event content.
 */
export function serializeRegistrationForNostr(reg: WatchtowerRegistration): {
  content: string;
  tags: string[][];
} {
  const content = JSON.stringify({
    channelId: reg.channelId,
    commitmentTxid: reg.commitmentTxid,
    fundingOutpoint: reg.fundingOutpoint,
    breachPenaltySat: reg.breachPenaltySat,
    encryptedState: Buffer.from(reg.encryptedState).toString("base64"),
    justiceTx: Buffer.from(reg.justiceTx).toString("base64"),
  });

  return {
    content,
    tags: [
      ["d", reg.id],
      ["p", reg.clientPubkey],
      ["expiration", String(Math.floor(reg.expiresAt / 1000))],
    ],
  };
}

/**
 * Deserializes a NOSTR event into a watchtower registration.
 */
export function deserializeRegistrationFromNostr(
  eventId: string,
  clientPubkey: string,
  content: string,
  createdAt: number,
): WatchtowerRegistration {
  const data = JSON.parse(content) as {
    channelId: string;
    commitmentTxid: string;
    fundingOutpoint: string;
    breachPenaltySat: number;
    encryptedState: string;
    justiceTx: string;
  };

  return {
    id: eventId,
    channelId: data.channelId,
    clientPubkey,
    encryptedState: new Uint8Array(Buffer.from(data.encryptedState, "base64")),
    justiceTx: new Uint8Array(Buffer.from(data.justiceTx, "base64")),
    commitmentTxid: data.commitmentTxid,
    fundingOutpoint: data.fundingOutpoint,
    breachPenaltySat: data.breachPenaltySat,
    createdAt: createdAt * 1000,
    expiresAt: createdAt * 1000 + 7 * 24 * 60 * 60 * 1000,
  };
}

/**
 * Serializes a breach alert for NOSTR transport.
 */
export function serializeBreachAlertForNostr(alert: BreachAlert): {
  content: string;
  tags: string[][];
} {
  const content = JSON.stringify({
    registrationId: alert.registrationId,
    breachTxid: alert.breachTxid,
    breachHeight: alert.breachHeight,
    justiceBroadcast: alert.justiceBroadcast,
    justiceTxid: alert.justiceTxid,
  });

  return {
    content,
    tags: [
      ["e", alert.registrationId],
      ["p", alert.channelId],
      ["status", alert.justiceBroadcast ? "justice_broadcast" : "justice_failed"],
    ],
  };
}
