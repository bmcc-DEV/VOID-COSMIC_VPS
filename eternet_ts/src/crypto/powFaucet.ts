/**
 * ETΞRNET — PoW Faucet (Emissão por Trabalho)
 *
 * Sistema de emissão de tokens ETR via prova de trabalho real.
 * Substitui o minerador fake (LCG) por hashcash SHA3-512 genuíno.
 *
 * Não compete com GPU/ASIC — dificuldade é baixa o suficiente
 * para browser (~1-5s por token) mas alta o suficiente para
 * prevenir spam.
 *
 * A dificuldade é ajustada pela DAO via propostas.
 */

import { sha3_512 } from "@noble/hashes/sha3.js";
import { secureRandomId } from "../utils/secureRandom";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Desafio PoW emitido pelo faucet */
export interface FaucetChallenge {
  /** Identificador único do desafio */
  id: string;
  /** Bytes aleatórios do desafio (32 bytes) */
  challenge: Uint8Array;
  /** Dificuldade: número de bits zero no início do hash */
  difficulty: number;
  /** Recompensa em wei (menor unidade) */
  reward: bigint;
  /** Timestamp de criação */
  createdAt: number;
  /** Timestamp de expiração */
  expiresAt: number;
}

/** Solução encontrada pelo minerador */
export interface FaucetSolution {
  /** ID do desafio resolvido */
  challengeId: string;
  /** Nonce encontrado */
  nonce: Uint8Array;
  /** SHA3-512(challenge || nonce) */
  hash: Uint8Array;
  /** Chave pública de quem resolveu */
  solverPk: string;
}

/** Estatísticas do faucet */
export interface FaucetStats {
  /** Dificuldade atual (bits zero) */
  difficulty: number;
  /** Recompensa por PoW */
  reward: bigint;
  /** Total emitido */
  totalMined: bigint;
  /** Desafios ativos */
  challengesActive: number;
  /** Tempo médio de resolução (ms) */
  averageSolveTimeMs: number;
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

/**
 * Conta bits zero no início de um Uint8Array.
 * Usado para verificar se o hash SHA3-512 atinge a dificuldade.
 */
function countLeadingZeroBits(data: Uint8Array): number {
  let count = 0;
  for (const byte of data) {
    if (byte === 0) {
      count += 8;
    } else {
      for (let bit = 7; bit >= 0; bit--) {
        if ((byte & (1 << bit)) === 0) count++;
        else return count;
      }
      return count;
    }
  }
  return count;
}

// ─── PoW Faucet (Singleton) ──────────────────────────────────────────────────

/**
 * Faucet de emissão por prova de trabalho.
 *
 * Cada token emitido exige encontrar um nonce tal que
 * SHA3-512(challenge || nonce) tenha N bits zero no início.
 * Isso garante que o emissor gastou CPU real, mas com dificuldade
 * baixa o suficiente para browser (~1-5s).
 */
class PowFaucet {
  private static instance: PowFaucet;

  private challenges: Map<string, FaucetChallenge> = new Map();
  private difficulty: number = 20; // bits zero — ~1s em browser moderno
  private reward: bigint = 100n; // 100 wei por PoW
  private totalMined: bigint = 0n;
  private solveTimes: number[] = [];

  public static getInstance(): PowFaucet {
    if (!PowFaucet.instance) {
      PowFaucet.instance = new PowFaucet();
    }
    return PowFaucet.instance;
  }

  private constructor() {
    console.log("[PowFaucet] Faucet de emissão PoW inicializado.");
  }

  // ─── Desafios ─────────────────────────────────────────────────────────────

  /**
   * Cria um novo desafio PoW.
   * Válido por 5 minutos.
   *
   * @returns Desafio criado
   */
  createChallenge(): FaucetChallenge {
    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);

    const id = secureRandomId(8);
    const now = Date.now();

    const challenge: FaucetChallenge = {
      id,
      challenge: challengeBytes,
      difficulty: this.difficulty,
      reward: this.reward,
      createdAt: now,
      expiresAt: now + 300_000, // 5 min
    };

    this.challenges.set(id, challenge);

    console.log(
      `[PowFaucet] Desafio criado: ${id} (dificuldade: ${this.difficulty} bits)`
    );

    return challenge;
  }

  // ─── Verificação ──────────────────────────────────────────────────────────

  /**
   * Verifica se uma solução é válida.
   *
   * Concatena challenge + nonce, computa SHA3-512 e verifica
   * se o hash tem bits zero suficientes no início.
   *
   * @param solution - Solução proposta
   * @returns true se a solução é válida
   */
  verifySolution(solution: FaucetSolution): boolean {
    const challenge = this.challenges.get(solution.challengeId);
    if (!challenge) return false;
    if (Date.now() > challenge.expiresAt) return false;

    // Concatena challenge + nonce
    const combined = new Uint8Array(
      challenge.challenge.length + solution.nonce.length
    );
    combined.set(challenge.challenge);
    combined.set(solution.nonce, challenge.challenge.length);

    // Computa SHA3-512
    const hash = sha3_512(combined);

    // Verifica leading zero bits
    const leadingZeros = countLeadingZeroBits(hash);
    if (leadingZeros < challenge.difficulty) return false;

    // Rastreia estatísticas
    const solveTime = Date.now() - challenge.createdAt;
    this.solveTimes.push(solveTime);
    if (this.solveTimes.length > 100) this.solveTimes.shift();
    this.totalMined += challenge.reward;

    // Remove desafio usado
    this.challenges.delete(solution.challengeId);

    console.log(
      `[PowFaucet] Solução válida: ${solution.challengeId} ` +
        `(${solveTime}ms, ${this.difficulty} bits zero)`
    );

    return true;
  }

  // ─── Mineração ────────────────────────────────────────────────────────────

  /**
   * Minera um desafio no browser.
   *
   * Tenta até 16M nonces aleatórios, yieldando a cada 1000
   * tentativas para não bloquear a UI.
   *
   * @param challengeId - ID do desafio a minerar
   * @returns Solução encontrada ou null se esgotar tentativas
   */
  async mineChallenge(challengeId: string): Promise<FaucetSolution | null> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || Date.now() > challenge.expiresAt) return null;

    const maxAttempts = 2 ** 24; // ~16M tentativas

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Gera nonce aleatório seguro
      const nonce = new Uint8Array(16);
      crypto.getRandomValues(nonce);

      // Concatena challenge + nonce
      const combined = new Uint8Array(
        challenge.challenge.length + nonce.length
      );
      combined.set(challenge.challenge);
      combined.set(nonce, challenge.challenge.length);

      const hash = sha3_512(combined);
      const leadingZeros = countLeadingZeroBits(hash);

      if (leadingZeros >= challenge.difficulty) {
        console.log(
          `[PowFaucet] Solução encontrada em ${attempt + 1} tentativas`
        );
        return {
          challengeId,
          nonce,
          hash,
          solverPk: "", // chamador preenche
        };
      }

      // Yield a cada 1000 tentativas para não bloquear UI
      if (attempt % 1000 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    console.warn(
      `[PowFaucet] Máximo de ${maxAttempts} tentativas atingido para ${challengeId}`
    );
    return null;
  }

  // ─── Configuração ─────────────────────────────────────────────────────────

  /**
   * Ajusta a dificuldade (bits zero no início do hash).
   * Pode ser chamado pela DAO via proposta.
   *
   * @param d - Nova dificuldade (1-32)
   */
  setDifficulty(d: number): void {
    this.difficulty = Math.max(1, Math.min(32, d));
    console.log(`[PowFaucet] Dificuldade ajustada para ${this.difficulty} bits`);
  }

  /**
   * Ajusta a recompensa por PoW.
   *
   * @param r - Nova recompensa em wei
   */
  setReward(r: bigint): void {
    this.reward = r;
    console.log(`[PowFaucet] Recompensa ajustada para ${r} wei`);
  }

  /** Retorna a dificuldade atual */
  getDifficulty(): number {
    return this.difficulty;
  }

  /** Retorna a recompensa atual */
  getReward(): bigint {
    return this.reward;
  }

  /**
   * Retorna estatísticas do faucet.
   */
  getStats(): FaucetStats {
    const avgTime =
      this.solveTimes.length > 0
        ? this.solveTimes.reduce((a, b) => a + b, 0) / this.solveTimes.length
        : 0;
    return {
      difficulty: this.difficulty,
      reward: this.reward,
      totalMined: this.totalMined,
      challengesActive: this.challenges.size,
      averageSolveTimeMs: avgTime,
    };
  }
}

/** Instância singleton do PoW Faucet */
export const powFaucet = PowFaucet.getInstance();
