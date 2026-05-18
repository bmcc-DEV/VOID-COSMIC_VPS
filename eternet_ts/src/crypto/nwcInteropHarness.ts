import { NWCClient, NWCClientError } from "./nwcProtocol";

export type NwcInteropStatus = "pass" | "fail" | "skipped";

export interface NwcInteropCheck {
  id: "connect" | "get_info" | "get_balance" | "list_transactions" | "make_invoice";
  status: NwcInteropStatus;
  durationMs: number;
  details: string;
  errorCode?: string;
}

export interface NwcInteropSummary {
  passed: number;
  failed: number;
  skipped: number;
}

export interface NwcInteropReport {
  walletPubKey?: string;
  relay?: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  checks: NwcInteropCheck[];
  summary: NwcInteropSummary;
}

export interface NwcInteropHarnessClient {
  connect(uri: string): Promise<{ walletPubKey: string; relay: string }>;
  disconnect(): void;
  getInfo(): Promise<{ alias?: string; network?: string; methods?: string[] }>;
  getBalance(): Promise<{ balance: number }>;
  listTransactions(limit?: number): Promise<{ transactions: unknown[] }>;
  makeInvoice(amountMsats: number, description: string, expiry?: number): Promise<{ invoice: string; payment_hash: string }>;
}

export interface NwcInteropHarnessOptions {
  timeoutMs?: number;
  invoiceAmountMsats?: number;
  includeInvoiceFlow?: boolean;
  client?: NwcInteropHarnessClient;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INVOICE_MSATS = 1_000;

function summarize(checks: NwcInteropCheck[]): NwcInteropSummary {
  return checks.reduce<NwcInteropSummary>((acc, check) => {
    if (check.status === "pass") acc.passed++;
    if (check.status === "fail") acc.failed++;
    if (check.status === "skipped") acc.skipped++;
    return acc;
  }, { passed: 0, failed: 0, skipped: 0 });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timeout em ${label} após ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function failDetails(err: unknown): { details: string; errorCode?: string } {
  if (err instanceof NWCClientError) {
    return { details: err.message, errorCode: err.code };
  }
  if (err instanceof Error) {
    return { details: err.message };
  }
  return { details: String(err) };
}

function addSkipped(checks: NwcInteropCheck[], id: NwcInteropCheck["id"], reason: string): void {
  checks.push({
    id,
    status: "skipped",
    durationMs: 0,
    details: reason,
  });
}

export async function runNwcInteropHarness(
  uri: string,
  options: NwcInteropHarnessOptions = {},
): Promise<NwcInteropReport> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const includeInvoiceFlow = options.includeInvoiceFlow ?? true;
  const amountMsats = options.invoiceAmountMsats ?? DEFAULT_INVOICE_MSATS;
  const client = options.client ?? createNwcInteropHarnessClient();
  const checks: NwcInteropCheck[] = [];
  let walletPubKey: string | undefined;
  let relay: string | undefined;

  const executeCheck = async <T>(
    id: NwcInteropCheck["id"],
    label: string,
    work: () => Promise<T>,
    onPass: (value: T) => string,
  ): Promise<boolean> => {
    const t0 = performance.now();
    try {
      const value = await withTimeout(work(), timeoutMs, label);
      checks.push({
        id,
        status: "pass",
        durationMs: performance.now() - t0,
        details: onPass(value),
      });
      return true;
    } catch (err) {
      const failed = failDetails(err);
      const failedCheck: NwcInteropCheck = {
        id,
        status: "fail",
        durationMs: performance.now() - t0,
        details: failed.details,
        ...(failed.errorCode ? { errorCode: failed.errorCode } : {}),
      };
      checks.push(failedCheck);
      return false;
    }
  };

  try {
    const connected = await executeCheck(
      "connect",
      "connect",
      () => client.connect(uri),
      (conn) => {
        walletPubKey = conn.walletPubKey;
        relay = conn.relay;
        return `Conectado em ${conn.relay}`;
      },
    );

    if (!connected) {
      addSkipped(checks, "get_info", "Conexão falhou");
      addSkipped(checks, "get_balance", "Conexão falhou");
      addSkipped(checks, "list_transactions", "Conexão falhou");
      if (includeInvoiceFlow) {
        addSkipped(checks, "make_invoice", "Conexão falhou");
      }
    } else {
      await executeCheck(
        "get_info",
        "get_info",
        () => client.getInfo(),
        (info) => `Alias=${info.alias ?? "n/a"} network=${info.network ?? "n/a"} methods=${(info.methods ?? []).length}`,
      );
      await executeCheck(
        "get_balance",
        "get_balance",
        () => client.getBalance(),
        (balance) => `Saldo ${balance.balance} sats`,
      );
      await executeCheck(
        "list_transactions",
        "list_transactions",
        () => client.listTransactions(5),
        (tx) => `Transações retornadas=${tx.transactions.length}`,
      );
      if (includeInvoiceFlow) {
        await executeCheck(
          "make_invoice",
          "make_invoice",
          () => client.makeInvoice(amountMsats, "ETRNET Interop Harness", 60),
          (invoice) => `Invoice criada hash=${invoice.payment_hash.slice(0, 12)}...`,
        );
      }
    }
  } finally {
    client.disconnect();
  }

  const finishedAt = Date.now();
  return {
    ...(walletPubKey ? { walletPubKey } : {}),
    ...(relay ? { relay } : {}),
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    checks,
    summary: summarize(checks),
  };
}

export function createNwcInteropHarnessClient(): NwcInteropHarnessClient {
  return new NWCClient();
}
