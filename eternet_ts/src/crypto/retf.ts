/**
 * ETΞRNET — ETFs Relativísticas (Capítulo 11.4)
 *
 * Fundos de Investimento em Troca (Exchange-Traded Funds) que usam
 * rebalanceamento causal baseado em saturação LSC (Loop Saturation Control).
 *
 * O peso de cada componente é ajustado proporcionalmente à sua
 * "contribuição causal" G(C_i), normalizada pela soma total.
 *
 * Fórmula de rebalanceamento:
 *   new_weight_i = old_weight_i * G(C_i) / Σ_j G(C_j)
 *
 * Referência: "O Livro do ETRNET", Cap. 11.4
 */

import { secureRandomId, secureRandom } from "../utils/secureRandom";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Componente de um ETF relativístico */
export interface ETFComponent {
  /** Símbolo do ativo */
  symbol: string;
  /** Peso atual no portfólio (0-1) */
  weight: number;
}

/** Evento de rebalanceamento */
export interface RebalanceEvent {
  /** Timestamp do rebalanceamento */
  timestamp: number;
  /** Pesos anteriores */
  oldWeights: number[];
  /** Pesos novos */
  newWeights: number[];
  /** Causa do rebalanceamento */
  cause: string;
}

/** ETF Relativístico */
export interface RelativisticETF {
  /** Identificador único */
  id: string;
  /** Nome do ETF */
  name: string;
  /** Componentes do fundo */
  components: ETFComponent[];
  /** NAV (Net Asset Value) atual */
  nav: number;
  /** Histórico de rebalanceamentos */
  rebalanceHistory: RebalanceEvent[];
}

// ─── Funções de Contribuição Causal ──────────────────────────────────────────

/**
 * Calcula a contribuição causal G(C) de um ativo.
 *
 * G(C) = saturação do loop causal = 1 - e^{-λ·C}
 * onde C é a "força causal" (variação de preço normalizada).
 *
 * @param causalForce - Força causal do ativo (variação normalizada)
 * @param lambda - Taxa de saturação (padrão: 1.0)
 * @returns G(C) no intervalo [0, 1)
 */
function causalContribution(causalForce: number, lambda: number = 1.0): number {
  return 1 - Math.exp(-lambda * Math.abs(causalForce));
}

/**
 * Calcula a NAV (Net Asset Value) de um ETF.
 *
 * NAV = Σ peso_i × preço_i
 *
 * @param components - Componentes com pesos
 * @param prices - Mapa de preços atuais
 * @returns NAV total
 */
function calculateNAV(
  components: ETFComponent[],
  prices: Map<string, number>
): number {
  let nav = 0;
  for (const comp of components) {
    const price = prices.get(comp.symbol) ?? 100;
    nav += comp.weight * price;
  }
  return nav;
}

// ─── Gerenciador de ETFs Relativísticos (Singleton) ──────────────────────────

/**
 * Gerenciador de ETFs Relativísticos (singleton).
 *
 * Cria, gerencia e rebalanceia fundos usando mecânica causal LSC.
 */
export class RelativisticETFManager {
  private static instance: RelativisticETFManager;
  private etfs: Map<string, RelativisticETF> = new Map();
  private prices: Map<string, number> = new Map();

  public static getInstance(): RelativisticETFManager {
    if (!RelativisticETFManager.instance) {
      RelativisticETFManager.instance = new RelativisticETFManager();
    }
    return RelativisticETFManager.instance;
  }

  private constructor() {}

  /**
   * Cria um novo ETF relativístico.
   *
   * Os pesos iniciais são distribuídos uniformemente entre as componentes.
   *
   * @param name - Nome do ETF
   * @param symbols - Símbolos dos ativos componentes
   * @returns O ETF criado
   */
  createETF(name: string, symbols: string[]): RelativisticETF {
    const id = `retf_${Date.now()}_${secureRandomId(4)}`;
    const uniformWeight = 1 / symbols.length;

    const components: ETFComponent[] = symbols.map((symbol) => ({
      symbol,
      weight: uniformWeight,
    }));

    // Inicializar preços se não existirem
    for (const symbol of symbols) {
      if (!this.prices.has(symbol)) {
        this.prices.set(symbol, 100 + secureRandom() * 200);
      }
    }

    const nav = calculateNAV(components, this.prices);

    const etf: RelativisticETF = {
      id,
      name,
      components,
      nav,
      rebalanceHistory: [],
    };

    this.etfs.set(id, etf);

    console.log(
      `[RelativisticETF] ETF criado: ${name} (${symbols.length} componentes, NAV: ${nav.toFixed(2)})`
    );

    return etf;
  }

  /**
   * Rebalanceia um ETF usando saturação LSC.
   *
   * Fórmula: new_weight_i = old_weight_i * G(C_i) / Σ_j G(C_j)
   *
   * A contribuição causal G(C_i) é calculada a partir da
   * variação de preço normalizada de cada ativo.
   *
   * @param etfId - ID do ETF a rebalancear
   * @param causalForces - Mapa de forças causais por símbolo
   * @param cause - Motivo do rebalanceamento
   * @returns O ETF rebalanceado
   */
  causalRebalance(
    etfId: string,
    causalForces: Map<string, number>,
    cause: string = "Rebalanceamento causal periódico"
  ): RelativisticETF {
    const etf = this.etfs.get(etfId);
    if (!etf) throw new Error(`ETF ${etfId} não encontrado`);

    const oldWeights = etf.components.map((c) => c.weight);

    // Calcular G(C_i) para cada componente
    const contributions = etf.components.map((comp) => {
      const force = causalForces.get(comp.symbol) ?? 0;
      return {
        symbol: comp.symbol,
        contribution: causalContribution(force),
      };
    });

    // Soma total de contribuições
    const totalContribution = contributions.reduce(
      (sum, c) => sum + c.contribution,
      0
    );

    // Normalizar: new_weight_i = old_weight_i * G(C_i) / ΣG(C_j)
    if (totalContribution > 0) {
      for (const comp of etf.components) {
        const contrib = contributions.find(
          (c) => c.symbol === comp.symbol
        );
        if (contrib) {
          comp.weight =
            (comp.weight * contrib.contribution) / totalContribution;
        }
      }
    }

    // Re-normalizar pesos para somar 1
    const totalWeight = etf.components.reduce(
      (sum, c) => sum + c.weight,
      0
    );
    if (totalWeight > 0) {
      for (const comp of etf.components) {
        comp.weight /= totalWeight;
      }
    }

    const newWeights = etf.components.map((c) => c.weight);

    // Registrar evento
    const event: RebalanceEvent = {
      timestamp: Date.now(),
      oldWeights,
      newWeights,
      cause,
    };
    etf.rebalanceHistory.push(event);

    // Recalcular NAV
    etf.nav = calculateNAV(etf.components, this.prices);

    console.log(
      `[RelativisticETF] ${etf.name} rebalanceado: NAV=${etf.nav.toFixed(2)}`
    );

    return etf;
  }

  /**
   * Retorna a NAV de um ETF.
   *
   * @param etfId - ID do ETF
   * @returns NAV atual
   */
  getNAV(etfId: string): number {
    const etf = this.etfs.get(etfId);
    if (!etf) throw new Error(`ETF ${etfId} não encontrado`);

    etf.nav = calculateNAV(etf.components, this.prices);
    return etf.nav;
  }

  /**
   * Retorna o histórico de rebalanceamentos de um ETF.
   *
   * @param etfId - ID do ETF
   * @returns Lista de eventos de rebalanceamento
   */
  getHistory(etfId: string): RebalanceEvent[] {
    const etf = this.etfs.get(etfId);
    if (!etf) throw new Error(`ETF ${etfId} não encontrado`);

    return [...etf.rebalanceHistory];
  }

  /**
   * Atualiza o preço de um ativo.
   *
   * @param symbol - Símbolo do ativo
   * @param price - Novo preço
   */
  updatePrice(symbol: string, price: number): void {
    this.prices.set(symbol, price);
  }

  /**
   * Retorna um ETF pelo ID.
   */
  getETF(etfId: string): RelativisticETF | undefined {
    return this.etfs.get(etfId);
  }

  /**
   * Retorna todos os ETFs registrados.
   */
  getAllETFs(): RelativisticETF[] {
    return Array.from(this.etfs.values());
  }
}

export const relativisticETFManager = RelativisticETFManager.getInstance();
