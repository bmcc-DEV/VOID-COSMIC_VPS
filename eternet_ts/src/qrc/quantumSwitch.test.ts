/**
 * Testes — QuantumSwitch (simulação clássica de ordem causal indefinida)
 *
 * O QuantumSwitch é uma simulação clássica via álgebra linear —
 * não há vantagem quântica real. Os testes cobrem:
 * - simulateQuantumSwitch sem GPU (CPU path)
 * - estrutura dos resultados (paths, colapso, profit, status)
 * - cenários de mercado extremos (bullish, bearish, lateral)
 */

import { describe, it, expect } from "vitest";
import { simulateQuantumSwitch } from "./quantumSwitch";
import type { QuantumSwitchConfig } from "./quantumSwitch";
import type { MarketState } from "./tensorNetwork";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMarket(overrides: Partial<MarketState> = {}): MarketState {
  return {
    prices:       new Float64Array([0.3, 0.5, 0.7, 0.9, 0.6]),
    volumes:      new Float64Array([100, 200, 150, 80, 120]),
    volatilities: new Float64Array([0.1, 0.2, 0.15, 0.05, 0.12]),
    timestamp:    Date.now(),
    ...overrides,
  };
}

function defaultConfig(overrides: Partial<QuantumSwitchConfig> = {}): QuantumSwitchConfig {
  return {
    targetAsset: "$ETBRL",
    timeSteps:   3,
    bondDim:     4,
    useGPU:      false,
    ...overrides,
  };
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe("simulateQuantumSwitch (CPU, sem WebGPU)", () => {

  // ── Estrutura básica do resultado ─────────────────────────────────────────

  describe("estrutura do resultado", () => {
    it("retorna 3 caminhos causais", async () => {
      const result = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      expect(result.paths).toHaveLength(3);
    });

    it("cada caminho tem description, operations, expectedValue, probability", async () => {
      const { paths } = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      for (const path of paths) {
        expect(typeof path.description).toBe("string");
        expect(Array.isArray(path.operations)).toBe(true);
        expect(path.operations.length).toBeGreaterThan(0);
        expect(typeof path.expectedValue).toBe("number");
        expect(path.probability).toBeGreaterThanOrEqual(0);
        expect(path.probability).toBeLessThanOrEqual(1);
        expect(path.finalAmplitudes).toBeInstanceOf(Float64Array);
      }
    });

    it("collapsedPath é um dos 3 caminhos", async () => {
      const result = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      const descricoes = result.paths.map((p) => p.description);
      expect(descricoes).toContain(result.collapsedPath.description);
    });

    it("collapsedPath tem o maior expectedValue entre os 3", async () => {
      const { paths, collapsedPath } = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      const maxValue = Math.max(...paths.map((p) => p.expectedValue));
      expect(collapsedPath.expectedValue).toBeCloseTo(maxValue, 8);
    });

    it("processingTimeMs > 0", async () => {
      const { processingTimeMs } = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      expect(processingTimeMs).toBeGreaterThan(0);
    });

    it("usedGPU=false no path CPU", async () => {
      const { usedGPU } = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      expect(usedGPU).toBe(false);
    });

    it("status é profit_found ou no_profit", async () => {
      const { status } = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      expect(["profit_found", "no_profit"]).toContain(status);
    });
  });

  // ── Caminhos esperados ────────────────────────────────────────────────────

  describe("nomes dos caminhos causais", () => {
    it("contém caminho BUY→HOLD→SELL", async () => {
      const { paths } = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      const buy = paths.find((p) => p.operations[0] === "BUY");
      expect(buy).toBeTruthy();
      expect(buy!.operations).toEqual(["BUY", "HOLD", "SELL"]);
    });

    it("contém caminho SELL→HOLD→BUY", async () => {
      const { paths } = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      const sell = paths.find((p) => p.operations[0] === "SELL");
      expect(sell).toBeTruthy();
      expect(sell!.operations).toEqual(["SELL", "HOLD", "BUY"]);
    });

    it("contém caminho HOLD→HOLD→HOLD", async () => {
      const { paths } = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      const hold = paths.find((p) => p.operations[0] === "HOLD");
      expect(hold).toBeTruthy();
      expect(hold!.operations).toEqual(["HOLD", "HOLD", "HOLD"]);
    });
  });

  // ── Payload ───────────────────────────────────────────────────────────────

  describe("payload e status", () => {
    it("payload é null quando status=no_profit", async () => {
      const result = await simulateQuantumSwitch(makeMarket(), defaultConfig(), null);
      if (result.status === "no_profit") {
        expect(result.payload).toBeNull();
      }
    });

    it("payload é string JSON quando status=profit_found", async () => {
      // Mercado fortemente bullish para forçar profit_found
      const bullishMarket = makeMarket({
        prices:       new Float64Array([0.1, 0.9, 0.95, 0.99, 0.98]),
        volatilities: new Float64Array([0.01, 0.01, 0.01, 0.01, 0.01]),
      });

      const result = await simulateQuantumSwitch(bullishMarket, defaultConfig(), null);
      if (result.status === "profit_found") {
        expect(typeof result.payload).toBe("string");
        const parsed = JSON.parse(result.payload!);
        expect(parsed).toHaveProperty("action");
        expect(parsed).toHaveProperty("expectedProfit");
        expect(parsed).toHaveProperty("asset");
      }
    });
  });

  // ── Cenários extremos ─────────────────────────────────────────────────────

  describe("cenários extremos de mercado", () => {
    it("mercado com preços zeros não lança erro", async () => {
      const flat = makeMarket({
        prices:       new Float64Array([0, 0, 0, 0, 0]),
        volatilities: new Float64Array([0, 0, 0, 0, 0]),
      });
      await expect(simulateQuantumSwitch(flat, defaultConfig(), null)).resolves.toBeTruthy();
    });

    it("mercado com preços uniformes não lança erro", async () => {
      const uniform = makeMarket({
        prices:       new Float64Array([0.5, 0.5, 0.5, 0.5, 0.5]),
        volatilities: new Float64Array([0.1, 0.1, 0.1, 0.1, 0.1]),
      });
      await expect(simulateQuantumSwitch(uniform, defaultConfig(), null)).resolves.toBeTruthy();
    });

    it("mercado com preços máximos (1.0) não lança erro", async () => {
      const maxed = makeMarket({
        prices:       new Float64Array([1, 1, 1, 1, 1]),
        volatilities: new Float64Array([0, 0, 0, 0, 0]),
      });
      await expect(simulateQuantumSwitch(maxed, defaultConfig(), null)).resolves.toBeTruthy();
    });

    it("bondDim=1 (mínimo) funciona", async () => {
      await expect(
        simulateQuantumSwitch(makeMarket(), defaultConfig({ bondDim: 1 }), null),
      ).resolves.toBeTruthy();
    });

    it("timeSteps=1 funciona", async () => {
      await expect(
        simulateQuantumSwitch(makeMarket(), defaultConfig({ timeSteps: 1 }), null),
      ).resolves.toBeTruthy();
    });
  });

  // ── Determinismo ──────────────────────────────────────────────────────────

  describe("comportamento determinístico (mesma entrada)", () => {
    it("dois runs com o mesmo mercado retornam o mesmo status", async () => {
      const market = makeMarket();
      const config = defaultConfig();

      const r1 = await simulateQuantumSwitch(market, config, null);
      const r2 = await simulateQuantumSwitch(market, config, null);

      expect(r1.status).toBe(r2.status);
      expect(r1.collapsedPath.operations).toEqual(r2.collapsedPath.operations);
    });
  });
});
