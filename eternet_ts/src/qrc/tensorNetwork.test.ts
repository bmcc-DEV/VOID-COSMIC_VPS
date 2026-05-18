import { describe, expect, it } from 'vitest';
import {
  contractTensors,
  expectationValue,
  marketToMPS,
  marketToQuantumAmplitudes,
  truncatedSVD,
  type MarketState,
} from './tensorNetwork';
import { simulateQuantumSwitch } from './quantumSwitch';

function makeMarket(): MarketState {
  return {
    prices: new Float64Array([0.35, 0.65]),
    volumes: new Float64Array([0.8, 0.6]),
    volatilities: new Float64Array([0.1, 0.2]),
    timestamp: 1_714_000_000,
  };
}

describe('tensorNetwork / QRC', () => {
  it('normaliza amplitudes de mercado para norma 1', () => {
    const amplitudes = marketToQuantumAmplitudes([0.25, 0.75], [0.1, 0.2]);
    const norm = amplitudes.reduce((sum, value) => sum + value * value, 0);

    expect(amplitudes).toHaveLength(4);
    expect(norm).toBeCloseTo(1, 10);
  });

  it('cria MPS com shapes coerentes com a configuração', () => {
    const config = { numSites: 2, physDim: 2, maxBondDim: 4 };
    const mps = marketToMPS(makeMarket(), config);

    expect(mps.numSites).toBe(config.numSites);
    expect(mps.physDim).toBe(config.physDim);
    expect(mps.maxBondDim).toBe(config.maxBondDim);
    expect(mps.cores).toHaveLength(config.numSites);
    expect(mps.shapes).toHaveLength(config.numSites);
    for (const shape of mps.shapes) {
      expect(shape[1]).toBe(config.physDim);
      expect(shape[0]).toBeGreaterThan(0);
      expect(shape[2]).toBeGreaterThan(0);
    }
  });

  it('calcula SVD truncada com rank dentro do limite', () => {
    const matrix = new Float64Array([
      1, 0,
      0, 1,
      1, 1,
    ]);
    const svd = truncatedSVD(matrix, 3, 2, 1);

    expect(svd.rank).toBeLessThanOrEqual(1);
    expect(svd.u).toHaveLength(3 * svd.rank);
    expect(svd.s).toHaveLength(svd.rank);
    expect(svd.vt).toHaveLength(svd.rank * 2);
  });

  it('contrai tensores compatíveis e rejeita dimensões incompatíveis', () => {
    const a = new Float64Array([1, 2, 3, 4]);
    const b = new Float64Array([5, 6, 7, 8]);
    const contracted = contractTensors(a, 2, 2, b, 2, 2);

    expect(Array.from(contracted.result)).toEqual([19, 22, 43, 50]);
    expect(contracted.rows).toBe(2);
    expect(contracted.cols).toBe(2);
    expect(() => contractTensors(a, 2, 2, b, 1, 4)).toThrow('Dimensões incompatíveis');
  });

  it('calcula valor esperado local finito', () => {
    const mps = marketToMPS(makeMarket(), { numSites: 2, physDim: 2, maxBondDim: 4 });
    const identity = new Float64Array([1, 0, 0, 1]);
    const value = expectationValue(mps, 0, identity);

    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it('simula Quantum Switch no fallback CPU', async () => {
    const result = await simulateQuantumSwitch(
      makeMarket(),
      { targetAsset: '$ETBRL', timeSteps: 3, bondDim: 4, useGPU: false },
      null,
    );

    expect(result.paths).toHaveLength(3);
    expect(result.usedGPU).toBe(false);
    expect(result.collapsedPath).toBeDefined();
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(['profit_found', 'no_profit']).toContain(result.status);
  });
});
