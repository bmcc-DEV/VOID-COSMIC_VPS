/**
 * ETΞRNET — C3 Engine (Criptografia de Malha Causal)
 *
 * Orquestrador que unifica os 3 pilares em um fluxo completo de transação:
 *
 * 1. FÁCIL (GhostID): Identidade líquida via Fuzzy Extractor — sem senhas
 * 2. FORTE (PQC + Shamir + Topologia): ML-KEM → Shamir K=2/N=3 → roteamento disjunto
 * 3. INFINITA (ZK + EcoNet): Agregação Merkle → fossilização O(1)
 *
 * Pipeline de envio:   plaintext → ML-KEM encrypt → Shamir fragment → route
 * Pipeline de recebimento: shards → reassemble → ML-KEM decrypt → verify signature
 *
 * Referência: "O Livro do ETRNET", Cap. 5-7 — Criptografia de Malha Causal
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import {
  hybridEncrypt, hybridDecrypt,
  mlDsaSign, mlDsaVerify,
  generateMLKEMKeypair, generateMLDSAKeypair,
  type PQCKeyPair,
} from "./pqc";
import {
  fragmentMessage, reconstituteMessage,
  generateRoutingInfo,
  type Shard, type RouteInfo,
} from "./qel";
import {
  compressState, fossilizeState,
  type CompressedState, type RangeProofLike,
} from "./zkCompressor";
import { EcoNet } from "./econet";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface C3Transaction {
  /** Payload da transação (string ou bytes) */
  payload: string | Uint8Array;
  /** Chave ML-KEM pública do destinatário (1568 bytes) */
  recipientMLKEMPubKey: Uint8Array;
  /** Provas ZK opcionais para compressão de estado */
  rangeProofs?: RangeProofLike[];
  /** IDs dos UTXOs associados */
  utxoIds?: string[];
}

export interface C3Result {
  /** Shards Shamir (K=2, N=3) */
  shards: Shard[];
  /** Informações de roteamento topológico */
  routingInfo: RouteInfo[];
  /** Chave encapsulada ML-KEM (1568 bytes) */
  encapsulatedKey: Uint8Array;
  /** Nonce ChaCha20-Poly1305 (12 bytes) */
  nonce: Uint8Array;
  /** Auth tag Poly1305 (16 bytes) */
  tag: Uint8Array;
  /** Chave ML-KEM pública do sender (útil para resposta cifrada) */
  senderMLKEMPubKey: Uint8Array;
  /** Chave ML-DSA pública do sender (para verificar assinatura) */
  senderMLDSAPubKey: Uint8Array;
  /** Assinatura ML-DSA-87 do payload original */
  signature: Uint8Array;
  /** Estado comprimido (se range proofs foram fornecidos) */
  compressedState: CompressedState | undefined;
  /** Metadados do fragmento original */
  originalLength: number;
  threshold: number;
  total: number;
  sessionKey: Uint8Array;
}

export interface C3HealthStatus {
  pqcReady: boolean;
  shamirReady: boolean;
  zkReady: boolean;
  ghostIdReady: boolean;
}

// ─── C3 Engine ────────────────────────────────────────────────────────────────

export class C3Engine {
  private pqcKeypair: PQCKeyPair;       // ML-KEM-1024
  private signingKeypair: PQCKeyPair;   // ML-DSA-87
  private econet: EcoNet;

  constructor() {
    this.pqcKeypair = generateMLKEMKeypair();
    this.signingKeypair = generateMLDSAKeypair();
    this.econet = EcoNet.getInstance();
  }

  // ─── Send Pipeline ───────────────────────────────────────────────────────

  /**
   * Pipeline C3 completo de envio:
   * 1. FÁCIL: Assina payload com ML-DSA-87 (prova de identidade pós-quântica)
   * 2. FORTE: Encripta com ML-KEM + ChaCha20-Poly1305, fragmenta com Shamir K=2/N=3
   * 3. INFINITA: Comprime proofs ZK e fossiliza no EcoNet
   */
  send(tx: C3Transaction): C3Result {
    // 1. Serializar payload
    const plaintext = typeof tx.payload === "string"
      ? new TextEncoder().encode(tx.payload)
      : tx.payload;

    // 2. FÁCIL: Assinatura pós-quântica
    const sig = mlDsaSign(this.signingKeypair.privateKey, plaintext);

    // 3. FORTE: Criptografia híbrida Pós-Quântica
    const encrypted = hybridEncrypt(tx.recipientMLKEMPubKey, plaintext);

    // 4. FORTE: Fragmentação Shamir (aplica sobre ciphertext)
    // Conversão chunked para evitar stack overflow em mensagens grandes
    const ciphertextB64 = uint8ArrayToBase64(encrypted.ciphertext);
    const fragmentResult = fragmentMessage(ciphertextB64);

    // 5. FORTE: Roteamento topológico disjunto
    const routingInfo = generateRoutingInfo(3);

    // 6. INFINITA: Compressão ZK + fossilização
    let compressedState: CompressedState | undefined;
    if (tx.rangeProofs && tx.rangeProofs.length > 0) {
      compressedState = compressState(tx.utxoIds ?? [], tx.rangeProofs);

      // Fossilizar estado antigo no EcoNet
      if (compressedState.proofCount > 0) {
        fossilizeState(compressedState, this.econet);
      }
    }

    return {
      shards: fragmentResult.shards,
      routingInfo,
      encapsulatedKey: encrypted.encapsulatedKey,
      nonce: encrypted.nonce,
      tag: encrypted.tag,
      senderMLKEMPubKey: this.pqcKeypair.publicKey,
      senderMLDSAPubKey: this.signingKeypair.publicKey,
      signature: sig.signature,
      compressedState,
      originalLength: fragmentResult.originalLength,
      threshold: fragmentResult.threshold,
      total: fragmentResult.total,
      sessionKey: fragmentResult.sessionKey,
    };
  }

  // ─── Receive Pipeline ────────────────────────────────────────────────────

  /**
   * Pipeline C3 de recebimento:
   * 1. Reconstitui shards Shamir (precisa de K=2)
   * 2. Decapsula chave ML-KEM
   * 3. Decifra ChaCha20-Poly1305
   * 4. Verifica assinatura ML-DSA-87
   */
  receive(
    shards: Shard[],
    sessionKey: Uint8Array,
    _senderMLKEMPubKey: Uint8Array,
    senderMLDSAPubKey: Uint8Array,
    encapsulatedKey: Uint8Array,
    nonce: Uint8Array,
    tag: Uint8Array,
    signature: Uint8Array,
  ): Uint8Array {
    // 1. Reconstituir shards Shamir → ciphertext base64
    const ciphertextB64 = reconstituteMessage(shards, sessionKey);

    // 2. Decodificar base64 → bytes
    const ciphertextBytes = Uint8Array.from(
      atob(ciphertextB64),
      c => c.charCodeAt(0),
    );

    // 3. Decifrar com ML-KEM + ChaCha20-Poly1305
    const plaintext = hybridDecrypt(
      this.pqcKeypair.privateKey,
      encapsulatedKey,
      ciphertextBytes,
      nonce,
      tag,
    );

    // 4. Verificar assinatura ML-DSA-87
    const isValid = mlDsaVerify(senderMLDSAPubKey, plaintext, signature);
    if (!isValid) {
      throw new Error("C3_RECEIVE: Assinatura ML-DSA-87 inválida — payload pode ter sido adulterado");
    }

    return plaintext;
  }

  // ─── Health Check ────────────────────────────────────────────────────────

  /**
   * Verifica se todos os sub-módulos C3 estão prontos.
   */
  healthCheck(): C3HealthStatus {
    return {
      pqcReady: this.pqcKeypair.publicKey.length === 1568
        && this.signingKeypair.publicKey.length === 2592,
      shamirReady: true, // qel.ts é stateless, sempre pronto
      zkReady: true,     // zkCompressor.ts depende apenas de EcoNet
      ghostIdReady: this.pqcKeypair !== null,
    };
  }

  // ─── Key Access ──────────────────────────────────────────────────────────

  /** Retorna a chave ML-KEM pública para compartilhamento. */
  getPublicKey(): Uint8Array {
    return this.pqcKeypair.publicKey;
  }

  /** Retorna a chave ML-DSA pública para verificação de assinatura. */
  getSigningPublicKey(): Uint8Array {
    return this.signingKeypair.publicKey;
  }

  /** Destrói todas as chaves (zero-fill). */
  destroy(): void {
    this.pqcKeypair.publicKey.fill(0);
    this.pqcKeypair.privateKey.fill(0);
    this.signingKeypair.publicKey.fill(0);
    this.signingKeypair.privateKey.fill(0);
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Conversão Uint8Array → Base64 sem spread (seguro para grandes arrays). */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export { sha3_256 };
