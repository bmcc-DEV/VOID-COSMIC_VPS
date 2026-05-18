/**
 * ETΞRNET — QuantumDAO: Governança Quântica Pura (Path 3)
 *
 * DAO descentralizada sem banco, sem NFTs fixos.
 * Governança pura via votação quadrática, delegação parcial
 * e execução automática de propostas.
 *
 * Princípios:
 * - Sem ponto central de controle
 * - Votação quadrática previne plutocracia
 * - Delegação parcial (weight 0-1)
 * - Propostas de emergência com quórum maior
 * - Execução transparente e rastreável
 *
 * Referência: "O Livro do ETRNET" — Path 3: Governança Quântica
 */

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Status possíveis de uma proposta */
export type ProposalStatus =
  | "pending"
  | "active"
  | "passed"
  | "rejected"
  | "executed"
  | "expired";

/** Categorias de propostas com parâmetros distintos */
export type ProposalCategory =
  | "treasury"
  | "parameter"
  | "upgrade"
  | "emergency"
  | "community";

/** Registro de voto individual */
export interface VoteRecord {
  side: "for" | "against";
  rawAmount: number;
  quadraticWeight: number;
}

/** Proposta da DAO */
export interface Proposal {
  id: string;
  title: string;
  description: string;
  category: ProposalCategory;
  proposerPk: string;
  status: ProposalStatus;
  createdAt: number;
  votingEndsAt: number;
  executionDelay: number;
  quorumRequired: number;
  votesFor: number;
  votesAgainst: number;
  voters: Map<string, VoteRecord>;
  executionPayload: {
    target: string;
    value: bigint;
    calldata: string;
  } | null;
}

/** Delegação parcial de voto */
export interface Delegation {
  delegator: string;
  delegate: string;
  weight: number;
  createdAt: number;
}

/** Resultado da apuração de votos */
export interface TallyResult {
  proposalId: string;
  totalVotesFor: number;
  totalVotesAgainst: number;
  quorumMet: boolean;
  participation: number;
  passed: boolean;
  voterCount: number;
}

/** Configuração da DAO */
export interface DAOConfig {
  votingPeriodMs: number;
  executionDelayMs: number;
  quorumThreshold: number;
  proposalThreshold: number;
  emergencyVotingPeriodMs: number;
  emergencyQuorum: number;
}

// ─── Configuração padrão ─────────────────────────────────────────────────────

const DEFAULT_CONFIG: DAOConfig = {
  votingPeriodMs: 3 * 24 * 60 * 60 * 1000, // 3 dias
  executionDelayMs: 2 * 24 * 60 * 60 * 1000, // 2 dias
  quorumThreshold: 0.1, // 10% do SOV staked
  proposalThreshold: 1000, // mínimo de SOV para propor
  emergencyVotingPeriodMs: 6 * 60 * 60 * 1000, // 6 horas
  emergencyQuorum: 0.3, // 30%
};

/** Multiplicadores de threshold por categoria */
const CATEGORY_MULTIPLIERS: Record<ProposalCategory, number> = {
  treasury: 1.5,
  parameter: 1.0,
  upgrade: 2.0,
  emergency: 0.5,
  community: 0.8,
};

// ─── QuantumDAO (Singleton) ──────────────────────────────────────────────────

/**
 * Motor de governança quântica descentralizada.
 *
 * Votação quadrática: peso = sqrt(quantidade) para prevenir plutocracia.
 * Delegação parcial: delegador pode transferir fração do poder de voto.
 * Propostas de emergência: período menor, quórum maior.
 */
export class QuantumDAO {
  private static instance: QuantumDAO;

  private proposals: Map<string, Proposal> = new Map();
  private delegations: Map<string, Delegation> = new Map();
  private config: DAOConfig = { ...DEFAULT_CONFIG };

  /** Stakes de SOV registrados (pk → amount) para cálculo de quórum */
  private stakedBalances: Map<string, number> = new Map();

  public static getInstance(): QuantumDAO {
    if (!QuantumDAO.instance) {
      QuantumDAO.instance = new QuantumDAO();
    }
    return QuantumDAO.instance;
  }

  private constructor() {
    console.log("[QuantumDAO] Motor de governança quântica inicializado.");
  }

  // ─── Registro de Stakes ──────────────────────────────────────────────────

  /**
   * Registra ou atualiza o saldo staked de um participante.
   * Usado para calcular quórum relativo ao total staked.
   */
  registerStake(pk: string, amount: number): void {
    this.stakedBalances.set(pk, amount);
  }

  /**
   * Retorna o total de SOV staked registrado.
   */
  getTotalStaked(): number {
    let total = 0;
    for (const [, amount] of this.stakedBalances) {
      total += amount;
    }
    return total;
  }

  // ─── Propostas ───────────────────────────────────────────────────────────

  /**
   * Cria uma nova proposta na DAO.
   *
   * Verifica se o proponente tem SOV staked suficiente
   * baseado na categoria e no threshold configurado.
   *
   * @param title - Título da proposta
   * @param description - Descrição detalhada
   * @param category - Categoria da proposta
   * @param proposerPk - Chave pública do proponente (hex)
   * @param executionPayload - Payload opcional para execução automática
   * @returns A proposta criada
   * @throws Error se o proponente não tem stake suficiente
   */
  createProposal(
    title: string,
    description: string,
    category: ProposalCategory,
    proposerPk: string,
    executionPayload: Proposal["executionPayload"] = null
  ): Proposal {
    const stakedAmount = this.stakedBalances.get(proposerPk) ?? 0;
    const requiredStake =
      this.config.proposalThreshold * CATEGORY_MULTIPLIERS[category];

    if (stakedAmount < requiredStake) {
      throw new Error(
        `Stake insuficiente para propor: necessário ${requiredStake}, disponível ${stakedAmount}`
      );
    }

    const isEmergency = category === "emergency";
    const votingPeriod = isEmergency
      ? this.config.emergencyVotingPeriodMs
      : this.config.votingPeriodMs;
    const quorum = isEmergency
      ? this.config.emergencyQuorum
      : this.config.quorumThreshold;

    const id = `prop_${Date.now()}_${secureRandomId(4)}`;
    const now = Date.now();

    const proposal: Proposal = {
      id,
      title,
      description,
      category,
      proposerPk,
      status: "active",
      createdAt: now,
      votingEndsAt: now + votingPeriod,
      executionDelay: this.config.executionDelayMs,
      quorumRequired: quorum,
      votesFor: 0,
      votesAgainst: 0,
      voters: new Map(),
      executionPayload,
    };

    this.proposals.set(id, proposal);

    console.log(
      `[QuantumDAO] Proposta criada: ${id} (${category}) ` +
        `votação até ${new Date(proposal.votingEndsAt).toISOString()}`
    );

    return proposal;
  }

  /**
   * Emite um voto quadrático em uma proposta.
   *
   * Peso do voto = sqrt(rawAmount)
   * Isso garante que grandes detentores não dominem a votação.
   *
   * @param proposalId - ID da proposta
   * @param voterPk - Chave pública do votante (hex)
   * @param side - "for" ou "against"
   * @param rawAmount - Quantidade de SOV comprometida no voto
   * @throws Error se a proposta não existe, votação encerrada, ou votante já votou
   */
  castVote(
    proposalId: string,
    voterPk: string,
    side: "for" | "against",
    rawAmount: number
  ): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposta não encontrada: ${proposalId}`);
    }

    if (proposal.status !== "active") {
      throw new Error(`Proposta não está ativa: ${proposal.status}`);
    }

    if (Date.now() > proposal.votingEndsAt) {
      throw new Error("Período de votação encerrado");
    }

    if (proposal.voters.has(voterPk)) {
      throw new Error("Votante já votou nesta proposta");
    }

    if (rawAmount <= 0) {
      throw new Error("Valor de voto deve ser positivo");
    }

    // Votação quadrática: peso = sqrt(quantidade)
    const quadraticWeight = Math.sqrt(rawAmount);

    const voteRecord: VoteRecord = {
      side,
      rawAmount,
      quadraticWeight,
    };

    proposal.voters.set(voterPk, voteRecord);

    if (side === "for") {
      proposal.votesFor += quadraticWeight;
    } else {
      proposal.votesAgainst += quadraticWeight;
    }

    console.log(
      `[QuantumDAO] Voto registrado: ${proposalId} ` +
        `${side} raw=${rawAmount} peso=${quadraticWeight.toFixed(4)}`
    );
  }

  // ─── Delegação ───────────────────────────────────────────────────────────

  /**
   * Delega parcialmente o poder de voto para outro participante.
   *
   * Suporta delegação parcial (weight 0-1).
   * Votos do delegatário incluem o peso delegado automaticamente.
   *
   * @param delegator - Quem delega (hex pk)
   * @param delegate - Quem recebe a delegação (hex pk)
   * @param weight - Fração do poder de voto delegada (0-1)
   * @throws Error se weight fora do intervalo ou auto-delegação
   */
  delegateVote(delegator: string, delegate: string, weight: number): void {
    if (delegator === delegate) {
      throw new Error("Auto-delegação não é permitida");
    }

    if (weight < 0 || weight > 1) {
      throw new Error("Peso de delegação deve estar entre 0 e 1");
    }

    const delegation: Delegation = {
      delegator,
      delegate,
      weight,
      createdAt: Date.now(),
    };

    this.delegations.set(delegator, delegation);

    console.log(
      `[QuantumDAO] Delegação registrada: ${delegator.slice(0, 8)}… → ` +
        `${delegate.slice(0, 8)}… (peso: ${weight})`
    );
  }

  /**
   * Revoga uma delegação de voto.
   *
   * @param delegator - Quem revoga (hex pk)
   */
  revokeDelegation(delegator: string): void {
    const existed = this.delegations.delete(delegator);
    if (existed) {
      console.log(
        `[QuantumDAO] Delegação revogada: ${delegator.slice(0, 8)}…`
      );
    }
  }

  // ─── Apuração ────────────────────────────────────────────────────────────

  /**
   * Apura os votos de uma proposta incluindo delegações.
   *
   * Para cada votante que recebeu delegações, seu peso de voto
   * é multiplicado por (1 + Σ weight_delegações).
   *
   * @param proposalId - ID da proposta
   * @returns Resultado da apuração
   * @throws Error se a proposta não existe
   */
  tallyVotes(proposalId: string): TallyResult {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposta não encontrada: ${proposalId}`);
    }

    // Recalcula pesos incluindo delegações
    let adjustedVotesFor = 0;
    let adjustedVotesAgainst = 0;

    // Coleta pesos de delegação por delegate
    const delegationWeights = new Map<string, number>();
    for (const [, delegation] of this.delegations) {
      const current = delegationWeights.get(delegation.delegate) ?? 0;
      delegationWeights.set(
        delegation.delegate,
        current + delegation.weight
      );
    }

    for (const [voterPk, voteRecord] of proposal.voters) {
      // Bônus de delegação: se este votante recebeu delegações,
      // seu peso é amplificado
      const delegationBonus = delegationWeights.get(voterPk) ?? 0;
      const adjustedWeight =
        voteRecord.quadraticWeight * (1 + delegationBonus);

      if (voteRecord.side === "for") {
        adjustedVotesFor += adjustedWeight;
      } else {
        adjustedVotesAgainst += adjustedWeight;
      }
    }

    // Calcula participação relativa ao total staked
    const totalStaked = this.getTotalStaked();
    const totalVotingPower = adjustedVotesFor + adjustedVotesAgainst;
    const participation = totalStaked > 0 ? totalVotingPower / totalStaked : 0;

    const quorumMet = participation >= proposal.quorumRequired;
    const passed = quorumMet && adjustedVotesFor > adjustedVotesAgainst;

    return {
      proposalId,
      totalVotesFor: adjustedVotesFor,
      totalVotesAgainst: adjustedVotesAgainst,
      quorumMet,
      participation,
      passed,
      voterCount: proposal.voters.size,
    };
  }

  // ─── Finalização e Execução ──────────────────────────────────────────────

  /**
   * Finaliza uma proposta após o período de votação.
   *
   * Muda o status para "passed" ou "rejected" baseado na apuração.
   * Só pode ser chamada após votingEndsAt.
   *
   * @param proposalId - ID da proposta
   * @returns Resultado da apuração
   * @throws Error se a proposta não existe ou votação ainda não encerrou
   */
  finalizeProposal(proposalId: string): TallyResult {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposta não encontrada: ${proposalId}`);
    }

    if (Date.now() < proposal.votingEndsAt) {
      throw new Error("Período de votação ainda não encerrou");
    }

    if (proposal.status !== "active") {
      throw new Error(`Proposta não está ativa: ${proposal.status}`);
    }

    const result = this.tallyVotes(proposalId);

    proposal.status = result.passed ? "passed" : "rejected";

    console.log(
      `[QuantumDAO] Proposta ${proposalId} finalizada: ${proposal.status} ` +
        `(for: ${result.totalVotesFor.toFixed(4)}, ` +
        `against: ${result.totalVotesAgainst.toFixed(4)}, ` +
        `quórum: ${result.quorumMet ? "sim" : "não"})`
    );

    return result;
  }

  /**
   * Executa uma proposta aprovada após o delay de execução.
   *
   * Retorna o payload de execução para que o chamador possa
   * aplicar as mudanças (transferir fundos do tesouro, atualizar
   * parâmetros, etc.).
   *
   * @param proposalId - ID da proposta
   * @returns Payload de execução
   * @throws Error se a proposta não foi aprovada, delay não expirou, ou já foi executada
   */
  executeProposal(proposalId: string): NonNullable<Proposal["executionPayload"]> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposta não encontrada: ${proposalId}`);
    }

    if (proposal.status !== "passed") {
      throw new Error(
        `Proposta não foi aprovada (status: ${proposal.status})`
      );
    }

    if (!proposal.executionPayload) {
      throw new Error("Proposta não possui payload de execução");
    }

    const executionReadyAt =
      proposal.votingEndsAt + proposal.executionDelay;
    if (Date.now() < executionReadyAt) {
      const remaining = executionReadyAt - Date.now();
      throw new Error(
        `Delay de execução não expirou. Restante: ${Math.ceil(remaining / 60000)} minutos`
      );
    }

    proposal.status = "executed";

    console.log(
      `[QuantumDAO] Proposta ${proposalId} executada: ` +
        `target=${proposal.executionPayload.target} ` +
        `value=${proposal.executionPayload.value}`
    );

    return proposal.executionPayload;
  }

  // ─── Consultas ───────────────────────────────────────────────────────────

  /**
   * Retorna uma proposta pelo ID.
   */
  getProposal(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  /**
   * Retorna todas as propostas.
   */
  getAllProposals(): Proposal[] {
    return Array.from(this.proposals.values());
  }

  /**
   * Retorna propostas filtradas por status.
   */
  getProposalsByStatus(status: ProposalStatus): Proposal[] {
    return this.getAllProposals().filter((p) => p.status === status);
  }

  /**
   * Retorna propostas filtradas por categoria.
   */
  getProposalsByCategory(category: ProposalCategory): Proposal[] {
    return this.getAllProposals().filter((p) => p.category === category);
  }

  /**
   * Retorna todas as delegações ativas.
   */
  getDelegations(): Delegation[] {
    return Array.from(this.delegations.values());
  }

  /**
   * Retorna a delegação de um participante específico.
   */
  getDelegation(delegator: string): Delegation | undefined {
    return this.delegations.get(delegator);
  }

  /**
   * Retorna a configuração atual da DAO.
   */
  getConfig(): DAOConfig {
    return { ...this.config };
  }

  /**
   * Atualiza parcialmente a configuração da DAO.
   *
   * @param partial - Valores de configuração a serem mesclados
   */
  updateConfig(partial: Partial<DAOConfig>): void {
    this.config = { ...this.config, ...partial };
    console.log("[QuantumDAO] Configuração atualizada:", partial);
  }
}

import { secureRandomId } from "../utils/secureRandom";

/** Instância singleton da QuantumDAO */
export const quantumDAO = QuantumDAO.getInstance();
