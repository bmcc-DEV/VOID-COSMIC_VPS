/**
 * ETΞRNET — Layer 3: Proof-of-Sovereignty ($SOV)
 * 
 * O $SOV é o token de governança e infraestrutura do ETΞRNET.
 * Ele é ganho fornecendo roteamento (HCN), liquidez local ou
 * armazenamento persistente (ANIMUS SW).
 * 
 * Diferente das stablecoins locais (Layer 4), o $SOV representa
 * o poder computacional e a resiliência contribuída para a rede.
 */

import { UTXO, createUTXO } from "./utxo";
import { GhostIdentity } from "./ghostid";
import { secureRandomId } from "../utils/secureRandom";

export interface SovStake {
  id: string;
  stakerPk: string;
  amount: bigint;
  lockedUntil: number;
  rewardMultiplier: number;
}

export class SovTokenomics {
  private static instance: SovTokenomics;
  private stakes: Map<string, SovStake> = new Map();
  private networkDifficulty: number = 1.0;
  private globalLoad: number = 0.5; // Simulação de carga da malha (0.0 a 1.0)

  public static getInstance(): SovTokenomics {
    if (!SovTokenomics.instance) {
      SovTokenomics.instance = new SovTokenomics();
    }
    return SovTokenomics.instance;
  }

  private constructor() {
    // Ajusta dificuldade baseado em peers reais via BroadcastChannel
    const mesh = new BroadcastChannel("void_omega_mesh");
    let peerCount = 1;
    mesh.onmessage = (e) => {
      if (e.data?.type === "PEER_ANNOUNCE") peerCount++;
    };
    setInterval(() => {
      // Load = f(peerCount, tempo_ativo) — sem Math.random()
      const uptimeFactor = Math.min(Date.now() / 3600000, 1); // 0→1 em 1h
      this.globalLoad = Math.min(0.3 + (peerCount / 100) * 0.4 + uptimeFactor * 0.1, 1.0);
      this.adjustDifficulty();
    }, 30000);
  }

  /**
   * Ajusta a dificuldade adaptativa da rede.
   * Se a carga está alta, o mint de $SOV fica mais difícil (deflação por congestionamento).
   */
  private adjustDifficulty() {
    if (this.globalLoad > 0.7) {
      this.networkDifficulty *= 1.05; // Aumenta dificuldade
    } else if (this.globalLoad < 0.4) {
      this.networkDifficulty *= 0.95; // Diminui dificuldade
    }
    this.networkDifficulty = Math.max(0.1, Math.min(10.0, this.networkDifficulty));
    console.log(`[$SOV] Dificuldade Adaptativa: ${this.networkDifficulty.toFixed(4)} (Carga: ${(this.globalLoad * 100).toFixed(1)}%)`);
  }

  /**
   * Recompensa um nó por manter o ANIMUS (Service Worker) ativo.
   */
  public mintRoutingReward(identity: GhostIdentity, relayedShardsCount: number): UTXO {
    const baseReward = 50n; 
    // Recompensa inversamente proporcional à dificuldade
    const difficultyFactor = 1.0 / this.networkDifficulty;
    const activityBonus = BigInt(Math.floor(relayedShardsCount * 10 * difficultyFactor));
    const totalReward = baseReward + activityBonus;

    return createUTXO(totalReward, identity.publicKey);
  }

  public getNetworkMetrics() {
    return {
      difficulty: this.networkDifficulty,
      load: this.globalLoad
    };
  }

  /**
   * Stake de $SOV para ganhar poder de voto e aumento nos rendimentos de liquidez DEX.
   */
  public stakeSov(identity: GhostIdentity, amount: bigint, durationDays: number): SovStake {
    if (amount <= 0n) throw new Error("Valor de stake inválido");

    const multiplier = 1.0 + (durationDays / 365) * 0.5; // Até 50% de bônus anual
    
    const stake: SovStake = {
      id: `stake_${Date.now()}_${secureRandomId(4)}`,
      stakerPk: Array.from(identity.publicKey).map(b => b.toString(16).padStart(2, '0')).join(''),
      amount,
      lockedUntil: Date.now() + (durationDays * 24 * 60 * 60 * 1000),
      rewardMultiplier: Number(multiplier.toFixed(2)),
    };

    this.stakes.set(stake.id, stake);
    return stake;
  }

  public getStakes(): SovStake[] {
    return Array.from(this.stakes.values());
  }
}

export const sovTokenomics = SovTokenomics.getInstance();
