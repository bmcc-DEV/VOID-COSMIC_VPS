/**
 * ETΞRNET — Quantum Switch Simulator (Ordem Causal Indefinida)
 *
 * Simula o "Interruptor Quântico" (Quantum Switch) — um dispositivo que
 * processa operações em superposição de ordem causal.
 *
 * No trade clássico: comprar(A) → vender(B) OU vender(B) → comprar(A)
 * No Quantum Switch: ambos simultaneamente → colapsa para o lucro máximo
 *
 * Referências:
 * - Chiribella et al. (2013) — "Quantum circuits with indefinite causal order"
   - Proc. 1405.0232 — Experimental verification of indefinite causal order
 * - O Livro do ETRNET, Cap. 11 — Computação Quântico-Relativística
 *
 * IMPLEMENTAÇÃO: Simulação clássica via redes tensoriais.
 * Não há vantagem quântica real — é álgebra linear otimizada que explora
 * ambos os caminhos causais e seleciona o mais lucrativo.
 *
 * O valor real está em: processar os dois cenários em paralelo (WebGPU)
 * e colapsar para o melhor antes que a ordem atinja o roteador.
 */

import {
  marketToMPS,
  marketToQuantumAmplitudes,
  expectationValue,
  type MarketState,
  type MPSConfig,
} from "./tensorNetwork";
import {
  initWebGPUTensor,
  gpuApplyOperator,
  destroyWebGPUTensor,
  type WebGPUTensorDevice,
} from "./webgpuTensorEngine";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuantumSwitchConfig {
  /** Ativo alvo (ex: "$ETBRL", "$BTC") */
  targetAsset: string;
  /** Número de passos temporais para simulação */
  timeSteps: number;
  /** Bond dimension para MPS (χ) — controla precisão */
  bondDim: number;
  /** Usar WebGPU se disponível */
  useGPU: boolean;
}

export interface CausalPath {
  /** Descrição do caminho causal */
  description: string;
  /** Sequência de operações */
  operations: string[];
  /** Valor esperado (lucro estimado) */
  expectedValue: number;
  /** Probabilidade do cenário */
  probability: number;
  /** Amplitudes quânticas simuladas do estado final */
  finalAmplitudes: Float64Array;
}

export interface QuantumSwitchResult {
  /** Caminhos causais explorados */
  paths: CausalPath[];
  /** Caminho colapsado (mais lucrativo) */
  collapsedPath: CausalPath;
  /** Lucro esperado do caminho vencedor */
  profit: number;
  /** Payload da transação (se lucro > 0) */
  payload: string | null;
  /** Se usou WebGPU */
  usedGPU: boolean;
  /** Tempo total de processamento */
  processingTimeMs: number;
  /** Status da operação */
  status: "profit_found" | "no_profit" | "error";
}

// ─── Operadores Quânticos Simulados ───────────────────────────────────────────

/**
 * Operador "Comprar": desloca amplitude para estados de preço mais alto.
 * Em termos quânticos: R_y(θ) onde θ ∝ momentum.
 */
function buyOperator(dim: number, momentum: number): Float64Array {
  const op = new Float64Array(dim * dim);
  const theta = momentum * Math.PI / 2;

  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      // Rotação que favorece estados superiores
      if (i === j) {
        op[i * dim + j] = Math.cos(theta / 2);
      } else if (i === j + 1 || j === i + 1) {
        op[i * dim + j] = Math.sin(theta / 2) * (i > j ? 1 : -1);
      }
    }
  }

  return op;
}

/**
 * Operador "Vender": desloca amplitude para estados de preço mais baixo.
 */
function sellOperator(dim: number, momentum: number): Float64Array {
  const op = new Float64Array(dim * dim);
  const theta = (1 - momentum) * Math.PI / 2;

  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      if (i === j) {
        op[i * dim + j] = Math.cos(theta / 2);
      } else if (i === j + 1 || j === i + 1) {
        op[i * dim + j] = Math.sin(theta / 2) * (i < j ? 1 : -1);
      }
    }
  }

  return op;
}

/**
 * Operador "Esperar": identidade (mantém estado).
 */
function holdOperator(dim: number): Float64Array {
  const op = new Float64Array(dim * dim);
  for (let i = 0; i < dim; i++) op[i * dim + i] = 1;
  return op;
}

/**
 * Operador de preço: diagonal com valores = preços normalizados.
 * Usado para calcular valor esperado ⟨ψ|P|ψ⟩.
 */
function priceOperator(prices: number[]): Float64Array {
  const dim = prices.length;
  const op = new Float64Array(dim * dim);
  for (let i = 0; i < dim; i++) op[i * dim + i] = prices[i];
  return op;
}

// ─── Quantum Switch Core ──────────────────────────────────────────────────────

/**
 * Simula o Quantum Switch: processa dois caminhos causais simultaneamente.
 *
 * Caminho A: comprar → esperar → vender  (se preço sobe)
 * Caminho B: vender → esperer → comprar  (se preço desce)
 * Caminho C: esperar (hold)              (se mercado lateral)
 *
 * Todos são calculados em paralelo. O "colapso" seleciona o de maior lucro.
 *
 * @param market Estado atual do mercado
 * @param config Configuração da simulação
 * @param gpu Dispositivo WebGPU (opcional, fallback CPU se null)
 */
export async function simulateQuantumSwitch(
  market: MarketState,
  config: QuantumSwitchConfig,
  gpu?: WebGPUTensorDevice | null,
): Promise<QuantumSwitchResult> {
  const t0 = performance.now();
  const dim = market.prices.length;

  // 1. Mapear mercado para estado quântico simulado
  const amplitudes = marketToQuantumAmplitudes(
    Array.from(market.prices),
    Array.from(market.volatilities),
  );

  // 2. Construir MPS do estado de mercado (compressão holográfica)
  const mpsConfig: MPSConfig = {
    numSites: dim,
    physDim: 2,
    maxBondDim: config.bondDim,
  };
  const mps = marketToMPS(market, mpsConfig);

  // 3. Medir coerência do MPS (usando expectation value no site central)
  const centralSite = Math.floor(dim / 2);
  const coherenceOp = new Float64Array(4); // 2×2 identity como proxy
  coherenceOp[0] = 1; coherenceOp[3] = 1;
  const mpsCoherence = expectationValue(mps, centralSite, coherenceOp);

  // 4. Construir operadores para cada caminho causal
  const momentum = Array.from(market.prices).reduce((s, p) => s + p, 0) / dim;
  const buyOp = buyOperator(dim, momentum * (1 + mpsCoherence * 0.1));
  const sellOp = sellOperator(dim, (1 - momentum) * (1 + mpsCoherence * 0.1));
  const holdOp = holdOperator(dim);
  const priceOp = priceOperator(Array.from(market.prices));

  // 4. Simular os 3 caminhos causais
  // Se GPU disponível, usar aceleração WebGPU; senão CPU
  const apply = gpu
    ? async (state: Float64Array, op: Float64Array) => {
        const f32State = new Float32Array(state);
        const f32Op = new Float32Array(op);
        const result = await gpuApplyOperator(gpu, f32Op, f32State, dim);
        return new Float64Array(result);
      }
    : async (state: Float64Array, op: Float64Array) => applyOperator(state, op, dim);

  const paths: CausalPath[] = [];

  // --- Caminho A: Comprar → Hold → Vender ---
  const stateAfterBuy = await apply(amplitudes, buyOp);
  const stateAfterHoldA = await apply(stateAfterBuy, holdOp);
  const stateAfterSellA = await apply(stateAfterHoldA, sellOp);
  const valueA = computeExpectation(stateAfterSellA, priceOp, dim);

  paths.push({
    description: "Comprar → Esperar → Vender (aposta em alta)",
    operations: ["BUY", "HOLD", "SELL"],
    expectedValue: valueA,
    probability: computeProbability(stateAfterSellA),
    finalAmplitudes: stateAfterSellA,
  });

  // --- Caminho B: Vender → Hold → Comprar ---
  const stateAfterSell = await apply(amplitudes, sellOp);
  const stateAfterHoldB = await apply(stateAfterSell, holdOp);
  const stateAfterBuyB = await apply(stateAfterHoldB, buyOp);
  const valueB = computeExpectation(stateAfterBuyB, priceOp, dim);

  paths.push({
    description: "Vender → Esperar → Comprar (aposta em baixa)",
    operations: ["SELL", "HOLD", "BUY"],
    expectedValue: valueB,
    probability: computeProbability(stateAfterBuyB),
    finalAmplitudes: stateAfterBuyB,
  });

  // --- Caminho C: Hold → Hold → Hold (lateral) ---
  const stateAfterHold = await apply(amplitudes, holdOp);
  const stateAfterHold2 = await apply(stateAfterHold, holdOp);
  const stateAfterHold3 = await apply(stateAfterHold2, holdOp);
  const valueC = computeExpectation(stateAfterHold3, priceOp, dim);

  paths.push({
    description: "Esperar → Esperar → Esperar (mercado lateral)",
    operations: ["HOLD", "HOLD", "HOLD"],
    expectedValue: valueC,
    probability: computeProbability(stateAfterHold3),
    finalAmplitudes: stateAfterHold3,
  });

  // 5. Colapso: selecionar o caminho de maior valor esperado
  const collapsedPath = paths.reduce((best, p) =>
    p.expectedValue > best.expectedValue ? p : best,
  );

  // 6. Determinar se há lucro (valor esperado > preço atual)
  const currentPrice = momentum; // preço médio atual
  const profit = collapsedPath.expectedValue - currentPrice;

  // 7. Gerar payload se lucrativo
  let payload: string | null = null;
  if (profit > 0) {
    const txData = {
      asset: config.targetAsset,
      action: collapsedPath.operations[0],
      expectedProfit: profit,
      confidence: collapsedPath.probability,
      timestamp: Date.now(),
    };
    payload = JSON.stringify(txData);
  }

  const usedGPU = gpu !== null && gpu !== undefined;

  return {
    paths,
    collapsedPath,
    profit,
    payload,
    usedGPU,
    processingTimeMs: performance.now() - t0,
    status: profit > 0 ? "profit_found" : "no_profit",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Aplica operador a um estado (multiplicação matriz × vetor).
 * CPU fallback — para GPU usar gpuApplyOperator().
 */
function applyOperator(
  state: Float64Array,
  operator: Float64Array,
  dim: number,
): Float64Array {
  const result = new Float64Array(dim);
  for (let i = 0; i < dim; i++) {
    let sum = 0;
    for (let j = 0; j < dim; j++) {
      sum += operator[i * dim + j] * state[j];
    }
    result[i] = sum;
  }
  return result;
}

/**
 * Calcula valor esperado ⟨ψ|O|ψ⟩.
 */
function computeExpectation(
  state: Float64Array,
  operator: Float64Array,
  dim: number,
): number {
  let expectation = 0;
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      expectation += state[i] * operator[i * dim + j] * state[j];
    }
  }
  return expectation;
}

/**
 * Calcula probabilidade (norma ao quadrado do estado).
 */
function computeProbability(state: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < state.length; i++) {
    sum += state[i] * state[i];
  }
  return sum;
}

/**
 * Versão GPU-acelerada do Quantum Switch.
 * Usa WebGPU para calcular os 3 caminhos causais em paralelo.
 */
export async function simulateQuantumSwitchGPU(
  market: MarketState,
  config: QuantumSwitchConfig,
): Promise<QuantumSwitchResult> {
  const gpu = await initWebGPUTensor();

  if (!gpu) {
    console.warn("[QRC] WebGPU indisponível, fallback para CPU");
    return simulateQuantumSwitch(market, config, null);
  }

  try {
    const result = await simulateQuantumSwitch(market, config, gpu);
    return result;
  } finally {
    destroyWebGPUTensor(gpu);
  }
}
