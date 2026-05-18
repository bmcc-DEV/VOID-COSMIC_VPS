import { afterEach, describe, expect, it, vi } from 'vitest';
import { EcoNet } from './econet';
import {
  SingularityHarvester,
  coherenceShortPhase,
  fossilMonopolyPhase,
  qrcFrontRunningPhase,
} from './singularityHarvester';
import { simulateQuantumSwitch } from '../qrc/quantumSwitch';
import type { MarketState } from '../qrc/tensorNetwork';

vi.mock('../qrc/quantumSwitch', () => ({
  simulateQuantumSwitch: vi.fn(),
}));

const mockedSimulateQuantumSwitch = vi.mocked(simulateQuantumSwitch);

function makeMarket(): MarketState {
  return {
    prices: new Float64Array([0.4, 0.6, 0.5]),
    volumes: new Float64Array([0.5, 0.5, 0.5]),
    volatilities: new Float64Array([0.1, 0.2, 0.15]),
    timestamp: Date.now(),
  };
}

describe('singularityHarvester', () => {
  const econet = EcoNet.getInstance();

  afterEach(() => {
    mockedSimulateQuantumSwitch.mockReset();
    econet.destroy();
  });

  it('identifica fósseis no EcoNet e calcula monopoly score', () => {
    const entryA = econet.store(new TextEncoder().encode('fossil_a'));
    const entryB = econet.store(new TextEncoder().encode('active_b'));
    const mutableA = econet.getEntry(entryA.id);
    const mutableB = econet.getEntry(entryB.id);
    if (!mutableA || !mutableB) throw new Error('entries não encontradas');
    mutableA.significance = 0.2; // decay = 0.8 (fóssil)
    mutableB.significance = 0.9; // decay = 0.1 (ativo)

    const result = fossilMonopolyPhase(econet);

    expect(result.fossilsScanned).toBe(2);
    expect(result.fossilsControlled).toBe(1);
    expect(result.monopolyScore).toBe(0.5);
    expect(result.scarTokensMinted).toBe(1);
    expect(result.totalDefectValue).toBeGreaterThan(0);
  });

  it('mapeia lucro encontrado na fase QRC', async () => {
    mockedSimulateQuantumSwitch.mockResolvedValue({
      paths: [{}, {}, {}],
      collapsedPath: { description: 'Comprar -> Vender' },
      profit: 1.25,
      payload: '{"asset":"$ETBRL"}',
      usedGPU: true,
      processingTimeMs: 12,
      status: 'profit_found',
    } as any);

    const result = await qrcFrontRunningPhase(makeMarket(), '$ETBRL');

    expect(result.status).toBe('profit_found');
    expect(result.profit).toBe(1.25);
    expect(result.collapsedPath).toContain('Comprar');
    expect(result.pathsExplored).toBe(3);
  });

  it('retorna status de erro na fase QRC quando simulação falha', async () => {
    mockedSimulateQuantumSwitch.mockRejectedValue(new Error('GPU indisponível'));

    const result = await qrcFrontRunningPhase(makeMarket(), '$ETBRL');

    expect(result.status).toBe('error');
    expect(result.profit).toBe(0);
    expect(result.payload).toBeNull();
    expect(result.collapsedPath).toContain('GPU indisponível');
  });

  it('calcula short de coerência quando CDR cruza limiar', () => {
    const result = coherenceShortPhase(4, 0.3);

    expect(result.cdr).toBeCloseTo(0.25, 6);
    expect(result.swapsCreated).toBeGreaterThanOrEqual(1);
    expect(result.totalYield).toBeGreaterThan(0);
  });

  it('orquestra harvest e acumula portfólio entre execuções', async () => {
    mockedSimulateQuantumSwitch.mockResolvedValue({
      paths: [{}, {}, {}],
      collapsedPath: { description: 'caminho vencedor' },
      profit: 2,
      payload: '{"tx":"ok"}',
      usedGPU: false,
      processingTimeMs: 5,
      status: 'profit_found',
    } as any);
    const harvester = new SingularityHarvester(econet);

    const first = await harvester.harvest(makeMarket(), 4, '$ETBRL');
    const second = await harvester.harvest(makeMarket(), 4, '$ETBRL');

    expect(first.phase1.fossilsScanned).toBe(0);
    expect(first.phase2.status).toBe('profit_found');
    expect(first.phase3.totalYield).toBeGreaterThan(0);
    expect(first.totalPortfolioSOV).toBeGreaterThan(0);
    expect(second.totalPortfolioSOV).toBeGreaterThan(first.totalPortfolioSOV);
    expect(harvester.getPortfolio()).toBe(second.totalPortfolioSOV);

    harvester.reset();
    expect(harvester.getPortfolio()).toBe(0);
  });
});
