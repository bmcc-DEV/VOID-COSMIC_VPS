/**
 * VØID Core — QEL Protocol (Quantum Entropy Layer)
 *
 * Implementação REAL do protocolo de fragmentação:
 *   • Shamir Secret Sharing (K=2, N=3) sobre GF(256) / polinômio irredutível 0x11B
 *   • Cifragem individual de cada shard via ChaCha20-Poly1305 (AEAD)
 *   • Commitments de integridade SHA3-256 por shard
 *
 * Garantia: nenhum nó intermediário vê mais de 1/3 da mensagem.
 * Bloqueio requer controlar ≥ K=2 caminhos simultaneamente.
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha3_256 }         from "@noble/hashes/sha3.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Shard {
  index:      number;      // 0 | 1 | 2
  data:       Uint8Array;  // ciphertext (ChaCha20)
  nonce:      Uint8Array;  // 12 bytes aleatórios
  tag:        Uint8Array;  // Poly1305 auth tag (16 bytes)
  commitment: string;      // SHA3-256(plaintext shard) hex[:16]
}

export interface FragmentResult {
  shards:        Shard[];
  originalLength: number;
  threshold:     number;      // K=2
  total:         number;      // N=3
  sessionKey:    Uint8Array;  // ChaCha20 key efêmera (32 bytes, RAM-only)
}

export interface RouteInfo {
  shardIndex:       number;
  channel:          string;
  hops:             string[];
  estimatedLatency: string;
}

import { gfMul, gfInv } from "./gf256";

// ─── Shamir Secret Sharing ────────────────────────────────────────────────────

/**
 * Divide `secret` em N=3 shares com threshold K=2 sobre GF(256).
 * Cada byte é dividido por um polinômio linear aleatório: f(x) = s + a1·x
 * Share i = f(i+1) para i = 0, 1, 2
 */
export function shamirSplit(secret: Uint8Array, k = 2, n = 3): Uint8Array[] {
  if (k !== 2) throw new Error("Este SSS suporta apenas K=2 (polinômio de grau 1)");
  const shares = Array.from({ length: n }, () => new Uint8Array(secret.length));

  for (let bi = 0; bi < secret.length; bi++) {
    const s  = secret[bi] || 0;
    const a1 = crypto.getRandomValues(new Uint8Array(1))[0] || 0; // coeficiente aleatório

    for (let i = 0; i < n; i++) {
      const x = i + 1; // pontos x = 1, 2, 3
      // f(x) = s XOR (a1 · x)  em GF(256)
      const share = shares[i];
      if (share) share[bi] = s ^ gfMul(a1, x);
    }
  }
  return shares;
}

/**
 * Reconstitui o segredo a partir de K=2 shares via interpolação de Lagrange em GF(256).
 * `indices` são os índices originais dos shares (0-based → x = index+1).
 */
export function shamirReconstruct(shares: Uint8Array[], indices: number[]): Uint8Array {
  if (shares.length < 2) throw new Error(`Necessário K≥2 shares, recebido: ${shares.length}`);
  if (shares.length !== indices.length) throw new Error("Mismatch: shares.length ≠ indices.length");

  const firstShare = shares[0];
  if (!firstShare) throw new Error("First share is undefined");
  const len = firstShare.length;
  const result = new Uint8Array(len);
  const xs = indices.map(i => i + 1); // x-coordinates

  for (let bi = 0; bi < len; bi++) {
    let secret = 0;
    for (let i = 0; i < shares.length; i++) {
      const share = shares[i];
      if (!share) continue;
      const yi = share[bi] || 0;
      let num = 1, den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        const xj = xs[j] || 0;
        const xi = xs[i] || 0;
        num = gfMul(num, xj);
        den = gfMul(den, xj ^ xi); // XOR = subtração em GF(char 2)
      }
      // Lagrange basis L_i(0) = num / den
      secret ^= gfMul(yi, gfMul(num, gfInv(den)));
    }
    result[bi] = secret;
  }
  return result;
}

// ─── ChaCha20-Poly1305 AEAD ──────────────────────────────────────────────────

/** Cifra um share com ChaCha20-Poly1305. Retorna { ciphertext, nonce, tag }. */
export function encryptShard(
  plaintext: Uint8Array,
  key: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array; tag: Uint8Array } {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = chacha20poly1305(key, nonce);
  // @noble/ciphers: encrypt() retorna ciphertext + 16-byte tag concatenados
  const combined = cipher.encrypt(plaintext) as Uint8Array;
  return {
    ciphertext: combined.slice(0, combined.length - 16),
    nonce,
    tag: combined.slice(combined.length - 16),
  };
}

/** Decifra e verifica um shard. Lança se a tag Poly1305 falhar. */
export function decryptShard(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  tag: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  const combined = new Uint8Array(ciphertext.length + 16);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  return chacha20poly1305(key, nonce).decrypt(combined) as Uint8Array;
}

// ─── Session Key ──────────────────────────────────────────────────────────────

/** Gera chave de sessão efêmera de 32 bytes via CSPRNG. */
export function generateSessionKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// ─── Commitment (integridade) ─────────────────────────────────────────────────

function shardCommitment(plaintextShare: Uint8Array): string {
  const hash = sha3_256(plaintextShare) as Uint8Array;
  return "0x" + Array.from(hash).map((b: number) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ─── Full QEL Pipeline ────────────────────────────────────────────────────────

/**
 * Fragmenta uma mensagem em N=3 shards cifrados via QEL.
 *
 * 1. Gera session key (CSPRNG 32 bytes)
 * 2. Shamir split K=2/N=3 sobre GF(256)
 * 3. ChaCha20-Poly1305 em cada share (nonce único por shard)
 * 4. SHA3-256 commitment por share para prova de integridade
 */
export function fragmentMessage(message: string | Uint8Array): FragmentResult {
  const plaintext = typeof message === "string"
    ? new TextEncoder().encode(message)
    : message;

  const sessionKey = generateSessionKey();
  const shares     = shamirSplit(plaintext, 2, 3);

  const shards: Shard[] = shares.map((share, index) => {
    const commit = shardCommitment(share);
    const { ciphertext, nonce, tag } = encryptShard(share, sessionKey);
    return { index, data: ciphertext, nonce, tag, commitment: commit };
  });

  return { shards, originalLength: plaintext.length, threshold: 2, total: 3, sessionKey };
}

/**
 * Reconstitui a mensagem a partir de K≥2 shards.
 *
 * 1. Decifra cada shard via ChaCha20-Poly1305
 * 2. Verifica commitment SHA3-256
 * 3. Shamir reconstruct sobre GF(256)
 */
export function reconstituteMessage(shards: Shard[], sessionKey: Uint8Array): string {
  if (shards.length < 2) throw new Error(`Necessário K≥2 shards, recebido: ${shards.length}`);

  const decrypted: Uint8Array[] = [];
  const indices:   number[]     = [];

  for (const shard of shards) {
    const share = decryptShard(shard.data, shard.nonce, shard.tag, sessionKey);

    // Verifica integridade
    const computed = shardCommitment(share);
    if (computed !== shard.commitment) {
      throw new Error(
        `Shard ${shard.index}: commit mismatch! esperado ${shard.commitment}, obtido ${computed}`
      );
    }
    decrypted.push(share);
    indices.push(shard.index);
  }

  const reconstructed = shamirReconstruct(decrypted, indices);
  return new TextDecoder().decode(reconstructed);
}

// ─── Security: zero-fill de material criptográfico sensível ──────────────────

/**
 * Apaga a chave de sessão e os dados plaintext dos shards da memória.
 * Chamar imediatamente após o envio/recepção dos shards.
 */
export function destroyFragmentResult(result: FragmentResult): void {
  result.sessionKey.fill(0);
  for (const shard of result.shards) {
    shard.data.fill(0);
    shard.nonce.fill(0);
    shard.tag.fill(0);
  }
}

/**
 * Apaga um Shard individual da memória.
 */
export function destroyShard(shard: Shard): void {
  shard.data.fill(0);
  shard.nonce.fill(0);
  shard.tag.fill(0);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b: number) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ─── Routing Info (MDNF) ─────────────────────────────────────────────────────

const CHANNELS = [
  { name: "BLE / Wi-Fi Direct",  hops: ["BLE beacon", "Direct peer"],                              latency: "5–80 ms"   },
  { name: "HCN (Human Carrier)", hops: ["Local carrier", "Mesh relay", "Proximity delivery"],      latency: "min–horas" },
  { name: "LoRa Mesh Relay",     hops: ["LoRa gateway", "Hop 1", "Hop 2", "Destination gateway"], latency: "horas"     },
];

/**
 * Gera rotas MDNF (Maximally Disjoint Non-repeating Flow):
 * cada shard recebe um canal de transporte diferente.
 */
export function generateRoutingInfo(n = 3): RouteInfo[] {
  return Array.from({ length: n }, (_, i) => {
    const channelTemplate = CHANNELS[i % CHANNELS.length];
    return {
      shardIndex:       i,
      channel:          channelTemplate?.name || "LOCAL",
      hops:             channelTemplate?.hops || [],
      estimatedLatency: channelTemplate?.latency || "unknown",
    };
  });
}
