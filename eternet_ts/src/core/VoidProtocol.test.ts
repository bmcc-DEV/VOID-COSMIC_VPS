/**
 * Testes — VoidProtocol
 *
 * Cobrem: construção, estado inicial, heartbeat causal, fossilização,
 * halt gracioso e modo offline (NWC/Stratum indisponíveis).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VoidProtocol, type VoidProtocolConfig } from "./VoidProtocol";

// ─── Mocks globais ────────────────────────────────────────────────────────────

vi.mock("../crypto/ghostid", () => ({
  spawnGhostId: vi.fn().mockResolvedValue({
    handle:          "ghost_test_1",
    publicKey:       new Uint8Array(32).fill(0xab),
    privateKey:      new Uint8Array(64).fill(0x00),
    x25519PublicKey: new Uint8Array(32).fill(0xcd),
    x25519SecretKey: new Uint8Array(32).fill(0x00),
    entropyBits:     256,
    quantumVerified: false,
  }),
}));

vi.mock("../crypto/nwcProtocol", () => ({
  nwcClient: {
    connect:    vi.fn().mockResolvedValue({}),
    getBalance: vi.fn().mockResolvedValue({ balance: 50_000 }), // 50 sats em msats
    disconnect: vi.fn(),
  },
}));

vi.mock("../crypto/cryptoMiner", () => ({
  CryptoMiner: {
    getInstance: vi.fn().mockReturnValue({
      init:     vi.fn().mockResolvedValue(true),
      start:    vi.fn(),
      stop:     vi.fn(),
      getStats: vi.fn().mockReturnValue({ isRunning: true }),
    }),
  },
  // garante que MiningConfig seja importável
}));

vi.mock("../crypto/c3Engine", () => ({
  C3Engine: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockReturnValue({
      shards:           [],
      routingInfo:      [{ shardIndex: 0, channel: "ch_test", hops: [], estimatedLatency: "1ms" }],
      encapsulatedKey:  new Uint8Array(32),
      nonce:            new Uint8Array(12),
      tag:              new Uint8Array(16),
      senderMLKEMPubKey: new Uint8Array(32),
      senderMLDSAPubKey: new Uint8Array(32),
      signature:         new Uint8Array(32),
      compressedState:   undefined,
      originalLength:    10,
      threshold:         2,
      total:             3,
      sessionKey:        new Uint8Array(32),
    }),
  })),
}));

vi.mock("../crypto/pqc", () => ({
  generateMLKEMKeypair: vi.fn().mockReturnValue({
    publicKey:  new Uint8Array(1568).fill(0x01),
    privateKey: new Uint8Array(64).fill(0x02),
  }),
  generateMLDSAKeypair: vi.fn().mockReturnValue({
    publicKey:  new Uint8Array(64).fill(0x03),
    privateKey: new Uint8Array(64).fill(0x04),
  }),
}));

vi.mock("../crypto/zkCompressor", () => ({
  compressState: vi.fn().mockReturnValue({
    merkleRoot:       new Uint8Array(32).fill(0x7a),
    totalCommitment:  new Uint8Array(32).fill(0x5c),
    proofCount:       1,
    timestamp:        Date.now(),
    utxoIds:          ["test"],
    econetEntryId:    undefined,
  }),
  fossilizeState: vi.fn(),
}));

vi.mock("../crypto/econet", () => ({
  EcoNet: {
    getInstance: vi.fn().mockReturnValue({
      store:  vi.fn().mockReturnValue("econet_id_test"),
      recall: vi.fn().mockReturnValue(null),
      decay:  vi.fn(),
    }),
  },
}));

vi.mock("../lsc/lscEngine", () => ({
  LSCEngine: {
    getInstance: vi.fn().mockReturnValue({
      law1MaximumPower: vi.fn().mockReturnValue(0.5),
      law2Saturation:   vi.fn().mockReturnValue(0.3),
      law3Holofriction: vi.fn().mockReturnValue(0.7),
      updateGraph:      vi.fn().mockImplementation((g: any) => g),
    }),
  },
  modalCoherence: vi.fn().mockReturnValue(0.45),
  totalEnergy:    vi.fn().mockReturnValue(2.6),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<VoidProtocolConfig> = {}): VoidProtocolConfig {
  return {
    nwcUri:           "nostr+walletconnect://fake_pubkey@relay.test?secret=abc",
    xmrWalletAddress: "4FakeXMRWallet1234567890",
    ...overrides,
  };
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe("VoidProtocol", () => {
  let protocol: VoidProtocol;

  beforeEach(() => {
    vi.useFakeTimers();
    protocol = new VoidProtocol(makeConfig());
  });

  afterEach(() => {
    protocol.halt("teste encerrado");
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Construção ─────────────────────────────────────────────────────────────

  describe("construção", () => {
    it("cria instância sem erros", () => {
      expect(protocol).toBeTruthy();
    });

    it("estado inicial correto antes da ignição", () => {
      const state = protocol.getState();
      expect(state.ghostHandle).toBe("(não inicializado)");
      expect(state.stateRoot).toBe("0xV0ID_OMEGA_GENESIS");
      expect(state.heartbeatCount).toBe(0);
      expect(state.fossilizedCount).toBe(0);
    });

    it("isRunning retorna false antes de igniteSingularity", () => {
      expect(protocol.isRunning()).toBe(false);
    });

    it("aceita valores customizados de lscCriticalLimit e heartbeatMs", () => {
      const custom = new VoidProtocol(makeConfig({ lscCriticalLimit: 0.75, heartbeatMs: 1000 }));
      expect(custom).toBeTruthy();
      custom.halt("teste");
    });
  });

  // ── Ignição ────────────────────────────────────────────────────────────────

  describe("igniteSingularity()", () => {
    it("muda isRunning para true", async () => {
      await protocol.igniteSingularity();
      expect(protocol.isRunning()).toBe(true);
    });

    it("preenche ghostHandle após ignição", async () => {
      await protocol.igniteSingularity();
      expect(protocol.getState().ghostHandle).toBe("ghost_test_1");
    });

    it("preenche nwcBalanceSats em msats→sats", async () => {
      await protocol.igniteSingularity();
      // 50_000 msats → 50 sats
      expect(protocol.getState().nwcBalanceSats).toBe(50);
    });

    it("não ignita duas vezes (idempotente)", async () => {
      await protocol.igniteSingularity();
      await protocol.igniteSingularity(); // deve ser no-op
      expect(protocol.isRunning()).toBe(true);
    });
  });

  // ── Heartbeat causal ───────────────────────────────────────────────────────

  describe("heartbeat causal", () => {
    it("incrementa heartbeatCount a cada tick", async () => {
      await protocol.igniteSingularity();
      expect(protocol.getState().heartbeatCount).toBe(0);

      await vi.advanceTimersByTimeAsync(2500);
      expect(protocol.getState().heartbeatCount).toBe(1);

      await vi.advanceTimersByTimeAsync(2500);
      expect(protocol.getState().heartbeatCount).toBe(2);
    });

    it("usa heartbeatMs customizado", async () => {
      const fast = new VoidProtocol(makeConfig({ heartbeatMs: 1000 }));
      await fast.igniteSingularity();

      await vi.advanceTimersByTimeAsync(3000);
      expect(fast.getState().heartbeatCount).toBe(3);

      fast.halt("teste");
    });
  });

  // ── Fossilização ───────────────────────────────────────────────────────────

  describe("fossilização", () => {
    it("fossilizedCount permanece 0 sem heartbeats", async () => {
      await protocol.igniteSingularity();
      // Não avançamos o timer — nenhum heartbeat, nenhuma fossilização
      expect(protocol.getState().fossilizedCount).toBe(0);
    });

    it("stateRoot muda após fossilização", async () => {
      const { modalCoherence } = await import("../lsc/lscEngine");
      // Força coerência acima do criticalLimit (0.86 padrão) para todos os calls
      vi.mocked(modalCoherence).mockReturnValue(0.9);

      await protocol.igniteSingularity();
      const rootBefore = "0xV0ID_OMEGA_GENESIS"; // raiz antes de qualquer heartbeat

      await vi.advanceTimersByTimeAsync(2500);

      // Restaurar mock para não poluir outros testes
      vi.mocked(modalCoherence).mockReturnValue(0.45);

      const rootAfter = protocol.getState().stateRoot;
      expect(rootAfter).not.toBe(rootBefore);
    });
  });

  // ── Halt ───────────────────────────────────────────────────────────────────

  describe("halt()", () => {
    it("para o daemon", async () => {
      await protocol.igniteSingularity();
      protocol.halt("teste halt");
      expect(protocol.isRunning()).toBe(false);
    });

    it("halt sem ignição não lança erro", () => {
      expect(() => protocol.halt("nunca iniciou")).not.toThrow();
    });

    it("halt múltiplos é idempotente", async () => {
      await protocol.igniteSingularity();
      protocol.halt("1ª vez");
      protocol.halt("2ª vez"); // deve ser no-op
      expect(protocol.isRunning()).toBe(false);
    });
  });

  // ── Modo offline ───────────────────────────────────────────────────────────

  describe("modo offline (NWC/Stratum indisponíveis)", () => {
    it("ignita mesmo com NWC falhando", async () => {
      const { nwcClient } = await import("../crypto/nwcProtocol");
      vi.mocked(nwcClient.connect).mockRejectedValueOnce(new Error("relay offline"));

      const p = new VoidProtocol(makeConfig());
      await expect(p.igniteSingularity()).resolves.toBeUndefined();
      expect(p.isRunning()).toBe(true);
      p.halt("teste offline");
    });

    it("ignita mesmo com Stratum falhando", async () => {
      const { CryptoMiner } = await import("../crypto/cryptoMiner");
      vi.mocked(CryptoMiner.getInstance().init).mockRejectedValueOnce(new Error("proxy offline"));

      const p = new VoidProtocol(makeConfig());
      await expect(p.igniteSingularity()).resolves.toBeUndefined();
      expect(p.isRunning()).toBe(true);
      p.halt("teste stratum offline");
    });
  });

  // ── getState ───────────────────────────────────────────────────────────────

  describe("getState()", () => {
    it("campos lsc são números válidos", async () => {
      await protocol.igniteSingularity();
      const state = protocol.getState();
      expect(typeof state.lscCoherence).toBe("number");
      expect(typeof state.lscSaturation).toBe("number");
    });

    it("miningActive reflete status real do miner", async () => {
      await protocol.igniteSingularity();
      expect(protocol.getState().miningActive).toBe(true);
    });
  });
});
