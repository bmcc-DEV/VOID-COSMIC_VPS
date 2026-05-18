/**
 * ETΞRNET — Social Recovery: Carteira Multi-Dispositivo
 *
 * Usa Shamir Secret Sharing (GF256) para dividir
 * a seed da carteira entre N amigos. Qualquer M de N podem recuperar.
 *
 * Fluxo:
 * 1. Usuário divide seed em N shares (ex: 3 de 5)
 * 2. Cada share é cifrado com a chave pública de um amigo
 * 3. Shares são enviados via NOSTR DMs criptografados
 * 4. Para recuperar, usuário coleta M shares e reconstrói seed
 *
 * Segurança: usa GF(256) Lagrange interpolation (não XOR).
 * Cada share é um ponto no polinômio de Shamir — share individual
 * NÃO revela a seed.
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { secureRandomId } from "../utils/secureRandom";
import { gfMul, gfInv } from "./gf256";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecoveryShare {
  id: string;
  index: number;           // share index (1-based)
  data: Uint8Array;        // share bytes (Shamir share point)
  recipientPk: string;     // hex public key of guardian
  encrypted: boolean;
  createdAt: number;
}

export interface RecoveryScheme {
  id: string;
  threshold: number;       // M — minimum shares to recover
  totalShares: number;     // N — total shares created
  shares: RecoveryShare[];
  createdAt: number;
  seedHash: string;        // SHA3-256 of original seed (for verification)
}

// ─── Shamir over GF(256) ─────────────────────────────────────────────────────

/**
 * Shamir split: polynomial of degree (threshold-1) over GF(256).
 *
 * f(x) = s ⊕ a1·x ⊕ a2·x² ⊕ ... ⊕ a_{k-1}·x^{k-1}
 *
 * where s is the secret byte, a1..a_{k-1} are random coefficients.
 * Addition is XOR, multiplication is GF(256) mul.
 */
function shamirSplit(secret: Uint8Array, threshold: number, totalShares: number): Uint8Array[] {
  const shares = Array.from({ length: totalShares }, () => new Uint8Array(secret.length));

  for (let bi = 0; bi < secret.length; bi++) {
    const s = secret[bi];
    // Random coefficients for degree (threshold-1) polynomial
    const coeffs = new Uint8Array(threshold - 1);
    crypto.getRandomValues(coeffs);

    for (let i = 0; i < totalShares; i++) {
      const x = i + 1; // share index (1-based)
      let fx = s;
      let xPow = x;
      for (let c = 0; c < coeffs.length; c++) {
        fx ^= gfMul(coeffs[c], xPow);
        xPow = gfMul(xPow, x);
      }
      shares[i][bi] = fx;
    }
  }
  return shares;
}

/**
 * Shamir reconstruct via Lagrange interpolation over GF(256).
 *
 * Given k shares (x_i, y_i), reconstruct f(0) = secret:
 *   secret = Σ y_i · Π_{j≠i} (x_j / (x_j ⊕ x_i))
 */
function shamirReconstruct(shares: Uint8Array[], indices: number[]): Uint8Array {
  if (shares.length < 2) throw new Error("Need at least 2 shares");
  const len = shares[0].length;
  const result = new Uint8Array(len);
  const xs = indices.map(i => i + 1); // convert to 1-based

  for (let bi = 0; bi < len; bi++) {
    let secret = 0;
    for (let i = 0; i < shares.length; i++) {
      const yi = shares[i][bi];
      // Lagrange basis: L_i(0) = Π_{j≠i} x_j / (x_j ⊕ x_i)
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = gfMul(num, xs[j]);
        den = gfMul(den, xs[j] ^ xs[i]);
      }
      secret ^= gfMul(yi, gfMul(num, gfInv(den)));
    }
    result[bi] = secret;
  }
  return result;
}

// ─── Social Recovery ──────────────────────────────────────────────────────────

class SocialRecovery {
  private static instance: SocialRecovery;
  private schemes: Map<string, RecoveryScheme> = new Map();

  public static getInstance(): SocialRecovery {
    if (!SocialRecovery.instance) SocialRecovery.instance = new SocialRecovery();
    return SocialRecovery.instance;
  }

  private constructor() {}

  /**
   * Divide uma seed em shares usando Shamir's Secret Sharing (GF256).
   *
   * Cada share é um ponto (x, f(x)) no polinômio de grau (threshold-1).
   * Share individual NÃO revela a seed — precisa de `threshold` shares
   * para interpolar o polinômio e recuperar f(0) = seed.
   */
  splitSeed(
    seed: Uint8Array,
    threshold: number,
    totalShares: number,
    guardianPks: string[],
  ): RecoveryScheme {
    if (threshold < 2) throw new Error("Threshold must be at least 2");
    if (threshold > totalShares) throw new Error("Threshold cannot exceed total shares");
    if (guardianPks.length < totalShares) throw new Error("Not enough guardian public keys");

    const seedHash = sha3_256(seed);
    const seedHashHex = Array.from(seedHash).map(b => b.toString(16).padStart(2, '0')).join('');

    // Real Shamir split over GF(256)
    const shareData = shamirSplit(seed, threshold, totalShares);

    const shares: RecoveryShare[] = [];
    for (let i = 0; i < totalShares; i++) {
      shares.push({
        id: `share_${secureRandomId(8)}`,
        index: i + 1,
        data: shareData[i],
        recipientPk: guardianPks[i],
        encrypted: false, // caller encrypts with guardian's public key
        createdAt: Date.now(),
      });
    }

    const scheme: RecoveryScheme = {
      id: `scheme_${secureRandomId(8)}`,
      threshold,
      totalShares,
      shares,
      createdAt: Date.now(),
      seedHash: seedHashHex,
    };

    this.schemes.set(scheme.id, scheme);
    return scheme;
  }

  /**
   * Recupera seed a partir de M shares usando Lagrange interpolation.
   *
   * Requer pelo menos `threshold` shares. A interpolação reconstrói
   * f(0) = secret byte para cada byte da seed.
   */
  recoverSeed(schemeId: string, shares: RecoveryShare[]): Uint8Array | null {
    const scheme = this.schemes.get(schemeId);
    if (!scheme) return null;
    if (shares.length < scheme.threshold) return null;

    // Need at least `threshold` shares for Lagrange interpolation
    const selectedShares = shares.slice(0, scheme.threshold);
    const shareArrays = selectedShares.map(s => s.data);
    const indices = selectedShares.map(s => s.index);

    // Reconstruct via Lagrange interpolation over GF(256)
    const recovered = shamirReconstruct(shareArrays, indices);

    // Verify against stored hash
    const recoveredHash = sha3_256(recovered);
    const recoveredHashHex = Array.from(recoveredHash).map(b => b.toString(16).padStart(2, '0')).join('');

    if (recoveredHashHex !== scheme.seedHash) {
      console.warn("[SocialRecovery] Hash verification failed — incorrect shares");
      return null;
    }

    return recovered;
  }

  /** Retorna um esquema de recuperação */
  getScheme(schemeId: string): RecoveryScheme | null {
    return this.schemes.get(schemeId) ?? null;
  }

  /** Retorna todos os esquemas */
  getSchemes(): RecoveryScheme[] {
    return Array.from(this.schemes.values());
  }

  /** Cria evento NOSTR para um share de recuperação (enviar ao guardião) */
  createShareEvent(share: RecoveryShare, guardianPk: string) {
    return {
      kind: 4, // NIP-04 encrypted DM
      tags: [['p', guardianPk]],
      content: JSON.stringify({
        type: 'eternet_recovery_share',
        shareId: share.id,
        index: share.index,
        data: Array.from(share.data), // should be encrypted before sending
      }),
      created_at: Math.floor(Date.now() / 1000),
    };
  }
}

export const socialRecovery = SocialRecovery.getInstance();
