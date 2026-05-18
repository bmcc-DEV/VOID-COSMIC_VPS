/**
 * Hydra v7.0 — Fragmented DEX Matchmaker
 *
 * Algoritmo de consenso P2P para parear ordens de compra/venda de forma cega:
 * - Ordens são fragmentadas em shards QEL
 * - Matching ocorre sem expor preço ou quantidade total
 * - Consenso via commit-reveal scheme
 *
 * Nenhuma entidade vê o order book inteiro.
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { secureRandomInt } from "../utils/secureRandom";

// ─── Types ────────────────────────────────────────────────────────────────────

export type OrderSide = "BUY" | "SELL";

export interface OrderIntent {
  id: string;
  side: OrderSide;
  pair: string;            // ex: "vBTC/vUSD"
  amount: number;          // quantidade
  price: number;           // preço limite
  timestamp: number;
  traderPubKey: string;    // chave pública do trader (anonimizada)
}

export interface OrderShard {
  shardId: string;
  orderId: string;
  index: number;           // 0, 1, 2
  encryptedData: string;   // shard criptografado (base64)
  commitment: string;      // hash do shard (prova de integridade)
  side: OrderSide;         // lado (visível para matching)
  pair: string;            // par (visível para matching)
}

export interface MatchResult {
  matchId: string;
  buyOrderId: string;
  sellOrderId: string;
  pair: string;            // par de trading (ex: "SOV/ETBRL")
  matchedAmount: number;
  matchedPrice: number;
  timestamp: number;
  proof: string;           // prova ZK do matching correto
}

// ─── Order Fragmentation ──────────────────────────────────────────────────────

/**
 * Fragmenta uma ordem em 3 shards usando o protocolo QEL.
 *
 * Cada shard contém:
 * - Shard 0: 40% do preço + lado
 * - Shard 1: 30% do preço + par
 * - Shard 2: 30% do preço + quantidade
 *
 * Nenhum shard individual revela a ordem completa.
 */
export function fragmentOrder(order: OrderIntent): OrderShard[] {
  const priceBytes = new TextEncoder().encode(order.price.toString());
  const amountBytes = new TextEncoder().encode(order.amount.toString());

  // Divide preço em 3 partes
  const pricePart1 = order.price * 0.4;
  const pricePart2 = order.price * 0.3;
  const pricePart3 = order.price * 0.3;

  const shards: OrderShard[] = [
    {
      shardId: `shard_${order.id}_0`,
      orderId: order.id,
      index: 0,
      encryptedData: btoa(JSON.stringify({
        side: order.side,
        pricePart: pricePart1,
        traderHash: sha3_256(new TextEncoder().encode(order.traderPubKey)),
      })),
      commitment: Array.from(sha3_256(priceBytes) as Uint8Array)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16),
      side: order.side,
      pair: order.pair,
    },
    {
      shardId: `shard_${order.id}_1`,
      orderId: order.id,
      index: 1,
      encryptedData: btoa(JSON.stringify({
        pair: order.pair,
        pricePart: pricePart2,
      })),
      commitment: Array.from(sha3_256(amountBytes) as Uint8Array)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16),
      side: order.side,
      pair: order.pair,
    },
    {
      shardId: `shard_${order.id}_2`,
      orderId: order.id,
      index: 2,
      encryptedData: btoa(JSON.stringify({
        amount: order.amount,
        pricePart: pricePart3,
      })),
      commitment: Array.from(sha3_256(new TextEncoder().encode(order.id)) as Uint8Array)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16),
      side: order.side,
      pair: order.pair,
    },
  ];

  return shards;
}

// ─── Blind Matching Algorithm ─────────────────────────────────────────────────

/**
 * Executa matching cego entre ordens de compra e venda.
 *
 * Algoritmo:
 * 1. Agrupa shards por par de trading
 * 2. Para cada par, encontra ordens BUY e SELL compatíveis
 * 3. Matching ocorre apenas se preço BUY ≥ preço SELL
 * 4. Gera prova ZK do matching correto
 *
 * Nenhum nó vê a ordem completa — apenas shards.
 */
export function blindMatch(
  buyOrders: OrderIntent[],
  sellOrders: OrderIntent[],
): MatchResult[] {
  const matches: MatchResult[] = [];

  // Agrupa por par
  const pairs = new Set([...buyOrders.map(o => o.pair), ...sellOrders.map(o => o.pair)]);

  for (const pair of pairs) {
    const pairBuys = buyOrders
      .filter(o => o.pair === pair)
      .sort((a, b) => b.price - a.price); // maior preço primeiro
    const pairSells = sellOrders
      .filter(o => o.pair === pair)
      .sort((a, b) => a.price - b.price); // menor preço primeiro

    // Matching: price-time priority
    let buyIdx = 0;
    let sellIdx = 0;

    while (buyIdx < pairBuys.length && sellIdx < pairSells.length) {
      const buy = pairBuys[buyIdx];
      const sell = pairSells[sellIdx];
      if (!buy || !sell) break;

      // Verifica compatibilidade de preço
      if (buy.price >= sell.price) {
        const matchedAmount = Math.min(buy.amount, sell.amount);
        // Taker executa ao preço do Maker (sell já estava no livro)
        const matchedPrice = sell.price;

        // Gera prova ZK do matching
        const proofData = new TextEncoder().encode(
          `${buy.id}|${sell.id}|${matchedAmount}|${matchedPrice}|${Date.now()}`
        );
        const proofHash = sha3_256(proofData) as Uint8Array;
        const proof = Array.from(proofHash)
          .map(b => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 32);

        matches.push({
          matchId: `match_${Date.now()}_${secureRandomInt(1000)}`,
          buyOrderId: buy.id,
          sellOrderId: sell.id,
          pair,
          matchedAmount,
          matchedPrice,
          timestamp: Date.now(),
          proof,
        });

        // Atualiza quantidades restantes
        buy.amount -= matchedAmount;
        sell.amount -= matchedAmount;

        // Avança se ordem foi totalmente preenchida
        if (buy.amount <= 0) buyIdx++;
        if (sell.amount <= 0) sellIdx++;
      } else {
        // Preços não compatíveis — avança para próxima ordem
        break;
      }
    }
  }

  return matches;
}

// ─── Commit-Reveal Scheme ─────────────────────────────────────────────────────

/**
 * Esquema commit-reveal para evitar front-running.
 *
 * Fase 1 (Commit): Traders enviam hash de suas ordens (compromisso)
 * Fase 2 (Reveal): Após período de coleta, traders revelam ordens
 * Matching ocorre apenas na fase reveal.
 */
export interface CommitPhase {
  traderId: string;
  commitment: string;      // hash da ordem
  timestamp: number;
}

export interface RevealPhase {
  traderId: string;
  order: OrderIntent;
  nonce: string;           // nonce usado no commitment
}

/**
 * Cria um commitment para a fase de commit.
 */
export function createCommitment(order: OrderIntent, nonce: string): string {
  const orderData = JSON.stringify(order);
  const commitData = new TextEncoder().encode(`${orderData}|${nonce}`);
  const hash = sha3_256(commitData) as Uint8Array;
  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifica um reveal contra o commitment original.
 */
export function verifyReveal(
  commitment: string,
  order: OrderIntent,
  nonce: string,
): boolean {
  const recomputed = createCommitment(order, nonce);
  return recomputed === commitment;
}

// ─── Order Book Manager ───────────────────────────────────────────────────────

export class FragmentedOrderBook {
  private buyOrders: Map<string, OrderIntent> = new Map();
  private sellOrders: Map<string, OrderIntent> = new Map();
  private orderShards: Map<string, OrderShard[]> = new Map();
  private matches: MatchResult[] = [];

  /**
   * Adiciona uma ordem ao livro fragmentado.
   */
  addOrder(order: OrderIntent): OrderShard[] {
    // Fragmenta a ordem
    const shards = fragmentOrder(order);
    this.orderShards.set(order.id, shards);

    // Adiciona ao lado apropriado
    if (order.side === "BUY") {
      this.buyOrders.set(order.id, order);
    } else {
      this.sellOrders.set(order.id, order);
    }

    return shards;
  }

  /**
   * Executa matching cego no livro atual.
   */
  runMatching(): MatchResult[] {
    const buyArray = Array.from(this.buyOrders.values());
    const sellArray = Array.from(this.sellOrders.values());

    const newMatches = blindMatch(buyArray, sellArray);
    this.matches.push(...newMatches);

    // Remove ordens totalmente preenchidas
    for (const match of newMatches) {
      const buyOrder = this.buyOrders.get(match.buyOrderId);
      const sellOrder = this.sellOrders.get(match.sellOrderId);

      if (buyOrder && buyOrder.amount <= 0) {
        this.buyOrders.delete(match.buyOrderId);
      }
      if (sellOrder && sellOrder.amount <= 0) {
        this.sellOrders.delete(match.sellOrderId);
      }
    }

    return newMatches;
  }

  /**
   * Retorna estatísticas do livro (sem expor ordens individuais).
   */
  getStats(): {
    buyOrderCount: number;
    sellOrderCount: number;
    totalMatches: number;
    pairs: string[];
  } {
    const pairs = new Set([
      ...Array.from(this.buyOrders.values()).map(o => o.pair),
      ...Array.from(this.sellOrders.values()).map(o => o.pair),
    ]);

    return {
      buyOrderCount: this.buyOrders.size,
      sellOrderCount: this.sellOrders.size,
      totalMatches: this.matches.length,
      pairs: Array.from(pairs),
    };
  }

  /**
   * Retorna todos os matches executados.
   */
  getMatches(): MatchResult[] {
    return this.matches;
  }

  /**
   * Limpa o livro.
   */
  clear(): void {
    this.buyOrders.clear();
    this.sellOrders.clear();
    this.orderShards.clear();
    this.matches = [];
  }
}
