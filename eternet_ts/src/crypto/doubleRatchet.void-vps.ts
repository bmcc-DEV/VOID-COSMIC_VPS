/**
 * VØID — Double Ratchet (X25519 + ChaCha20-Poly1305 + Ed25519)
 *
 * Implementa o Signal Protocol Double Ratchet:
 * 1. X25519 ECDH para acordo inicial de chaves.
 * 2. Ratchet simétrico — chave única por mensagem, deletada após uso (forward secrecy).
 * 3. DH Ratchet — novo par de chaves X25519 a cada step (post-compromise security).
 * 4. Ed25519 signatures em cada mensagem (autenticação).
 * 5. Pre-key bundles publicados via NOSTR para troca offline.
 */

import { x25519, ed25519 } from "@noble/curves/ed25519";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface DHKeyPair {
  privateKey: Uint8Array; // 32 bytes X25519
  publicKey: Uint8Array;  // 32 bytes X25519
}

export interface RatchetState {
  /** Par de chaves DH do ratchet atual */
  dhSelf: DHKeyPair;
  /** Chave pública do outro lado (último recebido) */
  dhRemote: Uint8Array | null;
  /** Root Key (32 bytes) — alimenta os KDFs dos ratchets */
  rootKey: Uint8Array;
  /** Chain Key de envio (32 bytes) */
  sendChainKey: Uint8Array | null;
  /** Chain Key de recepção (32 bytes) */
  recvChainKey: Uint8Array | null;
  /** Contador de mensagens enviadas no step atual */
  sendCount: number;
  /** Contador de mensagens recebidas no step atual */
  recvCount: number;
  /** Número de mensagens no step anterior (para mensagens atrasadas) */
  prevSendCount: number;
  /** Cache de message keys para mensagens out-of-order */
  skippedKeys: Map<string, Uint8Array>;
}

export interface EncryptedMessage {
  /** Ciphertext cifrado com ChaCha20-Poly1305 */
  ciphertext: Uint8Array;
  /** Chave pública DH deste step do ratchet */
  dhPublic: Uint8Array;
  /** Número de mensagem no step atual */
  messageNumber: number;
  /** Número de mensagens no step anterior */
  prevChainLength: number;
  /** Assinatura Ed25519 de toda a mensagem */
  signature: Uint8Array;
  /** Nonce aleatório de 12 bytes */
  nonce: Uint8Array;
}

export interface PreKeyBundle {
  /** Chave pública de identidade Ed25519 */
  identityKey: Uint8Array;
  /** Chave pública efêmera X25519 (pré-chave assinada) */
  signedPreKey: Uint8Array;
  /** Assinatura da pré-chave pela chave de identidade */
  preKeySignature: Uint8Array;
  /** One-time pre-key X25519 (descartada após um uso) */
  oneTimePreKey: Uint8Array;
}

// ─── KDF Functions ────────────────────────────────────────────────────────────

const VOID_RATCHET_DOMAIN = new TextEncoder().encode("void-double-ratchet-v1");
const VOID_MSG_KEY_DOMAIN = new TextEncoder().encode("void-msg-key-v1");

/** KDF raiz: deriva nova rootKey + chainKey a partir de DH input */
function kdfRoot(
  rootKey: Uint8Array,
  dhOutput: Uint8Array
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const okm = hkdf(sha256, dhOutput, rootKey, VOID_RATCHET_DOMAIN, 64);
  return {
    rootKey: okm.slice(0, 32),
    chainKey: okm.slice(32, 64),
  };
}

/** KDF de chain: deriva messageKey + próxima chainKey */
function kdfChain(chainKey: Uint8Array): {
  messageKey: Uint8Array;
  nextChainKey: Uint8Array;
} {
  // Mensagem: HMAC-SHA256(chainKey, 0x01)
  // Próxima chain: HMAC-SHA256(chainKey, 0x02)
  const msgKey = hkdf(sha256, new Uint8Array([0x01]), chainKey, VOID_MSG_KEY_DOMAIN, 32);
  const nextChainKey = hkdf(sha256, new Uint8Array([0x02]), chainKey, VOID_MSG_KEY_DOMAIN, 32);
  return { messageKey: msgKey, nextChainKey };
}

/** DH X25519 entre nossa chave privada e a pública do remote */
function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

// ─── RatchetSession ───────────────────────────────────────────────────────────

export class RatchetSession {
  private state: RatchetState;
  private identityKey: { privateKey: Uint8Array; publicKey: Uint8Array };

  constructor(state: RatchetState, identityKey: { privateKey: Uint8Array; publicKey: Uint8Array }) {
    this.state = state;
    this.identityKey = identityKey;
  }

  // ─── Session Setup ──────────────────────────────────────────────────────────

  /**
   * Lado ALICE: inicia sessão a partir do PreKeyBundle de Bob.
   * Realiza o handshake X3DH simplificado (DH1..DH4 → Master Secret → RootKey).
   */
  static initAlice(
    aliceIdentity: { privateKey: Uint8Array; publicKey: Uint8Array },
    bobBundle: PreKeyBundle
  ): RatchetSession {
    // X3DH: 4 DH exchanges
    const ephemeral = generateDHKeyPair();

    const dh1 = dh(aliceIdentity.privateKey, bobBundle.signedPreKey);
    const dh2 = dh(ephemeral.privateKey, bobBundle.identityKey.slice(0, 32));
    const dh3 = dh(ephemeral.privateKey, bobBundle.signedPreKey);
    const dh4 = dh(ephemeral.privateKey, bobBundle.oneTimePreKey);

    // Master secret = DH1 || DH2 || DH3 || DH4
    const masterInput = new Uint8Array(128);
    masterInput.set(dh1, 0);
    masterInput.set(dh2, 32);
    masterInput.set(dh3, 64);
    masterInput.set(dh4, 96);

    const rootKey = hkdf(sha256, masterInput, new Uint8Array(32), VOID_RATCHET_DOMAIN, 32);

    const dhSelf = generateDHKeyPair();

    // Primeiro DH ratchet com a signed pre-key de Bob
    const { rootKey: newRoot, chainKey: sendChain } = kdfRoot(
      rootKey,
      dh(dhSelf.privateKey, bobBundle.signedPreKey)
    );

    const state: RatchetState = {
      dhSelf,
      dhRemote: bobBundle.signedPreKey,
      rootKey: newRoot,
      sendChainKey: sendChain,
      recvChainKey: null,
      sendCount: 0,
      recvCount: 0,
      prevSendCount: 0,
      skippedKeys: new Map(),
    };

    return new RatchetSession(state, aliceIdentity);
  }

  /**
   * Lado BOB: inicializa sessão a partir de sua própria pre-key.
   * Bob completa o handshake ao receber a primeira mensagem de Alice.
   */
  static initBob(
    bobIdentity: { privateKey: Uint8Array; publicKey: Uint8Array },
    bobSignedPreKey: DHKeyPair,
    bobOneTimePreKey: DHKeyPair,
    aliceIdentityPublic: Uint8Array,
    aliceEphemeralPublic: Uint8Array
  ): RatchetSession {
    const dh1 = dh(bobSignedPreKey.privateKey, aliceIdentityPublic);
    const dh2 = dh(bobIdentity.privateKey, aliceEphemeralPublic);
    const dh3 = dh(bobSignedPreKey.privateKey, aliceEphemeralPublic);
    const dh4 = dh(bobOneTimePreKey.privateKey, aliceEphemeralPublic);

    const masterInput = new Uint8Array(128);
    masterInput.set(dh1, 0);
    masterInput.set(dh2, 32);
    masterInput.set(dh3, 64);
    masterInput.set(dh4, 96);

    const rootKey = hkdf(sha256, masterInput, new Uint8Array(32), VOID_RATCHET_DOMAIN, 32);

    const state: RatchetState = {
      dhSelf: bobSignedPreKey,
      dhRemote: null,
      rootKey,
      sendChainKey: null,
      recvChainKey: null,
      sendCount: 0,
      recvCount: 0,
      prevSendCount: 0,
      skippedKeys: new Map(),
    };

    return new RatchetSession(state, bobIdentity);
  }

  // ─── Encrypt ────────────────────────────────────────────────────────────────

  encrypt(plaintext: Uint8Array): EncryptedMessage {
    const state = this.state;

    if (!state.sendChainKey) {
      throw new Error("Ratchet: sendChainKey não inicializado — aguardando primeira mensagem");
    }

    // Avança chain key de envio
    const { messageKey, nextChainKey } = kdfChain(state.sendChainKey);
    state.sendChainKey = nextChainKey;

    // Cifra com ChaCha20-Poly1305
    const nonce = randomBytes(12);
    const cipher = chacha20poly1305(messageKey, nonce);
    const ciphertext = cipher.encrypt(plaintext);

    // Monta payload para assinar: dhPublic || messageNumber || prevChainLength || nonce || ciphertext
    const sigPayload = buildSigPayload(
      state.dhSelf.publicKey,
      state.sendCount,
      state.prevSendCount,
      nonce,
      ciphertext
    );

    const signature = ed25519.sign(sigPayload, this.identityKey.privateKey);

    const msg: EncryptedMessage = {
      ciphertext,
      dhPublic: state.dhSelf.publicKey,
      messageNumber: state.sendCount,
      prevChainLength: state.prevSendCount,
      signature,
      nonce,
    };

    state.sendCount++;
    return msg;
  }

  // ─── Decrypt ────────────────────────────────────────────────────────────────

  decrypt(msg: EncryptedMessage, senderIdentityPublic: Uint8Array): Uint8Array {
    const state = this.state;

    // Verifica assinatura
    const sigPayload = buildSigPayload(
      msg.dhPublic,
      msg.messageNumber,
      msg.prevChainLength,
      msg.nonce,
      msg.ciphertext
    );
    const sigValid = ed25519.verify(msg.signature, sigPayload, senderIdentityPublic);
    if (!sigValid) {
      throw new Error("Ratchet: assinatura inválida — mensagem possivelmente adulterada");
    }

    // Verifica se é uma mensagem de um step anterior (skipped key)
    const skipKey = `${Buffer.from(msg.dhPublic).toString("hex")}:${msg.messageNumber}`;
    const cachedKey = state.skippedKeys.get(skipKey);
    if (cachedKey) {
      state.skippedKeys.delete(skipKey);
      return decryptWithKey(cachedKey, msg.nonce, msg.ciphertext);
    }

    // DH Ratchet: nova chave pública DH detectada → avança ratchet
    const dhPubHex = Buffer.from(msg.dhPublic).toString("hex");
    const prevDhHex = state.dhRemote
      ? Buffer.from(state.dhRemote).toString("hex")
      : null;

    if (dhPubHex !== prevDhHex) {
      // Skipa mensagens do chain anterior
      this.skipMessages(state.prevSendCount, msg.prevChainLength);

      // Avança DH ratchet (recepção)
      const recvDH = dh(state.dhSelf.privateKey, msg.dhPublic);
      const { rootKey: newRoot1, chainKey: recvChain } = kdfRoot(state.rootKey, recvDH);

      // Gera novo par DH local e avança ratchet de envio
      state.dhSelf = generateDHKeyPair();
      const sendDH = dh(state.dhSelf.privateKey, msg.dhPublic);
      const { rootKey: newRoot2, chainKey: sendChain } = kdfRoot(newRoot1, sendDH);

      state.prevSendCount = state.sendCount;
      state.sendCount = 0;
      state.recvCount = 0;
      state.dhRemote = msg.dhPublic;
      state.rootKey = newRoot2;
      state.recvChainKey = recvChain;
      state.sendChainKey = sendChain;
    }

    // Skipa mensagens ausentes no chain atual
    this.skipMessages(state.recvCount, msg.messageNumber);

    if (!state.recvChainKey) {
      throw new Error("Ratchet: recvChainKey não inicializado");
    }

    const { messageKey, nextChainKey } = kdfChain(state.recvChainKey);
    state.recvChainKey = nextChainKey;
    state.recvCount++;

    return decryptWithKey(messageKey, msg.nonce, msg.ciphertext);
  }

  // ─── Skip Messages ──────────────────────────────────────────────────────────

  private skipMessages(from: number, to: number): void {
    const MAX_SKIP = 100;
    if (to - from > MAX_SKIP) {
      throw new Error(`Ratchet: muitas mensagens puladas (${to - from} > ${MAX_SKIP})`);
    }

    let chainKey = this.state.recvChainKey;
    if (!chainKey) return;

    for (let i = from; i < to; i++) {
      const { messageKey, nextChainKey } = kdfChain(chainKey);
      chainKey = nextChainKey;
      const key = `${Buffer.from(this.state.dhRemote ?? new Uint8Array(32)).toString("hex")}:${i}`;
      this.state.skippedKeys.set(key, messageKey);
    }

    this.state.recvChainKey = chainKey;
  }

  // ─── Export state (para persistência) ──────────────────────────────────────

  exportState(): RatchetState {
    return { ...this.state };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Gera par de chaves X25519 */
export function generateDHKeyPair(): DHKeyPair {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Gera par de chaves Ed25519 para identidade */
export function generateIdentityKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = randomBytes(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Cria um PreKeyBundle (publicado via NOSTR kind 31220) */
export function createPreKeyBundle(
  identity: { privateKey: Uint8Array; publicKey: Uint8Array }
): { bundle: PreKeyBundle; signedPreKeyPair: DHKeyPair; oneTimePreKeyPair: DHKeyPair } {
  const signedPreKeyPair = generateDHKeyPair();
  const oneTimePreKeyPair = generateDHKeyPair();

  // Assina a signed pre-key com a identidade Ed25519
  const preKeySignature = ed25519.sign(signedPreKeyPair.publicKey, identity.privateKey);

  return {
    bundle: {
      identityKey: identity.publicKey,
      signedPreKey: signedPreKeyPair.publicKey,
      preKeySignature,
      oneTimePreKey: oneTimePreKeyPair.publicKey,
    },
    signedPreKeyPair,
    oneTimePreKeyPair,
  };
}

function buildSigPayload(
  dhPublic: Uint8Array,
  messageNumber: number,
  prevChainLength: number,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  const buf = new Uint8Array(32 + 4 + 4 + 12 + ciphertext.length);
  buf.set(dhPublic, 0);
  new DataView(buf.buffer).setUint32(32, messageNumber, false);
  new DataView(buf.buffer).setUint32(36, prevChainLength, false);
  buf.set(nonce, 40);
  buf.set(ciphertext, 52);
  return buf;
}

function decryptWithKey(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  const cipher = chacha20poly1305(key, nonce);
  return cipher.decrypt(ciphertext);
}

// Compatibilidade com ambiente sem Buffer (browsers)
const Buffer = {
  from: (arr: Uint8Array) => ({
    toString: (enc: string) => {
      if (enc === "hex") {
        return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      return "";
    },
  }),
};
