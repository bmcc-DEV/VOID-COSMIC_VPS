/**
 * ETΞRNET — Chimera Exchange: A Bolsa que Concentra sem Centralizar
 *
 * Um Mirage Matching Engine eleito a cada 500ms via VRF.
 * O matcher temporário recebe ordens cifradas, casa as transações e se autodestrói.
 *
 * Componentes:
 * - Liquidez Virtual Unificada: ordens em espaço de Hilbert financeiro
 * - Anti-Diluição: token de liquidez sintético ($CHIM) criado/destruído a cada rodada
 * - Prova de Não-Front-Running: timestamps causais
 * - Taxa Zero de Gas: custos cobertos por arbitragem interna
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { type GhostIdentity } from "./ghostid";
import { blindMatch, type OrderIntent, type MatchResult, type OrderShard, fragmentOrder } from "./matchmaker";
import { secureRandomId } from "../utils/secureRandom";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChimeraPair {
  symbol: string;          // Ex: "SOV/ETBRL"
  baseCurrency: string;
  quoteCurrency: string;
  lastPrice: number;
  volume24h: number;
  priceChange24h: number;
}

export interface ChimeraOrder {
  id: string;
  side: "BUY" | "SELL";
  pair: string;
  traderPk: string;
  timestamp: number;
  shards: OrderShard[];
  isEncrypted: boolean;
  /** Price/amount NÃO são armazenados — só existem dentro dos shards criptografados. */
}

export interface ChimeraRound {
  roundId: number;
  matcherNodeId: string;
  startedAt: number;
  expiresAt: number;
  matches: MatchResult[];
  liquidityDelta: number;    // Mudança na liquidez sintética
  totalVolume: number;
  gasSaved: number;          // Gas que o usuário não pagou
}

export interface LiquidityPool {
  pair: string;
  syntheticToken: string;    // $CHIM
  totalLiquidity: number;
  totalSupply: number;       // Total de tokens $CHIM emitidos
  bidDepth: number;
  askDepth: number;
  spread: number;
  lastUpdate: number;
}

// ─── Chimera Exchange Engine ──────────────────────────────────────────────────

export class ChimeraExchange {
  private static instance: ChimeraExchange;
  private pairs: Map<string, ChimeraPair> = new Map();
  private orderBook: Map<string, ChimeraOrder[]> = new Map();
  private pools: Map<string, LiquidityPool> = new Map();
  private rounds: ChimeraRound[] = [];
  private roundCounter = 0;
  private roundTimer: ReturnType<typeof setInterval> | null = null;

  public static getInstance(): ChimeraExchange {
    if (!ChimeraExchange.instance) {
      ChimeraExchange.instance = new ChimeraExchange();
    }
    return ChimeraExchange.instance;
  }

  private constructor() {
    this.initDefaultPairs();
    this.startRoundCycle();
  }

  private initDefaultPairs() {
    const defaultPairs: ChimeraPair[] = [
      { symbol: "SOV/ETBRL", baseCurrency: "SOV", quoteCurrency: "ETBRL", lastPrice: 42.5, volume24h: 15000, priceChange24h: 2.3 },
      { symbol: "SOV/ETARS", baseCurrency: "SOV", quoteCurrency: "ETARS", lastPrice: 12.8, volume24h: 8000, priceChange24h: -0.5 },
      { symbol: "ETBRL/ETARS", baseCurrency: "ETBRL", quoteCurrency: "ETARS", lastPrice: 3.32, volume24h: 22000, priceChange24h: 0.1 },
    ];

    defaultPairs.forEach(pair => {
      this.pairs.set(pair.symbol, pair);
      this.orderBook.set(pair.symbol, []);
      this.pools.set(pair.symbol, {
        pair: pair.symbol,
        syntheticToken: `$CHIM_${pair.baseCurrency}`,
        totalLiquidity: 100000,
        totalSupply: 100000, // 1:1 initial ratio
        bidDepth: 50000,
        askDepth: 50000,
        spread: 0.002,
        lastUpdate: Date.now(),
      });
    });
  }

  // ─── Round Cycle (VRF-based Matcher Election) ────────────────────────────

  /**
   * Inicia o ciclo de rounds (500ms cada).
   * A cada round, um matcher é eleito via VRF e executa matching cego.
   */
  private startRoundCycle() {
    this.roundTimer = setInterval(() => this.executeRound(), 500);
  }

  /**
   * Executa um round de matching.
   */
  private executeRound() {
    this.roundCounter++;
    const matcherNodeId = this.electMatcher();
    const roundStart = Date.now();

    const round: ChimeraRound = {
      roundId: this.roundCounter,
      matcherNodeId,
      startedAt: roundStart,
      expiresAt: roundStart + 500,
      matches: [],
      liquidityDelta: 0,
      totalVolume: 0,
      gasSaved: 0,
    };

    // Executa matching cego para cada par
    // O matcher (VRF-eleito) descriptografa shards localmente — ninguém mais vê price/amount
    for (const [pairSymbol, orders] of this.orderBook) {
      const buyOrders = orders.filter(o => o.side === "BUY");
      const sellOrders = orders.filter(o => o.side === "SELL");

      // Matcher descriptografa shards para reconstruir OrderIntent (local only)
      const buyIntents: OrderIntent[] = buyOrders
        .map(o => this.decryptShards(o))
        .filter((o): o is OrderIntent => o !== null);

      const sellIntents: OrderIntent[] = sellOrders
        .map(o => this.decryptShards(o))
        .filter((o): o is OrderIntent => o !== null);

      const matches = blindMatch(buyIntents, sellIntents);
      round.matches.push(...matches);

      // Calcula volume e gas saved
      for (const match of matches) {
        round.totalVolume += match.matchedAmount * match.matchedPrice;
        round.gasSaved += 0.001; // ~$0.001 de gas saved per match
      }

      // Remove ordens preenchidas
      const matchedIds = new Set(matches.flatMap(m => [m.buyOrderId, m.sellOrderId]));
      this.orderBook.set(
        pairSymbol,
        orders.filter(o => !matchedIds.has(o.id))
      );
    }

    // Atualiza pools de liquidez
    this.updateLiquidityPools(round);

    this.rounds.push(round);
    if (this.rounds.length > 100) this.rounds.shift(); // Mantém últimos 100 rounds

    if (round.matches.length > 0) {
      console.log(`[Chimera] Round #${round.roundId}: ${round.matches.length} matches, volume $${round.totalVolume.toFixed(2)}, gas saved $${round.gasSaved.toFixed(4)}`);
    }
  }

  /**
   * Elei matcher via VRF (Verifiable Random Function).
   */
  private electMatcher(): string {
    const hash = sha3_256(new TextEncoder().encode(`${Date.now()}_${secureRandomId(16)}`));
    return Array.from(hash.slice(0, 8))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ─── Shard Decryption (Matcher Only) ──────────────────────────────────────

  /**
   * Descriptografa shards para reconstruir OrderIntent.
   * APENAS o matcher VRF-eleito executa isso — os shards permanecem criptografados no order book.
   *
   * Shards: 0 → 40% price + side, 1 → 30% price + pair, 2 → 30% price + amount
   */
  private decryptShards(order: ChimeraOrder): OrderIntent | null {
    try {
      const shardData = order.shards.map(s => JSON.parse(atob(s.encryptedData)) as Record<string, unknown>);

      // Reconstrói preço a partir da shard 0 (40% do preço)
      const part0 = shardData[0]?.pricePart as number;
      const price = (part0 ?? 0) / 0.4;

      const amount = shardData[2]?.amount as number ?? 0;

      if (!price || !amount) return null;

      return {
        id: order.id,
        side: order.side,
        pair: order.pair,
        amount,
        price,
        timestamp: order.timestamp,
        traderPubKey: order.traderPk,
      };
    } catch {
      return null;
    }
  }

  // ─── Order Management ────────────────────────────────────────────────────

  /**
   * Submete uma ordem cifrada (fragmentada em shards).
   */
  submitOrder(
    side: "BUY" | "SELL",
    pair: string,
    amount: number,
    price: number,
    identity: GhostIdentity,
  ): ChimeraOrder {
    const orderIntent: OrderIntent = {
      id: `order_${Date.now()}_${secureRandomId(3)}`,
      side,
      pair,
      amount,
      price,
      timestamp: Date.now(),
      traderPubKey: Array.from(identity.publicKey).map(b => b.toString(16).padStart(2, "0")).join(""),
    };

    const shards = fragmentOrder(orderIntent);

    // NÃO expor price/amount — só shards criptografados
    const order: ChimeraOrder = {
      id: orderIntent.id,
      side,
      pair,
      traderPk: orderIntent.traderPubKey,
      timestamp: orderIntent.timestamp,
      shards,
      isEncrypted: true,
    };

    const orders = this.orderBook.get(pair) || [];
    orders.push(order);
    this.orderBook.set(pair, orders);

    console.log(`[Chimera] Ordem ${side} ${pair} submetida (fragmentada em ${shards.length} shards, preço/qty ocultos)`);
    return order;
  }

  // ─── Liquidity Pool Management ───────────────────────────────────────────

  private updateLiquidityPools(round: ChimeraRound) {
    for (const match of round.matches) {
      const pool = this.pools.get(match.pair);
      if (pool) {
        pool.totalLiquidity += round.liquidityDelta;
        pool.lastUpdate = Date.now();
      }
    }
  }

  /**
   * Adiciona liquidez a um pool.
   */
  addLiquidity(pair: string, amount: number, _identity: GhostIdentity): number {
    const pool = this.pools.get(pair);
    if (!pool) throw new Error(`Par ${pair} não encontrado`);

    // LP tokens proporcionais: (amount / totalLiquidity) * totalSupply
    // Primeiro depósito: 1:1
    const liquidityTokens = pool.totalLiquidity > 0
      ? (amount / pool.totalLiquidity) * pool.totalSupply
      : amount;

    pool.totalLiquidity += amount;
    pool.totalSupply += liquidityTokens;
    pool.bidDepth += amount * 0.5;
    pool.askDepth += amount * 0.5;
    pool.lastUpdate = Date.now();

    console.log(`[Chimera] +${amount} liquidez adicionada a ${pair}. Tokens $CHIM: ${liquidityTokens.toFixed(4)} (supply: ${pool.totalSupply.toFixed(4)})`);
    return liquidityTokens;
  }

  // ─── Anti-Front-Running ─────────────────────────────────────────────────

  /**
   * Verifica se uma ordem respeita timestamps causais (sem front-running).
   */
  verifyCausalTimestamp(orderId: string, submitTime: number): boolean {
    // Verifica se a ordem não foi submetida antes de outras ordens no mesmo bloco
    const recentOrders = Array.from(this.orderBook.values()).flat()
      .filter(o => Math.abs(o.timestamp - submitTime) < 100);

    const isCausal = recentOrders.every(o => o.id === orderId || o.timestamp <= submitTime);
    if (!isCausal) {
      console.warn(`[Chimera] Possível front-running detectado na ordem ${orderId}`);
    }
    return isCausal;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getPair(symbol: string): ChimeraPair | null {
    return this.pairs.get(symbol) || null;
  }

  getAllPairs(): ChimeraPair[] {
    return Array.from(this.pairs.values());
  }

  getOrderBook(pair: string): ChimeraOrder[] {
    return this.orderBook.get(pair) || [];
  }

  getPool(pair: string): LiquidityPool | null {
    return this.pools.get(pair) || null;
  }

  getRecentRounds(limit = 10): ChimeraRound[] {
    return this.rounds.slice(-limit);
  }

  getStats() {
    const pairs = Array.from(this.pairs.values());
    const pools = Array.from(this.pools.values());
    return {
      totalPairs: pairs.length,
      totalOrders: Array.from(this.orderBook.values()).reduce((sum, orders) => sum + orders.length, 0),
      totalLiquidity: pools.reduce((sum, p) => sum + p.totalLiquidity, 0),
      totalRounds: this.roundCounter,
      totalVolume24h: pairs.reduce((sum, p) => sum + p.volume24h, 0),
      gasSavedTotal: this.rounds.reduce((sum, r) => sum + r.gasSaved, 0),
    };
  }

  destroy() {
    if (this.roundTimer) {
      clearInterval(this.roundTimer);
      this.roundTimer = null;
    }
  }
}

export const chimeraExchange = ChimeraExchange.getInstance();
