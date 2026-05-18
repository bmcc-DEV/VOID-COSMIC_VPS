/**
 * VØID Payment Gateway — NWC Only
 *
 * Filosofia: sem intermediário, sem identidade, sem rastro.
 *
 * Fluxo:
 * 1. Usuário conecta wallet via NWC URI (nostr+walletconnect://...)
 * 2. Gera invoice real via NWC (NIP-47)
 * 3. Ou paga uma invoice recebida via NWC
 * 4. Sem KYC, sem conta, sem terceiro
 *
 * Método de pagamento: APENAS NWC (Nostr Wallet Connect)
 * LDK WASM removido — secp256k1-sys não compila para wasm32
 * Bitcoin on-chain removido — fake invoices
 */
import type { NWCClientFailureCode } from "./nwcProtocol";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PaymentItem {
  label: string;
  amount: string; // e.g. "49.90"
  currency: string; // e.g. "BRL"
}

export interface PaymentResult {
  success: boolean;
  method: "nwc";
  invoice?: string;
  amountSat?: number;
  paymentHash?: string;
  preimage?: string;
  error?: string;
  errorCode?: NWCClientFailureCode | "UNKNOWN";
  errorHint?: string;
  attempts?: number;
}

export interface NWCWalletInfo {
  connected: boolean;
  walletPubKey: string;
  relay: string;
  balanceSat: number | undefined;
}

// ─── Live Prices ─────────────────────────────────────────────────────────────

let cachedPrices: { brl: number; usd: number; eur: number; fetchedAt: number } | null = null;
const PRICE_CACHE_MS = 60_000; // 1 min

async function fetchBtcPrices(): Promise<{ brl: number; usd: number; eur: number }> {
  if (cachedPrices && Date.now() - cachedPrices.fetchedAt < PRICE_CACHE_MS) {
    return cachedPrices;
  }

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl,usd,eur"
    );
    if (!res.ok) throw new Error(`CoinGecko: ${res.status}`);
    const data = await res.json() as { bitcoin: { brl: number; usd: number; eur: number } };
    cachedPrices = { ...data.bitcoin, fetchedAt: Date.now() };
    return cachedPrices;
  } catch {
    // Fallback se API indisponível
    return { brl: 420_000, usd: 85_000, eur: 78_000 };
  }
}

// ─── NWC Payment ─────────────────────────────────────────────────────────────

class NWCPayment {
  private amountSat: number;

  constructor(amountSat: number) {
    this.amountSat = amountSat;
  }

  async createInvoice(): Promise<{ invoice: string; paymentHash: string }> {
    const { nwcClient } = await import("./nwcProtocol");

    if (!nwcClient.isConnected()) {
      throw new Error("NWC não conectado. Conecte uma wallet Lightning primeiro.");
    }

    const amountMsats = this.amountSat * 1000;
    const result = await nwcClient.makeInvoice(amountMsats, "ETΞRNET Payment");

    return {
      invoice: result.invoice,
      paymentHash: result.payment_hash,
    };
  }

  async payInvoice(invoice: string): Promise<{ preimage: string }> {
    const { nwcClient } = await import("./nwcProtocol");

    if (!nwcClient.isConnected()) {
      throw new Error("NWC não conectado. Conecte uma wallet Lightning primeiro.");
    }

    return nwcClient.payInvoice(invoice, this.amountSat * 1000);
  }
}

const FRIENDLY_NWC_ERRORS: Record<NWCClientFailureCode, { message: string; hint: string }> = {
  NOT_CONNECTED: {
    message: "Wallet NWC não conectada.",
    hint: "Conecte uma URI nostr+walletconnect válida antes de enviar.",
  },
  DISCONNECTED: {
    message: "Conexão NWC encerrada durante a operação.",
    hint: "Reconecte a wallet e tente novamente.",
  },
  TIMEOUT: {
    message: "Timeout no relay/wallet NWC.",
    hint: "Verifique conectividade do relay e tente novamente em alguns segundos.",
  },
  INSUFFICIENT_BALANCE: {
    message: "Saldo insuficiente para concluir o pagamento.",
    hint: "Reduza o valor ou reabasteça a wallet Lightning.",
  },
  PAYMENT_REJECTED: {
    message: "Pagamento rejeitado pela wallet.",
    hint: "Confira validade da invoice e permissões NWC.",
  },
  PAYMENT_FAILED: {
    message: "Falha no pagamento Lightning.",
    hint: "Tente novamente com rota/valor diferente.",
  },
  PAYMENT_TIMEOUT: {
    message: "Pagamento expirou antes da confirmação.",
    hint: "Gere nova invoice ou aumente a janela de expiração.",
  },
  RATE_LIMITED: {
    message: "Limite de requisições atingido na wallet/relay.",
    hint: "Aguarde alguns segundos antes de repetir a operação.",
  },
  QUOTA_EXCEEDED: {
    message: "Quota da integração NWC foi excedida.",
    hint: "Revise limites do provedor NWC e tente novamente.",
  },
  RESTRICTED: {
    message: "Operação bloqueada pela política da wallet.",
    hint: "Revise permissões do token NWC para este método.",
  },
  UNAUTHORIZED: {
    message: "Token/secret NWC não autorizado.",
    hint: "Recrie a URI NWC com escopos corretos e reconecte.",
  },
  NOT_IMPLEMENTED: {
    message: "Método NWC não implementado pela wallet.",
    hint: "Use uma wallet com suporte ao método solicitado.",
  },
  INTERNAL: {
    message: "Erro interno da wallet NWC.",
    hint: "Tente novamente; se persistir, troque de relay ou wallet.",
  },
  OTHER: {
    message: "Falha genérica retornada pela wallet NWC.",
    hint: "Verifique logs e detalhes da wallet para diagnóstico.",
  },
};

function isNwcFailureCode(value: unknown): value is NWCClientFailureCode {
  return typeof value === "string" && value in FRIENDLY_NWC_ERRORS;
}

export interface NwcRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
}

export interface NwcRetryEvent {
  attempt: number;
  maxAttempts: number;
  code: NWCClientFailureCode;
  nextDelayMs: number;
}

export interface PaymentExecutionOptions {
  onRetry?: (event: NwcRetryEvent) => void;
}

const DEFAULT_NWC_RETRY_POLICY: NwcRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 250,
  backoffMultiplier: 2,
};

const RETRYABLE_NWC_CODES = new Set<NWCClientFailureCode>([
  "TIMEOUT",
  "RATE_LIMITED",
  "PAYMENT_TIMEOUT",
]);

function isRetryableNwcCode(code: NWCClientFailureCode | "UNKNOWN"): code is NWCClientFailureCode {
  return code !== "UNKNOWN" && RETRYABLE_NWC_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithNwcRetry<T>(
  operation: () => Promise<T>,
  retryPolicy: Partial<NwcRetryPolicy> = {},
  onRetry?: (event: NwcRetryEvent) => void,
): Promise<{ result?: T; attempts: number; lastError?: unknown }> {
  const policy: NwcRetryPolicy = {
    maxRetries: retryPolicy.maxRetries ?? DEFAULT_NWC_RETRY_POLICY.maxRetries,
    baseDelayMs: retryPolicy.baseDelayMs ?? DEFAULT_NWC_RETRY_POLICY.baseDelayMs,
    backoffMultiplier: retryPolicy.backoffMultiplier ?? DEFAULT_NWC_RETRY_POLICY.backoffMultiplier,
  };
  let attempts = 0;
  let lastError: unknown;

  while (attempts <= policy.maxRetries) {
    attempts++;
    try {
      const result = await operation();
      return { result, attempts };
    } catch (err) {
      lastError = err;
      const mapped = mapNwcError(err);
      const retryableCode = isRetryableNwcCode(mapped.code) ? mapped.code : null;
      const canRetry = retryableCode !== null && attempts <= policy.maxRetries;
      if (!canRetry) {
        return { attempts, lastError };
      }
      const backoff = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempts - 1);
      onRetry?.({
        attempt: attempts,
        maxAttempts: policy.maxRetries + 1,
        code: retryableCode,
        nextDelayMs: backoff,
      });
      await delay(backoff);
    }
  }
  return { attempts, lastError };
}

export function mapNwcError(err: unknown): { code: NWCClientFailureCode | "UNKNOWN"; message: string; hint: string } {
  if (err && typeof err === "object") {
    const maybeCode = (err as { code?: unknown }).code;
    const maybeMessage = (err as { message?: unknown }).message;
    if (isNwcFailureCode(maybeCode)) {
      const friendly = FRIENDLY_NWC_ERRORS[maybeCode];
      return {
        code: maybeCode,
        message: friendly.message,
        hint: friendly.hint,
      };
    }
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      return {
        code: "UNKNOWN",
        message: maybeMessage,
        hint: "Verifique logs locais e o status da wallet NWC.",
      };
    }
  }
  return {
    code: "UNKNOWN",
    message: "Erro inesperado no gateway de pagamento.",
    hint: "Tente novamente e valide conexão com relay/wallet.",
  };
}

// ─── Unified Payment Gateway ─────────────────────────────────────────────────

export class PaymentGateway {
  private static instance: PaymentGateway;

  static getInstance(): PaymentGateway {
    if (!PaymentGateway.instance) {
      PaymentGateway.instance = new PaymentGateway();
    }
    return PaymentGateway.instance;
  }

  /**
   * Converte moeda fiat para satoshis usando preço ao vivo.
   */
  async fiatToSat(amount: string, currency: string): Promise<number> {
    const prices = await fetchBtcPrices();
    const price = currency === "BRL" ? prices.brl
      : currency === "EUR" ? prices.eur
      : prices.usd;
    const btcAmount = parseFloat(amount) / price;
    return Math.round(btcAmount * 100_000_000);
  }

  /**
   * Retorna preço atual do BTC nas 3 moedas.
   */
  async getBtcPrices(): Promise<{ brl: number; usd: number; eur: number }> {
    return fetchBtcPrices();
  }

  /**
   * Conecta a um wallet NWC via URI.
   */
  async connectNWC(uri: string): Promise<NWCWalletInfo> {
    const { nwcClient } = await import("./nwcProtocol");
    const conn = await nwcClient.connect(uri);

    let balanceSat: number | undefined;
    try {
      const bal = await nwcClient.getBalance();
      balanceSat = bal.balance;
    } catch { /* balance pode falhar */ }

    return {
      connected: conn.connected,
      walletPubKey: conn.walletPubKey,
      relay: conn.relay,
      balanceSat,
    };
  }

  /**
   * Desconecta do wallet NWC.
   */
  async disconnectNWC(): Promise<void> {
    const { nwcClient } = await import("./nwcProtocol");
    nwcClient.disconnect();
  }

  /**
   * Verifica se NWC está conectado.
   */
  async isNWCConnected(): Promise<boolean> {
    const { nwcClient } = await import("./nwcProtocol");
    return nwcClient.isConnected();
  }

  /**
   * Retorna info do wallet conectado.
   */
  async getWalletInfo(): Promise<NWCWalletInfo | null> {
    const { nwcClient } = await import("./nwcProtocol");
    if (!nwcClient.isConnected()) return null;

    const conn = nwcClient.getConnection();
    if (!conn) return null;

    let balanceSat: number | undefined;
    try {
      const bal = await nwcClient.getBalance();
      balanceSat = bal.balance;
    } catch { /* OK */ }

    return {
      connected: true,
      walletPubKey: conn.walletPubKey,
      relay: conn.relay,
      balanceSat,
    };
  }

  /**
   * Cria pagamento (invoice) via NWC.
   * Falha se NWC não conectado.
   */
  async createPayment(item: PaymentItem, options: PaymentExecutionOptions = {}): Promise<PaymentResult> {
    try {
      const amountSat = await this.fiatToSat(item.amount, item.currency);
      const payment = new NWCPayment(amountSat);
      const outcome = await executeWithNwcRetry(
        () => payment.createInvoice(),
        {},
        options.onRetry,
      );
      if (!outcome.result) {
        const mapped = mapNwcError(outcome.lastError);
        return {
          success: false,
          method: "nwc",
          error: mapped.message,
          errorCode: mapped.code,
          errorHint: outcome.attempts > 1
            ? `${mapped.hint} (${outcome.attempts - 1} retentativa(s) automática(s) aplicadas.)`
            : mapped.hint,
          attempts: outcome.attempts,
        };
      }
      const { invoice, paymentHash } = outcome.result;

      return {
        success: true,
        method: "nwc",
        invoice,
        amountSat,
        paymentHash,
        attempts: outcome.attempts,
      };
    } catch (err: unknown) {
      const mapped = mapNwcError(err);
      return {
        success: false,
        method: "nwc",
        error: mapped.message,
        errorCode: mapped.code,
        errorHint: mapped.hint,
        attempts: 1,
      };
    }
  }

  /**
   * Paga uma invoice BOLT11 via NWC.
   */
  async pay(invoice: string, amountSat?: number, options: PaymentExecutionOptions = {}): Promise<PaymentResult> {
    try {
      const payment = new NWCPayment(amountSat ?? 0);
      const outcome = await executeWithNwcRetry(
        () => payment.payInvoice(invoice),
        {},
        options.onRetry,
      );
      if (!outcome.result) {
        const mapped = mapNwcError(outcome.lastError);
        return {
          success: false,
          method: "nwc",
          error: mapped.message,
          errorCode: mapped.code,
          errorHint: outcome.attempts > 1
            ? `${mapped.hint} (${outcome.attempts - 1} retentativa(s) automática(s) aplicadas.)`
            : mapped.hint,
          attempts: outcome.attempts,
        };
      }
      const { preimage } = outcome.result;

      return {
        success: true,
        method: "nwc",
        preimage,
        attempts: outcome.attempts,
      };
    } catch (err: unknown) {
      const mapped = mapNwcError(err);
      return {
        success: false,
        method: "nwc",
        error: mapped.message,
        errorCode: mapped.code,
        errorHint: mapped.hint,
        attempts: 1,
      };
    }
  }

  /**
   * Cria pagamento NWC (alias para compatibilidade com UI existente).
   */
  async createNWCPayment(_uri: string, item: PaymentItem): Promise<PaymentResult> {
    return this.createPayment(item);
  }
}

export const paymentGateway = PaymentGateway.getInstance();
