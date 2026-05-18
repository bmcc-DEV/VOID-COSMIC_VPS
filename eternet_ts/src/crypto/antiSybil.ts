/**
 * VØID Core — Anti-Sybil / Anti-Spam Defense Layer
 *
 * Resolve o vetor de ataque de spam na fragmentação QEL:
 * Sem identidade central, um adversário pode criar milhões de GhostIDs
 * falsos e inundar a HCN com shards de lixo.
 *
 * Solução: Prova de Trabalho (PoW) Dinâmica + VDF (Verifiable Delay Function)
 * acoplada à geração de cada mensagem/shard QEL.
 *
 * Mecanismos:
 * 1. Dynamic PoW (Hashcash-style): dificuldade ajustada pela rede
 * 2. VDF Sequential: prova de tempo gasto, não paralelizável
 * 3. Rate Limiting por GhostID: janela deslizante de créditos
 * 4. Economic Cost Analysis: spam em massa torna-se inviável
 */

import { sha3_256 } from "@noble/hashes/sha3.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PoWProof {
  nonce:        number;
  hash:         string;
  difficulty:   number;   // número de zeros hex necessários no início
  timestamp:    number;
  iterations:   number;   // quantas hashes foram computadas
  elapsedMs:    number;   // tempo gasto
}

export interface VDFProof {
  input:        string;
  result:       string;   // hash final após N iterações sequenciais
  iterations:   number;   // N — não paralelizável
  elapsedMs:    number;
  challenge:    string;   // desafio único da rede
}

export interface ShardTicket {
  ghostId:      string;
  powProof:     PoWProof;
  vdfProof:     VDFProof;
  shardCount:   number;   // quantos shards este ticket cobre
  timestamp:    number;
  creditBurned: number;   // créditos gastos deste GhostID
}

export interface RateLimitState {
  ghostId:      string;
  credits:      number;   // créditos disponíveis (regeneram ao longo do tempo)
  maxCredits:   number;   // teto de créditos
  lastRefill:   number;   // timestamp da última recarga
  totalShards:  number;   // total de shards enviados por este ID
  totalBurned:  number;   // total de créditos queimados
}

export interface NetworkHealth {
  totalShards:      number;
  acceptedShards:   number;
  rejectedShards:   number;
  avgPoWTimeMs:     number;
  currentDifficulty: number;
  activeGhostIds:   number;
  storagePressure:  number; // 0-100%
  spamDetected:     number; // tentativas de spam bloqueadas
}

// ─── 1. Dynamic Proof-of-Work (Hashcash-style) ───────────────────────────────

/**
 * Calcula a dificuldade PoW dinâmica baseada na carga da rede.
 * Quanto mais shards/segundo, maior a dificuldade.
 */
export function calculateDynamicDifficulty(
  shardsPerSecond: number,
  targetShardsPerSecond = 10,
  baseDifficulty = 2,
): number {
  const ratio = shardsPerSecond / targetShardsPerSecond;
  // Dificuldade cresce logaritmicamente com a carga
  const adjusted = baseDifficulty + Math.floor(Math.log2(Math.max(1, ratio)));
  return Math.min(adjusted, 8); // cap em 8 zeros hex (praticamente impossível)
}

/**
 * Verifica se um hash satisfaz a dificuldade (prefixo de zeros hex).
 */
export function satisfiesDifficulty(hash: string, difficulty: number): boolean {
  const prefix = "0".repeat(difficulty);
  return hash.startsWith(prefix);
}

/**
 * Minera um PoW para um shard QEL.
 * Tenta HGPU (processamento geométrico) → GPU WebGPU → CPU SHA3.
 */
export async function minePoW(
  ghostId: string,
  shardCommitment: string,
  difficulty: number,
  maxIterations = 10_000_000,
): Promise<PoWProof> {
  // 1. Tentar HGPU PoW (processamento geométrico real)
  const { hgpuPoW } = await import("./hgpuCompute");
  const hgpuResult = hgpuPoW(difficulty, Math.min(maxIterations, 100000));

  // Verificar se HGPU encontrou hash válido com SHA3 real
  if (hgpuResult.found) {
    const base = `${ghostId}|${shardCommitment}|`;
    const data = base + hgpuResult.nonce;
    const realHash = Array.from(sha3_256(new TextEncoder().encode(data)) as Uint8Array)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    if (satisfiesDifficulty(realHash, difficulty)) {
      return {
        nonce: hgpuResult.nonce,
        hash: realHash,
        difficulty,
        timestamp: Date.now(),
        iterations: hgpuResult.iterations,
        elapsedMs: hgpuResult.elapsedMs,
      };
    }
  }

  // 2. Tentar GPU WebGPU
  const { gpuMiner } = await import("./gpuMiner");
  const gpuResult = await gpuMiner.mine({
    challenge: shardCommitment,
    difficulty,
    prefix: `${ghostId}|${shardCommitment}|`,
  }, maxIterations);

  if (gpuResult.found) {
    const base = `${ghostId}|${shardCommitment}|`;
    const data = base + gpuResult.nonce;
    const realHash = Array.from(sha3_256(new TextEncoder().encode(data)) as Uint8Array)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    if (satisfiesDifficulty(realHash, difficulty)) {
      return {
        nonce: gpuResult.nonce,
        hash: realHash,
        difficulty,
        timestamp: Date.now(),
        iterations: gpuResult.iterations,
        elapsedMs: gpuResult.elapsedMs,
      };
    }
  }

  // 3. Fallback CPU SHA3
  const start = performance.now();
  const base = `${ghostId}|${shardCommitment}|`;
  let nonce = 0;
  let hash = "";

  for (nonce = 0; nonce < maxIterations; nonce++) {
    const data = base + nonce;
    hash = Array.from(sha3_256(new TextEncoder().encode(data)) as Uint8Array)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    if (satisfiesDifficulty(hash, difficulty)) {
      break;
    }
  }

  return {
    nonce,
    hash,
    difficulty,
    timestamp: Date.now(),
    iterations: nonce + 1,
    elapsedMs: performance.now() - start,
  };
}

/**
 * Verifica um PoW (rápido — O(1)).
 */
export function verifyPoW(
  ghostId: string,
  shardCommitment: string,
  proof: PoWProof,
): boolean {
  const data = `${ghostId}|${shardCommitment}|${proof.nonce}`;
  const expectedHash = Array.from(sha3_256(new TextEncoder().encode(data)) as Uint8Array)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return (
    expectedHash === proof.hash &&
    satisfiesDifficulty(proof.hash, proof.difficulty) &&
    proof.elapsedMs >= 0 // sanity check
  );
}

// ─── 2. Verifiable Delay Function (VDF) ──────────────────────────────────────

/**
 * Computa uma VDF sequencial: N iterações de SHA3-256.
 * NÃO é paralelizável — cada iteração depende da anterior.
 * Isso garante que o remetente REALMENTE gastou tempo (e bateria).
 */
export function computeVDF(
  input: string,
  iterations: number,
  challenge: string,
): VDFProof {
  const start = performance.now();

  let current: Uint8Array = new TextEncoder().encode(input + challenge);
  for (let i = 0; i < iterations; i++) {
    current = sha3_256(current) as Uint8Array;
  }

  const elapsed = performance.now() - start;

  return {
    input,
    result: Array.from(current).map(b => b.toString(16).padStart(2, "0")).join(""),
    iterations,
    elapsedMs: elapsed,
    challenge,
  };
}

/**
 * Verifica uma VDF (rápido — O(N), mas N é pequeno).
 */
export function verifyVDF(proof: VDFProof): boolean {
  const recomputed = computeVDF(proof.input, proof.iterations, proof.challenge);
  return recomputed.result === proof.result;
}

// ─── 3. Rate Limiting por GhostID (Token Bucket) ─────────────────────────────

/**
 * Sistema de créditos por GhostID.
 * Cada GhostID tem um "bucket" de créditos que regenera ao longo do tempo.
 * Enviar um shard consome créditos. Sem créditos = não pode enviar.
 */
export class RateLimiter {
  private states: Map<string, RateLimitState> = new Map();
  private readonly REFILL_RATE = 1;      // 1 crédito / segundo
  private readonly MAX_CREDITS = 60;     // teto de 60 créditos
  private readonly SHARD_COST = 5;       // custo de 1 shard QEL
  private readonly VDF_BONUS = 10;       // bônus por VDF (prova de tempo real)

  /**
   * Obtém ou cria o estado de rate limit para um GhostID.
   */
  getState(ghostId: string): RateLimitState {
    if (!this.states.has(ghostId)) {
      this.states.set(ghostId, {
        ghostId,
        credits: this.MAX_CREDITS,
        maxCredits: this.MAX_CREDITS,
        lastRefill: Date.now(),
        totalShards: 0,
        totalBurned: 0,
      });
    }
    return this.states.get(ghostId)!;
  }

  /**
   * Recarrega créditos baseado no tempo decorrido.
   */
  private refill(state: RateLimitState): void {
    const now = Date.now();
    const elapsedSec = (now - state.lastRefill) / 1000;
    const newCredits = Math.min(
      state.maxCredits,
      state.credits + elapsedSec * this.REFILL_RATE
    );
    state.credits = newCredits;
    state.lastRefill = now;
  }

  /**
   * Tenta consumir créditos para enviar shards.
   * Retorna true se autorizado, false se rate limited.
   */
  trySpend(ghostId: string, shardCount: number, hasVDF = false): boolean {
    const state = this.getState(ghostId);
    this.refill(state);

    const cost = shardCount * this.SHARD_COST;
    const bonus = hasVDF ? this.VDF_BONUS : 0;
    const netCost = Math.max(0, cost - bonus);

    if (state.credits < netCost) {
      return false; // Rate limited!
    }

    state.credits -= netCost;
    state.totalShards += shardCount;
    state.totalBurned += netCost;
    return true;
  }

  /**
   * Retorna estatísticas de todos os GhostIDs.
   */
  getStats(): {
    totalIds: number;
    totalShards: number;
    avgCredits: number;
    rateLimitedIds: number;
  } {
    const states = Array.from(this.states.values());
    return {
      totalIds: states.length,
      totalShards: states.reduce((s, st) => s + st.totalShards, 0),
      avgCredits: states.reduce((s, st) => s + st.credits, 0) / Math.max(1, states.length),
      rateLimitedIds: states.filter(st => st.credits < this.SHARD_COST).length,
    };
  }

  clear(): void {
    this.states.clear();
  }
}

// ─── 4. Shard Validator (Gateway Anti-Spam) ──────────────────────────────────

export class ShardValidator {
  private rateLimiter = new RateLimiter();
  private difficulty = 2;
  private totalShards = 0;
  private acceptedShards = 0;
  private rejectedShards = 0;
  private spamDetected = 0;
  private poWTimes: number[] = [];

  /**
   * Valida um shard QEL completo (PoW + VDF + Rate Limit).
   * Esta é a função chamada por cada nó da rede ao receber um shard.
   */
  validateShard(
    ghostId: string,
    shardCommitment: string,
    powProof: PoWProof,
    vdfProof: VDFProof,
  ): { accepted: boolean; reason?: string } {
    this.totalShards++;

    // 1. Verifica PoW
    if (!verifyPoW(ghostId, shardCommitment, powProof)) {
      this.rejectedShards++;
      this.spamDetected++;
      return { accepted: false, reason: "INVALID_POW" };
    }

    // 2. Verifica VDF
    if (!verifyVDF(vdfProof)) {
      this.rejectedShards++;
      this.spamDetected++;
      return { accepted: false, reason: "INVALID_VDF" };
    }

    // 3. Verifica Rate Limit
    if (!this.rateLimiter.trySpend(ghostId, 1, true)) {
      this.rejectedShards++;
      this.spamDetected++;
      return { accepted: false, reason: "RATE_LIMITED" };
    }

    // 4. Atualiza dificuldade dinâmica
    this.poWTimes.push(powProof.elapsedMs);
    if (this.poWTimes.length > 100) this.poWTimes.shift();
    this.adjustDifficulty();

    this.acceptedShards++;
    return { accepted: true };
  }

  /**
   * Ajusta dificuldade baseado no tempo médio de PoW.
   * Alvo: 500ms por PoW em dispositivo médio.
   */
  private adjustDifficulty(): void {
    if (this.poWTimes.length < 10) return;
    const avg = this.poWTimes.reduce((a, b) => a + b, 0) / this.poWTimes.length;

    if (avg < 200 && this.difficulty < 8) {
      this.difficulty++; // muito fácil, aumenta
    } else if (avg > 2000 && this.difficulty > 1) {
      this.difficulty--; // muito difícil, diminui
    }
  }

  /**
   * Retorna saúde da rede.
   */
  getHealth(): NetworkHealth {
    const rateStats = this.rateLimiter.getStats();
    return {
      totalShards: this.totalShards,
      acceptedShards: this.acceptedShards,
      rejectedShards: this.rejectedShards,
      avgPoWTimeMs: this.poWTimes.length > 0
        ? this.poWTimes.reduce((a, b) => a + b, 0) / this.poWTimes.length
        : 0,
      currentDifficulty: this.difficulty,
      activeGhostIds: rateStats.totalIds,
      storagePressure: Math.min(100, (this.acceptedShards / 10000) * 100),
      spamDetected: this.spamDetected,
    };
  }

  getDifficulty(): number {
    return this.difficulty;
  }

  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  reset(): void {
    this.rateLimiter.clear();
    this.difficulty = 2;
    this.totalShards = 0;
    this.acceptedShards = 0;
    this.rejectedShards = 0;
    this.spamDetected = 0;
    this.poWTimes = [];
  }
}

// ─── 5. Economic Cost Analysis ────────────────────────────────────────────────

/**
 * Calcula o custo econômico de um ataque de spam.
 *
 * Para inundar a rede com 1 milhão de shards/hora:
 * - Cada shard precisa de PoW + VDF
 * - PoW a dificuldade 3: ~500ms em média
 * - VDF com 1000 iterações: ~200ms
 * - Total por shard: ~700ms de CPU contínuo
 *
 * Para 1M shards/hora:
 * - 1M × 700ms = 700.000 segundos = 194 horas de CPU
 * - Em 1000 dispositivos: 0.19 horas cada = ~11 minutos de CPU contínua
 * - Custo de bateria: ~15% por hora de CPU máxima
 */
export function calculateSpamCost(
  shardsPerHour: number,
  difficulty: number,
  vdfIterations: number,
  deviceCount: number,
): {
  totalCpuHours: number;
  cpuHoursPerDevice: number;
  batteryDrainPercent: number;
  estimatedCostUSD: number;
} {
  // Estimativas empíricas (ms por operação)
  const msPerPoW = 100 * Math.pow(2, difficulty - 1); // exponencial
  const msPerVDF = vdfIterations * 0.2; // ~0.2ms por iteração SHA3
  const msPerShard = msPerPoW + msPerVDF;

  const totalMs = shardsPerHour * msPerShard;
  const totalCpuHours = totalMs / 3600000;
  const cpuHoursPerDevice = totalCpuHours / deviceCount;

  // Bateria: ~15% por hora de CPU máxima em smartphone
  const batteryDrainPercent = cpuHoursPerDevice * 15;

  // Custo estimado: $0.05/kWh em cloud, $0.50/hora em smartphone wear
  const estimatedCostUSD = totalCpuHours * 0.5;

  return {
    totalCpuHours: Math.round(totalCpuHours * 100) / 100,
    cpuHoursPerDevice: Math.round(cpuHoursPerDevice * 100) / 100,
    batteryDrainPercent: Math.round(batteryDrainPercent * 100) / 100,
    estimatedCostUSD: Math.round(estimatedCostUSD * 100) / 100,
  };
}
