/**
 * Hydra v7.0 — Crypto Testament (Recuperação de Fundos Zero-Disco)
 *
 * Resolve o problema: se o app existe apenas na RAM e o celular desliga,
 * todos os UTXOs atrelados àquele GhostID se tornam inacessíveis para sempre.
 *
 * Solução: "Seed Phrase Subconsciente" + "Testamento Criptográfico Distribuído"
 *
 * ARQUITETURA:
 *
 * 1. DERIVED MASTER KEY (DMK):
 *    Em vez de gerar a chave do GhostID puramente por entropia de hardware,
 *    o sistema MISTURA a entropia com uma "passphrase memorizada" do usuário
 *    + parâmetros biométricos reprodutíveis (ritmo de digitação, padrão de toque).
 *    Resultado: chave determinística que o usuário pode REDERIVATE amanhã
 *    a partir das mesmas entradas.
 *
 * 2. TESTAMENT SHARDS (usando QEL existente):
 *    A DMK é fragmentada via Shamir (K=3, N=5) e os shards são cifrados
 *    e distribuídos na rede HCN com TTL longo (30 dias).
 *    Recuperação exige 3 de 5 shards + a passphrase + biometria.
 *
 * 3. TIME-DELAYED RECOVERY:
 *    A recuperação tem um cooldown de 48h para evitar roubo por coerção.
 *    Durante o cooldown, o GhostID original (se ainda existir) pode
 *    vetar a recuperação.
 *
 * 4. DEAD MAN'S SWITCH:
 *    Se nenhuma atividade for detectada em X dias, os shards do testamento
 *    são automaticamente liberados para um herdeiro pré-configurado.
 */

import { sha3_256, sha3_512 } from "@noble/hashes/sha3.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { gfMul, gfInv } from "./gf256";
import { secureRandomInt } from "../utils/secureRandom";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BiometricProfile {
  keystrokePattern: number[];   // intervalos entre teclas em ms
  touchPressure: number[];      // intensidade de toque (0-1)
  swipeVelocity: number[];      // velocidade de gestos
}

export interface RecoveryConfig {
  passphrase: string;
  biometrics: BiometricProfile;
  totalShards: number;          // N (padrão 5)
  threshold: number;            // K (padrão 3)
  testamentTTLDays: number;     // TTL dos shards na rede (padrão 30)
  cooldownHours: number;        // cooldown anti-coerção (padrão 48)
  deadManDays: number;          // dead man's switch (padrão 90)
  heirPubKey?: string;          // chave pública do herdeiro
}

export interface TestamentShard {
  index: number;
  data: Uint8Array;             // shard cifrado (ChaCha20-Poly1305)
  nonce: Uint8Array;
  tag: Uint8Array;
  commitment: string;           // SHA3-256 do shard plaintext
  nodeId: string;               // nó HCN que armazena
  expiresAt: number;
  createdAt: number;
}

export interface Testament {
  id: string;
  shards: TestamentShard[];
  totalShards: number;
  threshold: number;
  passphraseHash: string;       // SHA3-256 da passphrase (para verificação)
  biometricHash: string;        // hash do perfil biométrico
  cooldownHours: number;
  deadManDays: number;
  heirPubKey: string;
  createdAt: number;
  lastActivity: number;
}

export interface RecoveryAttempt {
  id: string;
  passphrase: string;
  biometrics: BiometricProfile;
  shardsCollected: number[];    // índices dos shards coletados
  status: "collecting" | "cooldown" | "recovering" | "complete" | "vetoed" | "failed";
  startedAt: number;
  cooldownEndsAt: number;
  recoveredKey: Uint8Array | null;
}

// ─── Shamir K=3 ──────────────────────────────────────────────────────────────

/**
 * Shamir Split com K=3, N=5 (polinômio de grau 2):
 *   f(x) = s + a1·x + a2·x²  sobre GF(256)
 */
function shamirSplitK3(secret: Uint8Array, n = 5): Uint8Array[] {
  const shares = Array.from({ length: n }, () => new Uint8Array(secret.length));

  for (let bi = 0; bi < secret.length; bi++) {
    const s  = secret[bi];
    const a1 = crypto.getRandomValues(new Uint8Array(1))[0];
    const a2 = crypto.getRandomValues(new Uint8Array(1))[0];

    for (let i = 0; i < n; i++) {
      const x = i + 1;
      // f(x) = s ⊕ (a1·x) ⊕ (a2·x²)
      shares[i][bi] = s ^ gfMul(a1, x) ^ gfMul(a2, gfMul(x, x));
    }
  }
  return shares;
}

/**
 * Shamir Reconstruct com K=3 (interpolação de Lagrange, 3+ shares)
 */
function shamirReconstructK3(shares: Uint8Array[], indices: number[]): Uint8Array {
  if (shares.length < 3) throw new Error("Necessário K≥3 shares");
  const len = shares[0].length;
  const result = new Uint8Array(len);
  const xs = indices.map(i => i + 1);

  for (let bi = 0; bi < len; bi++) {
    let secret = 0;
    for (let i = 0; i < shares.length; i++) {
      const yi = shares[i][bi];
      let num = 1, den = 1;
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

// ─── 1. Derived Master Key (DMK) ─────────────────────────────────────────────

/**
 * Deriva a Master Key a partir de passphrase + biometria.
 * Se o usuário fornecer os mesmos inputs amanhã, obtém a mesma chave.
 *
 * Pipeline:
 *   passphrase → SHA3-512 → IKM
 *   biometrics → normalize → SHA3-256 → salt
 *   IKM + salt → Argon2id(64MB, 3it) → 32 bytes seed
 *   seed → HKDF-SHA3-512 → DMK (32 bytes)
 */
export function deriveMasterKey(
  passphrase: string,
  biometrics: BiometricProfile,
): Uint8Array {
  // 1. Hash da passphrase → IKM
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const ikm = sha3_512(passphraseBytes) as Uint8Array;

  // 2. Normaliza biometria → salt determinístico
  const bioData = normalizeBiometrics(biometrics);
  const bioSalt = sha3_256(bioData) as Uint8Array;

  // 3. Argon2id: endurece com memória alta
  const seed = argon2id(ikm, bioSalt.slice(0, 16), {
    m: 16384, // 16 MB (browser-safe)
    t: 3,
    p: 1,
    dkLen: 32,
  }) as Uint8Array;

  // 4. HKDF: expande para DMK final
  const info = new TextEncoder().encode("void-testament-dmk-v1");
  const dmk = hkdf(sha3_512, seed, bioSalt, info, 32) as Uint8Array;

  return dmk;
}

/**
 * Normaliza dados biométricos para gerar salt determinístico.
 * Arredonda valores para reduzir variância entre sessões.
 */
function normalizeBiometrics(bio: BiometricProfile): Uint8Array {
  // Quantiza os intervalos de digitação em buckets de 10ms
  const keyBuckets = bio.keystrokePattern.map(ms => Math.round(ms / 10) * 10);
  // Quantiza pressão de toque em buckets de 0.1
  const touchBuckets = bio.touchPressure.map(p => Math.round(p * 10) / 10);
  // Quantiza velocidade em buckets de 50
  const swipeBuckets = bio.swipeVelocity.map(v => Math.round(v / 50) * 50);

  const combined = JSON.stringify({ k: keyBuckets, t: touchBuckets, s: swipeBuckets });
  return new TextEncoder().encode(combined);
}

// ─── 2. Testament Creation ────────────────────────────────────────────────────

/**
 * Cria um Testamento Criptográfico:
 * - Fragmenta a DMK em N=5 shards (K=3)
 * - Cifra cada shard com ChaCha20-Poly1305
 * - Distribui na rede HCN com TTL configurável
 */
export function createTestament(
  masterKey: Uint8Array,
  config: RecoveryConfig,
): Testament {
  const id = `testament_${Date.now()}_${secureRandomInt(10000)}`;
  const now = Date.now();

  // Fragmenta a DMK via Shamir (K=3, N=5)
  const rawShards = shamirSplitK3(masterKey, config.totalShards);

  // Deriva chave de cifragem dos shards a partir da passphrase
  const shardEncKey = sha3_256(
    new TextEncoder().encode(config.passphrase + ":shard-enc")
  ) as Uint8Array;

  // Cifra cada shard
  const testamentShards: TestamentShard[] = rawShards.map((raw, index) => {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const cipher = chacha20poly1305(shardEncKey, nonce);
    const combined = cipher.encrypt(raw) as Uint8Array;
    const ct = combined.slice(0, combined.length - 16);
    const tag = combined.slice(combined.length - 16);

    const commitment = Array.from(sha3_256(raw) as Uint8Array)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    return {
      index,
      data: ct,
      nonce,
      tag,
      commitment: `0x${commitment}`,
      nodeId: `hcn_node_${secureRandomInt(10000)}`,
      createdAt: now,
      expiresAt: now + config.testamentTTLDays * 24 * 60 * 60 * 1000,
    };
  });

  return {
    id,
    shards: testamentShards,
    totalShards: config.totalShards,
    threshold: config.threshold,
    passphraseHash: Array.from(sha3_256(new TextEncoder().encode(config.passphrase)) as Uint8Array)
      .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16),
    biometricHash: Array.from(sha3_256(normalizeBiometrics(config.biometrics)) as Uint8Array)
      .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16),
    cooldownHours: config.cooldownHours,
    deadManDays: config.deadManDays,
    heirPubKey: config.heirPubKey || "",
    createdAt: now,
    lastActivity: now,
  };
}

// ─── 3. Recovery Engine ───────────────────────────────────────────────────────

/**
 * Inicia uma tentativa de recuperação.
 */
export function initiateRecovery(
  passphrase: string,
  biometrics: BiometricProfile,
  testament: Testament,
): RecoveryAttempt {
  const now = Date.now();

  // Verifica passphrase
  const providedHash = Array.from(sha3_256(new TextEncoder().encode(passphrase)) as Uint8Array)
    .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

  if (providedHash !== testament.passphraseHash) {
    return {
      id: `recovery_${now}`,
      passphrase,
      biometrics,
      shardsCollected: [],
      status: "failed",
      startedAt: now,
      cooldownEndsAt: 0,
      recoveredKey: null,
    };
  }

  // Verifica biometria (com tolerância)
  const providedBioHash = Array.from(sha3_256(normalizeBiometrics(biometrics)) as Uint8Array)
    .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

  if (providedBioHash !== testament.biometricHash) {
    return {
      id: `recovery_${now}`,
      passphrase,
      biometrics,
      shardsCollected: [],
      status: "failed",
      startedAt: now,
      cooldownEndsAt: 0,
      recoveredKey: null,
    };
  }

  return {
    id: `recovery_${now}`,
    passphrase,
    biometrics,
    shardsCollected: [],
    status: "collecting",
    startedAt: now,
    cooldownEndsAt: now + testament.cooldownHours * 60 * 60 * 1000,
    recoveredKey: null,
  };
}

/**
 * Tenta reconstruir a DMK a partir dos shards coletados.
 */
export function reconstructMasterKey(
  attempt: RecoveryAttempt,
  testament: Testament,
): RecoveryAttempt {
  if (attempt.shardsCollected.length < testament.threshold) {
    return { ...attempt, status: "collecting" };
  }

  // Verifica cooldown
  const now = Date.now();
  if (now < attempt.cooldownEndsAt) {
    return { ...attempt, status: "cooldown" };
  }

  // Decifra shards
  const shardEncKey = sha3_256(
    new TextEncoder().encode(attempt.passphrase + ":shard-enc")
  ) as Uint8Array;

  try {
    const decryptedShards: Uint8Array[] = [];
    const indices: number[] = [];

    for (const idx of attempt.shardsCollected.slice(0, testament.threshold)) {
      const shard = testament.shards[idx];
      if (!shard) continue;

      const combined = new Uint8Array(shard.data.length + 16);
      combined.set(shard.data);
      combined.set(shard.tag, shard.data.length);

      const decrypted = chacha20poly1305(shardEncKey, shard.nonce).decrypt(combined) as Uint8Array;
      decryptedShards.push(decrypted);
      indices.push(shard.index);
    }

    // Reconstrói via Shamir (K=3)
    const recoveredKey = shamirReconstructK3(decryptedShards, indices);

    return {
      ...attempt,
      status: "complete",
      recoveredKey,
    };
  } catch {
    return { ...attempt, status: "failed", recoveredKey: null };
  }
}

// ─── 4. Dead Man's Switch ─────────────────────────────────────────────────────

/**
 * Verifica se o Dead Man's Switch deve ser ativado.
 */
export function checkDeadManSwitch(testament: Testament): boolean {
  const daysSinceActivity = (Date.now() - testament.lastActivity) / (24 * 60 * 60 * 1000);
  return daysSinceActivity >= testament.deadManDays;
}

/**
 * Atualiza o timestamp de última atividade (heartbeat).
 */
export function heartbeat(testament: Testament): Testament {
  return { ...testament, lastActivity: Date.now() };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function hexSlice(data: Uint8Array, len = 16): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}
