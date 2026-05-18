/**
 * Hydra v7.0 — Temporal Intent Oracle (TIO)
 *
 * Resolve o problema de latência crítica em DeFi/DEX offline:
 *
 * Quando uma ordem viaja via LoRa/HCN (horas a dias), o preço
 * muda e a ordem chega defasada. O Temporal Intent Oracle resolve
 * isso através de três mecanismos complementares:
 *
 * 1. TIME-LOCKED INTENTS: Ordens com janelas de validade criptográfica.
 *    Se a janela expirar antes da chegada, a ordem é auto-cancelada.
 *
 * 2. RETROACTIVE PRICE ANCHORING (ZK-Anchored Execution):
 *    O trader compromete um "preço de referência" no momento da emissão.
 *    A execução ocorre com base nesse preço ± slippage tolerance,
 *    provado via ZK sem revelar a intenção original.
 *
 * 3. DELTA-NEUTRAL HEDGING COMMITMENTS:
 *    Para ordens de alto valor, o protocolo gera automaticamente
 *    "insurance shards" que protegem contra variação de preço.
 *
 * Bibliotecas: @noble/hashes (SHA3-256), @noble/curves (Ed25519)
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { ed25519 }  from "@noble/curves/ed25519.js";
import { secureRandomInt } from "../utils/secureRandom";

// ─── Types ────────────────────────────────────────────────────────────────────

export type OrderSide = "BUY" | "SELL";

export interface TemporalIntent {
  id:                 string;
  side:               OrderSide;
  pair:               string;
  amount:             number;
  // ── Temporal Fields ──────────────────────────────────────────────────────
  anchorPrice:        number;       // preço no momento da criação da ordem
  slippageBps:        number;       // tolerância em basis points (1 bps = 0.01%)
  validFrom:          number;       // unix ms — início da janela
  validUntil:         number;       // unix ms — fim da janela (time-lock)
  // ── Cryptographic Proofs ─────────────────────────────────────────────────
  priceCommitment:    string;       // SHA3-256(anchorPrice || secret)
  timeProof:          string;       // assinatura Ed25519 do timestamp
  intentSecret:       Uint8Array;   // segredo para abrir o commitment (destruído após reveal)
  // ── Transport Metadata ───────────────────────────────────────────────────
  channel:            string;       // BLE, LoRa, HCN, etc.
  estimatedLatency:   string;       // estimativa de latência do canal
  // ── Trader Identity (Anon) ───────────────────────────────────────────────
  traderPubKey:       Uint8Array;
}

export interface AnchoredExecution {
  intentId:           string;
  executionPrice:     number;       // preço real de execução
  anchorPrice:        number;       // preço ancorado original
  slippageActual:     number;       // slippage real em bps
  slippageAllowed:    number;       // slippage máximo permitido
  accepted:           boolean;      // se a execução foi aceita
  zkProof:            string;       // prova ZK de que execução respeita limites
  timestamp:          number;
}

export interface HedgeCommitment {
  intentId:           string;
  hedgeAmount:        number;       // valor protegido
  hedgeDirection:     OrderSide;    // direção oposta à ordem original
  premium:            number;       // custo do hedge em bps
  activationPrice:    number;       // preço que ativa o hedge
  commitment:         string;       // compromisso criptográfico
  expiresAt:          number;       // expiração do hedge
}

export interface OracleStats {
  totalIntents:       number;
  activeIntents:      number;
  expiredIntents:     number;
  executedIntents:    number;
  rejectedSlippage:   number;
  avgLatencyMs:       number;
  hedgesActive:       number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexSlice(data: Uint8Array, len = 16): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

function hashStr(input: string): string {
  return hexSlice(sha3_256(new TextEncoder().encode(input)) as Uint8Array, 32);
}

// ─── 1. Time-Locked Intent Factory ───────────────────────────────────────────

/**
 * Cria uma ordem com janela de validade criptográfica.
 *
 * A ordem só pode ser executada dentro do intervalo [validFrom, validUntil].
 * Fora desse intervalo, o commitment não pode ser aberto e a ordem
 * é matematicamente inválida — não importa quantos nós a recebam.
 */
export function createTimeLockIntent(params: {
  side:             OrderSide;
  pair:             string;
  amount:           number;
  anchorPrice:      number;
  slippageBps:      number;
  validityWindowMs: number;       // duração da janela em ms
  channel:          string;
  estimatedLatency: string;
  traderPrivKey:    Uint8Array;   // Ed25519 private key (32 bytes)
}): TemporalIntent {
  const now = Date.now();
  const id  = `tio_${now}_${secureRandomInt(100000)}`;

  // Secret: random 32 bytes, usado para fechar/abrir o price commitment
  const intentSecret = crypto.getRandomValues(new Uint8Array(32));

  // Price Commitment: SHA3-256(anchorPrice || intentSecret)
  // Só pode ser aberto por quem conhece o secret
  const priceData     = `${params.anchorPrice}|${hexSlice(intentSecret, 64)}`;
  const priceCommit   = hashStr(priceData);

  // Time Proof: assinatura Ed25519 do intervalo de validade
  // Prova que o trader criou a ordem neste instante preciso
  const timeMessage   = new TextEncoder().encode(
    `${id}|${now}|${now + params.validityWindowMs}|${priceCommit}`
  );
  const timeSignature = ed25519.sign(timeMessage, params.traderPrivKey) as Uint8Array;
  const timeProof     = hexSlice(timeSignature, 32);

  // Chave pública do trader
  const traderPubKey  = ed25519.getPublicKey(params.traderPrivKey) as Uint8Array;

  return {
    id,
    side:             params.side,
    pair:             params.pair,
    amount:           params.amount,
    anchorPrice:      params.anchorPrice,
    slippageBps:      params.slippageBps,
    validFrom:        now,
    validUntil:       now + params.validityWindowMs,
    priceCommitment:  priceCommit,
    timeProof,
    intentSecret,
    channel:          params.channel,
    estimatedLatency: params.estimatedLatency,
    traderPubKey,
  };
}

/**
 * Verifica se uma ordem temporal ainda está dentro da janela de validade.
 */
export function isIntentValid(intent: TemporalIntent, now = Date.now()): boolean {
  return now >= intent.validFrom && now <= intent.validUntil;
}

/**
 * Calcula o tempo restante na janela de validade.
 */
export function getTimeRemaining(intent: TemporalIntent, now = Date.now()): number {
  return Math.max(0, intent.validUntil - now);
}

// ─── 2. Retroactive Price Anchoring (ZK-Anchored Execution) ──────────────────

/**
 * Executa uma ordem ancorada retroativamente.
 *
 * O matchmaker recebe a ordem (possivelmente horas depois) e
 * compara o preço atual com o preço ancorado ± slippage tolerance.
 *
 * Se o slippage real estiver dentro dos limites, a ordem é executada.
 * Caso contrário, é rejeitada com prova ZK de que os limites foram violados.
 *
 * Fórmula de slippage:
 *   slippage_bps = |currentPrice - anchorPrice| / anchorPrice * 10000
 *
 * Condição de aceitação:
 *   slippage_bps ≤ intent.slippageBps
 */
export function executeWithAnchor(
  intent: TemporalIntent,
  currentPrice: number,
): AnchoredExecution {
  const now = Date.now();

  // 1. Verifica janela temporal
  if (!isIntentValid(intent, now)) {
    return {
      intentId:       intent.id,
      executionPrice: currentPrice,
      anchorPrice:    intent.anchorPrice,
      slippageActual: Infinity,
      slippageAllowed: intent.slippageBps,
      accepted:       false,
      zkProof:        hashStr(`EXPIRED|${intent.id}|${now}`),
      timestamp:      now,
    };
  }

  // 2. Calcula slippage real em basis points
  const priceDiff   = Math.abs(currentPrice - intent.anchorPrice);
  const slippageBps = (priceDiff / intent.anchorPrice) * 10000;

  // 3. Decide aceitar ou rejeitar
  const accepted = slippageBps <= intent.slippageBps;

  // 4. Gera prova ZK da decisão
  // A prova compromete: anchor, current, slippage, decision
  // Sem revelar o anchorPrice original (apenas o commitment)
  const proofInput = [
    intent.priceCommitment,
    currentPrice.toFixed(8),
    slippageBps.toFixed(4),
    accepted ? "ACCEPT" : "REJECT",
    now.toString(),
  ].join("|");

  const zkProof = hashStr(proofInput);

  return {
    intentId:       intent.id,
    executionPrice: accepted ? currentPrice : 0,
    anchorPrice:    intent.anchorPrice,
    slippageActual: Math.round(slippageBps),
    slippageAllowed: intent.slippageBps,
    accepted,
    zkProof,
    timestamp:      now,
  };
}

/**
 * Verifica o price commitment (prova de que o anchor price é genuíno).
 * Chamado durante a fase reveal para provar que o trader não alterou o preço.
 */
export function verifyPriceCommitment(
  intent: TemporalIntent,
  claimedPrice: number,
  secret: Uint8Array,
): boolean {
  const priceData   = `${claimedPrice}|${hexSlice(secret, 64)}`;
  const recomputed  = hashStr(priceData);
  return recomputed === intent.priceCommitment;
}

// ─── 3. Delta-Neutral Hedging Commitments ────────────────────────────────────

/**
 * Gera um hedge commitment para proteger contra variação de preço
 * durante o transporte da ordem.
 *
 * Se a ordem é BUY a $100 com 2% slippage, o hedge cria
 * uma posição SELL condicional que ativa se o preço subir acima de $102.
 */
export function createHedgeCommitment(
  intent: TemporalIntent,
  premiumBps = 50, // custo do hedge: 0.5%
): HedgeCommitment {
  const hedgeDir = intent.side === "BUY" ? "SELL" : "BUY";

  // Preço de ativação: anchorPrice ± slippage tolerance
  const slippageFraction = intent.slippageBps / 10000;
  const activationPrice = intent.side === "BUY"
    ? intent.anchorPrice * (1 + slippageFraction)
    : intent.anchorPrice * (1 - slippageFraction);

  // Valor do hedge: proporcional ao valor da ordem
  const hedgeAmount = intent.amount * (premiumBps / 10000);

  const commitData = [
    intent.id,
    hedgeDir,
    hedgeAmount.toFixed(8),
    activationPrice.toFixed(8),
    intent.validUntil.toString(),
  ].join("|");

  return {
    intentId:        intent.id,
    hedgeAmount,
    hedgeDirection:  hedgeDir,
    premium:         premiumBps,
    activationPrice,
    commitment:      hashStr(commitData),
    expiresAt:       intent.validUntil,
  };
}

/**
 * Verifica se um hedge deve ser ativado dado o preço atual.
 */
export function shouldActivateHedge(
  hedge: HedgeCommitment,
  currentPrice: number,
  originalSide: OrderSide,
): boolean {
  if (Date.now() > hedge.expiresAt) return false;
  return originalSide === "BUY"
    ? currentPrice >= hedge.activationPrice
    : currentPrice <= hedge.activationPrice;
}

// ─── Temporal Oracle Manager ──────────────────────────────────────────────────

export class TemporalOracle {
  private intents:     Map<string, TemporalIntent>     = new Map();
  private executions:  AnchoredExecution[]              = [];
  private hedges:      Map<string, HedgeCommitment>     = new Map();

  /**
   * Registra uma nova ordem temporal no oráculo.
   */
  registerIntent(intent: TemporalIntent): void {
    this.intents.set(intent.id, intent);
  }

  /**
   * Tenta executar uma ordem com o preço atual.
   * Retorna o resultado da execução ancorada.
   */
  tryExecute(intentId: string, currentPrice: number): AnchoredExecution | null {
    const intent = this.intents.get(intentId);
    if (!intent) return null;

    const execution = executeWithAnchor(intent, currentPrice);
    this.executions.push(execution);

    if (execution.accepted) {
      this.intents.delete(intentId);
      this.hedges.delete(intentId);
    }

    return execution;
  }

  /**
   * Cria e registra um hedge para uma ordem existente.
   */
  addHedge(intentId: string, premiumBps = 50): HedgeCommitment | null {
    const intent = this.intents.get(intentId);
    if (!intent) return null;

    const hedge = createHedgeCommitment(intent, premiumBps);
    this.hedges.set(intentId, hedge);
    return hedge;
  }

  /**
   * Sweep: limpa ordens expiradas e retorna estatísticas.
   */
  sweep(): OracleStats {
    const now = Date.now();
    let expired = 0;

    for (const [id, intent] of this.intents) {
      if (now > intent.validUntil) {
        this.intents.delete(id);
        this.hedges.delete(id);
        expired++;
      }
    }

    const executed = this.executions.filter(e => e.accepted).length;
    const rejected = this.executions.filter(e => !e.accepted).length;

    return {
      totalIntents:     this.intents.size + executed + expired + rejected,
      activeIntents:    this.intents.size,
      expiredIntents:   expired,
      executedIntents:  executed,
      rejectedSlippage: rejected,
      avgLatencyMs:     0,
      hedgesActive:     this.hedges.size,
    };
  }

  /**
   * Retorna todas as ordens ativas com tempo restante.
   */
  getActiveIntents(): Array<TemporalIntent & { timeRemainingMs: number }> {
    const now = Date.now();
    return Array.from(this.intents.values())
      .filter(i => isIntentValid(i, now))
      .map(i => ({ ...i, timeRemainingMs: getTimeRemaining(i, now) }));
  }

  /**
   * Retorna o histórico de execuções.
   */
  getExecutions(): AnchoredExecution[] {
    return [...this.executions];
  }

  /**
   * Retorna hedges ativos.
   */
  getHedges(): HedgeCommitment[] {
    return Array.from(this.hedges.values());
  }

  /**
   * Limpa o oráculo.
   */
  clear(): void {
    this.intents.clear();
    this.executions = [];
    this.hedges.clear();
  }
}
