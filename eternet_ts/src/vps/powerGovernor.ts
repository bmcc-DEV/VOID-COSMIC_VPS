/**
 * PowerGovernor — regulação auto-adaptativa
 */

export interface GovernorState {
  miningDifficulty: number;
  qelShardTtlMs: number;
  computePriceFactor: number;
  marketCoherence: number;
}

export class PowerGovernor {
  private params: GovernorState = {
    miningDifficulty: 16,
    qelShardTtlMs: 3_600_000,
    computePriceFactor: 1.0,
    marketCoherence: 0.5,
  };

  private blockRateHistory: number[] = [];
  private latencyHistory: number[] = [];

  get state(): GovernorState {
    return { ...this.params };
  }

  /** Ajusta dificuldade de mineração pela taxa de blocos */
  recordBlock(intervalMs: number): void {
    this.blockRateHistory.push(intervalMs);
    if (this.blockRateHistory.length > 20) this.blockRateHistory.shift();

    const avg =
      this.blockRateHistory.reduce((a, b) => a + b, 0) /
      this.blockRateHistory.length;
    const target = 60_000; // 1 bloco/min alvo

    if (avg < target * 0.8) this.params.miningDifficulty = Math.min(24, this.params.miningDifficulty + 1);
    else if (avg > target * 1.2) this.params.miningDifficulty = Math.max(8, this.params.miningDifficulty - 1);
  }

  /** Ajusta TTL de shards QEL pela latência */
  recordLatency(ms: number): void {
    this.latencyHistory.push(ms);
    if (this.latencyHistory.length > 50) this.latencyHistory.shift();

    const avg =
      this.latencyHistory.reduce((a, b) => a + b, 0) /
      this.latencyHistory.length;

    if (avg > 500) this.params.qelShardTtlMs = Math.min(7_200_000, this.params.qelShardTtlMs * 1.1);
    else if (avg < 100) this.params.qelShardTtlMs = Math.max(600_000, this.params.qelShardTtlMs * 0.9);
  }

  /** Métrica de Sobolev simplificada → preço de computação */
  updateMarketCoherence(demand: number, supply: number): void {
    if (supply <= 0) return;
    this.params.marketCoherence = Math.min(1, Math.max(0, demand / supply));
    this.params.computePriceFactor = 1 + this.params.marketCoherence ** 2;
  }

  computePrice(baseCycles: number): number {
    return Math.floor(baseCycles * this.params.computePriceFactor);
  }
}
