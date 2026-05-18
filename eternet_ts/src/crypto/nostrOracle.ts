/**
 * ETΞRNET — Oracle de Preço Descentralizado via NOSTR
 *
 * Coleta preços de ativos publicados como eventos NOSTR por múltiplos
 * oráculos (nós confiáveis). Calcula mediana após remoção de outliers.
 *
 * Kind 31219: Price report (ETR/BRL, ETR/XMR, etc.)
 *
 * Modelo de confiança: Schelling point — se 5+ nós reportam
 * preços similares, a mediana é confiável. Outliers (>20% da mediana)
 * são descartados.
 */

import { secureRandomId } from "../utils/secureRandom";

export const ORACLE_PRICE_KIND = 31219;

export interface PriceReport {
  id: string;
  oraclePk: string;       // public key do oráculo
  pair: string;            // ex: "ETR/BRL", "ETR/XMR", "BTC/USDT"
  price: number;
  timestamp: number;
  confidence: number;      // 0-1, quão confiante o oráculo está
  source: string;          // ex: "binance", "coingecko", "manual"
}

export interface AggregatedPrice {
  pair: string;
  medianPrice: number;
  meanPrice: number;
  reports: PriceReport[];
  validReports: number;
  outlierCount: number;
  timestamp: number;
  confidence: number;      // 0-1, baseado em quantidade de reports
}

export type PriceListener = (price: AggregatedPrice) => void;

class NostrOracle {
  private static instance: NostrOracle;
  private reports: Map<string, PriceReport[]> = new Map(); // pair → reports
  private aggregated: Map<string, AggregatedPrice> = new Map();
  private listeners: Set<PriceListener> = new Set();
  private outlierThreshold: number = 0.20; // 20% da mediana

  public static getInstance(): NostrOracle {
    if (!NostrOracle.instance) NostrOracle.instance = new NostrOracle();
    return NostrOracle.instance;
  }

  private constructor() {}

  /** Envia um relatório de preço (local ou recebido via NOSTR) */
  submitReport(report: PriceReport): void {
    const pairReports = this.reports.get(report.pair) || [];

    // Deduplica por oráculo + par + timestamp
    const exists = pairReports.some(
      r => r.oraclePk === report.oraclePk &&
           Math.abs(r.timestamp - report.timestamp) < 60000 // mesmo minuto
    );
    if (exists) return;

    pairReports.push(report);

    // Mantém apenas os últimos 100 relatórios por par
    if (pairReports.length > 100) {
      pairReports.splice(0, pairReports.length - 100);
    }

    this.reports.set(report.pair, pairReports);

    // Reagrega
    this.aggregate(report.pair);
  }

  /** Ingesta um evento NOSTR como relatório de preço */
  ingestEvent(event: { kind: number; tags: string[][]; content: string; created_at: number; pubkey: string }): void {
    if (event.kind !== ORACLE_PRICE_KIND) return;

    try {
      const data = JSON.parse(event.content);
      const report: PriceReport = {
        id: `rpt_${secureRandomId(8)}`,
        oraclePk: event.pubkey,
        pair: data.pair,
        price: data.price,
        timestamp: event.created_at * 1000,
        confidence: data.confidence ?? 1,
        source: data.source ?? "unknown",
      };

      this.submitReport(report);
    } catch { /* evento inválido */ }
  }

  /** Agrega relatórios de um par — mediana com remoção de outliers */
  private aggregate(pair: string): void {
    const reports = this.reports.get(pair);
    if (!reports || reports.length === 0) return;

    // Filtra relatórios recentes (últimos 5 minutos)
    const cutoff = Date.now() - 300000;
    const recent = reports.filter(r => r.timestamp > cutoff);
    if (recent.length === 0) return;

    // Ordena por preço
    const sorted = [...recent].sort((a, b) => a.price - b.price);

    // Calcula mediana inicial
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1].price + sorted[mid].price) / 2
      : sorted[mid].price;

    // Remove outliers (> threshold da mediana)
    const valid = sorted.filter(r => {
      const deviation = Math.abs(r.price - median) / median;
      return deviation <= this.outlierThreshold;
    });

    const outliers = sorted.length - valid.length;

    // Recalcula com relatórios válidos
    let finalMedian = median;
    let mean = median;
    if (valid.length > 0) {
      const validSorted = [...valid].sort((a, b) => a.price - b.price);
      const vMid = Math.floor(validSorted.length / 2);
      finalMedian = validSorted.length % 2 === 0
        ? (validSorted[vMid - 1].price + validSorted[vMid].price) / 2
        : validSorted[vMid].price;

      mean = valid.reduce((sum, r) => sum + r.price, 0) / valid.length;
    }

    // Confiança baseada na quantidade de relatórios válidos
    const confidence = Math.min(1, valid.length / 5); // 5+ relatórios = confiança total

    const aggregated: AggregatedPrice = {
      pair,
      medianPrice: finalMedian,
      meanPrice: mean,
      reports: valid,
      validReports: valid.length,
      outlierCount: outliers,
      timestamp: Date.now(),
      confidence,
    };

    this.aggregated.set(pair, aggregated);

    // Notifica listeners
    for (const listener of this.listeners) {
      try { listener(aggregated); } catch { /* ignora */ }
    }
  }

  /** Obtém preço agregado de um par */
  getPrice(pair: string): AggregatedPrice | null {
    return this.aggregated.get(pair.toUpperCase()) ?? null;
  }

  /** Obtém todos os pares rastreados */
  getPairs(): string[] {
    return Array.from(this.aggregated.keys());
  }

  /** Inscreve para atualizações de preço */
  onPriceUpdate(listener: PriceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cria evento NOSTR para um relatório de preço */
  createReportEvent(report: PriceReport) {
    return {
      kind: ORACLE_PRICE_KIND,
      tags: [
        ['t', 'eternet_oracle'],
        ['pair', report.pair],
        ['source', report.source],
      ],
      content: JSON.stringify({
        pair: report.pair,
        price: report.price,
        confidence: report.confidence,
        source: report.source,
      }),
      created_at: Math.floor(report.timestamp / 1000),
    };
  }

  /** Define threshold de outliers */
  setOutlierThreshold(threshold: number): void {
    this.outlierThreshold = Math.max(0.05, Math.min(0.5, threshold));
  }

  /** Obtém estatísticas */
  getStats(): { pairs: number; totalReports: number } {
    let totalReports = 0;
    for (const reports of this.reports.values()) {
      totalReports += reports.length;
    }
    return { pairs: this.reports.size, totalReports };
  }
}

export const nostrOracle = NostrOracle.getInstance();
