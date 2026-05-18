/**
 * VØID-LN — NWC Protocol (NIP-47: Nostr Wallet Connect)
 *
 * Implementação completa do NIP-47 para pagamentos Lightning
 * via NOSTR relays. Permite que o PWA se conecte a qualquer
 * wallet NWC (Alby, Mutiny, LNbits, etc.) para enviar/receber
 * pagamentos Lightning sem rodar um nó local.
 *
 * Fluxo:
 * 1. Usuário fornece URI: nostr+walletconnect://<wallet_pk>?relay=<url>&secret=<hex>
 * 2. Client conecta ao relay NWC
 * 3. Client envia requests (kind 23194) criptografados NIP-04
 * 4. Wallet processa e responde (kind 23195)
 * 5. Client decriptografa resposta e atualiza UI
 *
 * Referência: https://github.com/nostr-protocol/nips/blob/master/47.md
 */

import { SimplePool, finalizeEvent, getPublicKey, nip04 } from "nostr-tools";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NWCConnection {
  walletPubKey: string;       // Wallet's Nostr public key (hex)
  relay: string;              // NWC relay URL
  secret: Uint8Array;         // Client's secret key for signing
  clientPubKey: string;       // Client's Nostr public key (hex)
  connected: boolean;
}

export interface NWCRequest {
  method: NWCMethod;
  params: Record<string, unknown>;
}

export interface NWCResponse {
  result_type: NWCMethod;
  error?: NWCError;
  result?: Record<string, unknown>;
}

export interface NWCError {
  code: NWCErrorCode;
  message: string;
}

export type NWCMethod =
  | "pay_invoice"
  | "make_invoice"
  | "get_balance"
  | "get_info"
  | "list_transactions"
  | "lookup_invoice";

export type NWCErrorCode =
  | "RATE_LIMITED"
  | "NOT_IMPLEMENTED"
  | "INSUFFICIENT_BALANCE"
  | "QUOTA_EXCEEDED"
  | "RESTRICTED"
  | "UNAUTHORIZED"
  | "INTERNAL"
  | "OTHER"
  | "PAYMENT_FAILED"
  | "PAYMENT_REJECTED"
  | "PAYMENT_TIMEOUT";

export interface NWCPayInvoiceParams {
  invoice: string;
  amount?: number;  // msats (optional, for zero-amount invoices)
}

export interface NWCMakeInvoiceParams {
  amount: number;       // msats
  description: string;
  description_hash?: string;
  expiry?: number;      // seconds
}

export interface NWCTransaction {
  type: "incoming" | "outgoing";
  invoice?: string;
  description?: string;
  description_hash?: string;
  preimage?: string;
  payment_hash: string;
  amount: number;       // msats
  fees_paid?: number;   // msats
  created_at: number;   // unix timestamp
  expires_at?: number;
  settled_at?: number;
  metadata?: Record<string, unknown>;
}

export type NWCEventListener = (response: NWCResponse) => void;

export type NWCClientFailureCode = NWCErrorCode | "NOT_CONNECTED" | "DISCONNECTED" | "TIMEOUT";

export class NWCClientError extends Error {
  readonly code: NWCClientFailureCode;
  readonly method: NWCMethod | undefined;
  readonly nwcMessage: string | undefined;

  constructor(
    message: string,
    code: NWCClientFailureCode,
    method?: NWCMethod,
    nwcMessage?: string,
  ) {
    super(message);
    this.name = "NWCClientError";
    this.code = code;
    this.method = method;
    this.nwcMessage = nwcMessage;
  }
}

type PoolLike = {
  subscribeMany: (relays: string[], filter: unknown, handlers: {
    onevent: (event: any) => void;
    onclose: () => void;
  }) => { close: () => void } | void;
  publish: (relays: string[], event: unknown) => void;
  close: (relays: string[]) => void;
  ensureRelay?: (relay: string) => Promise<unknown>;
};

export interface NWCClientOptions {
  poolFactory?: () => PoolLike;
  serializeRequestContent?: (request: NWCRequest, connection: NWCConnection) => Promise<string> | string;
  parseResponseEvent?: (event: any, connection: NWCConnection) => Promise<NWCResponse> | NWCResponse;
}

// ─── NWC Protocol ─────────────────────────────────────────────────────────────

/**
 * Parse uma URI NWC: nostr+walletconnect://<wallet_pk>?relay=<url>&secret=<hex>
 */
export function parseNWCUri(uri: string): { walletPubKey: string; relay: string; secret: Uint8Array } {
  const match = uri.match(/^nostr\+walletconnect:\/\/([0-9a-f]+)\?(.+)$/i);
  if (!match) throw new Error("Invalid NWC URI format");

  const walletPubKey = match[1];
  const params = new URLSearchParams(match[2]);

  const relay = params.get("relay");
  if (!relay) throw new Error("NWC URI missing relay parameter");

  const secretHex = params.get("secret");
  if (!secretHex) throw new Error("NWC URI missing secret parameter");

  // Convert hex secret to Uint8Array
  const secret = new Uint8Array(secretHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

  return { walletPubKey, relay, secret };
}

/**
 * NWC Client — conecta a um wallet NWC via NOSTR relay
 */
export class NWCClient {
  private readonly options: NWCClientOptions;
  private connection: NWCConnection | null = null;
  private pool: PoolLike | null = null;
  private responseSub: { close: () => void } | null = null;
  private listeners: Set<NWCEventListener> = new Set();
  private pendingRequests: Map<string, {
    method: NWCMethod;
    resolve: (value: NWCResponse) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();
  private responseEventsReceived = 0;
  private responseParseFailures = 0;

  constructor(options: NWCClientOptions = {}) {
    this.options = options;
  }

  /**
   * Conecta a um wallet NWC via URI
   */
  async connect(uri: string): Promise<NWCConnection> {
    // Evita múltiplas subscriptions paralelas no mesmo cliente.
    this.disconnect();

    const { walletPubKey, relay, secret } = parseNWCUri(uri);
    const clientPubKey = getPublicKey(secret);

    this.connection = {
      walletPubKey,
      relay,
      secret,
      clientPubKey,
      connected: false,
    };

    // Connect to relay
    const pool = this.options.poolFactory?.() ?? (new SimplePool() as unknown as PoolLike);
    this.pool = pool;
    if (pool.ensureRelay) {
      await pool.ensureRelay(relay);
    }

    // Subscribe to responses (kind 23195)
    const maybeSub = pool.subscribeMany([relay], {
      kinds: [23195],
      authors: [walletPubKey],
    }, {
      onevent: (event: any) => {
        void this.handleResponse(event);
      },
      onclose: () => {
        if (this.connection) this.connection.connected = false;
      },
    });
    this.responseSub = maybeSub ?? null;

    this.connection.connected = true;
    this.responseEventsReceived = 0;
    this.responseParseFailures = 0;
    console.log(`[NWC] Connected to wallet ${walletPubKey.slice(0, 8)}... via ${relay}`);

    return this.connection;
  }

  /**
   * Desconecta do wallet NWC
   */
  disconnect(): void {
    if (this.responseSub) {
      try {
        this.responseSub.close();
      } catch {
        // noop
      }
      this.responseSub = null;
    }

    this.pool = null;
    if (this.connection) {
      this.connection.connected = false;
      this.connection = null;
    }
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new NWCClientError("Disconnected", "DISCONNECTED", pending.method));
    }
    this.pendingRequests.clear();
  }

  /**
   * Envia um request NWC e aguarda resposta
   */
  async sendRequest(
    method: NWCMethod,
    params: Record<string, unknown> = {},
    timeoutMs: number = 30000,
  ): Promise<NWCResponse> {
    if (!this.connection || !this.pool) {
      throw new NWCClientError("NWC not connected", "NOT_CONNECTED", method);
    }

    const request: NWCRequest = { method, params };
    const connection = this.connection;
    const pool = this.pool;
    const serializedContentMaybe = this.serializeRequestContent(request, connection);
    const serializedContent = typeof serializedContentMaybe === "string"
      ? serializedContentMaybe
      : await serializedContentMaybe;

    // Create NOSTR event (kind 23194)
    const event = finalizeEvent({
      kind: 23194,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", connection.walletPubKey],
      ],
      content: serializedContent,
    }, connection.secret);
    const requestEventId = event.id;

    // Publish
    pool.publish([connection.relay], event);

    // Wait for response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestEventId);
        reject(new NWCClientError(
          `NWC request timeout: ${method} (responses=${this.responseEventsReceived}, parse_failures=${this.responseParseFailures})`,
          "TIMEOUT",
          method,
        ));
      }, timeoutMs);

      this.pendingRequests.set(requestEventId, { method, resolve, reject, timeout });
    });
  }

  /**
   * Paga uma invoice Lightning
   */
  async payInvoice(invoice: string, amountMsats?: number): Promise<{ preimage: string }> {
    const params: Record<string, unknown> = { invoice };
    if (amountMsats) params.amount = amountMsats;

    const response = await this.sendRequest("pay_invoice", params);
    this.assertNoError(response, "pay_invoice");

    return { preimage: response.result!.preimage as string };
  }

  /**
   * Cria uma invoice Lightning
   */
  async makeInvoice(
    amountMsats: number,
    description: string,
    expiry?: number,
  ): Promise<{ invoice: string; payment_hash: string }> {
    const params: Record<string, unknown> = { amount: amountMsats, description };
    if (expiry) params.expiry = expiry;

    const response = await this.sendRequest("make_invoice", params);
    this.assertNoError(response, "make_invoice");

    return {
      invoice: response.result!.invoice as string,
      payment_hash: response.result!.payment_hash as string,
    };
  }

  /**
   * Consulta saldo do wallet
   */
  async getBalance(): Promise<{ balance: number }> {
    const response = await this.sendRequest("get_balance");
    this.assertNoError(response, "get_balance");

    return { balance: response.result!.balance as number };
  }

  /**
   * Consulta info do wallet
   */
  async getInfo(): Promise<{ alias: string; color: string; pubkey: string; network: string; methods: string[] }> {
    const response = await this.sendRequest("get_info");
    this.assertNoError(response, "get_info");

    return response.result as any;
  }

  /**
   * Lista transações
   */
  async listTransactions(
    from?: number,
    until?: number,
    limit?: number,
    offset?: number,
    unpaid?: boolean,
    type?: "incoming" | "outgoing",
  ): Promise<{ transactions: NWCTransaction[] }> {
    const params: Record<string, unknown> = {};
    if (from !== undefined) params.from = from;
    if (until !== undefined) params.until = until;
    if (limit !== undefined) params.limit = limit;
    if (offset !== undefined) params.offset = offset;
    if (unpaid !== undefined) params.unpaid = unpaid;
    if (type !== undefined) params.type = type;

    const response = await this.sendRequest("list_transactions", params);
    this.assertNoError(response, "list_transactions");

    return { transactions: response.result!.transactions as NWCTransaction[] };
  }

  /**
   * Busca uma invoice específica
   */
  async lookupInvoice(
    paymentHash?: string,
    invoice?: string,
  ): Promise<NWCTransaction> {
    const params: Record<string, unknown> = {};
    if (paymentHash) params.payment_hash = paymentHash;
    if (invoice) params.invoice = invoice;

    const response = await this.sendRequest("lookup_invoice", params);
    this.assertNoError(response, "lookup_invoice");

    return response.result as unknown as NWCTransaction;
  }

  /**
   * Registra listener para respostas
   */
  onResponse(listener: NWCEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Verifica se está conectado
   */
  isConnected(): boolean {
    return this.connection?.connected === true;
  }

  /**
   * Retorna info da conexão
   */
  getConnection(): NWCConnection | null {
    return this.connection;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private async handleResponse(event: any): Promise<void> {
    if (!this.connection) return;
    this.responseEventsReceived++;

    try {
      const responseMaybe = this.parseResponseEvent(event, this.connection);
      const response = responseMaybe instanceof Promise
        ? await responseMaybe
        : responseMaybe;

      // Notify listeners
      for (const listener of this.listeners) {
        try { listener(response); } catch { /* ignore */ }
      }

      // Resolve pending request
      const requestId = event.tags.find((t: string[]) => t[0] === "e")?.[1];
      if (requestId && this.pendingRequests.has(requestId)) {
        const pending = this.pendingRequests.get(requestId)!;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        pending.resolve(response);
      }
    } catch (err) {
      this.responseParseFailures++;
      console.warn("[NWC] Failed to handle response:", err);
    }
  }

  private serializeRequestContent(request: NWCRequest, connection: NWCConnection): Promise<string> | string {
    if (this.options.serializeRequestContent) {
      return this.options.serializeRequestContent(request, connection);
    }
    return nip04.encrypt(connection.secret, connection.walletPubKey, JSON.stringify(request));
  }

  private parseResponseEvent(event: any, connection: NWCConnection): Promise<NWCResponse> | NWCResponse {
    if (this.options.parseResponseEvent) {
      return this.options.parseResponseEvent(event, connection);
    }
    const decryptedText = nip04.decrypt(connection.secret, event.pubkey, event.content);
    return JSON.parse(decryptedText) as NWCResponse;
  }

  private assertNoError(response: NWCResponse, method: NWCMethod): void {
    if (!response.error) return;
    throw new NWCClientError(
      `NWC ${method} failed: ${response.error.code} — ${response.error.message}`,
      response.error.code,
      method,
      response.error.message,
    );
  }
}

// Singleton
export const nwcClient = new NWCClient();
