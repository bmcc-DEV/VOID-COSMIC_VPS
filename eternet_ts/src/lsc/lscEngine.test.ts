import { describe, it, expect } from 'vitest';
import {
  totalEnergy,
  modalCoherence,
  geometrogenesis,
  LSCEngine,
  getLSCEngine,
  type QuantumCausalGraph,
  type QCGNode,
} from './lscEngine';

// ─── Helper para criar grafo de teste ──────────────────
function makeGraph(nodes: QCGNode[], edges: QuantumCausalGraph['edges'] = []): QuantumCausalGraph {
  return { nodes, edges };
}

function makeNode(id: string, E_tau: number): QCGNode {
  return {
    id,
    E_tau,
    coherencePhase: 0,
    vibrationalModes: [1, 2, 3],
  };
}

// ─── totalEnergy ───────────────────────────────────────

describe('lscEngine', () => {
  describe('totalEnergy', () => {
    it('retorna 0 para grafo vazio', () => {
      const graph = makeGraph([]);
      expect(totalEnergy(graph)).toBe(0);
    });

    it('soma energias de todos os nós', () => {
      const graph = makeGraph([
        makeNode('a', 10),
        makeNode('b', 20),
        makeNode('c', 30),
      ]);
      expect(totalEnergy(graph)).toBe(60);
    });

    it('funciona com um único nó', () => {
      const graph = makeGraph([makeNode('x', 42)]);
      expect(totalEnergy(graph)).toBe(42);
    });

    it('nós com energia zero não afetam a soma', () => {
      const graph = makeGraph([
        makeNode('a', 0),
        makeNode('b', 0),
        makeNode('c', 5),
      ]);
      expect(totalEnergy(graph)).toBe(5);
    });
  });

  // ─── modalCoherence ────────────────────────────────────

  describe('modalCoherence', () => {
    it('retorna 0 para arrays vazios', () => {
      expect(modalCoherence([], [])).toBe(0);
    });

    it('lança erro para tamanhos diferentes', () => {
      expect(() => modalCoherence([1, 2], [1])).toThrow(
        'amplitudes e phases devem ter o mesmo tamanho'
      );
    });

    it('coerência máxima quando todas as fases são iguais', () => {
      // |Σ 1·e^{i·0}|² / 3 = |3|² / 3 = 9/3 = 3
      const result = modalCoherence([1, 1, 1], [0, 0, 0]);
      expect(result).toBeCloseTo(3.0, 10);
    });

    it('coerência parcial com amplitudes iguais e fases uniformes', () => {
      // fases: 0, 2π/3, 4π/3 → soma vetorial = 0
      const amplitudes = [1, 1, 1];
      const phases = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
      const result = modalCoherence(amplitudes, phases);
      // |Σ e^{iφ_k}|² = 0 (simetria perfeita)
      expect(result).toBeCloseTo(0, 10);
    });

    it('coerência com amplitude única', () => {
      // Um modo: |a·e^{iφ}|² / 1 = a²
      expect(modalCoherence([5], [0])).toBeCloseTo(25, 10);
      expect(modalCoherence([5], [Math.PI / 4])).toBeCloseTo(25, 10);
    });

    it('amplitude zero reduz coerência', () => {
      // Apenas um modo ativo de 3
      // |1·e^{i·0}|² / 3 = 1/3
      const result = modalCoherence([1, 0, 0], [0, 0, 0]);
      expect(result).toBeCloseTo(1 / 3, 10);
    });

    it('amplitudes diferentes afetam coerência', () => {
      // |2·e^{i·0} + 1·e^{i·0}|² / 2 = |3|² / 2 = 9/2 = 4.5
      const result = modalCoherence([2, 1], [0, 0]);
      expect(result).toBeCloseTo(4.5, 10);
    });
  });

  // ─── geometrogenesis ───────────────────────────────────

  describe('geometrogenesis', () => {
    it('R = κE', () => {
      expect(geometrogenesis(100, 0.5)).toBeCloseTo(50, 10);
    });

    it('κ = 0 resulta em curvatura zero', () => {
      expect(geometrogenesis(1000, 0)).toBe(0);
    });

    it('energia zero resulta em curvatura zero', () => {
      expect(geometrogenesis(0, 5)).toBe(0);
    });

    it('κ negativo inverte o sinal', () => {
      expect(geometrogenesis(10, -2)).toBeCloseTo(-20, 10);
    });
  });

  // ─── LSCEngine ─────────────────────────────────────────

  describe('LSCEngine', () => {
    // Reset singleton para testes isolados
    let engine: LSCEngine;

    it('getInstance retorna singleton', () => {
      const a = LSCEngine.getInstance();
      const b = LSCEngine.getInstance();
      expect(a).toBe(b);
    });

    describe('law1MaximumPower', () => {
      it('retorna P_demand quando menor que P_max * C_epsilon', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        // P_demand=50, P_max=100, C=1.0 → effectiveMax=100 → min(50,100)=50
        const result = engine.law1MaximumPower(50, 100, 1.0);
        expect(result).toBe(50);
      });

      it('retorna P_max * C_epsilon quando P_demand excede', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        // P_demand=200, P_max=100, C=0.5 → effectiveMax=50 → min(200,50)=50
        const result = engine.law1MaximumPower(200, 100, 0.5);
        expect(result).toBe(50);
      });

      it('coerência zero bloqueia toda potência', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        // P_demand=100, P_max=100, C=0 → effectiveMax=0 → min(100,0)=0
        const result = engine.law1MaximumPower(100, 100, 0);
        expect(result).toBe(0);
      });

      it('P_demand zero retorna zero', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        expect(engine.law1MaximumPower(0, 100, 1.0)).toBe(0);
      });

      it('atualiza P_current no estado', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        engine.law1MaximumPower(30, 100, 1.0);
        expect(engine.getState().P_current).toBe(30);
      });
    });

    describe('law2Saturation', () => {
      it('C_epsilon = 0: G = 1/(1 + μ)', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        // μ=0.1 → G = 1/1.1 ≈ 0.90909...
        const result = engine.law2Saturation(0, 0.1, 3);
        expect(result).toBeCloseTo(1 / 1.1, 5);
      });

      it('C_epsilon = 1: G = 1/(μ·e^β)', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        // μ=0.1, β=3 → G = 1/(0.1·e³) = 1/(0.1·20.0855) ≈ 0.4979
        const expected = 1 / (0.1 * Math.exp(3));
        const result = engine.law2Saturation(1, 0.1, 3);
        expect(result).toBeCloseTo(expected, 5);
      });

      it('G é sempre positivo', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        for (let c = 0; c <= 1; c += 0.1) {
          expect(engine.law2Saturation(c)).toBeGreaterThan(0);
        }
      });

      it('parâmetros customizados funcionam', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        // μ=1, β=0, C=0 → G = 1/(1 + 1·e^0) = 1/2 = 0.5
        const result = engine.law2Saturation(0, 1, 0);
        expect(result).toBeCloseTo(0.5, 5);
      });
    });

    describe('law3Holofriction', () => {
      it('C_epsilon = 0: K_eff = K_0 + R_thermal', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        // K_0=1.0, R_thermal=0.01 → K_eff = 1.0*(1-0) + 0.01 = 1.01
        const result = engine.law3Holofriction(0, 1.0, 0.01);
        expect(result).toBeCloseTo(1.01, 10);
      });

      it('C_epsilon = 1: K_eff = R_thermal (mínimo)', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        // K_0=1.0, R_thermal=0.01 → K_eff = 1.0*(1-1) + 0.01 = 0.01
        const result = engine.law3Holofriction(1, 1.0, 0.01);
        expect(result).toBeCloseTo(0.01, 10);
      });

      it('K_eff diminui linearmente com coerência', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const k0 = engine.law3Holofriction(0, 2.0, 0);
        const k1 = engine.law3Holofriction(0.5, 2.0, 0);
        const k2 = engine.law3Holofriction(1, 2.0, 0);
        // K_0*(1-0)=2, K_0*(1-0.5)=1, K_0*(1-1)=0
        expect(k0).toBeCloseTo(2.0, 10);
        expect(k1).toBeCloseTo(1.0, 10);
        expect(k2).toBeCloseTo(0.0, 10);
      });

      it('atualiza K_eff no estado', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        engine.law3Holofriction(0.5, 1.0, 0.0);
        expect(engine.getState().K_eff).toBeCloseTo(0.5, 10);
      });
    });

    describe('updateGraph', () => {
      it('propaga estresse para nós destino', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const graph = makeGraph(
          [makeNode('a', 10), makeNode('b', 20)],
          [{ from: 'a', to: 'b', causalStrength: 0.5 }]
        );
        // stress=10, causalStrength=0.5 → b.E_tau += 5
        const updated = engine.updateGraph(graph, 10);
        const nodeB = updated.nodes.find((n) => n.id === 'b');
        expect(nodeB!.E_tau).toBeCloseTo(25, 10);
      });

      it('não modifica o nó de origem', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const graph = makeGraph(
          [makeNode('a', 10), makeNode('b', 20)],
          [{ from: 'a', to: 'b', causalStrength: 0.5 }]
        );
        const updated = engine.updateGraph(graph, 10);
        const nodeA = updated.nodes.find((n) => n.id === 'a');
        expect(nodeA!.E_tau).toBe(10);
      });

      it('preserva arestas do grafo', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const edges = [
          { from: 'a', to: 'b', causalStrength: 0.5 },
          { from: 'b', to: 'a', causalStrength: 0.3 },
        ];
        const graph = makeGraph([makeNode('a', 10), makeNode('b', 20)], edges);
        const updated = engine.updateGraph(graph, 10);
        expect(updated.edges).toEqual(edges);
      });

      it('atualiza histórico de estresse', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const graph = makeGraph([makeNode('a', 10)]);
        engine.updateGraph(graph, 5);
        engine.updateGraph(graph, 10);
        const state = engine.getState();
        expect(state.stressHistory).toContain(5);
        expect(state.stressHistory).toContain(10);
      });
    });

    describe('simulateSaturationCurve', () => {
      it('gera número correto de pontos', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const curve = engine.simulateSaturationCurve(10);
        expect(curve.length).toBe(10);
      });

      it('pontos vão de C_epsilon=0 a C_epsilon=1', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const curve = engine.simulateSaturationCurve(50);
        expect(curve[0]![0]).toBeCloseTo(0, 10);
        expect(curve[49]![0]).toBeCloseTo(1, 10);
      });

      it('valores G correspondem a law2Saturation', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const curve = engine.simulateSaturationCurve(5);
        // curve[2] → C_epsilon = 2/4 = 0.5
        const expected = engine.law2Saturation(0.5);
        expect(curve[2]![1]).toBeCloseTo(expected, 10);
      });

      it('pares são tuplas [C_epsilon, G]', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const curve = engine.simulateSaturationCurve(3);
        expect(curve.length).toBe(3);
        for (const [c, g] of curve) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
          expect(g).toBeGreaterThan(0);
        }
      });
    });

    describe('getState / reset', () => {
      it('estado inicial tem valores padrão', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const state = engine.getState();
        expect(state.C_epsilon).toBe(0);
        expect(state.P_current).toBe(0);
        expect(state.K_eff).toBe(1.0);
        expect(state.stressHistory).toEqual([]);
      });

      it('reset restaura estado inicial', () => {
        engine = LSCEngine.getInstance();
        engine.law1MaximumPower(50, 100, 0.5);
        engine.reset();
        const state = engine.getState();
        expect(state.P_current).toBe(0);
      });

      it('getState retorna cópia defensiva', () => {
        engine = LSCEngine.getInstance();
        engine.reset();
        const state1 = engine.getState();
        const state2 = engine.getState();
        expect(state1).not.toBe(state2);
        expect(state1).toEqual(state2);
      });
    });
  });

  // ─── getLSCEngine ──────────────────────────────────────

  describe('getLSCEngine', () => {
    it('retorna instância válida', () => {
      const engine = getLSCEngine();
      expect(engine).toBeInstanceOf(LSCEngine);
    });
  });
});
