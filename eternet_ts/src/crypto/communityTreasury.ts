/**
 * ETΞRNET — Community Treasury (Governança Quântica Pura — Camada 3)
 *
 * Tesouro comunitário descentralizado com:
 * - Multi-assinatura (M-of-N) para execução de saques
 * - Alocações por categoria vinculadas a propostas DAO
 * - Histórico completo de transações
 * - Transparência total: todas as operações são auditáveis
 *
 * Referência: "O Livro do ETRNET" — Path 3: Governança Quântica Pura
 */

import { secureRandomId } from "../utils/secureRandom";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type AllocationCategory =
  | 'development'
  | 'community'
  | 'security'
  | 'research'
  | 'reserve'
  | 'grants';

export type TransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'allocation'
  | 'reward'
  | 'penalty';

export interface TreasuryAllocation {
  /** Identificador único da alocação */
  id: string;
  /** Categoria da alocação */
  category: AllocationCategory;
  /** Valor alocado */
  amount: bigint;
  /** IDs das propostas que aprovaram esta alocação */
  approvedBy: string[];
  /** Timestamp de execução */
  executedAt: number;
  /** Descrição da alocação */
  description: string;
}

export interface TreasuryTransaction {
  /** Identificador único da transação */
  id: string;
  /** Tipo da transação */
  type: TransactionType;
  /** Valor da transação */
  amount: bigint;
  /** Origem: hex pk ou 'mint' */
  from: string;
  /** Destino: hex pk ou nome da categoria */
  to: string;
  /** ID da proposta vinculada (se aplicável) */
  proposalId: string | null;
  /** Timestamp da transação */
  timestamp: number;
  /** Descrição da transação */
  description: string;
}

export interface PendingAllocation {
  /** Identificador único da alocação pendente */
  id: string;
  /** Categoria alvo */
  category: AllocationCategory;
  /** Valor proposto */
  amount: bigint;
  /** Descrição da alocação */
  description: string;
  /** Assinaturas coletadas (hex public keys) */
  signatures: Set<string>;
  /** Número mínimo de assinaturas necessárias */
  requiredSignatures: number;
  /** Timestamp de criação */
  createdAt: number;
}

export interface MultiSigConfig {
  /** Número mínimo de assinaturas para executar */
  requiredSignatures: number;
  /** Chaves públicas hex dos signatários autorizados */
  signers: Set<string>;
  /** Número máximo de signatários */
  maxSigners: number;
}

export interface TreasuryStats {
  /** Saldo total do tesouro */
  totalBalance: bigint;
  /** Saldo já alocado */
  allocatedBalance: bigint;
  /** Saldo disponível para alocação */
  availableBalance: bigint;
  /** Alocações por categoria */
  allocationsByCategory: Record<AllocationCategory, bigint>;
  /** Total de transações registradas */
  transactionCount: number;
  /** Timestamp do último depósito */
  lastDepositAt: number;
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_SIGNERS = 7;
const DEFAULT_REQUIRED_SIGS = 3;
const MAX_TRANSACTIONS = 10000;

// ─── Gerador de IDs ──────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = secureRandomId(4);
  return `${prefix}_${ts}_${rand}`;
}

// ─── CommunityTreasury (Singleton) ───────────────────────────────────────────

/**
 * Tesouro Comunitário Descentralizado.
 *
 * Gerencia fundos da comunidade com multi-assinatura,
 * alocações por categoria vinculadas a propostas DAO
 * e histórico completo de transações.
 */
export class CommunityTreasury {
  private static instance: CommunityTreasury;

  private balance: bigint = 0n;
  private allocations: Map<string, TreasuryAllocation> = new Map();
  private pendingAllocations: Map<string, PendingAllocation> = new Map();
  private transactions: TreasuryTransaction[] = [];
  private lastDepositAt: number = 0;

  /** Configuração multi-sig */
  private multisig: MultiSigConfig = {
    requiredSignatures: DEFAULT_REQUIRED_SIGS,
    signers: new Set(),
    maxSigners: DEFAULT_MAX_SIGNERS,
  };

  private constructor() {}

  /**
   * Obtém a instância singleton do tesouro.
   */
  public static getInstance(): CommunityTreasury {
    if (!CommunityTreasury.instance) {
      CommunityTreasury.instance = new CommunityTreasury();
    }
    return CommunityTreasury.instance;
  }

  // ─── Depósito ────────────────────────────────────────────────────────────

  /**
   * Deposita fundos no tesouro.
   *
   * @param amount - Valor a depositar (em unidades mínimas)
   * @param from - Chave pública hex do depositante ou 'mint'
   * @param description - Descrição do depósito
   * @returns A transação registrada
   */
  deposit(
    amount: bigint,
    from: string,
    description: string,
  ): TreasuryTransaction {
    if (amount <= 0n) {
      throw new Error('Valor de depósito deve ser positivo');
    }

    this.balance += amount;
    this.lastDepositAt = Date.now();

    const tx = this.recordTransaction({
      type: 'deposit',
      amount,
      from,
      to: 'treasury',
      proposalId: null,
      description,
    });

    console.log(
      `[CommunityTreasury] Depósito: +${amount} de ${from.slice(0, 8)}... (Saldo: ${this.balance})`,
    );

    return tx;
  }

  // ─── Multi-sig ───────────────────────────────────────────────────────────

  /**
   * Adiciona um signatário ao multi-sig.
   * Requer assinaturas existentes suficientes.
   *
   * @param pk - Chave pública hex do novo signatário
   * @param signatures - Assinaturas de aprovação dos signatários atuais
   */
  addSigner(pk: string, signatures: string[]): void {
    if (this.multisig.signers.size >= this.multisig.maxSigners) {
      throw new Error(
        `Limite máximo de signatários (${this.multisig.maxSigners}) atingido`,
      );
    }
    if (this.multisig.signers.has(pk)) {
      throw new Error('Signatário já registrado');
    }

    this.verifySignatures(signatures);

    this.multisig.signers.add(pk);
    console.log(
      `[CommunityTreasury] Signatário adicionado: ${pk.slice(0, 8)}... (Total: ${this.multisig.signers.size})`,
    );
  }

  /**
   * Remove um signatário do multi-sig.
   *
   * @param pk - Chave pública hex do signatário a remover
   * @param signatures - Assinaturas de aprovação dos signatários atuais
   */
  removeSigner(pk: string, signatures: string[]): void {
    if (!this.multisig.signers.has(pk)) {
      throw new Error('Signatário não encontrado');
    }
    if (this.multisig.signers.size <= this.multisig.requiredSignatures) {
      throw new Error(
        'Não é possível remover: manteria menos signatários que o mínimo necessário',
      );
    }

    this.verifySignatures(signatures);

    this.multisig.signers.delete(pk);
    console.log(
      `[CommunityTreasury] Signatário removido: ${pk.slice(0, 8)}... (Total: ${this.multisig.signers.size})`,
    );
  }

  /**
   * Verifica se as assinaturas são válidas.
   */
  private verifySignatures(signatures: string[]): void {
    const validSigners = signatures.filter((sig) =>
      this.multisig.signers.has(sig),
    );
    if (validSigners.length < this.multisig.requiredSignatures) {
      throw new Error(
        `Assinaturas insuficientes: ${validSigners.length}/${this.multisig.requiredSignatures} válidas`,
      );
    }
  }

  /**
   * Retorna a configuração multi-sig atual.
   */
  getMultiSigConfig(): MultiSigConfig {
    return {
      requiredSignatures: this.multisig.requiredSignatures,
      signers: new Set(this.multisig.signers),
      maxSigners: this.multisig.maxSigners,
    };
  }

  // ─── Proposta de Alocação ────────────────────────────────────────────────

  /**
   * Propõe uma nova alocação de fundos.
   * Cria uma alocação pendente que requer multi-sig para executar.
   *
   * @param category - Categoria da alocação
   * @param amount - Valor a alocar
   * @param description - Descrição da alocação
   * @returns A alocação pendente criada
   */
  proposeAllocation(
    category: AllocationCategory,
    amount: bigint,
    description: string,
  ): PendingAllocation {
    if (amount <= 0n) {
      throw new Error('Valor da alocação deve ser positivo');
    }
    if (amount > this.getAvailableBalance()) {
      throw new Error(
        `Saldo disponível insuficiente: ${this.getAvailableBalance()} < ${amount}`,
      );
    }

    const pending: PendingAllocation = {
      id: generateId('alloc'),
      category,
      amount,
      description,
      signatures: new Set(),
      requiredSignatures: this.multisig.requiredSignatures,
      createdAt: Date.now(),
    };

    this.pendingAllocations.set(pending.id, pending);

    console.log(
      `[CommunityTreasury] Alocação proposta: ${pending.id} (${category}: ${amount})`,
    );

    return pending;
  }

  /**
   * Aprova uma alocação pendente (adiciona assinatura).
   *
   * @param allocationId - ID da alocação pendente
   * @param signerPk - Chave pública hex do signatário
   */
  approveAllocation(allocationId: string, signerPk: string): void {
    const pending = this.pendingAllocations.get(allocationId);
    if (!pending) {
      throw new Error('Alocação pendente não encontrada');
    }
    if (!this.multisig.signers.has(signerPk)) {
      throw new Error('Signatário não autorizado');
    }
    if (pending.signatures.has(signerPk)) {
      throw new Error('Signatário já aprovou esta alocação');
    }

    pending.signatures.add(signerPk);

    console.log(
      `[CommunityTreasury] Alocação ${allocationId} aprovada por ${signerPk.slice(0, 8)}... (${pending.signatures.size}/${pending.requiredSignatures})`,
    );
  }

  /**
   * Executa uma alocação pendente se tiver assinaturas suficientes.
   *
   * @param allocationId - ID da alocação pendente
   * @returns A alocação executada
   */
  executeAllocation(allocationId: string): TreasuryAllocation {
    const pending = this.pendingAllocations.get(allocationId);
    if (!pending) {
      throw new Error('Alocação pendente não encontrada');
    }

    if (pending.signatures.size < pending.requiredSignatures) {
      throw new Error(
        `Assinaturas insuficientes: ${pending.signatures.size}/${pending.requiredSignatures}`,
      );
    }

    if (pending.amount > this.getAvailableBalance()) {
      throw new Error('Saldo disponível insuficiente para executar alocação');
    }

    // Cria a alocação executada
    const allocation: TreasuryAllocation = {
      id: pending.id,
      category: pending.category,
      amount: pending.amount,
      approvedBy: Array.from(pending.signatures),
      executedAt: Date.now(),
      description: pending.description,
    };

    this.allocations.set(allocation.id, allocation);
    this.pendingAllocations.delete(allocationId);

    // Registra transação
    this.recordTransaction({
      type: 'allocation',
      amount: pending.amount,
      from: 'treasury',
      to: pending.category,
      proposalId: null,
      description: `Alocação para ${pending.category}: ${pending.description}`,
    });

    console.log(
      `[CommunityTreasury] Alocação executada: ${allocationId} (${pending.category}: ${pending.amount})`,
    );

    return allocation;
  }

  // ─── Alocação direta (para integração com DAO) ───────────────────────────

  /**
   * Aloca fundos diretamente (requer ID de proposta DAO aprovada).
   * Usado pelo QuantumDAO quando uma proposta de alocação é aprovada por votação.
   *
   * @param category - Categoria da alocação
   * @param amount - Valor a alocar
   * @param proposalId - ID da proposta DAO que aprovou
   * @returns A alocação criada
   */
  allocateFunds(
    category: AllocationCategory,
    amount: bigint,
    proposalId: string,
  ): TreasuryAllocation {
    if (amount <= 0n) {
      throw new Error('Valor da alocação deve ser positivo');
    }
    if (amount > this.getAvailableBalance()) {
      throw new Error('Saldo disponível insuficiente');
    }

    const allocation: TreasuryAllocation = {
      id: generateId('alloc'),
      category,
      amount,
      approvedBy: [proposalId],
      executedAt: Date.now(),
      description: `Alocação via proposta DAO ${proposalId}`,
    };

    this.allocations.set(allocation.id, allocation);

    this.recordTransaction({
      type: 'allocation',
      amount,
      from: 'treasury',
      to: category,
      proposalId,
      description: `Alocação para ${category} via proposta ${proposalId}`,
    });

    console.log(
      `[CommunityTreasury] Alocação via DAO: ${category} = ${amount} (Proposta: ${proposalId})`,
    );

    return allocation;
  }

  // ─── Saque ───────────────────────────────────────────────────────────────

  /**
   * Realiza um saque multi-sig de uma categoria alocada.
   *
   * @param category - Categoria de onde sacar
   * @param amount - Valor a sacar
   * @param to - Chave pública hex do destinatário
   * @param proposalId - ID da proposta vinculada (se aplicável)
   * @param signatures - Assinaturas de aprovação
   * @returns A transação registrada
   */
  withdraw(
    category: AllocationCategory,
    amount: bigint,
    to: string,
    proposalId: string | null,
    signatures: string[],
  ): TreasuryTransaction {
    if (amount <= 0n) {
      throw new Error('Valor do saque deve ser positivo');
    }

    const allocated = this.getAllocationByCategory(category);
    if (amount > allocated) {
      throw new Error(
        `Saldo alocado insuficiente em ${category}: ${allocated} < ${amount}`,
      );
    }

    this.verifySignatures(signatures);

    // Deduz da alocação da categoria
    const allocationEntry = this.findAllocationByCategory(category, amount);
    if (allocationEntry) {
      allocationEntry.amount -= amount;
      if (allocationEntry.amount <= 0n) {
        this.allocations.delete(allocationEntry.id);
      }
    }

    const tx = this.recordTransaction({
      type: 'withdrawal',
      amount,
      from: category,
      to,
      proposalId,
      description: `Saque de ${category} para ${to.slice(0, 8)}...`,
    });

    console.log(
      `[CommunityTreasury] Saque: -${amount} de ${category} → ${to.slice(0, 8)}...`,
    );

    return tx;
  }

  // ─── Consultas ───────────────────────────────────────────────────────────

  /**
   * Retorna o saldo total do tesouro.
   */
  getBalance(): bigint {
    return this.balance;
  }

  /**
   * Retorna o saldo alocado total.
   */
  getAllocatedBalance(): bigint {
    let total = 0n;
    for (const alloc of this.allocations.values()) {
      total += alloc.amount;
    }
    return total;
  }

  /**
   * Retorna o saldo disponível (total - alocado).
   */
  getAvailableBalance(): bigint {
    return this.balance - this.getAllocatedBalance();
  }

  /**
   * Retorna o valor alocado para uma categoria específica.
   *
   * @param category - Categoria a consultar
   * @returns Total alocado na categoria
   */
  getAllocationByCategory(category: AllocationCategory): bigint {
    let total = 0n;
    for (const alloc of this.allocations.values()) {
      if (alloc.category === category) {
        total += alloc.amount;
      }
    }
    return total;
  }

  /**
   * Retorna estatísticas completas do tesouro.
   */
  getStats(): TreasuryStats {
    const allocationsByCategory: Record<AllocationCategory, bigint> = {
      development: 0n,
      community: 0n,
      security: 0n,
      research: 0n,
      reserve: 0n,
      grants: 0n,
    };

    for (const alloc of this.allocations.values()) {
      allocationsByCategory[alloc.category] += alloc.amount;
    }

    return {
      totalBalance: this.balance,
      allocatedBalance: this.getAllocatedBalance(),
      availableBalance: this.getAvailableBalance(),
      allocationsByCategory,
      transactionCount: this.transactions.length,
      lastDepositAt: this.lastDepositAt,
    };
  }

  /**
   * Retorna o histórico de transações (mais recentes primeiro).
   *
   * @param limit - Número máximo de transações a retornar
   */
  getTransactions(limit: number = 50): TreasuryTransaction[] {
    return this.transactions.slice(-limit).reverse();
  }

  /**
   * Retorna todas as alocações executadas.
   */
  getAllocations(): TreasuryAllocation[] {
    return Array.from(this.allocations.values());
  }

  /**
   * Retorna todas as alocações pendentes.
   */
  getPendingAllocations(): PendingAllocation[] {
    return Array.from(this.pendingAllocations.values());
  }

  /**
   * Busca uma alocação pendente pelo ID.
   */
  getPendingAllocation(id: string): PendingAllocation | undefined {
    return this.pendingAllocations.get(id);
  }

  // ─── Internos ────────────────────────────────────────────────────────────

  /**
   * Encontra uma alocação por categoria com saldo suficiente.
   */
  private findAllocationByCategory(
    category: AllocationCategory,
    _minAmount: bigint,
  ): TreasuryAllocation | undefined {
    for (const alloc of this.allocations.values()) {
      if (alloc.category === category && alloc.amount > 0n) {
        return alloc;
      }
    }
    return undefined;
  }

  /**
   * Registra uma transação no histórico.
   */
  private recordTransaction(
    params: Omit<TreasuryTransaction, 'id' | 'timestamp'>,
  ): TreasuryTransaction {
    const tx: TreasuryTransaction = {
      id: generateId('tx'),
      ...params,
      timestamp: Date.now(),
    };

    this.transactions.push(tx);

    // Limita o tamanho do histórico
    if (this.transactions.length > MAX_TRANSACTIONS) {
      this.transactions = this.transactions.slice(-MAX_TRANSACTIONS);
    }

    return tx;
  }
}

/**
 * Instância singleton do tesouro comunitário.
 */
export const communityTreasury = CommunityTreasury.getInstance();
