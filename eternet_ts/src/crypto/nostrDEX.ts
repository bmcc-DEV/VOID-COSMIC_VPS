/**
 * ETΞRNET — DEX via NOSTR (Bolsa Descentralizada)
 *
 * Order book distribuído via eventos NOSTR.
 * Ordens são eventos assinados; matching ocorre localmente;
 * liquidação usa UTXOs cegos (Pedersen commitments).
 *
 * Kind 31215: Ordem (buy/sell)
 * Kind 31216: Trade (match confirmado)
 *
 * Sem custódia, sem intermediário, sem blockchain própria.
 */
import { sha3_256 } from "@noble/hashes/sha3.js";
import { secureRandomId } from "../utils/secureRandom";

export const ORDER_KIND = 31215;
export const TRADE_KIND = 31216;

export type OrderSide = "buy" | "sell";
export type OrderStatus = "open" | "matched" | "cancelled" | "settled";

export interface DEXOrder {
  id: string;
  side: OrderSide;
  pair: string;
  amount: number;
  price: number;
  makerPk: string;
  status: OrderStatus;
  createdAt: number;
  utxoCommitment: string;
  expiresAt: number;
}

export interface DEXTrade {
  id: string;
  buyOrderId: string;
  sellOrderId: string;
  pair: string;
  amount: number;
  price: number;
  buyerPk: string;
  sellerPk: string;
  hashLock: string;
  createdAt: number;
}

export interface OrderBookEntry {
  price: number;
  amount: number;
  orderId: string;
  side: OrderSide;
}

export interface OrderBookSnapshot {
  pair: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  lastPrice: number;
  spread: number;
  timestamp: number;
}

/**
 * Motor de correspondência local.
 * Mantém um livro de ofertas em memória e casa ordens compatíveis.
 */
class NostrDEX {
  private static instance: NostrDEX;
  private orders: Map<string, DEXOrder> = new Map();
  private trades: Map<string, DEXTrade> = new Map();
  private pairs: Set<string> = new Set(["ETR/BRL", "ETR/XMR", "ETR/SOV"]);

  public static getInstance(): NostrDEX {
    if (!NostrDEX.instance) NostrDEX.instance = new NostrDEX();
    return NostrDEX.instance;
  }

  private constructor() {}

  /**
   * Cria uma nova ordem (a ser transmitida como evento NOSTR).
   */
  createOrder(
    side: OrderSide,
    pair: string,
    amount: number,
    price: number,
    makerPk: string,
    utxoCommitment: string,
    ttlMs: number = 3600000
  ): DEXOrder {
    const id = `ord_${secureRandomId(8)}`;
    const now = Date.now();

    const order: DEXOrder = {
      id,
      side,
      pair: pair.toUpperCase(),
      amount,
      price,
      makerPk,
      status: "open",
      createdAt: now,
      utxoCommitment,
      expiresAt: now + ttlMs,
    };

    this.orders.set(id, order);
    this.pairs.add(order.pair);

    console.log(
      `[DEX] Ordem criada: ${side.toUpperCase()} ${amount} ${pair} @ ${price}`
    );

    return order;
  }

  /**
   * Ingere uma ordem recebida via NOSTR (já assinada por remoto).
   */
  ingestRemoteOrder(order: DEXOrder): void {
    if (this.orders.has(order.id)) return;
    if (order.expiresAt < Date.now()) return;
    this.orders.set(order.id, order);
  }

  /**
   * Casa ordens — roda localmente em cada nó.
   * Retorna os trades resultantes.
   */
  matchOrders(pair: string): DEXTrade[] {
    const trades: DEXTrade[] = [];
    const pairOrders = Array.from(this.orders.values()).filter(
      (o) =>
        o.pair === pair.toUpperCase() &&
        o.status === "open" &&
        o.expiresAt > Date.now()
    );

    const buys = pairOrders
      .filter((o) => o.side === "buy")
      .sort((a, b) => b.price - a.price);

    const sells = pairOrders
      .filter((o) => o.side === "sell")
      .sort((a, b) => a.price - b.price);

    for (const buy of buys) {
      for (const sell of sells) {
        if (buy.status !== "open" || sell.status !== "open") continue;
        if (buy.price < sell.price) continue;
        if (buy.makerPk === sell.makerPk) continue;

        const matchAmount = Math.min(buy.amount, sell.amount);
        // Taker executa ao preço do Maker (ordem que já estava no livro)
        // Sell já estava no livro → Maker; Buy é o Taker que cruza
        const matchPrice = sell.price;

        const hashLockBytes = sha3_256(
          new TextEncoder().encode(
            `${buy.id}:${sell.id}:${secureRandomId(16)}`
          )
        );
        const hashLock = Array.from(hashLockBytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        const trade: DEXTrade = {
          id: `trd_${secureRandomId(8)}`,
          buyOrderId: buy.id,
          sellOrderId: sell.id,
          pair,
          amount: matchAmount,
          price: matchPrice,
          buyerPk: buy.makerPk,
          sellerPk: sell.makerPk,
          hashLock,
          createdAt: Date.now(),
        };

        buy.amount -= matchAmount;
        sell.amount -= matchAmount;
        if (buy.amount <= 0) buy.status = "matched";
        if (sell.amount <= 0) sell.status = "matched";

        this.trades.set(trade.id, trade);
        trades.push(trade);

        console.log(
          `[DEX] Trade: ${matchAmount} ${pair} @ ${matchPrice} (${trade.id})`
        );
      }
    }

    return trades;
  }

  /**
   * Cancela uma ordem (apenas o dono).
   */
  cancelOrder(orderId: string, makerPk: string): boolean {
    const order = this.orders.get(orderId);
    if (!order || order.makerPk !== makerPk) return false;
    order.status = "cancelled";
    return true;
  }

  /**
   * Retorna o snapshot do livro de ofertas para um par.
   */
  getOrderBook(pair: string): OrderBookSnapshot {
    const pairOrders = Array.from(this.orders.values()).filter(
      (o) =>
        o.pair === pair.toUpperCase() &&
        o.status === "open" &&
        o.expiresAt > Date.now()
    );

    const bids: OrderBookEntry[] = pairOrders
      .filter((o) => o.side === "buy")
      .map((o) => ({
        price: o.price,
        amount: o.amount,
        orderId: o.id,
        side: o.side,
      }))
      .sort((a, b) => b.price - a.price);

    const asks: OrderBookEntry[] = pairOrders
      .filter((o) => o.side === "sell")
      .map((o) => ({
        price: o.price,
        amount: o.amount,
        orderId: o.id,
        side: o.side,
      }))
      .sort((a, b) => a.price - b.price);

    const lastTrade = Array.from(this.trades.values())
      .filter((t) => t.pair === pair.toUpperCase())
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    const lastPrice = lastTrade?.price ?? 0;
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

    return { pair, bids, asks, lastPrice, spread, timestamp: Date.now() };
  }

  /**
   * Cria evento NOSTR a partir de uma ordem.
   */
  createOrderEvent(order: DEXOrder) {
    return {
      kind: ORDER_KIND,
      tags: [
        ["t", "eternet_order"],
        ["pair", order.pair],
        ["side", order.side],
        ["price", order.price.toString()],
        ["amount", order.amount.toString()],
        ["order_id", order.id],
      ],
      content: JSON.stringify(order),
      created_at: Math.floor(order.createdAt / 1000),
    };
  }

  /**
   * Cria evento NOSTR a partir de um trade.
   */
  createTradeEvent(trade: DEXTrade) {
    return {
      kind: TRADE_KIND,
      tags: [
        ["t", "eternet_trade"],
        ["pair", trade.pair],
        ["price", trade.price.toString()],
        ["amount", trade.amount.toString()],
        ["buy_order", trade.buyOrderId],
        ["sell_order", trade.sellOrderId],
      ],
      content: JSON.stringify(trade),
      created_at: Math.floor(trade.createdAt / 1000),
    };
  }

  /**
   * Retorna ordens abertas.
   */
  getOpenOrders(): DEXOrder[] {
    return Array.from(this.orders.values()).filter(
      (o) => o.status === "open" && o.expiresAt > Date.now()
    );
  }

  /**
   * Retorna trades recentes.
   */
  getTrades(limit: number = 50): DEXTrade[] {
    return Array.from(this.trades.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * Retorna pares disponíveis.
   */
  getPairs(): string[] {
    return Array.from(this.pairs);
  }
}

/** Instância singleton do DEX. */
export const nostrDEX = NostrDEX.getInstance();
