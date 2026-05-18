/**
 * ETΞRNET — SingularityHarvester (Máquina de Enriquecimento Absoluto)
 *
 * Orquestra a captura de riqueza em escala geométrica usando:
 * - Fase 1: Monopólio Paleontológico (Fossil Monopoly) — REAL
 * - Fase 2: Front-Running Quântico-Relativístico (QRC) — SIMULAÇÃO MPS/WebGPU
 * - Fase 3: Short de Coerência Sistêmica (Coherence Short) — REAL
 *
 * Referência: "O Livro do ETRNET", Cap. 12 — Mercados com Memória
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { EcoNet } from "./econet";
import {
  simulateQuantumSwitch,
  type QuantumSwitchConfig,
} from "../qrc/quantumSwitch";
import type { MarketState } from "../qrc/tensorNetwork";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FossilMonopolyResult {
  fossilsScanned: number;
  fossilsControlled: number;
  monopolyScore: number;        // 0-1: fração de fósseis controlados
  scarTokensMinted: number;
  totalDefectValue: number;
}

export interface QRCFrontRunResult {
  status: "simulated" | "profit_found" | "no_profit" | "error";
  /** Caminho causal vencedor */
  collapsedPath: string;
  /** Lucro esperado (0 se nenhum cenário lucrativo) */
  profit: number;
  /** Payload da transação (null se não lucrativo) */
  payload: string | null;
  /** Se usou WebGPU */
  usedGPU: boolean;
  /** Tempo de processamento */
  processingTimeMs: number;
  /** Caminhos explorados */
  pathsExplored: number;
}

export interface CoherenceShortResult {
  cdr: number;                  // Coherence Diversification Ratio
  swapsCreated: number;
  totalYield: number;
  marketCoherence: number;
}

export interface HarvestResult {
  phase1: FossilMonopolyResult;
  phase2: QRCFrontRunResult;
  phase3: CoherenceShortResult;
  totalPortfolioSOV: number;
  timestamp: number;
}

export interface HarvesterScarToken {
  id: string;
  fossilId: string;
  defectValue: number;
  mintedAt: number;
}

// ─── Fase 1: Monopólio Paleontológico (REAL) ─────────────────────────────────

/**
 * Escaneia EcoNet por entries fossilizadas e mapeia "defect fields".
 *
 * Cada fóssil (decay > 0.7) gera um Scar Token proporcional à significância
 * original dos dados. O monopoly score é a fração de fósseis da rede
 * que este nó controla.
 */
export function fossilMonopolyPhase(
  econet: EcoNet,
  _minDecayLevel = 0.7,
): FossilMonopolyResult {
  const allEntries = econet.getAllEntries();
  const fossils = allEntries.filter(e => {
    const decayLevel = 1 - e.significance;
    return decayLevel > _minDecayLevel;
  });

  const scarTokens: HarvesterScarToken[] = [];
  let totalDefectValue = 0;

  for (const fossil of fossils) {
    const hash = sha3_256(fossil.data);
    const defectValue = computeDefectValue(hash, fossil.significance);

    const token: HarvesterScarToken = {
      id: `scar_${fossil.id.slice(0, 8)}_${Date.now()}`,
      fossilId: fossil.id,
      defectValue,
      mintedAt: Date.now(),
    };

    scarTokens.push(token);
    totalDefectValue += defectValue;
  }

  const monopolyScore = allEntries.length > 0
    ? fossils.length / allEntries.length
    : 0;

  return {
    fossilsScanned: allEntries.length,
    fossilsControlled: fossils.length,
    monopolyScore,
    scarTokensMinted: scarTokens.length,
    totalDefectValue,
  };
}

function computeDefectValue(hash: Uint8Array, significance: number): number {
  let sum = 0;
  for (let i = 0; i < hash.length; i++) {
    sum += hash[i];
  }
  const normalized = sum / (hash.length * 255);
  return normalized * significance * 100;
}

// ─── Fase 2: QRC Front-Running (SIMULAÇÃO MPS/WebGPU) ────────────────────────

/**
 * Front-Running via simulação de Quantum Switch.
 *
 * Usa Redes Tensoriais (MPS) para mapear o estado de mercado para
 * amplitudes quânticas simuladas, depois calcula 3 caminhos causais
 * (comprar, vender, esperar) em paralelo e colapsa para o mais lucrativo.
 *
 * O que é REAL:
 * - Matemática de MPS (Matrix Product States)
 * - Paralelismo via WebGPU compute shaders
 * - Exploração de múltiplos caminhos causais simultaneamente
 *
 * O que é SIMULAÇÃO:
 * - Isto NÃO é computação quântica real
 * - É álgebra linear clássica otimizada que explora ambos os caminhos
 * - O "colapso" é uma seleção deterministic do máximo, não medição quântica
 */
export async function qrcFrontRunningPhase(
  market: MarketState,
  targetAsset = "$ETBRL",
  bondDim = 32,
): Promise<QRCFrontRunResult> {
  try {
    const config: QuantumSwitchConfig = {
      targetAsset,
      timeSteps: 3,
      bondDim,
      useGPU: true,
    };

    const result = await simulateQuantumSwitch(market, config);

    return {
      status: result.profit > 0 ? "profit_found" : "no_profit",
      collapsedPath: result.collapsedPath.description,
      profit: result.profit,
      payload: result.payload,
      usedGPU: result.usedGPU,
      processingTimeMs: result.processingTimeMs,
      pathsExplored: result.paths.length,
    };
  } catch (err) {
    return {
      status: "error",
      collapsedPath: "ERRO: " + String(err),
      profit: 0,
      payload: null,
      usedGPU: false,
      processingTimeMs: 0,
      pathsExplored: 0,
    };
  }
}

// ─── Fase 3: Short de Coerência (REAL) ────────────────────────────────────────

/**
 * Calcula o CDR (Coherence Diversification Ratio) e cria Coherence Swaps
 * que lucram com decaimento de coerência do mercado.
 */
export function coherenceShortPhase(
  marketCoherence: number,
  coherenceThreshold = 0.3,
): CoherenceShortResult {
  const cdr = marketCoherence > 0 ? 1 / marketCoherence : 1;

  let swapsCreated = 0;
  let totalYield = 0;

  if (cdr < coherenceThreshold) {
    const gap = coherenceThreshold - cdr;
    swapsCreated = Math.max(1, Math.floor(gap * 10));
    totalYield = gap * marketCoherence * 1000;
  }

  return {
    cdr,
    swapsCreated,
    totalYield,
    marketCoherence,
  };
}

// ─── Harvester Orquestrador ───────────────────────────────────────────────────

/**
 * Orquestra as 3 fases de captura de riqueza do SingularityHarvester.
 *
 * ```typescript
 * const econet = EcoNet.getInstance();
 * const harvester = new SingularityHarvester(econet);
 * const result = await harvester.harvest(market, 0.5);
 * console.log(result.totalPortfolioSOV);
 * ```
 */
export class SingularityHarvester {
  private econet: EcoNet;
  private portfolioSOV = 0;

  constructor(econet: EcoNet) {
    this.econet = econet;
  }

  /**
   * Executa as 3 fases de harvest.
   * @param market Estado atual do mercado (preços, volumes, volatilidades)
   * @param marketCoherence Coerência atual do mercado (0-1)
   * @param targetAsset Ativo alvo para QRC
   */
  async harvest(
    market: MarketState,
    marketCoherence = 0.5,
    targetAsset = "$ETBRL",
  ): Promise<HarvestResult> {
    // Fase 1: Monopólio Paleontológico
    const phase1 = fossilMonopolyPhase(this.econet);
    this.portfolioSOV += phase1.totalDefectValue;

    // Fase 2: QRC (simulação MPS/WebGPU)
    const phase2 = await qrcFrontRunningPhase(market, targetAsset);
    if (phase2.profit > 0) {
      this.portfolioSOV += phase2.profit * 1000; // Escala para SOV
    }

    // Fase 3: Short de Coerência
    const phase3 = coherenceShortPhase(marketCoherence);
    this.portfolioSOV += phase3.totalYield;

    return {
      phase1,
      phase2,
      phase3,
      totalPortfolioSOV: this.portfolioSOV,
      timestamp: Date.now(),
    };
  }

  /** Retorna o patrimônio acumulado. */
  getPortfolio(): number {
    return this.portfolioSOV;
  }

  /** Reseta o patrimônio. */
  reset(): void {
    this.portfolioSOV = 0;
  }
}
