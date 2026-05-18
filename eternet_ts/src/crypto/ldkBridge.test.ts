/**
 * Testes — LDKBridge (LND REST API client)
 *
 * Cobre: construção, configure(), init() deprecated, listeners, payInvoice,
 * createInvoice, getChannelBalance, listChannels — com fetch mockado.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LDKBridge } from "./ldkBridge";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(payload: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json:  async () => payload,
      text:  async () => JSON.stringify(payload),
    }),
  );
}

function bridge(url = "https://lnd.test:8080", mac = "deadbeef"): LDKBridge {
  const b = new LDKBridge();
  b.configure(url, mac);
  return b;
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe("ldkBridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Construção ─────────────────────────────────────────────────────────────

  describe("LDKBridge — construção", () => {
    it("cria bridge não configurado", () => {
      const b = new LDKBridge();
      expect(b.isInitialized()).toBe(false);
      expect(b.isConfigured()).toBe(false);
      expect(b.getNodePubkey()).toBeNull();
      expect(b.getChannelCount()).toBe(0);
    });

    it("init() deprecated não lança erro (seed ignorada — lógica no nó LND)", async () => {
      const b = new LDKBridge();
      // init() deprecated é no-op quando não há configure(); não lança
      await expect(b.init(new Uint8Array(16))).resolves.toBeUndefined();
      await expect(b.init(new Uint8Array(32))).resolves.toBeUndefined();
    });

    it("init() com seed válida emite aviso mas não lança (modo legado)", async () => {
      const b = new LDKBridge();
      const seed = new Uint8Array(32).fill(0xab);
      // Não deve lançar — apenas emite console.warn
      await expect(b.init(seed, "regtest")).resolves.toBeUndefined();
    });

    it("registra e remove listener de eventos", () => {
      const b = new LDKBridge();
      const events: unknown[] = [];
      const remove = b.onEvent(e => events.push(e));
      expect(typeof remove).toBe("function");
      remove();
    });
  });

  // ── configure() ────────────────────────────────────────────────────────────

  describe("configure()", () => {
    it("marca isConfigured e isInitialized como true", () => {
      const b = new LDKBridge();
      expect(b.isConfigured()).toBe(false);
      b.configure("https://lnd.test:8080", "aabbcc");
      expect(b.isConfigured()).toBe(true);
      expect(b.isInitialized()).toBe(true);
    });

    it("lança erro claro ao usar métodos sem configurar", async () => {
      const b = new LDKBridge();
      await expect(b.getNodeInfo()).rejects.toThrow("não configurado");
      await expect(b.createInvoice(1000, "test")).rejects.toThrow("não configurado");
    });
  });

  // ── getNodeInfo() ──────────────────────────────────────────────────────────

  describe("getNodeInfo()", () => {
    beforeEach(() => {
      mockFetch({
        identity_pubkey:    "03abc123",
        alias:              "VOID-NODE",
        chains:             [{ network: "regtest" }],
        block_height:       850_000,
        synced_to_chain:    true,
        num_active_channels: 3,
        num_peers:          5,
      });
    });

    it("retorna info do nó formatada", async () => {
      const info = await bridge().getNodeInfo();
      expect(info.pubkey).toBe("03abc123");
      expect(info.alias).toBe("VOID-NODE");
      expect(info.network).toBe("regtest");
      expect(info.blockHeight).toBe(850_000);
      expect(info.synced).toBe(true);
      expect(info.numActiveChannels).toBe(3);
    });

    it("usa cabeçalho Grpc-Metadata-Macaroon correto", async () => {
      await bridge("https://lnd.test:8080", "mymac").getNodeInfo();
      const call = (global.fetch as any).mock.calls[0];
      expect(call[1].headers["Grpc-Metadata-Macaroon"]).toBe("mymac");
    });
  });

  // ── createInvoice() ────────────────────────────────────────────────────────

  describe("createInvoice()", () => {
    it("cria invoice BOLT11 real via LND", async () => {
      mockFetch({
        payment_request: "lnbc10n1ptest...",
        r_hash:          "abcdef01",
        add_index:       "1",
      });

      const inv = await bridge().createInvoice(10_000, "VOID test", 3600);
      expect(inv.bolt11).toBe("lnbc10n1ptest...");
      expect(inv.paymentHash).toBe("abcdef01");
      expect(inv.amountMsats).toBe(10_000);
      expect(inv.description).toBe("VOID test");
      expect(inv.expiresAt).toBeGreaterThan(Date.now() / 1000);
    });
  });

  // ── payInvoice() ───────────────────────────────────────────────────────────

  describe("payInvoice()", () => {
    it("retorna sucesso com preimage quando pago", async () => {
      mockFetch({
        payment_preimage: "61626364", // "abcd" em hex
        payment_error:    "",
        fee_sat:          "2",
      });

      const result = await bridge().payInvoice("lnbc...");
      expect(result.success).toBe(true);
      expect(result.preimage).toBeTruthy();
      expect(result.feeMsats).toBe(2000);
      expect(result.error).toBeUndefined();
    });

    it("retorna failure com payment_error preenchido", async () => {
      mockFetch({
        payment_preimage: "",
        payment_error:    "insufficient_balance",
        fee_sat:          "0",
      });

      const result = await bridge().payInvoice("lnbc...");
      expect(result.success).toBe(false);
      expect(result.error).toBe("insufficient_balance");
      expect(result.preimage).toBeUndefined();
    });

    it("retorna failure quando fetch lança exceção", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

      const result = await bridge().payInvoice("lnbc...");
      expect(result.success).toBe(false);
      expect(result.error).toContain("network error");
    });
  });

  // ── getChannelBalance() ────────────────────────────────────────────────────

  describe("getChannelBalance()", () => {
    it("retorna saldo local e remoto em sats", async () => {
      mockFetch({
        local_balance:  { sat: "500000" },
        remote_balance: { sat: "250000" },
      });

      const bal = await bridge().getChannelBalance();
      expect(bal.localSat).toBe(500_000);
      expect(bal.remoteSat).toBe(250_000);
    });
  });

  // ── listChannels() ─────────────────────────────────────────────────────────

  describe("listChannels()", () => {
    it("lista canais com campos corretos", async () => {
      mockFetch({
        channels: [
          {
            channel_point:  "txid123:0",
            remote_pubkey:  "03peer1",
            capacity:       "1000000",
            local_balance:  "500000",
            remote_balance: "500000",
            active:         true,
            private:        false,
          },
        ],
      });

      const channels = await bridge().listChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0]!.channelId).toBe("txid123:0");
      expect(channels[0]!.peerPubkey).toBe("03peer1");
      expect(channels[0]!.capacitySat).toBe(1_000_000);
      expect(channels[0]!.isActive).toBe(true);
      expect(channels[0]!.isPublic).toBe(true);
    });

    it("retorna array vazio quando não há canais", async () => {
      mockFetch({ channels: [] });
      const channels = await bridge().listChannels();
      expect(channels).toHaveLength(0);
    });
  });
});
