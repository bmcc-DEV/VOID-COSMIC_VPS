/**
 * ETΞRNET — Paleo-Yield Farming (Capítulo 12.3)
 *
 * Yield farming para ativos "fósseis" — sistemas legados,
 * algoritmos core e infraestrutura open-source que geram
 * rendimento decrescente com a idade.
 *
 * Fórmula de rendimento:
 *   yield = staked × (APR / 365) × days × exp(-λ × age)
 *
 * O fator exponencial penaliza ativos antigos, simulando
 * a " fossilização" do valor.
 *
 * Referência: "O Livro do ETRNET", Cap. 12.3
 */

import { secureRandomId } from "../utils/secureRandom";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Categoria de Fossil ETF */
export type FossilCategory = "CORE_ALGOS" | "LEGACY_ENTERPRISE" | "OSS_INFRA";

/** Fazenda de yield */
export interface YieldFarm {
  /** Identificador único */
  id: string;
  /** Nome da fazenda */
  name: string;
  /** Taxa anual de rendimento (APR) */
  apr: number;
  /** Total apostado na fazenda */
  totalStaked: number;
  /** Idade da fazenda em dias */
  age: number;
}

/** Posição de paleo-yield */
export interface PaleoYieldPosition {
  /** ID da fazenda */
  farmId: string;
  /** Valor apostado */
  amount: number;
  /** Timestamp de início */
  startTime: number;
  /** Total já resgatado */
  claimed: number;
}

/** ETF de Fósseis */
export interface FossilETF {
  /** Identificador único */
  id: string;
  /** Nome do ETF */
  name: string;
  /** Categoria do fóssil */
  category: FossilCategory;
  /** Símbolos dos componentes */
  components: string[];
}

// ─── Constantes ──────────────────────────────────────────────────────────────

/** Taxa de fossilização (decaimento exponencial) */
const FOSSILIZATION_RATE = 0.001;

// ─── Funções de Yield ────────────────────────────────────────────────────────

/**
 * Calcula o rendimento paleo-yield.
 *
 * yield = staked × (APR / 365) × days × exp(-λ × age)
 *
 * O fator exp(-λ × age) simula a " fossilização":
 * quanto mais velho o ativo, menor o rendimento.
 *
 * @param position - Posição do usuário
 * @param farm - Fazenda onde está apostado
 * @param currentTime - Timestamp atual
 * @returns Valor do rendimento acumulado
 */
export function calculatePaleoYield(
  position: PaleoYieldPosition,
  farm: YieldFarm,
  currentTime: number
): number {
  const daysElapsed =
    (currentTime - position.startTime) / (1000 * 60 * 60 * 24);

  if (daysElapsed <= 0) return 0;

  const dailyRate = farm.apr / 365;
  const fossilizationFactor = Math.exp(-FOSSILIZATION_RATE * farm.age);

  const yieldAmount =
    position.amount * dailyRate * daysElapsed * fossilizationFactor;

  // Descontar o que já foi resgatado
  const netYield = Math.max(0, yieldAmount - position.claimed);

  return Math.round(netYield * 10000) / 10000;
}

// ─── Gerenciador Paleo-Yield (Singleton) ─────────────────────────────────────

/**
 * Gerenciador de Paleo-Yield Farming (singleton).
 *
 * Cria fazendas, gerencia posições e ETFs de fósseis.
 */
export class PaleoYieldManager {
  private static instance: PaleoYieldManager;
  private farms: Map<string, YieldFarm> = new Map();
  private positions: Map<string, PaleoYieldPosition[]> = new Map();
  private fossilETFs: Map<string, FossilETF> = new Map();

  public static getInstance(): PaleoYieldManager {
    if (!PaleoYieldManager.instance) {
      PaleoYieldManager.instance = new PaleoYieldManager();
    }
    return PaleoYieldManager.instance;
  }

  private constructor() {}

  /**
   * Cria uma nova fazenda de yield.
   *
   * @param name - Nome da fazenda
   * @param apr - Taxa anual de rendimento (ex: 0.15 = 15%)
   * @param age - Idade da fazenda em dias
   * @returns A fazenda criada
   */
  createFarm(name: string, apr: number, age: number): YieldFarm {
    const id = `farm_${Date.now()}_${secureRandomId(4)}`;

    const farm: YieldFarm = {
      id,
      name,
      apr,
      totalStaked: 0,
      age,
    };

    this.farms.set(id, farm);

    console.log(
      `[PaleoYield] Fazenda criada: ${name} (APR: ${(apr * 100).toFixed(1)}%, idade: ${age}d)`
    );

    return farm;
  }

  /**
   * Aplica (stake) um valor em uma fazenda.
   *
   * @param farmId - ID da fazenda
   * @param amount - Valor a apostar
   * @returns Posição criada
   */
  stake(farmId: string, amount: number): PaleoYieldPosition {
    const farm = this.farms.get(farmId);
    if (!farm) throw new Error(`Fazenda ${farmId} não encontrada`);
    if (amount <= 0) throw new Error("Valor deve ser positivo");

    farm.totalStaked += amount;

    const position: PaleoYieldPosition = {
      farmId,
      amount,
      startTime: Date.now(),
      claimed: 0,
    };

    const positions = this.positions.get(farmId) || [];
    positions.push(position);
    this.positions.set(farmId, positions);

    console.log(
      `[PaleoYield] Stake: ${amount} em ${farm.name} (total: ${farm.totalStaked})`
    );

    return position;
  }

  /**
   * Resgata o rendimento acumulado de uma posição.
   *
   * @param farmId - ID da fazenda
   * @param positionIndex - Índice da posição na lista
   * @param currentTime - Timestamp atual
   * @returns Valor resgatado
   */
  claim(farmId: string, positionIndex: number, currentTime: number): number {
    const farm = this.farms.get(farmId);
    if (!farm) throw new Error(`Fazenda ${farmId} não encontrada`);

    const positions = this.positions.get(farmId);
    if (!positions || !positions[positionIndex]) {
      throw new Error(`Posição ${positionIndex} não encontrada na fazenda ${farmId}`);
    }

    const position = positions[positionIndex];
    const yieldAmount = calculatePaleoYield(position, farm, currentTime);

    if (yieldAmount <= 0) {
      console.log(`[PaleoYield] Nenhum yield disponível para resgate`);
      return 0;
    }

    position.claimed += yieldAmount;

    console.log(
      `[PaleoYield] Resgate: ${yieldAmount.toFixed(4)} de ${farm.name}`
    );

    return yieldAmount;
  }

  /**
   * Cria um ETF de fósseis.
   *
   * @param name - Nome do ETF
   * @param category - Categoria (CORE_ALGOS, LEGACY_ENTERPRISE, OSS_INFRA)
   * @param components - Símbolos dos ativos componentes
   * @returns O ETF criado
   */
  createFossilETF(
    name: string,
    category: FossilCategory,
    components: string[]
  ): FossilETF {
    const id = `fossil_${Date.now()}_${secureRandomId(4)}`;

    const etf: FossilETF = {
      id,
      name,
      category,
      components,
    };

    this.fossilETFs.set(id, etf);

    console.log(
      `[PaleoYield] Fossil ETF criado: ${name} (${category}, ${components.length} componentes)`
    );

    return etf;
  }

  /**
   * Retorna uma fazenda pelo ID.
   */
  getFarm(farmId: string): YieldFarm | undefined {
    return this.farms.get(farmId);
  }

  /**
   * Retorna as posições de uma fazenda.
   */
  getPositions(farmId: string): PaleoYieldPosition[] {
    return this.positions.get(farmId) || [];
  }

  /**
   * Retorna todas as fazendas.
   */
  getAllFarms(): YieldFarm[] {
    return Array.from(this.farms.values());
  }

  /**
   * Retorna todos os ETFs de fósseis.
   */
  getAllFossilETFs(): FossilETF[] {
    return Array.from(this.fossilETFs.values());
  }
}

export const paleoYieldManager = PaleoYieldManager.getInstance();
