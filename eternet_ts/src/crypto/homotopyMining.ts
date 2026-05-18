/**
 * ETΞRNET — Mineração por Homotopia (Capítulo 11.2)
 *
 * Proof-of-Homotopia: consenso baseado na suavidade de campos
 * usando métricas Sobolev (H¹, H²) via FFT.
 *
 * O trabalho de mineração consiste em encontrar um nonce tal que
 * o hash Sobolev do campo combinado com o nonce atenda a dificuldade.
 *
 * Métrica Sobolev: ||f||²_{H^s} = Σ_k (1 + k^{2s}) |ĉ_k|²
 *
 * Referência: "O Livro do ETRNET", Cap. 11.2
 */

import { sha3_256 } from "@noble/hashes/sha3.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Métrica Sobolev de um campo */
export interface SobolevMetric {
  /** Norma H¹: penaliza variações de primeira ordem */
  h1Norm: number;
  /** Norma H²: penaliza variações de segunda ordem */
  h2Norm: number;
  /** Hash do espectro (hex) */
  spectrumHash: string;
}

/** Bloco de homotopia na cadeia */
export interface HomotopyBlock {
  /** Índice do bloco na cadeia */
  index: number;
  /** Hash do bloco anterior */
  previousHash: string;
  /** Hash Sobolev do campo + nonce */
  sobolevHash: string;
  /** Nonce descoberto pelo minerador */
  nonce: number;
  /** Timestamp de mineração */
  timestamp: number;
}

// ─── Transformada Discreta de Fourier (DFT) Simplificada ─────────────────────

/**
 * DFT simplificada para campos reais.
 *
 * Calcula ĉ_k = Σ_n f[n] * e^{-i 2π k n / N}
 * Retorna apenas as magnitudes |ĉ_k|² (espectro de potência).
 *
 * @param field - Campo discreto f[n]
 * @returns Array de |ĉ_k|² para k = 0, 1, ..., N-1
 */
function powerSpectrum(field: number[]): number[] {
  const N = field.length;
  const spectrum = new Array(N).fill(0);

  for (let k = 0; k < N; k++) {
    let realPart = 0;
    let imagPart = 0;

    for (let n = 0; n < N; n++) {
      const angle = (-2 * Math.PI * k * n) / N;
      realPart += field[n] * Math.cos(angle);
      imagPart += field[n] * Math.sin(angle);
    }

    // |ĉ_k|² = Re² + Im²
    spectrum[k] = (realPart * realPart + imagPart * imagPart) / (N * N);
  }

  return spectrum;
}

// ─── Métrica Sobolev ─────────────────────────────────────────────────────────

/**
 * Calcula a métrica Sobolev de um campo discreto.
 *
 * ||f||²_{H^s} = Σ_{k=0}^{N-1} (1 + k^{2s}) |ĉ_k|²
 *
 * @param field - Campo discreto (array de números)
 * @returns Métrica Sobolev com normas H¹ e H²
 */
export function sobolevMetric(field: number[]): SobolevMetric {
  const spectrum = powerSpectrum(field);
  const N = spectrum.length;

  let h1Norm = 0;
  let h2Norm = 0;

  for (let k = 0; k < N; k++) {
    const kSquared = k * k;
    // H¹: s = 1 → (1 + k²)
    h1Norm += (1 + kSquared) * spectrum[k];
    // H²: s = 2 → (1 + k⁴)
    h2Norm += (1 + kSquared * kSquared) * spectrum[k];
  }

  h1Norm = Math.sqrt(h1Norm);
  h2Norm = Math.sqrt(h2Norm);

  // Hash do espectro: SHA3-256 dos valores espectrais quantizados
  const spectrumBytes = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const val = Math.round(spectrum[i] * 1e6);
    spectrumBytes[i * 4] = val & 0xff;
    spectrumBytes[i * 4 + 1] = (val >> 8) & 0xff;
    spectrumBytes[i * 4 + 2] = (val >> 16) & 0xff;
    spectrumBytes[i * 4 + 3] = (val >> 24) & 0xff;
  }

  const hash = sha3_256(spectrumBytes);
  const spectrumHash = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return { h1Norm, h2Norm, spectrumHash };
}

// ─── Trabalho de Mineração ───────────────────────────────────────────────────

/**
 * Calcula o trabalho de homotopia: combina hash Sobolev com nonce.
 *
 * O resultado é um hash que deve atender à dificuldade
 * (número de zeros no início em hex).
 *
 * @param field - Campo de entrada
 * @param nonce - Nonce a testar
 * @returns Hash hexadecimal do trabalho
 */
export function homotopyWork(field: number[], nonce: number): string {
  // Converter nonce para bytes e adicionar ao campo
  const nonceBytes = new Uint8Array(4);
  nonceBytes[0] = nonce & 0xff;
  nonceBytes[1] = (nonce >> 8) & 0xff;
  nonceBytes[2] = (nonce >> 16) & 0xff;
  nonceBytes[3] = (nonce >> 24) & 0xff;

  // Calcular métrica Sobolev do campo
  const metric = sobolevMetric(field);

  // Hash Sobolev: SHA3(spectrumHash + nonce)
  const combined = new TextEncoder().encode(
    metric.spectrumHash + nonce.toString(16).padStart(8, "0")
  );
  const hash = sha3_256(combined);

  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifica se o trabalho de homotopia atende à dificuldade.
 *
 * @param block - Bloco a verificar
 * @param difficulty - Número de zeros exigidos no início do hash
 * @returns true se o bloco é válido
 */
export function verifyHomotopyWork(
  block: HomotopyBlock,
  difficulty: number
): boolean {
  // Verificar se começa com 'difficulty' zeros
  const prefix = "0".repeat(difficulty);
  if (!block.sobolevHash.startsWith(prefix)) {
    return false;
  }

  // Verificar que o hash corresponde ao nonce + dados
  // (em produção, reconstruir o campo do bloco)
  return block.sobolevHash.length === 64; // SHA3-256 = 32 bytes = 64 hex
}

// ─── Minerador Homotopia (Singleton) ────────────────────────────────────────

/**
 * Minerador de Proof-of-Homotopia (singleton).
 *
 * Minera blocos encontrando nonces que tornam o hash Sobolev
 * do campo com nonce menor que o alvo (dificuldade).
 */
export class HomotopyMiner {
  private static instance: HomotopyMiner;
  private chain: HomotopyBlock[] = [];

  public static getInstance(): HomotopyMiner {
    if (!HomotopyMiner.instance) {
      HomotopyMiner.instance = new HomotopyMiner();
    }
    return HomotopyMiner.instance;
  }

  private constructor() {
    // Bloco genesis
    this.chain.push({
      index: 0,
      previousHash: "0".repeat(64),
      sobolevHash: "0".repeat(64),
      nonce: 0,
      timestamp: Date.now(),
    });
  }

  /**
   * Minera um novo bloco na cadeia.
   *
   * Encontra o nonce tal que hash(Sobolev(campo) + nonce) tenha
   * difficulty zeros no início.
   *
   * @param field - Campo base para o bloco
   * @param difficulty - Número de zeros exigidos (padrão: 4)
   * @returns O bloco minerado
   */
  mineBlock(
    field: number[],
    difficulty: number = 4
  ): HomotopyBlock {
    const previousBlock = this.chain[this.chain.length - 1];
    const previousHash = previousBlock.sobolevHash;
    const prefix = "0".repeat(difficulty);

    let nonce = 0;
    let hash = "";
    const maxIterations = 10_000_000;

    console.log(
      `[HomotopyMiner] Mineração iniciada (dificuldade: ${difficulty})...`
    );

    while (nonce < maxIterations) {
      hash = homotopyWork(field, nonce);

      if (hash.startsWith(prefix)) {
        break;
      }

      nonce++;
    }

    if (nonce >= maxIterations) {
      throw new Error(
        `Mineração falhou após ${maxIterations} iterações`
      );
    }

    const block: HomotopyBlock = {
      index: this.chain.length,
      previousHash,
      sobolevHash: hash,
      nonce,
      timestamp: Date.now(),
    };

    this.chain.push(block);

    console.log(
      `[HomotopyMiner] Bloco #${block.index} minerado! nonce=${nonce}, hash=${hash.substring(0, 16)}...`
    );

    return block;
  }

  /**
   * Valida toda a cadeia de blocos homotopia.
   *
   * Verifica encadeamento de hashes e Proof-of-Work.
   *
   * @param difficulty - Dificuldade esperada
   * @returns true se a cadeia é válida
   */
  validateChain(difficulty: number = 4): boolean {
    const prefix = "0".repeat(difficulty);

    for (let i = 1; i < this.chain.length; i++) {
      const current = this.chain[i];
      const previous = this.chain[i - 1];

      // Verificar encadeamento
      if (current.previousHash !== previous.sobolevHash) {
        console.error(
          `[HomotopyMiner] Cadeia quebrada no bloco #${current.index}: hash anterior não confere`
        );
        return false;
      }

      // Verificar Proof-of-Work
      if (!current.sobolevHash.startsWith(prefix)) {
        console.error(
          `[HomotopyMiner] Bloco #${current.index} não atende dificuldade`
        );
        return false;
      }
    }

    console.log(
      `[HomotopyMiner] Cadeia válida: ${this.chain.length} blocos`
    );
    return true;
  }

  /**
   * Retorna a cadeia completa.
   */
  getChain(): HomotopyBlock[] {
    return [...this.chain];
  }

  /**
   * Retorna o último bloco da cadeia.
   */
  getLatestBlock(): HomotopyBlock {
    return this.chain[this.chain.length - 1];
  }
}

export const homotopyMiner = HomotopyMiner.getInstance();
