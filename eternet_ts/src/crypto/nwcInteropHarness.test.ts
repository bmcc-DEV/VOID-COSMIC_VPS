import { describe, expect, it } from "vitest";
import type { NwcInteropHarnessClient } from "./nwcInteropHarness";
import { runNwcInteropHarness } from "./nwcInteropHarness";

function makeClient(overrides: Partial<NwcInteropHarnessClient> = {}): NwcInteropHarnessClient {
  return {
    connect: async () => ({ walletPubKey: "abcd", relay: "wss://relay.test" }),
    disconnect: () => undefined,
    getInfo: async () => ({ alias: "wallet", network: "mainnet", methods: ["get_info"] }),
    getBalance: async () => ({ balance: 1234 }),
    listTransactions: async () => ({ transactions: [1, 2] }),
    makeInvoice: async () => ({ invoice: "lnbc1...", payment_hash: "0011223344556677" }),
    ...overrides,
  };
}

describe("nwcInteropHarness", () => {
  it("gera relatório de sucesso quando todos checks passam", async () => {
    const report = await runNwcInteropHarness("nostr+walletconnect://dummy?relay=wss://relay&secret=00", {
      timeoutMs: 100,
      client: makeClient(),
    });

    expect(report.summary.failed).toBe(0);
    expect(report.summary.passed).toBe(5);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("marca checks como skipped quando conexão falha", async () => {
    const report = await runNwcInteropHarness("nostr+walletconnect://dummy?relay=wss://relay&secret=00", {
      timeoutMs: 100,
      client: makeClient({
        connect: async () => {
          throw new Error("relay offline");
        },
      }),
    });

    expect(report.summary.failed).toBe(1);
    expect(report.summary.skipped).toBe(4);
    expect(report.checks[0]?.id).toBe("connect");
    expect(report.checks[0]?.status).toBe("fail");
  });

  it("continua checks mesmo com falha parcial", async () => {
    const report = await runNwcInteropHarness("nostr+walletconnect://dummy?relay=wss://relay&secret=00", {
      timeoutMs: 100,
      client: makeClient({
        getBalance: async () => {
          throw new Error("denied");
        },
      }),
    });

    expect(report.summary.failed).toBe(1);
    expect(report.summary.passed).toBe(4);
    const balanceCheck = report.checks.find((check) => check.id === "get_balance");
    expect(balanceCheck?.status).toBe("fail");
    expect(balanceCheck?.details).toContain("denied");
  });
});
