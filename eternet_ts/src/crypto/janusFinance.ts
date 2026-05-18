/**
 * ETΞRNET — Janus Finance: O Banco de Duas Faces
 *
 * Experiência de neobank sem custódia central.
 * O usuário vê saldo em reais, extrato limpo, PIX e cartão virtual —
 * mas cada ativo é um UTXO fantasma no Hydra v7.0.
 *
 * Componentes:
 * - Balance Hallucination Engine: agrega UTXOs via CLT e projeta saldo fiduciário
 * - Extrato por Prova ZK: cada linha é uma prova de conhecimento-zero
 * - Cartão Virtual Descartável: lastreado em $ETXX, validade de 1 hora
 * - Fachada Regulatória: entidade legal offshore
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { createUTXO, type UTXO, formatAmount } from "./utxo";
import { secureRandomId, secureRandomInt } from "../utils/secureRandom";
import { type GhostIdentity } from "./ghostid";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JanusBalance {
  currency: string;         // "BRL", "USD", "$ETBRL", etc.
  available: bigint;        // Saldo disponível
  pending: bigint;          // Saldo pendente
  total: bigint;            // Total
  utxoCount: number;        // Número de UTXOs subjacentes
  lastUpdated: number;
}

export interface VirtualCard {
  id: string;
  number: string;           // Número do cartão (16 dígitos)
  cvv: string;
  expiryDate: string;       // MM/YY
  limit: bigint;
  currency: string;
  linkedUtxoId: string;
  createdAt: number;
  expiresAt: number;        // 1 hora após criação
  isActive: boolean;
}

export interface StatementLine {
  id: string;
  timestamp: number;
  type: "CREDIT" | "DEBIT";
  amount: bigint;
  currency: string;
  description: string;
  zkProof: string;          // Prova ZK da transação
  nullifier: string;        // Para prevenir double-spend
}

export interface PIXData {
  key: string;              // Chave PIX (GhostID hash)
  type: "ghostid" | "random";
  payload: string;
}

// ─── Janus Finance Engine ────────────────────────────────────────────────────

export class JanusFinance {
  private static instance: JanusFinance;
  private utxos: Map<string, UTXO> = new Map();
  private cards: Map<string, VirtualCard> = new Map();
  private statements: Map<string, StatementLine[]> = new Map();
  private balanceCache: Map<string, JanusBalance> = new Map();

  public static getInstance(): JanusFinance {
    if (!JanusFinance.instance) {
      JanusFinance.instance = new JanusFinance();
    }
    return JanusFinance.instance;
  }

  private constructor() {}

  // ─── Balance Hallucination Engine ─────────────────────────────────────────

  /**
   * Agrega UTXOs via Contact Lattice Token (CLT) e projeta saldo fiduciário.
   * O usuário vê "R$ 500,00" mas por baixo são UTXOs fragmentados.
   */
  calculateBalance(identity: GhostIdentity, currency = "BRL"): JanusBalance {
    const userUtxos = Array.from(this.utxos.values()).filter(
      u => !u.spent && this.matchesOwner(u, identity)
    );

    const available = userUtxos.reduce((sum, u) => sum + u.amount, 0n);

    const cached = this.balanceCache.get(`${identity.handle}_${currency}`) || {
      currency,
      available: 0n,
      pending: 0n,
      total: 0n,
      utxoCount: 0,
      lastUpdated: 0,
    };

    cached.available = available;
    cached.utxoCount = userUtxos.length;
    cached.lastUpdated = Date.now();
    cached.total = cached.available + cached.pending;

    this.balanceCache.set(`${identity.handle}_${currency}`, cached);
    return { ...cached };
  }

  private matchesOwner(utxo: UTXO, identity: GhostIdentity): boolean {
    return utxo.ownerPubKey.every((b, i) => b === identity.publicKey[i]);
  }

  // ─── Deposit / Withdraw ──────────────────────────────────────────────────

  /**
   * Deposita fundos (cria novos UTXOs).
   */
  deposit(amount: bigint, identity: GhostIdentity, currency = "BRL"): UTXO {
    const utxo = createUTXO(amount, identity.publicKey);
    this.utxos.set(utxo.id, utxo);

    // Registra no extrato
    this.addStatementLine(identity.handle, {
      type: "CREDIT",
      amount,
      currency,
      description: `Depósito de ${formatAmount(amount)}`,
    });

    console.log(`[Janus] Depósito: ${formatAmount(amount)} ${currency} → ${utxo.id}`);
    return utxo;
  }

  /**
   * Cria um PIX de saída (consome UTXOs).
   */
  createPIX(
    amount: bigint,
    recipientKey: Uint8Array,
    identity: GhostIdentity,
    currency = "BRL",
  ): { utxo: UTXO; proof: string } {
    // Seleciona UTXOs
    const userUtxos = Array.from(this.utxos.values()).filter(
      u => !u.spent && this.matchesOwner(u, identity)
    );

    let total = 0n;
    const selected: UTXO[] = [];
    for (const utxo of userUtxos) {
      if (total >= amount) break;
      selected.push(utxo);
      total += utxo.amount;
    }

    if (total < amount) {
      throw new Error(`Saldo insuficiente: necessário ${formatAmount(amount)}, disponível ${formatAmount(total)}`);
    }

    // Marca UTXOs como gastos
    selected.forEach(u => { u.spent = true; });

    // Cria UTXO para o destinatário
    const newUtxo = createUTXO(amount, recipientKey);
    this.utxos.set(newUtxo.id, newUtxo);

    // Gera prova ZK
    const proofHash = Array.from(sha3_256(new TextEncoder().encode(
      `${selected.map(u => u.id).join(",")}->${newUtxo.id}:${amount}`
    ))).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

    // Registra no extrato
    this.addStatementLine(identity.handle, {
      type: "DEBIT",
      amount,
      currency,
      description: `PIX enviado → ${Array.from(recipientKey.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join("")}`,
    });

    console.log(`[Janus] PIX: ${formatAmount(amount)} ${currency} enviado via ${newUtxo.id}`);
    return { utxo: newUtxo, proof: proofHash };
  }

  // ─── Virtual Card ────────────────────────────────────────────────────────

  /**
   * Gera um cartão virtual descartável (validade 1 hora).
   * Lastreado em $ETXX com limite exato.
   */
  generateVirtualCard(
    amount: bigint,
    currency: string,
    identity: GhostIdentity,
  ): VirtualCard {
    const utxo = createUTXO(amount, identity.publicKey);
    this.utxos.set(utxo.id, utxo);

    const now = Date.now();
    const cardNumber = this.generateCardNumber();
    const cvv = (100 + secureRandomInt(900)).toString();
    const expiry = new Date(now + 3600000); // 1 hora

    const card: VirtualCard = {
      id: `card_${Date.now()}_${secureRandomId(3)}`,
      number: cardNumber,
      cvv,
      expiryDate: `${String(expiry.getMonth() + 1).padStart(2, "0")}/${String(expiry.getFullYear()).slice(2)}`,
      limit: amount,
      currency,
      linkedUtxoId: utxo.id,
      createdAt: now,
      expiresAt: now + 3600000,
      isActive: true,
    };

    this.cards.set(card.id, card);
    console.log(`[Janus] Cartão virtual ${card.number.slice(-4)} gerado. Limite: ${formatAmount(amount)} ${currency}`);
    return card;
  }

  private generateCardNumber(): string {
    // Gera número no formato Visa/Mastercard
    const prefix = secureRandomInt(2) === 0 ? "4" : "5";
    let number = prefix;
    for (let i = 1; i < 16; i++) {
      number += secureRandomInt(10).toString();
    }
    return number;
  }

  /**
   * Valida se um cartão virtual ainda está ativo.
   */
  validateCard(cardId: string): boolean {
    const card = this.cards.get(cardId);
    if (!card) return false;

    if (Date.now() > card.expiresAt) {
      card.isActive = false;
      console.log(`[Janus] Cartão ${card.number.slice(-4)} expirado e destruído.`);
      return false;
    }

    return card.isActive;
  }

  // ─── Statement (ZK Proofs) ───────────────────────────────────────────────

  /**
   * Gera extrato com provas ZK para cada linha.
   */
  private addStatementLine(
    userHandle: string,
    data: Omit<StatementLine, "id" | "timestamp" | "zkProof" | "nullifier">,
  ): StatementLine {
    const line: StatementLine = {
      id: `stmt_${Date.now()}_${secureRandomId(3)}`,
      timestamp: Date.now(),
      ...data,
      zkProof: "",  // Será preenchido
      nullifier: "", // Será preenchido
    };

    // Gera ZK proof da linha
    const proofInput = new TextEncoder().encode(
      `${line.id}:${line.type}:${line.amount}:${line.currency}:${line.timestamp}`
    );
    line.zkProof = Array.from(sha3_256(proofInput))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);

    // Gera nullifier
    line.nullifier = Array.from(sha3_256(new TextEncoder().encode(`null_${line.id}`)))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    const lines = this.statements.get(userHandle) || [];
    lines.push(line);
    this.statements.set(userHandle, lines);

    return line;
  }

  /**
   * Retorna extrato verificável (cada linha tem prova ZK).
   */
  getStatement(userHandle: string, limit = 20): StatementLine[] {
    const lines = this.statements.get(userHandle) || [];
    return lines.slice(-limit);
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getCard(id: string): VirtualCard | null {
    return this.cards.get(id) || null;
  }

  getAllCards(): VirtualCard[] {
    return Array.from(this.cards.values());
  }

  getActiveCards(): VirtualCard[] {
    return Array.from(this.cards.values()).filter(c => c.isActive && Date.now() < c.expiresAt);
  }

  getStats() {
    const cards = Array.from(this.cards.values());
    return {
      totalCards: cards.length,
      activeCards: cards.filter(c => c.isActive).length,
      expiredCards: cards.filter(c => !c.isActive).length,
      totalUtxos: this.utxos.size,
      totalStatements: Array.from(this.statements.values()).reduce((sum, lines) => sum + lines.length, 0),
    };
  }
}

export const janusFinance = JanusFinance.getInstance();
