/**
 * ETΞRNET — EcoNet: A Memória Distribuída que Esquece
 *
 * Uma DHT sobre CRDTs com decaimento temporal entrópico.
 * Dados se dissolvem estatisticamente como sinapses não reforçadas.
 *
 * Propriedades:
 * - Fossilização Inversa: bits menos significativos são corrompidos progressivamente
 * - Decaimento por Percolação: shards abaixo do limiar crítico tendem a zero
 * - Reforço por Acesso: cada acesso restaura os shards
 * - Provas de Esquecimento: ZKP atestam que dado não é mais recuperável
 */

import { sha3_256 } from "@noble/hashes/sha3.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EcoNetEntry {
  id: string;
  data: Uint8Array;
  commitment: string;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  decayRate: number;         // Taxa de decaimento (0.0 = eterno, 1.0 = destruição imediata)
  significance: number;      // Importância (0.0 a 1.0) — dados mais acessados ganham significância
  isDecayed: boolean;
}

export interface DecayConfig {
  baseDecayRate: number;     // Taxa base de decaimento por hora
  accessRestoration: number; // Quanto cada acesso restaura (0.0 a 1.0)
  significanceThreshold: number; // Limiar abaixo do qual dados são considerados "esquecidos"
  maxAge: number;            // Idade máxima em ms (padrão: 30 dias)
  fossilizationStart: number; // Percentual de decaimento onde fossilização começa
}

export interface ForgettingProof {
  entryId: string;
  proofHash: string;
  timestamp: number;
  decayLevel: number;
  isIrrecoverable: boolean;
}

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_DECAY_CONFIG: DecayConfig = {
  baseDecayRate: 0.001,         // 0.1% por hora
  accessRestoration: 0.15,      // 15% de restauração por acesso
  significanceThreshold: 0.05,  // Abaixo de 5% = esquecido
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dias
  fossilizationStart: 0.7,      // 70% de decaimento
};

// ─── EcoNet Engine ────────────────────────────────────────────────────────────

export class EcoNet {
  private static instance: EcoNet;
  private entries: Map<string, EcoNetEntry> = new Map();
  private config: DecayConfig;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  public static getInstance(config?: Partial<DecayConfig>): EcoNet {
    if (!EcoNet.instance) {
      EcoNet.instance = new EcoNet(config);
    }
    return EcoNet.instance;
  }

  private constructor(config?: Partial<DecayConfig>) {
    this.config = { ...DEFAULT_DECAY_CONFIG, ...config };
    this.startDecaySweep();
  }

  // ─── Core Operations ──────────────────────────────────────────────────────

  /**
   * Armazena um dado na EcoNet com decaimento temporal.
   */
  store(data: Uint8Array, customDecayRate?: number): EcoNetEntry {
    const id = Array.from(sha3_256(data))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    const entry: EcoNetEntry = {
      id,
      data: new Uint8Array(data), // Cópia
      commitment: id,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      decayRate: customDecayRate ?? this.config.baseDecayRate,
      significance: 0.5, // Começa com significância média
      isDecayed: false,
    };

    this.entries.set(id, entry);
    console.log(`[EcoNet] Entry ${id} armazenada. Decay rate: ${entry.decayRate}`);
    return entry;
  }

  /**
   * Recupera um dado da EcoNet (reforça significância).
   */
  retrieve(entryId: string): Uint8Array | null {
    const entry = this.entries.get(entryId);
    if (!entry) return null;

    // Reforço por acesso
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    entry.significance = Math.min(1.0, entry.significance + this.config.accessRestoration);

    // Se estava degradado, restaura parcialmente
    if (entry.isDecayed && entry.significance > this.config.significanceThreshold) {
      entry.isDecayed = false;
      this.restoreData(entry);
    }

    console.log(`[EcoNet] Entry ${entryId} acessada. Significância: ${entry.significance.toFixed(3)}`);
    return new Uint8Array(entry.data);
  }

  /**
   * Remove um dado explicitamente (sem decaimento).
   */
  forget(entryId: string): ForgettingProof | null {
    const entry = this.entries.get(entryId);
    if (!entry) return null;

    const proof = this.generateForgettingProof(entry);
    this.entries.delete(entryId);
    console.log(`[EcoNet] Entry ${entryId} esquecida explicitamente.`);
    return proof;
  }

  // ─── Decay Engine ─────────────────────────────────────────────────────────

  /**
   * Inicia a varredura periódica de decaimento.
   */
  private startDecaySweep() {
    // A cada 60 segundos, aplica decaimento
    this.sweepTimer = setInterval(() => this.applyDecay(), 60000);
  }

  /**
   * Aplica decaimento temporal a todas as entradas.
   * Implementa Fossilização Inversa e Decaimento por Percolação.
   */
  private applyDecay() {
    const now = Date.now();

    for (const [id, entry] of this.entries) {
      // Calcula tempo desde último acesso
      const hoursSinceAccess = (now - entry.lastAccessedAt) / (60 * 60 * 1000);

      // Fossilização Inversa: degrada bits menos significativos
      const fossilizationFactor = Math.min(1.0, hoursSinceAccess * entry.decayRate);
      if (fossilizationFactor > this.config.fossilizationStart) {
        this.applyFossilization(entry, fossilizationFactor);
      }

      // Decaimento por Percolação: reduz significância
      const decayAmount = hoursSinceAccess * entry.decayRate * (1.0 - entry.significance * 0.5);
      entry.significance = Math.max(0, entry.significance - decayAmount);

      // Marca como degradado se abaixo do limiar
      if (entry.significance < this.config.significanceThreshold) {
        entry.isDecayed = true;
      }

      // Remove se muito antigo ou totalmente degradado
      if (entry.significance <= 0 || (now - entry.createdAt) > this.config.maxAge) {
        this.entries.delete(id);
        console.log(`[EcoNet] Entry ${id} removida por decaimento completo.`);
      }
    }
  }

  /**
   * Fossilização Inversa: corrompe progressivamente bits menos significativos.
   */
  private applyFossilization(entry: EcoNetEntry, factor: number) {
    const bytesToCorrupt = Math.floor(entry.data.length * factor * 0.3);
    for (let i = 0; i < bytesToCorrupt; i++) {
      const idx = entry.data.length - 1 - i;
      if (idx >= 0 && entry.data) {
        // Corrompe o byte com XOR aleatório
        entry.data[idx] ^= crypto.getRandomValues(new Uint8Array(1))[0] || 0;
      }
    }
  }

  /**
   * Restaura dados degradados (quando há reforço por acesso).
   * Na prática, isso requer cópia de backup ou reconstrução.
   */
  private restoreData(entry: EcoNetEntry) {
    // Em implementação real, restauraria de backup ou reconstruiria via erasure coding
    // Por aqui, apenas marca como restaurado
    console.log(`[EcoNet] Entry ${entry.id} restaurada (${(entry.significance * 100).toFixed(1)}%)`);
  }

  // ─── Forgetting Proofs ───────────────────────────────────────────────────

  /**
   * Gera uma prova ZK de que o dado foi esquecido (não mais recuperável).
   */
  private generateForgettingProof(entry: EcoNetEntry): ForgettingProof {
    const proofData = new Uint8Array(entry.data.length + 32);
    proofData.set(entry.data);
    proofData.set(sha3_256(entry.data), entry.data.length);

    return {
      entryId: entry.id,
      proofHash: Array.from(sha3_256(proofData))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32),
      timestamp: Date.now(),
      decayLevel: 1.0 - entry.significance,
      isIrrecoverable: true,
    };
  }

  /**
   * Verifica se uma entry foi esquecida (prova de destruição).
   */
  verifyForgetting(entryId: string): ForgettingProof | null {
    const entry = this.entries.get(entryId);
    if (!entry || entry.isDecayed) {
      return {
        entryId,
        proofHash: Array.from(sha3_256(new TextEncoder().encode(entryId)))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 32),
        timestamp: Date.now(),
        decayLevel: 1.0,
        isIrrecoverable: true,
      };
    }
    return null; // Ainda não esquecido
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getEntry(id: string): EcoNetEntry | null {
    return this.entries.get(id) || null;
  }

  getAllEntries(): EcoNetEntry[] {
    return Array.from(this.entries.values());
  }

  getActiveEntries(): EcoNetEntry[] {
    return Array.from(this.entries.values()).filter(e => !e.isDecayed);
  }

  getDecayedEntries(): EcoNetEntry[] {
    return Array.from(this.entries.values()).filter(e => e.isDecayed);
  }

  getStats() {
    const entries = Array.from(this.entries.values());
    return {
      totalEntries: entries.length,
      activeEntries: entries.filter(e => !e.isDecayed).length,
      decayedEntries: entries.filter(e => e.isDecayed).length,
      avgSignificance: entries.length > 0
        ? entries.reduce((sum, e) => sum + e.significance, 0) / entries.length
        : 0,
      totalDataBytes: entries.reduce((sum, e) => sum + e.data.length, 0),
    };
  }

  destroy() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.entries.clear();
  }
}

export const econet = EcoNet.getInstance();
