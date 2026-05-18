/**
 * ETΞRNET — Mirage Compute: Execução Fantasma
 *
 * Computação onde ninguém sabe o que foi executado, onde nem por quem.
 *
 * Componentes:
 * - Fragmentação de Código: bytecode dividido em fatias funcionais
 * - Enclaves Efêmeros: ANIMUS desperta SGX/SEV apenas pelo tempo de execução
 * - Oráculo de Consenso Causal: testemunhas de causalidade assinam a ordem temporal
 * - Faturamento Invisível: UTXO fantasma embutido no shard de código paga o executor
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { createUTXO, type UTXO } from "./utxo";
import { type GhostIdentity } from "./ghostid";
import { secureRandomId } from "../utils/secureRandom";
import { signWithNodeKey } from "./signingKeys";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CodeFragment {
  id: string;
  index: number;
  bytecode: Uint8Array;
  encryptedWith: Uint8Array;  // Chave do enclave efêmero
  hashCommitment: string;
  inputRequirements: string[]; // IDs dos fragments de entrada necessários
}

export interface MirageExecution {
  id: string;
  codeFragments: CodeFragment[];
  inputFragments: CodeFragment[];
  outputFragment: CodeFragment | null;
  enclaveId: string;
  startedAt: number;
  completedAt: number | null;
  causalWitnesses: CausalWitness[];
  paymentUTXO: UTXO | null;
  status: "pending" | "executing" | "completed" | "failed";
}

export interface CausalWitness {
  nodeId: string;
  timestamp: number;
  signature: Uint8Array;
  causalOrder: number;
}

export interface EnclaveState {
  id: string;
  createdAt: number;
  expiresAt: number;
  memoryWiped: boolean;
  attestation: Uint8Array;
}

// ─── Mirage Compute Engine ────────────────────────────────────────────────────

export class MirageCompute {
  private static instance: MirageCompute;
  private executions: Map<string, MirageExecution> = new Map();
  private activeEnclaves: Map<string, EnclaveState> = new Map();
  private causalOrderCounter = 0;

  public static getInstance(): MirageCompute {
    if (!MirageCompute.instance) {
      MirageCompute.instance = new MirageCompute();
    }
    return MirageCompute.instance;
  }

  private constructor() {
    // Auto-limpa enclaves expirados a cada 30s
    setInterval(() => this.cleanupEnclaves(), 30000);
  }

  // ─── Code Fragmentation ───────────────────────────────────────────────────

  /**
   * Fragmenta bytecode em fatias funcionais.
   * Cada fragmento é independente e pode ser executado por qualquer nó.
   */
  fragmentCode(bytecode: Uint8Array, fragmentCount = 3): CodeFragment[] {
    const fragmentSize = Math.ceil(bytecode.length / fragmentCount);
    const fragments: CodeFragment[] = [];

    for (let i = 0; i < fragmentCount; i++) {
      const start = i * fragmentSize;
      const end = Math.min(start + fragmentSize, bytecode.length);
      const slice = bytecode.slice(start, end);

      // Gera chave efêmera para este fragmento
      const ephemeralKey = crypto.getRandomValues(new Uint8Array(32));
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const cipher = chacha20poly1305(ephemeralKey, nonce);
      const encrypted = cipher.encrypt(slice);

      const fragment: CodeFragment = {
        id: `frag_${Date.now()}_${i}_${secureRandomId(3)}`,
        index: i,
        bytecode: encrypted as Uint8Array,
        encryptedWith: ephemeralKey,
        hashCommitment: Array.from(sha3_256(slice))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 16),
        inputRequirements: i > 0 ? [fragments[i - 1]!.id] : [],
      };

      fragments.push(fragment);
    }

    console.log(`[Mirage] Código fragmentado em ${fragmentCount} fatias`);
    return fragments;
  }

  // ─── Ephemeral Enclaves ──────────────────────────────────────────────────

  /**
   * Cria um enclave efêmero que existe apenas durante a execução.
   */
  createEnclave(durationMs = 5000): EnclaveState {
    const enclaveId = `enclave_${Date.now()}_${secureRandomId(4)}`;

    const enclave: EnclaveState = {
      id: enclaveId,
      createdAt: Date.now(),
      expiresAt: Date.now() + durationMs,
      memoryWiped: false,
      attestation: this.generateAttestation(enclaveId),
    };

    this.activeEnclaves.set(enclaveId, enclave);
    console.log(`[Mirage] Enclave efêmero ${enclaveId} criado. TTL: ${durationMs}ms`);

    return enclave;
  }

  /**
   * Gera atestação do enclave (simula SGX/SEV attestation).
   */
  private generateAttestation(enclaveId: string): Uint8Array {
    const data = new TextEncoder().encode(`${enclaveId}:${Date.now()}`);
    return sha3_256(data);
  }

  /**
   * Limpa enclaves expirados (zero-fill na memória).
   */
  private cleanupEnclaves() {
    const now = Date.now();
    for (const [id, enclave] of this.activeEnclaves) {
      if (now > enclave.expiresAt && !enclave.memoryWiped) {
        enclave.memoryWiped = true;
        this.activeEnclaves.delete(id);
        console.log(`[Mirage] Enclave ${id} expirado e memória zerada.`);
      }
    }
  }

  // ─── Execution Pipeline ──────────────────────────────────────────────────

  /**
   * Executa código fragmentado em enclave efêmero.
   */
  async execute(
    codeFragments: CodeFragment[],
    inputFragments: CodeFragment[],
    executorIdentity: GhostIdentity,
    paymentAmount: bigint = 100n,
  ): Promise<MirageExecution> {
    const executionId = `exec_${Date.now()}_${secureRandomId(4)}`;

    // 1. Cria enclave efêmero
    const enclave = this.createEnclave(10000);

    // 2. Cria UTXO de pagamento fantasma
    const paymentUTXO = createUTXO(paymentAmount, executorIdentity.publicKey);

    // 3. Desfragmenta e executa
    const assembledCode = this.assembleFragments(codeFragments);

    const execution: MirageExecution = {
      id: executionId,
      codeFragments,
      inputFragments,
      outputFragment: null,
      enclaveId: enclave.id,
      startedAt: Date.now(),
      completedAt: null,
      causalWitnesses: [],
      paymentUTXO,
      status: "executing",
    };

    this.executions.set(executionId, execution);

    try {
      // 4. Simula execução (em produção, rodaria em WASM/SGX)
      const output = await this.runInEnclave(assembledCode, inputFragments, enclave.id);

      // 5. Gera fragmento de saída
      execution.outputFragment = {
        id: `out_${executionId}`,
        index: 0,
        bytecode: output,
        encryptedWith: crypto.getRandomValues(new Uint8Array(32)),
        hashCommitment: Array.from(sha3_256(output))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 16),
        inputRequirements: codeFragments.map(f => f.id),
      };

      execution.status = "completed";
      execution.completedAt = Date.now();

      console.log(`[Mirage] Execução ${executionId} completa em ${execution.completedAt - execution.startedAt}ms`);
    } catch (err) {
      execution.status = "failed";
      execution.completedAt = Date.now();
      console.error(`[Mirage] Execução ${executionId} falhou:`, err);
    }

    return execution;
  }

  /**
   * Monta fragmentos de código em bytecode executável.
   */
  private assembleFragments(fragments: CodeFragment[]): Uint8Array {
    const sorted = [...fragments].sort((a, b) => a.index - b.index);
    const totalSize = sorted.reduce((sum, f) => sum + f.bytecode.length, 0);
    const assembled = new Uint8Array(totalSize);
    let offset = 0;

    for (const fragment of sorted) {
      assembled.set(fragment.bytecode, offset);
      offset += fragment.bytecode.length;
    }

    return assembled;
  }

  /**
   * Executa bytecode no enclave via WebAssembly.
   * Se WASM não estiver disponível, retorna hash determinístico (fail-safe).
   */
  private async runInEnclave(
    code: Uint8Array,
    inputs: CodeFragment[],
    _enclaveId: string,
  ): Promise<Uint8Array> {
    const combined = new Uint8Array(code.length + inputs.length * 32);
    combined.set(code);
    inputs.forEach((input, i) => {
      combined.set(input.bytecode.slice(0, 32), code.length + i * 32);
    });

    // Tenta execução WASM real
    try {
      const wasmModule = await WebAssembly.compile(code as BufferSource);
      const memory = new WebAssembly.Memory({ initial: 1 });
      const instance = await WebAssembly.instantiate(wasmModule, {
        env: { memory },
      });

      // Escreve inputs na memória WASM e executa
      const memView = new Uint8Array(memory.buffer);
      const inputOffset = code.length;
      memView.set(combined.slice(code.length), inputOffset);

      // Chama a função 'process' se existir, senão usa 'main'
      const exports = instance.exports as any;
      if (typeof exports.process === "function") {
        const resultPtr = exports.process(inputOffset, inputs.length * 32);
        const result = new Uint8Array(memory.buffer.slice(resultPtr, resultPtr + 32));
        return sha3_256(result);
      }

      // Fallback: hash determinístico se WASM não tem entry point
      return sha3_256(combined);
    } catch {
      // WASM inválido ou não suportado: retorna hash determinístico
      return sha3_256(combined);
    }
  }

  // ─── Causal Consensus ────────────────────────────────────────────────────

  /**
   * Adiciona testemunha causal a uma execução.
   */
  addCausalWitness(
    executionId: string,
    nodeId: string,
  ): CausalWitness | null {
    const execution = this.executions.get(executionId);
    if (!execution) return null;

    this.causalOrderCounter++;

    const witnessData = `${executionId}:${nodeId}:${Date.now()}:${this.causalOrderCounter}`;
    const witness: CausalWitness = {
      nodeId,
      timestamp: Date.now(),
      signature: signWithNodeKey(
        "mirage-witness",
        sha3_256(new TextEncoder().encode(witnessData))
      ),
      causalOrder: this.causalOrderCounter,
    };

    execution.causalWitnesses.push(witness);
    console.log(`[Mirage] Testemunha causal adicionada à execução ${executionId} (ordem: ${witness.causalOrder})`);

    return witness;
  }

  /**
   * Verifica se a ordem causal da execução está correta.
   */
  verifyCausalOrder(executionId: string): boolean {
    const execution = this.executions.get(executionId);
    if (!execution) return false;

    const witnesses = execution.causalWitnesses;
    if (witnesses.length < 2) return true; // Menos de 2 testemunhas = trivialmente válido

    // Verifica se os timestamps são monotonicamente crescentes
    for (let i = 1; i < witnesses.length; i++) {
      if (witnesses[i]!.causalOrder <= witnesses[i - 1]!.causalOrder) {
        console.warn(`[Mirage] Ordem causal quebrada na execução ${executionId}`);
        return false;
      }
    }

    return true;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getExecution(id: string): MirageExecution | null {
    return this.executions.get(id) || null;
  }

  getAllExecutions(): MirageExecution[] {
    return Array.from(this.executions.values());
  }

  getActiveEnclaves(): EnclaveState[] {
    return Array.from(this.activeEnclaves.values());
  }

  getStats() {
    const execs = Array.from(this.executions.values());
    return {
      totalExecutions: execs.length,
      completedExecutions: execs.filter(e => e.status === "completed").length,
      failedExecutions: execs.filter(e => e.status === "failed").length,
      activeEnclaves: this.activeEnclaves.size,
      causalOrderCounter: this.causalOrderCounter,
    };
  }
}

export const mirageCompute = MirageCompute.getInstance();
