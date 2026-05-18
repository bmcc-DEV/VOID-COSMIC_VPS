/**
 * ETΞRNET — Instrumentos de Finanças de Colapso (Capítulo 12)
 *
 * Instrumentos financeiros baseados na teoria de colapsos com memória:
 *
 * - CCB (Collateralized Collapse Bond): títulos com cupom dependente
 *   de estresse e divergência KL
 * - HSV (Hysteresis Vault): cofres com penalidade de histerese
 * - LSC Regulated ETF: ETFs com controle de saturação de loop
 * - Coherence Bond: títulos com yield proporcional à coerência
 * - Scar Token: tokens que representam cicatrizes topológicas
 * - Coherence Swap: swaps baseados em divergência de coerência
 *
 * Referência: "O Livro do ETRNET", Cap. 12
 */

import { secureRandomId } from "../utils/secureRandom";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Título Colateralizado de Colapso (CCB) */
export interface CollateralizedCollapseBond {
  /** Identificador único */
  id: string;
  /** Taxa base do cupom */
  baseRate: number;
  /** Índice de estresse do mercado (0-1) */
  stressIndex: number;
  /** Divergência KL entre distribuições forward/backward */
  klDivergence: number;
  /** Valor nominal */
  principal: number;
  /** Data de vencimento */
  maturityDate: number;
  /** Timestamp de criação */
  createdAt: number;
}

/** Cofre com Histerese (HSV) */
export interface HysteresisVault {
  /** Identificador único */
  id: string;
  /** Saldo depositado */
  balance: number;
  /** Estado da histerese h(t) */
  hysteresisState: number;
  /** Timestamp do último depósito/saque */
  lastActionTime: number;
  /** Parâmetro β de decaimento */
  beta: number;
  /** Timestamp de criação */
  createdAt: number;
}

/** ETF Regulado por LSC */
export interface LSCRegulatedETF {
  /** Identificador único */
  id: string;
  /** Nome do ETF */
  name: string;
  /** Saturação atual do loop (0-1) */
  loopSaturation: number;
  /** Peso alvo */
  targetWeight: number;
  /** Peso atual */
  currentWeight: number;
}

/** Título de Coerência */
export interface CoherenceBond {
  /** Identificador único */
  id: string;
  /** Taxa base */
  baseRate: number;
  /** Medida de coerência C_epsilon */
  coherenceMeasure: number;
  /** Valor nominal */
  principal: number;
  /** Data de vencimento */
  maturityDate: number;
}

/** Token de Cicatriz (Scar Token) */
export interface ScarToken {
  /** Identificador único */
  id: string;
  /** Campo de defeitos χ(x) codificado */
  defectField: number[];
  /** Densidade de defeitos média */
  defectDensity: number;
  /** Valor do token */
  value: number;
}

/** Swap de Coerência */
export interface CoherenceSwap {
  /** Identificador único */
  id: string;
  /** Parte A: medida de coerência */
  partyACoherence: number;
  /** Parte B: medida de coerência */
  partyBCoherence: number;
  /** Troca: fluxo de A para B */
  flowAToB: number;
  /** Timestamp */
  timestamp: number;
}

// ─── Funções de Instrumentos ─────────────────────────────────────────────────

/**
 * Calcula o cupom de um CCB.
 *
 * cupom = baseRate × (1 + stressIndex) × exp(-klDivergence)
 *
 * O cupom aumenta com estresse mas diminui com divergência KL
 * (quanto mais "irreversível" o sistema, menor o cupom).
 *
 * @param bond - Título CCB
 * @returns Valor do cupom
 */
export function ccbCoupon(bond: CollateralizedCollapseBond): number {
  const coupon =
    bond.baseRate * (1 + bond.stressIndex) * Math.exp(-bond.klDivergence);
  return Math.round(coupon * 10000) / 10000;
}

/**
 * Realiza um depósito no HSV.
 *
 * h(t) = ∫₀ᵗ e^{-β(t-s)} σ(s) ds
 *
 * Implementado via EMA (Exponential Moving Average):
 * h_new = e^{-β·Δt} · h_old + (1 - e^{-β·Δt}) · σ
 *
 * @param vault - Cofre HSV
 * @param amount - Valor a depositar
 * @param t - Timestamp atual
 * @returns Cofre atualizado
 */
export function hsvDeposit(
  vault: HysteresisVault,
  amount: number,
  t: number
): HysteresisVault {
  const deltaT = (t - vault.lastActionTime) / 1000; // em segundos
  const decayFactor = Math.exp(-vault.beta * deltaT);

  // σ(t) = sinal do depósito (positivo para depósito)
  const sigma = amount > 0 ? 1 : -1;

  // Atualizar estado de histerese via EMA
  const newHysteresis =
    decayFactor * vault.hysteresisState + (1 - decayFactor) * sigma;

  return {
    ...vault,
    balance: vault.balance + amount,
    hysteresisState: newHysteresis,
    lastActionTime: t,
  };
}

/**
 * Realiza um saque do HSV com penalidade de histerese.
 *
 * penalidade = |h(t) - h(t-τ)|
 *
 * Quanto mais recente a última ação, maior a penalidade.
 * Isso desestimula saques frequentes (comportamento "flipping").
 *
 * @param vault - Cofre HSV
 * @param t - Timestamp atual
 * @returns Objeto com valor líquido e penalidade
 */
export function hsvWithdraw(
  vault: HysteresisVault,
  t: number
): { amount: number; penalty: number; vault: HysteresisVault } {
  const deltaT = (t - vault.lastActionTime) / 1000;
  const tau = 3600; // janela de histerese: 1 hora

  // Penalidade: diferença de histerese entre agora e t-τ
  // Simulamos h(t-τ) com decaimento
  const hysteresisPast = vault.hysteresisState * Math.exp(-vault.beta * tau);
  const penalty = Math.abs(vault.hysteresisState - hysteresisPast);

  // Valor líquido: saldo menos penalidade percentual
  const penaltyAmount = vault.balance * penalty * 0.1;
  const netAmount = Math.max(0, vault.balance - penaltyAmount);

  // Atualizar estado
  const decayFactor = Math.exp(-vault.beta * deltaT);
  const newHysteresis = decayFactor * vault.hysteresisState - (1 - decayFactor);

  const updatedVault: HysteresisVault = {
    ...vault,
    balance: 0,
    hysteresisState: newHysteresis,
    lastActionTime: t,
  };

  return {
    amount: netAmount,
    penalty: penaltyAmount,
    vault: updatedVault,
  };
}

/**
 * Calcula o cupom de um Coherence Bond.
 *
 * yield = base × C_ε²
 *
 * O rendimento é proporcional ao quadrado da medida de coerência.
 * Sistemas mais coerentes pagam mais.
 *
 * @param bond - Título de coerência
 * @returns Valor do cupom
 */
export function coherenceCoupon(bond: CoherenceBond): number {
  return bond.baseRate * bond.coherenceMeasure * bond.coherenceMeasure;
}

/**
 * Calcula a Coherence Diversification Ratio (CDR).
 *
 * CDR = |{H¹ ≠ 0}| / total
 *
 * Mede a fração de ativos com norma H¹ não-nula
 * (i.e., com variação de primeira ordem significativa).
 *
 * @param assets - Lista de normas H¹ dos ativos
 * @returns CDR no intervalo [0, 1]
 */
export function cohDiversificationRatio(assets: number[]): number {
  if (assets.length === 0) return 0;

  const nonZeroH1 = assets.filter((h1) => Math.abs(h1) > 1e-10).length;
  return nonZeroH1 / assets.length;
}

// ─── Gerenciador de Finanças de Colapso (Singleton) ──────────────────────────

/**
 * Gerenciador de Instrumentos de Finanças de Colapso (singleton).
 *
 * Cria e gerencia todos os instrumentos baseados na
 * teoria de colapsos com memória.
 */
export class CollapseFinanceManager {
  private static instance: CollapseFinanceManager;
  private ccbBonds: Map<string, CollateralizedCollapseBond> = new Map();
  private hsvVaults: Map<string, HysteresisVault> = new Map();
  private coherenceBonds: Map<string, CoherenceBond> = new Map();
  private scarTokens: Map<string, ScarToken> = new Map();
  private coherenceSwaps: Map<string, CoherenceSwap> = new Map();

  public static getInstance(): CollapseFinanceManager {
    if (!CollapseFinanceManager.instance) {
      CollapseFinanceManager.instance = new CollapseFinanceManager();
    }
    return CollapseFinanceManager.instance;
  }

  private constructor() {}

  /**
   * Cria um Collateralized Collapse Bond.
   *
   * @param baseRate - Taxa base do cupom
   * @param stressIndex - Índice de estresse inicial
   * @param principal - Valor nominal
   * @param maturityMs - Ms até o vencimento
   * @returns O título CCB criado
   */
  createCCB(
    baseRate: number,
    stressIndex: number,
    principal: number,
    maturityMs: number
  ): CollateralizedCollapseBond {
    const id = `ccb_${Date.now()}_${secureRandomId(4)}`;

    const bond: CollateralizedCollapseBond = {
      id,
      baseRate,
      stressIndex,
      klDivergence: 0.1, // valor inicial baixo
      principal,
      maturityDate: Date.now() + maturityMs,
      createdAt: Date.now(),
    };

    this.ccbBonds.set(id, bond);

    const coupon = ccbCoupon(bond);
    console.log(
      `[CollapseFinance] CCB criado: ${id} (cupom: ${(coupon * 100).toFixed(2)}%)`
    );

    return bond;
  }

  /**
   * Cria um Hysteresis Vault.
   *
   * @param initialBalance - Saldo inicial
   * @param beta - Parâmetro de decaimento (padrão: 0.01)
   * @returns O cofre HSV criado
   */
  createHSV(
    initialBalance: number,
    beta: number = 0.01
  ): HysteresisVault {
    const id = `hsv_${Date.now()}_${secureRandomId(4)}`;

    const vault: HysteresisVault = {
      id,
      balance: initialBalance,
      hysteresisState: 0,
      lastActionTime: Date.now(),
      beta,
      createdAt: Date.now(),
    };

    this.hsvVaults.set(id, vault);

    console.log(
      `[CollapseFinance] HSV criado: ${id} (saldo: ${initialBalance}, β: ${beta})`
    );

    return vault;
  }

  /**
   * Cria um título de Coerência.
   *
   * @param baseRate - Taxa base
   * @param coherenceMeasure - Medida de coerência C_epsilon
   * @param principal - Valor nominal
   * @param maturityMs - Ms até o vencimento
   * @returns O título de coerência criado
   */
  createCoherenceBond(
    baseRate: number,
    coherenceMeasure: number,
    principal: number,
    maturityMs: number
  ): CoherenceBond {
    const id = `coh_${Date.now()}_${secureRandomId(4)}`;

    const bond: CoherenceBond = {
      id,
      baseRate,
      coherenceMeasure,
      principal,
      maturityDate: Date.now() + maturityMs,
    };

    this.coherenceBonds.set(id, bond);

    const coupon = coherenceCoupon(bond);
    console.log(
      `[CollapseFinance] Coherence Bond criado: ${id} (yield: ${(coupon * 100).toFixed(2)}%)`
    );

    return bond;
  }

  /**
   * Cria um Scar Token.
   *
   * @param defectField - Campo de defeitos χ(x)
   * @param value - Valor do token
   * @returns O token de cicatriz criado
   */
  createScarToken(defectField: number[], value: number): ScarToken {
    const id = `scar_${Date.now()}_${secureRandomId(4)}`;

    // Densidade média de defeitos
    const avgDensity =
      defectField.reduce((sum, d) => sum + Math.abs(d), 0) /
      Math.max(1, defectField.length);

    const token: ScarToken = {
      id,
      defectField: [...defectField],
      defectDensity: avgDensity,
      value,
    };

    this.scarTokens.set(id, token);

    console.log(
      `[CollapseFinance] Scar Token criado: ${id} (densidade: ${avgDensity.toFixed(4)})`
    );

    return token;
  }

  /**
   * Cria um Coherence Swap.
   *
   * @param partyACoherence - Coerência da parte A
   * @param partyBCoherence - Coerência da parte B
   * @returns O swap criado
   */
  createCoherenceSwap(
    partyACoherence: number,
    partyBCoherence: number
  ): CoherenceSwap {
    const id = `cswap_${Date.now()}_${secureRandomId(4)}`;

    // Fluxo baseado na diferença de coerência
    const flowAToB = partyACoherence - partyBCoherence;

    const swap: CoherenceSwap = {
      id,
      partyACoherence,
      partyBCoherence,
      flowAToB,
      timestamp: Date.now(),
    };

    this.coherenceSwaps.set(id, swap);

    console.log(
      `[CollapseFinance] Coherence Swap criado: ${id} (fluxo A→B: ${flowAToB.toFixed(4)})`
    );

    return swap;
  }

  /**
   * Calcula o Coherence Diversification Ratio (CDR).
   *
   * @param etfId - ID do ETF para calcular CDR
   * @returns CDR no intervalo [0, 1]
   */
  calculateCDR(_etfId: string): number {
    // Coletar normas H¹ de todos os ativos (simulado)
    // Em produção, viria de cálculos Sobolev reais
    const assets: number[] = [];

    for (const [, bond] of this.ccbBonds) {
      assets.push(bond.stressIndex);
    }
    for (const [, cohBond] of this.coherenceBonds) {
      assets.push(cohBond.coherenceMeasure);
    }
    for (const [, scar] of this.scarTokens) {
      assets.push(scar.defectDensity);
    }

    const cdr = cohDiversificationRatio(assets);
    console.log(`[CollapseFinance] CDR: ${(cdr * 100).toFixed(2)}%`);
    return cdr;
  }

  /**
   * Retorna um CCB pelo ID.
   */
  getCCB(id: string): CollateralizedCollapseBond | undefined {
    return this.ccbBonds.get(id);
  }

  /**
   * Retorna um HSV pelo ID.
   */
  getHSV(id: string): HysteresisVault | undefined {
    return this.hsvVaults.get(id);
  }

  /**
   * Retorna todos os CCBs.
   */
  getAllCCBs(): CollateralizedCollapseBond[] {
    return Array.from(this.ccbBonds.values());
  }

  /**
   * Retorna todos os HSVs.
   */
  getAllHSVs(): HysteresisVault[] {
    return Array.from(this.hsvVaults.values());
  }
}

export const collapseFinanceManager = CollapseFinanceManager.getInstance();
