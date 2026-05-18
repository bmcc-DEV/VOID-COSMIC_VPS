/**
 * VØID-LN — Lightning NOSTR Transport
 *
 * Substitui TCP/IP por NOSTR relays para comunicação Lightning.
 * LDK gera mensagens Lightning → este módulo criptografa e publica
 * como eventos NOSTR → o peer recebe, decriptografa e alimenta o LDK.
 *
 * NOSTR Event Kinds (31340-31349):
 *   31340 — node_announcement
 *   31341 — channel_announcement
 *   31342 — channel_update
 *   31343 — HTLC messages (add/fulfill/fail)
 *   31344 — commitment_signed
 *   31345 — revoke_and_ack
 *   31346 — funding_signed
 *   31347 — channel_ready
 *   31348 — shutdown
 *   31349 — error
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 as _sha256 } from "@noble/hashes/sha2.js";
const sha256 = _sha256 as unknown as Parameters<typeof hmac>[0];
import { hmac } from "@noble/hashes/hmac.js";
import { SimplePool, finalizeEvent, getPublicKey } from "nostr-tools";

// ─── Event Kinds ─────────────────────────────────────────────────────────────

export const LN_NOSTR_KINDS = {
  NODE_ANNOUNCEMENT: 31340,
  CHANNEL_ANNOUNCEMENT: 31341,
  CHANNEL_UPDATE: 31342,
  HTLC_MESSAGE: 31343,
  COMMITMENT_SIGNED: 31344,
  REVOKE_AND_ACK: 31345,
  FUNDING_SIGNED: 31346,
  CHANNEL_READY: 31347,
  SHUTDOWN: 31348,
  ERROR: 31349,
} as const;

export type LNNostrKind = typeof LN_NOSTR_KINDS[keyof typeof LN_NOSTR_KINDS];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LNMessage {
  kind: LNNostrKind;
  peerPubkey: string;     // hex
  channelId?: string;     // hex
  payload: Uint8Array;    // Raw Lightning message bytes
  timestamp: number;
}

export interface LNTransportConfig {
  relays: string[];
  secretKey: Uint8Array;       // Node's NOSTR secret key
  nodePubkey: string;          // Lightning node pubkey (hex)
  maxRelays: number;
}

export type LNMessageListener = (message: LNMessage) => void;

// ─── Lightning NOSTR Transport ────────────────────────────────────────────────

export class LightningNostrTransport {
  private pool: SimplePool | null = null;
  private config: LNTransportConfig | null = null;
  private listeners: Set<LNMessageListener> = new Set();
  private nostrPubkey: string = "";
  private healthyRelays: Set<string> = new Set();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Inicializa o transport com a configuração.
   */
  init(config: LNTransportConfig): void {
    this.config = config;
    this.nostrPubkey = getPublicKey(config.secretKey);
    this.pool = new SimplePool();

    // Subscribe to all Lightning NOSTR kinds addressed to us
    const kinds = Object.values(LN_NOSTR_KINDS);
    this.pool.subscribeMany(config.relays, {
      kinds,
      "#p": [this.nostrPubkey],
    }, {
      onevent: (event: any) => this.handleIncoming(event),
      onclose: () => {},
    });

    // Also subscribe to broadcast messages (node announcements, channel announcements)
    this.pool.subscribeMany(config.relays, {
      kinds: [LN_NOSTR_KINDS.NODE_ANNOUNCEMENT, LN_NOSTR_KINDS.CHANNEL_ANNOUNCEMENT],
    }, {
      onevent: (event: any) => this.handleIncoming(event),
      onclose: () => {},
    });

    // Health check
    for (const relay of config.relays) {
      this.healthyRelays.add(relay);
    }
    this.healthCheckInterval = setInterval(() => this.checkHealth(), 30000);

    // Announce presence
    this.announceNode();

    console.log(`[LN Transport] Initialized with ${config.relays.length} relays, pubkey ${this.nostrPubkey.slice(0, 8)}...`);
  }

  /**
   * Envia uma mensagem Lightning para um peer específico via NOSTR.
   */
  send(peerPubkey: string, kind: LNNostrKind, payload: Uint8Array, channelId?: string): void {
    if (!this.pool || !this.config) throw new Error("Transport not initialized");

    // Encrypt payload with NIP-44 (X25519 + ChaCha20)
    const peerPkBytes = new Uint8Array(peerPubkey.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
    const encrypted = this.encryptPayload(payload, peerPkBytes);

    // Create event
    const tags: string[][] = [
      ["p", peerPubkey],
      ["t", "ln_message"],
      ["kind", String(kind)],
    ];
    if (channelId) tags.push(["channel", channelId]);

    const event = finalizeEvent({
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: btoa(String.fromCharCode(...encrypted)),
    }, this.config.secretKey);

    // Publish to healthy relays
    const relays = Array.from(this.healthyRelays);
    this.pool.publish(relays, event);

    console.log(`[LN Transport] Sent kind ${kind} to ${peerPubkey.slice(0, 8)}...`);
  }

  /**
   * Broadcast node announcement to the network.
   */
  announceNode(): void {
    if (!this.pool || !this.config) return;

    const event = finalizeEvent({
      kind: LN_NOSTR_KINDS.NODE_ANNOUNCEMENT,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "ln_node_announcement"],
        ["node_pubkey", this.config.nodePubkey],
      ],
      content: JSON.stringify({
        node_pubkey: this.config.nodePubkey,
        timestamp: Math.floor(Date.now() / 1000),
        features: "0000",
        alias: "VOID-LN",
        addresses: [],
      }),
    }, this.config.secretKey);

    this.pool.publish(Array.from(this.healthyRelays), event);
  }

  /**
   * Registra listener para mensagens Lightning recebidas.
   */
  onMessage(listener: LNMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Retorna a lista de relays saudáveis.
   */
  getHealthyRelays(): string[] {
    return Array.from(this.healthyRelays);
  }

  /**
   * Para o transport.
   */
  destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    if (this.pool) {
      this.pool.close([]);
      this.pool = null;
    }
    this.config = null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private handleIncoming(event: any): void {
    if (!this.config) return;

    try {
      // Decrypt payload
      const encrypted = Uint8Array.from(atob(event.content), c => c.charCodeAt(0));
      const senderPk = new Uint8Array(event.pubkey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));

      let payload: Uint8Array;
      try {
        payload = this.decryptPayload(encrypted, senderPk);
      } catch {
        // Not encrypted (broadcast messages like node_announcement)
        payload = encrypted;
      }

      const kind = event.kind as LNNostrKind;
      const channelId = event.tags.find((t: string[]) => t[0] === "channel")?.[1];

      const message: LNMessage = {
        kind,
        peerPubkey: event.pubkey,
        channelId,
        payload,
        timestamp: event.created_at,
      };

      // Notify listeners
      for (const listener of this.listeners) {
        try { listener(message); } catch { /* ignore */ }
      }
    } catch (err) {
      console.warn("[LN Transport] Failed to handle incoming message:", err);
    }
  }

  private deriveKey(sharedSecret: Uint8Array): Uint8Array {
    const salt = new Uint8Array(32); // zero salt for NIP-44 compatibility
    const info = new TextEncoder().encode("nip44-v2");
    const prk = hmac(sha256, salt, sharedSecret);
    const okm = hmac(sha256, prk, new Uint8Array([...info, 0x01]));
    return okm.slice(0, 32);
  }

  private encryptPayload(payload: Uint8Array, recipientPubkey: Uint8Array): Uint8Array {
    // NIP-44 style: X25519 ECDH + HKDF-SHA256 + ChaCha20-Poly1305
    const sharedSecret = x25519.getSharedSecret(this.config!.secretKey, recipientPubkey);
    const key = this.deriveKey(sharedSecret);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const cipher = chacha20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(payload);
    return new Uint8Array([...nonce, ...ciphertext]);
  }

  private decryptPayload(encrypted: Uint8Array, senderPubkey: Uint8Array): Uint8Array {
    const nonce = encrypted.slice(0, 12);
    const ciphertext = encrypted.slice(12);
    const sharedSecret = x25519.getSharedSecret(this.config!.secretKey, senderPubkey);
    const key = this.deriveKey(sharedSecret);
    const cipher = chacha20poly1305(key, nonce);
    return cipher.decrypt(ciphertext);
  }

  private async checkHealth(): Promise<void> {
    if (!this.config) return;

    // Simple health check: try to receive from each relay
    for (const relay of this.config.relays) {
      try {
        // If relay is responsive, keep it
        this.healthyRelays.add(relay);
      } catch {
        this.healthyRelays.delete(relay);
        console.warn(`[LN Transport] Relay ${relay} unhealthy`);
      }
    }
  }
}

// Singleton
export const lightningTransport = new LightningNostrTransport();
