/**
 * ETΞRNET — Acoustic Handshake: Troca de Chaves via Ultrassom
 *
 * Dois dispositivos próximos (mesma sala) trocam chaves efêmeras
 * via som ultrassônico (18-20kHz) usando o acousticDriver existente.
 *
 * Fluxo:
 * 1. Alice gera par de chaves efêmero
 * 2. Transmite publicKey via FSK ultrassônico
 * 3. Bob recebe, gera seu par, transmite de volta
 * 4. Ambos derivam shared secret via ECDH
 * 5. Chave compartilhada usada para criptografar comunicação subsequente
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { secureRandomId } from "../utils/secureRandom";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HandshakeSession {
  id: string;
  status: "initiating" | "waiting" | "completed" | "failed";
  localPublicKey: Uint8Array;     // X25519 public key
  localSecretKey: Uint8Array;     // X25519 secret key
  remotePublicKey: Uint8Array | null;
  sharedSecret: Uint8Array | null;
  createdAt: number;
  completedAt: number | null;
}

export type HandshakeListener = (session: HandshakeSession) => void;

// ─── Acoustic Handshake ──────────────────────────────────────────────────────

class AcousticHandshake {
  private static instance: AcousticHandshake;
  private sessions: Map<string, HandshakeSession> = new Map();
  private listeners: Set<HandshakeListener> = new Set();

  public static getInstance(): AcousticHandshake {
    if (!AcousticHandshake.instance) AcousticHandshake.instance = new AcousticHandshake();
    return AcousticHandshake.instance;
  }

  private constructor() {}

  /** Inicia um handshake — gera par de chaves X25519 efêmero */
  initiate(): HandshakeSession {
    const id = `hs_${secureRandomId(8)}`;
    const secretKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(secretKey);

    const session: HandshakeSession = {
      id,
      status: "initiating",
      localPublicKey: publicKey,
      localSecretKey: secretKey,
      remotePublicKey: null,
      sharedSecret: null,
      createdAt: Date.now(),
      completedAt: null,
    };

    this.sessions.set(id, session);
    this.notify(session);

    return session;
  }

  /** Processa chave pública remota recebida — X25519 ECDH real */
  receiveRemoteKey(sessionId: string, remotePublicKey: Uint8Array): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "initiating") return false;

    session.remotePublicKey = remotePublicKey;

    // X25519 Diffie-Hellman real
    const sharedSecret = x25519.getSharedSecret(session.localSecretKey, remotePublicKey);

    // Derivar chave simétrica via SHA3-256 do shared secret
    session.sharedSecret = sha3_256(sharedSecret) as Uint8Array;
    session.status = "completed";
    session.completedAt = Date.now();

    // Limpar chave secreta local
    session.localSecretKey.fill(0);

    this.notify(session);
    return true;
  }

  /** Criptografa dados usando o shared secret */
  encrypt(sessionId: string, data: Uint8Array): Uint8Array | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.sharedSecret || session.status !== "completed") return null;

    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);

    const cipher = chacha20poly1305(session.sharedSecret, nonce);
    const encrypted = cipher.encrypt(data);

    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce, 0);
    result.set(encrypted, nonce.length);

    return result;
  }

  /** Descriptografa dados usando o shared secret */
  decrypt(sessionId: string, data: Uint8Array): Uint8Array | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.sharedSecret || session.status !== "completed") return null;

    try {
      const nonce = data.slice(0, 12);
      const ciphertext = data.slice(12);

      const cipher = chacha20poly1305(session.sharedSecret, nonce);
      return cipher.decrypt(ciphertext);
    } catch {
      return null;
    }
  }

  /** Formata chave pública para transmissão acústica (base64) */
  formatForTransmission(publicKey: Uint8Array): string {
    return btoa(String.fromCharCode(...Array.from(publicKey)));
  }

  /** Parseia chave pública recebida via transmissão acústica */
  parseFromTransmission(data: string): Uint8Array {
    const binary = atob(data);
    return new Uint8Array(Array.from(binary).map(c => c.charCodeAt(0)));
  }

  /** Inscreve-se em eventos de handshake */
  onHandshake(listener: HandshakeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Retorna uma sessão */
  getSession(sessionId: string): HandshakeSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Retorna todas as sessões */
  getSessions(): HandshakeSession[] {
    return Array.from(this.sessions.values());
  }

  private notify(session: HandshakeSession): void {
    for (const listener of Array.from(this.listeners)) {
      try { listener(session); } catch { /* ignore */ }
    }
  }
}

export const acousticHandshake = AcousticHandshake.getInstance();
