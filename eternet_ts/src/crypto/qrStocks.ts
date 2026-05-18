/**
 * ETΞRNET — Ações Quântico-Relativísticas (Capítulo 11)
 *
 * Implementa ações em superposição quântica onde preço e volume
 * coexistem como amplitudes até uma medição colapsar o estado.
 *
 * Conceitos:
 * - Superposição coerente: cada ação mantém |α|² para cada preço/volume
 * - Ordem causal: ordem de execução não é temporal mas causal (LSC)
 * - Colapso por medição: projetar superposição em preço/volume definidos
 * - Valor esperado: ⟨Ψ|H|Ψ⟩ = Σ |α|²·E_i
 *
 * Referência: "O Livro do ETRNET", Cap. 11
 */

import { secureRandomId, secureRandom } from "../utils/secureRandom";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Ordem causal no livro de ofertas */
export interface CausalOrder {
  /** Identificador único da ordem */
  id: string;
  /** Lado da operação */
  side: "BUY" | "SELL";
  /** Amplitude quântica da ordem (|α|² = probabilidade) */
  amplitude: number;
  /** Preço da ordem */
  price: number;
  /** Volume da ordem */
  volume: number;
  /** Timestamp de criação */
  timestamp: number;
}

/** Livro de ofertas causal — ordenado por causalidade, não por tempo */
export interface CausalOrderBook {
  /** Ordens de compra */
  bids: CausalOrder[];
  /** Ordens de venda */
  asks: CausalOrder[];
}

/** Ação quântico-relativística */
export interface QRStock {
  /** Símbolo da ação (ex: "ETBTC") */
  symbol: string;
  /** Amplitudes de preço: Map<preço, amplitude> */
  priceAmplitudes: Map<number, number>;
  /** Amplitudes de volume: Map<volume, amplitude> */
  volumeAmplitudes: Map<number, number>;
  /** Superposição de propriedade: Map<id_detentor, fração> */
  ownershipSuperposition: Map<string, number>;
  /** Livro de ofertas causal */
  causalOrderBook: CausalOrderBook;
}

/** Resultado de uma medição quântica sobre uma ação */
export interface MeasurementResult {
  /** Preço colapsado */
  collapsedPrice: number;
  /** Volume colapsado */
  collapsedVolume: number;
  /** Probabilidade do resultado */
  probability: number;
  /** Momento da medição */
  measuredAt: number;
}

// ─── Funções de Superposição ──────────────────────────────────────────────────

/**
 * Cria uma ação em superposição coerente.
 *
 * Inicializa com distribuição uniforme de amplitudes sobre
 * faixas de preço e volume, representando incerteza máxima.
 *
 * @param symbol - Símbolo da ação
 * @param initialPrice - Preço médio inicial (centro da superposição)
 * @returns Ação em estado de superposição
 */
export function createStock(symbol: string, initialPrice: number): QRStock {
  const priceRange = 5; // número de amplitudes de preço
  const volumeRange = 5; // número amplitudes de volume

  // Amplitudes uniformes: cada estado tem mesma probabilidade
  const uniformAmp = 1 / Math.sqrt(priceRange + volumeRange);

  const priceAmplitudes = new Map<number, number>();
  for (let i = -Math.floor(priceRange / 2); i <= Math.floor(priceRange / 2); i++) {
    const price = Math.round(initialPrice * (1 + i * 0.1) * 100) / 100;
    priceAmplitudes.set(price, uniformAmp);
  }

  const volumeAmplitudes = new Map<number, number>();
  const baseVolume = Math.max(1, Math.round(initialPrice * 10));
  for (let i = 0; i < volumeRange; i++) {
    const vol = baseVolume * (i + 1);
    volumeAmplitudes.set(vol, uniformAmp);
  }

  return {
    symbol,
    priceAmplitudes,
    volumeAmplitudes,
    ownershipSuperposition: new Map(),
    causalOrderBook: { bids: [], asks: [] },
  };
}

/**
 * Calcula o valor esperado da ação: ⟨Ψ|H|Ψ⟩ = Σ |α|²·E_i
 *
 * O hamiltoniano H atribui energia E_i a cada estado.
 * Aqui, o "preço" é a energia e a "amplitude" é α.
 *
 * @param stock - Ação em superposição
 * @returns Valor esperado (preço médio ponderado pelas amplitudes)
 */
export function superpositionValue(stock: QRStock): number {
  let expectedValue = 0;

  // Σ |α_price|² · preço
  for (const [price, amplitude] of stock.priceAmplitudes) {
    expectedValue += amplitude * amplitude * price;
  }

  return Math.round(expectedValue * 10000) / 10000;
}

/**
 * Colapsa a superposição em um preço e volume definidos.
 *
 * A medição projeta o estado quântico: escolhe um preço
 * com probabilidade |α|² e um volume correspondente.
 *
 * @param stock - Ação em superposição
 * @returns Resultado da medição com preço/volume colapsados
 */
export function collapseMeasurement(stock: QRStock): MeasurementResult {
  // Sortear preço baseado nas probabilidades |α|²
  const priceEntries = Array.from(stock.priceAmplitudes.entries());
  const priceProbs = priceEntries.map(([, amp]) => amp * amp);
  const totalPriceProb = priceProbs.reduce((a, b) => a + b, 0);

  let rand = secureRandom() * totalPriceProb;
  let collapsedPrice = priceEntries[0][0];
  let priceProbability = 0;

  for (let i = 0; i < priceEntries.length; i++) {
    rand -= priceProbs[i];
    if (rand <= 0) {
      collapsedPrice = priceEntries[i][0];
      priceProbability = priceProbs[i] / totalPriceProb;
      break;
    }
  }

  // Sortear volume baseado nas probabilidades |α|²
  const volumeEntries = Array.from(stock.volumeAmplitudes.entries());
  const volumeProbs = volumeEntries.map(([, amp]) => amp * amp);
  const totalVolumeProb = volumeProbs.reduce((a, b) => a + b, 0);

  rand = secureRandom() * totalVolumeProb;
  let collapsedVolume = volumeEntries[0][0];

  for (let i = 0; i < volumeEntries.length; i++) {
    rand -= volumeProbs[i];
    if (rand <= 0) {
      collapsedVolume = volumeEntries[i][0];
      break;
    }
  }

  // Após medição, a superposição colapsa: só resta o estado medido
  stock.priceAmplitudes = new Map([[collapsedPrice, 1.0]]);
  stock.volumeAmplitudes = new Map([[collapsedVolume, 1.0]]);

  return {
    collapsedPrice,
    collapsedVolume,
    probability: priceProbability,
    measuredAt: Date.now(),
  };
}

// ─── Gerenciador de Mercado Quântico ─────────────────────────────────────────

/**
 * Gerenciador de mercado quântico-relativístico (singleton).
 *
 * Mantém registro de todas as ações em superposição e
 * gerencia ordens causais no livro de ofertas.
 */
export class QRMarket {
  private static instance: QRMarket;
  private stocks: Map<string, QRStock> = new Map();
  private causalHistory: Array<{
    symbol: string;
    action: string;
    timestamp: number;
    details: string;
  }> = [];

  public static getInstance(): QRMarket {
    if (!QRMarket.instance) {
      QRMarket.instance = new QRMarket();
    }
    return QRMarket.instance;
  }

  private constructor() {}

  /**
   * Registra uma nova ação no mercado.
   *
   * @param symbol - Símbolo da ação
   * @param initialPrice - Preço médio inicial
   * @returns A ação criada em superposição
   */
  listStock(symbol: string, initialPrice: number): QRStock {
    if (this.stocks.has(symbol)) {
      throw new Error(`Ação ${symbol} já listada no mercado`);
    }

    const stock = createStock(symbol, initialPrice);
    this.stocks.set(symbol, stock);

    this.causalHistory.push({
      symbol,
      action: "LIST",
      timestamp: Date.now(),
      details: `Ação ${symbol} listada com preço médio ${initialPrice}`,
    });

    console.log(`[QRMarket] Ação listada: ${symbol} (preço médio: ${initialPrice})`);
    return stock;
  }

  /**
   * Submete uma ordem causal ao livro de ofertas.
   *
   * A ordem recebe amplitude quântica baseada na distância
   * do preço em relação ao valor esperado.
   *
   * @param symbol - Símbolo da ação
   * @param side - Lado da operação (BUY/SELL)
   * @param price - Preço proposto
   * @param volume - Volume proposto
   * @returns A ordem criada com amplitude calculada
   */
  submitOrder(
    symbol: string,
    side: "BUY" | "SELL",
    price: number,
    volume: number
  ): CausalOrder {
    const stock = this.stocks.get(symbol);
    if (!stock) throw new Error(`Ação ${symbol} não encontrada`);

    const expectedPrice = superpositionValue(stock);
    // Amplitude decresce com distância do valor esperado
    const distance = Math.abs(price - expectedPrice) / expectedPrice;
    const amplitude = Math.exp(-distance);

    const order: CausalOrder = {
      id: `ord_${Date.now()}_${secureRandomId(4)}`,
      side,
      amplitude,
      price,
      volume,
      timestamp: Date.now(),
    };

    if (side === "BUY") {
      stock.causalOrderBook.bids.push(order);
      // Ordenar por amplitude decrescentes (maior prioridade causal)
      stock.causalOrderBook.bids.sort((a, b) => b.amplitude - a.amplitude);
    } else {
      stock.causalOrderBook.asks.push(order);
      stock.causalOrderBook.asks.sort((a, b) => b.amplitude - a.amplitude);
    }

    this.causalHistory.push({
      symbol,
      action: `ORDER_${side}`,
      timestamp: order.timestamp,
      details: `${side} ${volume} @ ${price} (amplitude: ${amplitude.toFixed(4)})`,
    });

    console.log(
      `[QRMarket] Ordem ${side}: ${symbol} ${volume} @ ${price} (amplitude: ${amplitude.toFixed(4)})`
    );
    return order;
  }

  /**
   * Mede uma ação, colapsando sua superposição.
   *
   * @param symbol - Símbolo da ação a medir
   * @returns Resultado da medição
   */
  measureStock(symbol: string): MeasurementResult {
    const stock = this.stocks.get(symbol);
    if (!stock) throw new Error(`Ação ${symbol} não encontrada`);

    const result = collapseMeasurement(stock);

    this.causalHistory.push({
      symbol,
      action: "MEASURE",
      timestamp: result.measuredAt,
      details: `Colapsado: preço=${result.collapsedPrice}, volume=${result.collapsedVolume}`,
    });

    console.log(
      `[QRMedida] ${symbol}: preço=${result.collapsedPrice}, volume=${result.collapsedVolume}`
    );
    return result;
  }

  /**
   * Retorna o histórico causal de operações sobre uma ação.
   *
   * @param symbol - Símbolo da ação (opcional, retorna todas se omitido)
   * @returns Lista de eventos causais
   */
  getCausalHistory(symbol?: string): Array<{
    symbol: string;
    action: string;
    timestamp: number;
    details: string;
  }> {
    if (symbol) {
      return this.causalHistory.filter((e) => e.symbol === symbol);
    }
    return [...this.causalHistory];
  }

  /**
   * Retorna uma ação pelo símbolo.
   */
  getStock(symbol: string): QRStock | undefined {
    return this.stocks.get(symbol);
  }

  /**
   * Retorna todas as ações listadas.
   */
  getAllStocks(): QRStock[] {
    return Array.from(this.stocks.values());
  }
}

export const qrMarket = QRMarket.getInstance();
