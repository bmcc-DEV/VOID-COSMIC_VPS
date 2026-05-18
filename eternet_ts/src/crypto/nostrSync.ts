/**
 * ETΞRNET — NOSTR Sync Layer
 *
 * Conecta o protocolo de transação ETRNET (kind 31214) ao mesh NOSTR.
 * Cada nó escuta transações de outros nós e retransmite as próprias.
 *
 * Fluxo:
 * 1. Conecta a relays NOSTR públicos
 * 2. Inscreve em eventos kind 31214 com tag ['t', 'eternet_tx']
 * 3. Ao receber evento: valida → registra nullifiers → notifica UI
 * 4. Ao criar transação local: assina → publica no relay
 */

import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { sha3_256 } from '@noble/hashes/sha3.js';
import {
  ETRNET_TX_KIND,
  nullifierStore,
  validateTransaction,
  type ETRTransactionData,
  type NostrTransaction,
} from './nostrTransaction';

/** Relays NOSTR padrão */
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

/** Transação sincronizada via NOSTR */
export interface SyncedTransaction {
  /** Hash da transação (hex) */
  txId: string;
  /** Dados da transação */
  data: ETRTransactionData;
  /** Timestamp de recebimento */
  receivedAt: number;
  /** Relay de origem */
  relaySource: string;
  /** Se a transação passou na validação */
  valid: boolean;
}

/** Callback para novas transações */
export type TransactionListener = (tx: SyncedTransaction) => void;

/**
 * Camada de sincronização NOSTR para transações ETRNET.
 *
 * Singleton que gerencia:
 * - Conexão a relays NOSTR
 * - Inscrição em eventos kind 31214
 * - Broadcast de transações locais
 * - Detecção de double-spend via nullifiers
 * - Notificação reativa para UI
 */
class NostrSync {
  private static instance: NostrSync;
  private pool = new SimplePool();
  private relays: string[] = [...DEFAULT_RELAYS];
  private sk: Uint8Array;
  private pk: string;
  private listeners: Set<TransactionListener> = new Set();
  private syncedTxs: Map<string, SyncedTransaction> = new Map();
  private connected = false;
  private sub: ReturnType<SimplePool['subscribeMany']> | null = null;

  public static getInstance(): NostrSync {
    if (!NostrSync.instance) NostrSync.instance = new NostrSync();
    return NostrSync.instance;
  }

  private constructor() {
    this.sk = generateSecretKey();
    this.pk = getPublicKey(this.sk);
  }

  /**
   * Conecta aos relays e começa a escutar transações ETRNET.
   */
  connect(): void {
    if (this.connected) return;

    this.sub = this.pool.subscribeMany(
      this.relays,
      {
        kinds: [ETRNET_TX_KIND],
        '#t': ['eternet_tx'],
      },
      {
        onevent: (event: any) => this.handleIncomingEvent(event),
        oneose: () => {
          console.log('[NOSTR Sync] Subscribed to ETRNET transactions');
        },
      }
    );

    this.connected = true;
    console.log(`[NOSTR Sync] Conectado a ${this.relays.length} relays`);
  }

  /**
   * Desconecta dos relays.
   */
  disconnect(): void {
    if (this.sub) {
      this.sub.close();
      this.sub = null;
    }
    this.pool.close(this.relays);
    this.connected = false;
    console.log('[NOSTR Sync] Desconectado');
  }

  /**
   * Transmite uma transação para todos os relays conectados.
   *
   * @param txData - Dados da transação a ser transmitida
   * @returns ID da transação (hash hex)
   */
  async broadcastTransaction(txData: ETRTransactionData): Promise<string> {
    // Gera txId a partir do conteúdo
    const txIdBytes = sha3_256(new TextEncoder().encode(JSON.stringify(txData)));
    const txId = Array.from(txIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    // Monta evento NOSTR
    const event = finalizeEvent(
      {
        kind: ETRNET_TX_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', 'eternet_tx'],
          ['version', txData.version.toString()],
          ...txData.nullifiers.map(n => ['nullifier', n]),
          ['txid', txId],
        ],
        content: JSON.stringify(txData),
      },
      this.sk
    );

    // Publica em todos os relays
    const pubs = this.pool.publish(this.relays, event);
    await Promise.allSettled(pubs);

    console.log(`[NOSTR Sync] Transação ${txId.slice(0, 16)}... publicada em ${this.relays.length} relays`);

    // Registra nullifiers localmente
    for (const nullifier of txData.nullifiers) {
      nullifierStore.add({
        nullifier,
        seenAt: Date.now(),
        relaySource: 'local',
        txId,
      });
    }

    return txId;
  }

  /**
   * Processa evento recebido do relay NOSTR.
   */
  private handleIncomingEvent(event: any): void {
    try {
      const content = JSON.parse(event.content) as ETRTransactionData;
      const relaySource = 'nostr_relay';

      // Gera txId a partir do conteúdo
      const txIdBytes = sha3_256(new TextEncoder().encode(event.content));
      const txId = Array.from(txIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');

      // Ignora se já visto
      if (this.syncedTxs.has(txId)) return;

      // Valida transação
      const nostrTx: NostrTransaction = {
        kind: ETRNET_TX_KIND,
        tags: event.tags,
        content: event.content,
        created_at: event.created_at,
      };

      const validation = validateTransaction(nostrTx, nullifierStore);

      const synced: SyncedTransaction = {
        txId,
        data: content,
        receivedAt: Date.now(),
        relaySource,
        valid: validation.valid,
      };

      this.syncedTxs.set(txId, synced);

      if (validation.valid) {
        // Registra nullifiers
        for (const nullifier of content.nullifiers) {
          nullifierStore.add({
            nullifier,
            seenAt: Date.now(),
            relaySource,
            txId,
          });
        }
        console.log(`[NOSTR Sync] Transação válida recebida: ${txId.slice(0, 16)}...`);
      } else {
        console.warn(`[NOSTR Sync] Transação rejeitada: ${validation.error}`);
      }

      // Notifica listeners
      for (const listener of this.listeners) {
        try {
          listener(synced);
        } catch {
          /* erro do listener não interrompe sync */
        }
      }
    } catch (err) {
      console.warn('[NOSTR Sync] Erro ao processar evento:', err);
    }
  }

  /**
   * Inscreve para receber novas transações.
   * Retorna função para cancelar inscrição.
   */
  onTransaction(listener: TransactionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Retorna todas as transações sincronizadas (mais recente primeiro).
   */
  getSyncedTransactions(): SyncedTransaction[] {
    return Array.from(this.syncedTxs.values())
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }

  /**
   * Retorna quantidade de nullifiers registrados.
   */
  getNullifierCount(): number {
    return nullifierStore.size();
  }

  /**
   * Verifica se está conectado aos relays.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Retorna a chave pública deste nó.
   */
  getPublicKey(): string {
    return this.pk;
  }

  /**
   * Adiciona um relay à lista.
   */
  addRelay(url: string): void {
    if (!this.relays.includes(url)) {
      this.relays.push(url);
    }
  }

  /**
   * Remove um relay da lista.
   */
  removeRelay(url: string): void {
    this.relays = this.relays.filter(r => r !== url);
  }

  /**
   * Retorna a lista de relays ativos.
   */
  getRelays(): string[] {
    return [...this.relays];
  }
}

export const nostrSync = NostrSync.getInstance();
