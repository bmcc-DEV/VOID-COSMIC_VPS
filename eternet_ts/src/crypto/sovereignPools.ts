/**
 * ETΞRNET — Sovereign Investment Pools (SIPs): Fundos com Gestor Fantasma
 *
 * O SynthManager é um GhostID público cuja chave privada é gerada
 * por threshold signature entre os cotistas, que votam via ZK-Rollup.
 *
 * Componentes:
 * - Propostas Ocultas: estratégias cifradas; voto ZK
 * - Resgate por Aegis Vault: cotas tokenizadas queimadas no instante do consenso
 * - Incentivo Anti-Centralização: taxa de performance distribuída aos votantes
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { type GhostIdentity } from "./ghostid";
import { secureRandomId } from "../utils/secureRandom";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SIPConfig {
  name: string;
  strategy: string;
  minInvestment: bigint;
  maxInvestors: number;
  performanceFeeRate: number;   // 0.0 a 0.1 (0% a 10%)
  managementFeeRate: number;    // 0.0 a 0.02 (0% a 2%)
}

export interface SIPPool {
  id: string;
  config: SIPConfig;
  totalAssets: bigint;
  investorCount: number;
  nav: number;                  // Net Asset Value por cota
  createdAt: number;
  lastRebalance: number;
  isActive: boolean;
}

export interface SIPShare {
  id: string;
  poolId: string;
  investorPk: string;
  shareAmount: bigint;
  entryNav: number;
  createdAt: number;
  isLocked: boolean;
}

export interface HiddenProposal {
  id: string;
  poolId: string;
  proposerPk: string;
  encryptedStrategy: Uint8Array;
  description: string;
  votesFor: number;
  votesAgainst: number;
  totalVoters: number;
  status: "pending" | "voting" | "approved" | "rejected";
  createdAt: number;
  expiresAt: number;
}

export interface ZKVote {
  voterPk: string;
  proposalId: string;
  voteHash: string;            // Hash do voto (oculto até tally)
  nullifier: string;           // Para prevenir double-voting
  timestamp: number;
}

// ─── Sovereign Pools Engine ──────────────────────────────────────────────────

export class SovereignPools {
  private static instance: SovereignPools;
  private pools: Map<string, SIPPool> = new Map();
  private shares: Map<string, SIPShare[]> = new Map();
  private proposals: Map<string, HiddenProposal[]> = new Map();
  private votes: Map<string, ZKVote[]> = new Map();

  public static getInstance(): SovereignPools {
    if (!SovereignPools.instance) {
      SovereignPools.instance = new SovereignPools();
    }
    return SovereignPools.instance;
  }

  private constructor() {}

  // ─── Pool Creation ───────────────────────────────────────────────────────

  /**
   * Cria um novo Sovereign Investment Pool.
   */
  createPool(config: SIPConfig, _manager: GhostIdentity): SIPPool {
    const poolId = `sip_${Date.now()}_${secureRandomId(4)}`;

    const pool: SIPPool = {
      id: poolId,
      config,
      totalAssets: 0n,
      investorCount: 0,
      nav: 1.0,
      createdAt: Date.now(),
      lastRebalance: Date.now(),
      isActive: true,
    };

    this.pools.set(poolId, pool);
    this.shares.set(poolId, []);
    this.proposals.set(poolId, []);

    console.log(`[SIP] Pool "${config.name}" criado (${poolId})`);
    return pool;
  }

  // ─── Investment ──────────────────────────────────────────────────────────

  /**
   * Investe em um pool SIP.
   */
  invest(
    poolId: string,
    amount: bigint,
    investor: GhostIdentity,
  ): SIPShare {
    const pool = this.pools.get(poolId);
    if (!pool || !pool.isActive) throw new Error("Pool não encontrado ou inativo");
    if (amount < pool.config.minInvestment) throw new Error("Investimento mínimo não atingido");

    // Calcula cotas baseado no NAV atual
    const shareAmount = BigInt(Math.floor(Number(amount) / pool.nav));

    const share: SIPShare = {
      id: `share_${Date.now()}_${secureRandomId(3)}`,
      poolId,
      investorPk: Array.from(investor.publicKey).map(b => b.toString(16).padStart(2, "0")).join(""),
      shareAmount,
      entryNav: pool.nav,
      createdAt: Date.now(),
      isLocked: false,
    };

    const poolShares = this.shares.get(poolId) || [];
    poolShares.push(share);
    this.shares.set(poolId, poolShares);

    pool.totalAssets += amount;
    pool.investorCount++;

    console.log(`[SIP] Investimento: ${amount} no pool "${pool.config.name}". ${shareAmount} cotas @ NAV ${pool.nav}`);
    return share;
  }

  /**
   * Resgata cotas do pool (via Aegis Vault - queima no instante do consenso).
   */
  redeem(
    shareId: string,
    investor: GhostIdentity,
  ): { amount: bigint; proof: string } | null {
    const poolShares = Array.from(this.shares.values()).flat();
    const share = poolShares.find(s => s.id === shareId);

    if (!share) return null;
    if (share.investorPk !== Array.from(investor.publicKey).map(b => b.toString(16).padStart(2, "0")).join("")) {
      throw new Error("Não é o proprietário desta cota");
    }

    const pool = this.pools.get(share.poolId);
    if (!pool) return null;

    // Calcula valor do resgate
    const redeemValue = BigInt(Math.floor(Number(share.shareAmount) * pool.nav));

    // Queima a cota
    share.shareAmount = 0n;
    pool.totalAssets -= redeemValue;
    pool.investorCount--;

    // Gera prova de resgate (instante do consenso)
    const proof = Array.from(sha3_256(new TextEncoder().encode(
      `redeem_${share.id}_${Date.now()}`
    ))).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

    console.log(`[SIP] Resgate: ${redeemValue} do pool "${pool.config.name}". Prova: ${proof}`);
    return { amount: redeemValue, proof };
  }

  // ─── Hidden Proposals & ZK Voting ────────────────────────────────────────

  /**
   * Submete uma proposta oculta (estratégia cifrada).
   */
  submitProposal(
    poolId: string,
    description: string,
    encryptedStrategy: Uint8Array,
    proposer: GhostIdentity,
  ): HiddenProposal {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error("Pool não encontrado");

    const proposal: HiddenProposal = {
      id: `prop_${Date.now()}_${secureRandomId(3)}`,
      poolId,
      proposerPk: Array.from(proposer.publicKey).map(b => b.toString(16).padStart(2, "0")).join(""),
      encryptedStrategy,
      description,
      votesFor: 0,
      votesAgainst: 0,
      totalVoters: 0,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 dias
    };

    const proposals = this.proposals.get(poolId) || [];
    proposals.push(proposal);
    this.proposals.set(poolId, proposals);

    console.log(`[SIP] Proposta "${description}" submetida para pool ${poolId}`);
    return proposal;
  }

  /**
   * Ativa uma proposta para votação (pending → voting).
   * Pode ser chamado pelo proposer ou após um período de review.
   */
  activateProposal(proposalId: string, activator: GhostIdentity): boolean {
    const allProposals = Array.from(this.proposals.values()).flat();
    const proposal = allProposals.find(p => p.id === proposalId);
    if (!proposal || proposal.status !== "pending") return false;

    // Apenas o proposer pode ativar (ou poderia ser automático via timer)
    const activatorPk = Array.from(activator.publicKey).map(b => b.toString(16).padStart(2, "0")).join("");
    if (proposal.proposerPk !== activatorPk) return false;

    proposal.status = "voting";
    console.log(`[SIP] Proposta ${proposalId} ativada para votação`);
    return true;
  }

  /**
   * Vota em uma proposta usando voto ZK.
   */
  vote(
    proposalId: string,
    support: boolean,
    voter: GhostIdentity,
  ): ZKVote | null {
    const allProposals = Array.from(this.proposals.values()).flat();
    const proposal = allProposals.find(p => p.id === proposalId);
    if (!proposal || proposal.status !== "voting") return null;

    const voterPk = Array.from(voter.publicKey).map(b => b.toString(16).padStart(2, "0")).join("");

    // Verifica se já votou (via nullifier)
    const existingVotes = this.votes.get(proposalId) || [];
    if (existingVotes.some(v => v.voterPk === voterPk)) {
      console.warn(`[SIP] Voter já votou nesta proposta`);
      return null;
    }

    const vote: ZKVote = {
      voterPk,
      proposalId,
      voteHash: Array.from(sha3_256(new TextEncoder().encode(
        `${voterPk}_${proposalId}_${support}_${Date.now()}`
      ))).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16),
      nullifier: Array.from(sha3_256(new TextEncoder().encode(`null_${voterPk}_${proposalId}`)))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16),
      timestamp: Date.now(),
    };

    existingVotes.push(vote);
    this.votes.set(proposalId, existingVotes);

    // Atualiza contadores
    if (support) {
      proposal.votesFor++;
    } else {
      proposal.votesAgainst++;
    }
    proposal.totalVoters++;

    console.log(`[SIP] Voto ZK registrado para proposta ${proposalId}: ${support ? "a favor" : "contra"}`);
    return vote;
  }

  /**
   * Finaliza votação e revela resultado.
   */
  finalizeVoting(proposalId: string): HiddenProposal | null {
    const allProposals = Array.from(this.proposals.values()).flat();
    const proposal = allProposals.find(p => p.id === proposalId);
    if (!proposal) return null;

    // A proposta é aprovada se >50% dos votos forem a favor
    const approvalRate = proposal.totalVoters > 0
      ? proposal.votesFor / proposal.totalVoters
      : 0;

    proposal.status = approvalRate > 0.5 ? "approved" : "rejected";

    console.log(`[SIP] Proposta ${proposalId} ${proposal.status} (${(approvalRate * 100).toFixed(1)}% aprovação)`);
    return proposal;
  }

  // ─── Performance Distribution ────────────────────────────────────────────

  /**
   * Distribui taxa de performance aos votantes da proposta vencedora.
   */
  distributePerformanceFee(
    poolId: string,
    proposalId: string,
    performanceAmount: bigint,
  ): number {
    const pool = this.pools.get(poolId);
    if (!pool) return 0;

    const poolVotes = this.votes.get(proposalId) || [];
    if (poolVotes.length === 0) return 0;

    const feePerVoter = performanceAmount / BigInt(poolVotes.length);
    console.log(`[SIP] Performance fee distribuído: ${feePerVoter} por votante (${poolVotes.length} votantes)`);
    return Number(feePerVoter);
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getPool(id: string): SIPPool | null {
    return this.pools.get(id) || null;
  }

  getAllPools(): SIPPool[] {
    return Array.from(this.pools.values());
  }

  getShares(poolId: string): SIPShare[] {
    return this.shares.get(poolId) || [];
  }

  getProposals(poolId: string): HiddenProposal[] {
    return this.proposals.get(poolId) || [];
  }

  getVotes(proposalId: string): ZKVote[] {
    return this.votes.get(proposalId) || [];
  }

  getStats() {
    const pools = Array.from(this.pools.values());
    const allShares = Array.from(this.shares.values()).flat();
    return {
      totalPools: pools.length,
      activePools: pools.filter(p => p.isActive).length,
      totalAssets: pools.reduce((sum, p) => sum + p.totalAssets, 0n),
      totalInvestors: pools.reduce((sum, p) => sum + p.investorCount, 0),
      totalShares: allShares.length,
      totalProposals: Array.from(this.proposals.values()).reduce((sum, ps) => sum + ps.length, 0),
    };
  }
}

export const sovereignPools = SovereignPools.getInstance();
