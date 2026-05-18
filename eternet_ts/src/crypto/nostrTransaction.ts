/**
 * ETΞRNET — Protocolo de Transação via NOSTR
 *
 * Transações UTXO cegas (Pedersen + Bulletproofs) transmitidas
 * como eventos NOSTR em kind 31214.
 *
 * Cada nó mantém:
 * - Set de nullifiers vistos (double-spend detection)
 * - Set de UTXOs não-gastos (aceitos como válidos)
 * - Histórico de transações (IndexedDB)
 *
 * Não há blockchain — consenso emerge dos relays NOSTR + validação local.
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { verifyRangeProof, verifyBalanceProof, type UTXO } from "./utxo";
import { mlDsaVerify } from "./pqc";

// ─── Constantes ──────────────────────────────────────────────────────────────

/** NOSTR event kind para transações ETRNET */
export const ETRNET_TX_KIND = 31214;

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Evento NOSTR contendo transação ETRNET */
export interface NostrTransaction {
  /** Event kind (sempre 31214) */
  kind: typeof ETRNET_TX_KIND;
  /** Tags do evento para indexação */
  tags: string[][];
  /** Dados serializados da transação */
  content: string;
  /** Timestamp de criação (segundos) */
  created_at: number;
}

/** Dados de transação ETRNET serializados */
export interface ETRTransactionData {
  /** Commitments de entrada (Pedersen) */
  inputs: string[];
  /** Commitments de saída (Pedersen) */
  outputs: string[];
  /** Bulletproof range proofs para outputs */
  rangeProofs: string[];
  /** Prova de balanço Pedersen */
  balanceProof: string;
  /** Nullifiers dos UTXOs gastos */
  nullifiers: string[];
  /** Assinatura ML-DSA */
  signature: string;
  /** Chave pública ML-DSA do remetente (hex) */
  senderPubKey: string;
  /** Versão do protocolo */
  version: number;
}

/** Entrada de nullifier no store */
export interface NullifierEntry {
  /** Hash do nullifier */
  nullifier: string;
  /** Timestamp de quando foi visto */
  seenAt: number;
  /** Relay de origem */
  relaySource: string;
  /** ID da transação vinculada */
  txId: string;
}

// ─── Nullifier Store ─────────────────────────────────────────────────────────

/**
 * Detecção de double-spend via set de nullifiers.
 * Cada nó mantém seu próprio set, sincronizado via NOSTR.
 */
class NullifierStore {
  private nullifiers: Map<string, NullifierEntry> = new Map();

  /**
   * Registra um nullifier.
   *
   * @returns true se é novo (aceito), false se já existe (double-spend)
   */
  add(entry: NullifierEntry): boolean {
    if (this.nullifiers.has(entry.nullifier)) {
      return false; // já visto — double-spend potencial
    }
    this.nullifiers.set(entry.nullifier, entry);
    return true;
  }

  /** Verifica se um nullifier já foi registrado */
  has(nullifier: string): boolean {
    return this.nullifiers.has(nullifier);
  }

  /** Retorna todos os nullifiers registrados */
  getAll(): NullifierEntry[] {
    return Array.from(this.nullifiers.values());
  }

  /** Número de nullifiers registrados */
  size(): number {
    return this.nullifiers.size;
  }
}

// ─── Funções de Protocolo ────────────────────────────────────────────────────

/** Converte hex string para Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Serialização canônica determinística para assinaturas criptográficas.
 *
 * JSON.stringify não garante ordem das chaves — V8 e SpiderMonkey podem
 * produzir JSONs diferentes para o mesmo objeto, quebrando assinaturas.
 *
 * Esta função ordena as chaves recursivamente e serializa em ordem alfabética.
 */
function canonicalStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalStringify).join(",")}]`;
  }
  if (typeof obj === "object") {
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const pairs = sortedKeys.map(
      k => `${JSON.stringify(k)}:${canonicalStringify((obj as Record<string, unknown>)[k])}`
    );
    return `{${pairs.join(",")}}`;
  }
  return String(obj);
}

/**
 * Cria um envelope NOSTR para transação ETRNET.
 * O chamador deve assinar com sua chave NOSTR usando nostr-tools.
 *
 * @param txData - Dados da transação
 * @returns Evento NOSTR pronto para assinatura e broadcast
 */
export function createTransactionEvent(
  txData: ETRTransactionData
): NostrTransaction {
  const txIdHash = sha3_256(
    new TextEncoder().encode(canonicalStringify(txData))
  );
  const txIdHex = Array.from(txIdHash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    kind: ETRNET_TX_KIND,
    tags: [
      ["t", "eternet_tx"],
      ["version", txData.version.toString()],
      ["sender_pubkey", txData.senderPubKey],
      ...txData.nullifiers.map((n) => ["nullifier", n]),
      ["txid", txIdHex],
    ],
    content: canonicalStringify(txData),
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Valida um evento de transação recebido.
 *
 * Verificações:
 * 1. Todos os nullifiers são novos (sem double-spend)
 * 2. Número correto de range proofs
 * 3. Inputs e outputs não vazios
 *
 * @param event - Evento NOSTR recebido
 * @param nullifierStore - Store local de nullifiers
 * @returns Resultado da validação
 */
export function validateTransaction(
  event: NostrTransaction,
  ns: NullifierStore
): { valid: boolean; error?: string } {
  try {
    const txData: ETRTransactionData = JSON.parse(event.content);

    // Verifica versão
    if (txData.version !== 1) {
      return { valid: false, error: `Versão desconhecida: ${txData.version}` };
    }

    // Verifica double-spend
    for (const nullifier of txData.nullifiers) {
      if (ns.has(nullifier)) {
        return {
          valid: false,
          error: `Nullifier já visto: ${nullifier.slice(0, 16)}...`,
        };
      }
    }

    // Verifica inputs
    if (txData.inputs.length === 0) {
      return { valid: false, error: "Sem inputs" };
    }

    // Verifica outputs
    if (txData.outputs.length === 0) {
      return { valid: false, error: "Sem outputs" };
    }

    // Verifica range proofs
    if (txData.rangeProofs.length !== txData.outputs.length) {
      return {
        valid: false,
        error: "Número de range proofs não corresponde a outputs",
      };
    }

    // ─── Verificação criptográfica (WASM + PQC) ─────────────────────────────
    // Se WASM não estiver inicializado, cai no fallback silencioso
    let cryptoVerified = false;

    try {
      // 1. Verifica Bulletproofs range proofs para cada output
      const outputCommitments = txData.outputs.map(hexToBytes);
      const rangeProofBytes = txData.rangeProofs.map(hexToBytes);

      for (let i = 0; i < outputCommitments.length; i++) {
        const rpValid = verifyRangeProof(outputCommitments[i], rangeProofBytes[i]);
        if (!rpValid) {
          return {
            valid: false,
            error: `Range proof inválido para output ${i}`,
          };
        }
      }

      // 2. Verifica Pedersen balance proof
      // Cria UTXOs sintéticos a partir dos commitments para verifyBalanceProof
      const dummyPk = new Uint8Array(32); // não usado na verificação
      const dummyBf = new Uint8Array(32); // não usado na verificação

      const inputUtxos: UTXO[] = txData.inputs.map((hex, i) => ({
        id: `input_${i}`,
        amount: 0n, // oculto pelo commitment
        commitment: hexToBytes(hex),
        blindingFactor: dummyBf,
        ownerPubKey: dummyPk,
        causalParents: [],
        createdAt: 0,
        spent: true,
      }));

      const outputUtxos: UTXO[] = txData.outputs.map((hex, i) => ({
        id: `output_${i}`,
        amount: 0n, // oculto pelo commitment
        commitment: hexToBytes(hex),
        blindingFactor: dummyBf,
        ownerPubKey: dummyPk,
        causalParents: [],
        createdAt: 0,
        spent: false,
      }));

      const balanceProofBytes = hexToBytes(txData.balanceProof);
      const balanceValid = verifyBalanceProof(inputUtxos, outputUtxos, balanceProofBytes);
      if (!balanceValid) {
        return {
          valid: false,
          error: "Pedersen balance proof inválido — inputs ≠ outputs",
        };
      }

      cryptoVerified = true;
    } catch (e) {
      // WASM não inicializado — rejeita transação (sem verificação cripto = sem confiança)
      return {
        valid: false,
        error: `Verificação criptográfica falhou (WASM não disponível): ${e instanceof Error ? e.message : e}`,
      };
    }

    // 3. Verifica ML-DSA signature (pós-quântica)
    try {
      if (txData.signature && txData.signature.length > 0 && txData.senderPubKey) {
        // A assinatura cobre o conteúdo serializado (sem a própria assinatura e sem senderPubKey)
        // Usa serialização canônica determinística — JSON.stringify não garante ordem de chaves
        const signedContent = canonicalStringify({
          inputs: txData.inputs,
          outputs: txData.outputs,
          rangeProofs: txData.rangeProofs,
          balanceProof: txData.balanceProof,
          nullifiers: txData.nullifiers,
          version: txData.version,
        });
        const message = new TextEncoder().encode(signedContent);
        const signatureBytes = hexToBytes(txData.signature);
        const pubKeyBytes = hexToBytes(txData.senderPubKey);

        const mldsaValid = mlDsaVerify(pubKeyBytes, message, signatureBytes);
        if (!mldsaValid) {
          return {
            valid: false,
            error: "Assinatura ML-DSA inválida — transação rejeitada",
          };
        }
        console.log("[NostrTx] Assinatura ML-DSA verificada com sucesso");
      }
    } catch (e) {
      // ML-DSA verification failure — rejeita transação
      return {
        valid: false,
        error: `Verificação ML-DSA falhou: ${e instanceof Error ? e.message : e}`,
      };
    }

    if (cryptoVerified) {
      console.log("[NostrTx] Transação validada com provas criptográficas completas");
    }

    return { valid: true };
  } catch {
    return { valid: false, error: "Dados de transação inválidos" };
  }
}

/**
 * Processa um evento de transação recebido via NOSTR.
 * Se válido, registra os nullifiers e retorna os dados.
 *
 * @param event - Evento NOSTR recebido
 * @param nullifierStore - Store local de nullifiers
 * @param relaySource - URL do relay de origem
 * @returns Dados da transação se válida, null caso contrário
 */
export function processIncomingTransaction(
  event: NostrTransaction,
  ns: NullifierStore,
  relaySource: string
): ETRTransactionData | null {
  const validation = validateTransaction(event, ns);
  if (!validation.valid) {
    console.warn(
      `[NostrTx] Transação rejeitada: ${validation.error}`
    );
    return null;
  }

  const txData: ETRTransactionData = JSON.parse(event.content);

  // Extrai senderPubKey das tags NOSTR se não estiver no conteúdo (backward compat)
  if (!txData.senderPubKey) {
    const pubKeyTag = event.tags.find(t => t[0] === "sender_pubkey");
    if (pubKeyTag && pubKeyTag[1]) {
      txData.senderPubKey = pubKeyTag[1];
    }
  }

  // Registra todos os nullifiers
  const txIdHash = sha3_256(
    new TextEncoder().encode(canonicalStringify(txData))
  );
  const txId = Array.from(txIdHash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  for (const nullifier of txData.nullifiers) {
    ns.add({
      nullifier,
      seenAt: Date.now(),
      relaySource,
      txId,
    });
  }

  console.log(
    `[NostrTx] Transação aceita: ${txId.slice(0, 16)}... ` +
      `(${txData.inputs.length} in, ${txData.outputs.length} out) via ${relaySource}`
  );

  return txData;
}

/** Instância singleton do nullifier store */
export const nullifierStore = new NullifierStore();
