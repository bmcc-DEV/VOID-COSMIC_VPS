/**
 * ETΞRNET — Tensor Network (MPS) para Simulação Quântica Clássica
 *
 * Implementação de Matrix Product States (MPS) para representar
 * estados de mercado como tensores comprimidos via SVD.
 *
 * Baseado na "Computação Quântico-Relativística" (Cap. 11 do Livro do ETRNET):
 * - Lei de Área: complexidade cresce pela borda, não pelo volume
 * - Compressão Holográfica: matrizes de petabytes → megabytes via SVD truncada
 * - Decomposição em cadeia de tensores de posto baixo (bond dimension χ)
 *
 * O que é REAL:
 * - Matemática de MPS (Fannes-Audenbelt, Perez-Garcia et al.)
 * - SVD truncada para compressão
 * - Contração de tensores (einsum-like)
 *
 * O que é TEÓRICO:
 * - Aplicação a mercados financeiros (mercados não são sistemas quânticos)
 * - "Vantagem quântica" via simulação clássica
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Um tensor MPS: array de matrizes 3D [χ_left, d, χ_right]
 * onde d = dimensão física (ex: 2 para qubit, N para mercado)
 * e χ = dimensão de vínculo (bond dimension, controla compressão)
 */
export interface MPSTensor {
  /** Matrizes do tensor: cores[i] tem shape [chiLeft, d, chiRight] */
  cores: Float64Array[];
  /** Dimensões de cada core: [chiLeft, d, chiRight] */
  shapes: [number, number, number][];
  /** Número de sites (qubits / ativos) */
  numSites: number;
  /** Dimensão física por site */
  physDim: number;
  /** Bond dimension máxima */
  maxBondDim: number;
}

export interface MPSConfig {
  /** Número de sites (ativos financeiros / qubits simulados) */
  numSites: number;
  /** Dimensão física (ex: 2 = {0,1}, 4 = {buy,sell,hold,close}) */
  physDim: number;
  /** Bond dimension máxima (χ). Controla precisão vs custo. χ=64 é prático. */
  maxBondDim: number;
}

export interface MarketState {
  /** Preços normalizados de cada ativo */
  prices: Float64Array;
  /** Volumes normalizados */
  volumes: Float64Array;
  /** Volatilidade por ativo */
  volatilities: Float64Array;
  /** Timestamp */
  timestamp: number;
}

// ─── SVD Truncada ─────────────────────────────────────────────────────────────

/**
 * SVD truncada: decompõe matriz M = U * Σ * V^T e retém apenas
 * os top-k valores singulares. Base da compressão MPS.
 *
 * Algoritmo: Golub-Reinsch simplificado (para matrizes pequenas-médias).
 * Para matrizes grandes, usar WebGPU (webgpuTensorEngine.ts).
 */
export function truncatedSVD(
  matrix: Float64Array,
  rows: number,
  cols: number,
  maxRank: number,
): { u: Float64Array; s: Float64Array; vt: Float64Array; rank: number } {
  // Jacobi eigenvalue algorithm para A^T * A (simplificado)
  const ata = new Float64Array(cols * cols);

  // Calcular A^T * A
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < cols; j++) {
      let sum = 0;
      for (let k = 0; k < rows; k++) {
        sum += matrix[k * cols + i] * matrix[k * cols + j];
      }
      ata[i * cols + j] = sum;
    }
  }

  // Jacobi iterations para autovalores
  const eigenvalues = new Float64Array(cols);
  const eigenvectors = new Float64Array(cols * cols);
  // Inicializar eigenvectors como identidade
  for (let i = 0; i < cols; i++) eigenvectors[i * cols + i] = 1;

  jacobiEigen(ata, cols, eigenvalues, eigenvectors, 100);

  // Ordenar autovalores decrescente
  const indices = Array.from({ length: cols }, (_, i) => i);
  indices.sort((a, b) => eigenvalues[b] - eigenvalues[a]);

  // Truncar para maxRank
  const rank = Math.min(maxRank, indices.filter(i => eigenvalues[i] > 1e-12).length);

  // Valores singulares = sqrt(autovalores)
  const s = new Float64Array(rank);
  for (let i = 0; i < rank; i++) {
    s[i] = Math.sqrt(Math.max(0, eigenvalues[indices[i]]));
  }

  // V^T = eigenvectors transpostos (ordenados)
  const vt = new Float64Array(rank * cols);
  for (let i = 0; i < rank; i++) {
    for (let j = 0; j < cols; j++) {
      vt[i * cols + j] = eigenvectors[indices[i] * cols + j];
    }
  }

  // U = A * V * Σ^{-1}
  const u = new Float64Array(rows * rank);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < rank; j++) {
      let sum = 0;
      for (let k = 0; k < cols; k++) {
        sum += matrix[i * cols + k] * vt[j * cols + k];
      }
      u[i * rank + j] = s[j] > 1e-15 ? sum / s[j] : 0;
    }
  }

  return { u, s, vt, rank };
}

/**
 * Algoritmo de Jacobi para autovalores/autovetores de matriz simétrica.
 */
function jacobiEigen(
  a: Float64Array,
  n: number,
  eigenvalues: Float64Array,
  eigenvectors: Float64Array,
  maxIter: number,
): void {
  const mat = new Float64Array(a); // cópia

  for (let iter = 0; iter < maxIter; iter++) {
    // Encontrar maior elemento off-diagonal
    let maxVal = 0;
    let p = 0;
    let q = 1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const val = Math.abs(mat[i * n + j]);
        if (val > maxVal) {
          maxVal = val;
          p = i;
          q = j;
        }
      }
    }

    if (maxVal < 1e-12) break;

    // Ângulo de rotação
    const theta = 0.5 * Math.atan2(
      2 * mat[p * n + q],
      mat[p * n + p] - mat[q * n + q],
    );
    const c = Math.cos(theta);
    const s = Math.sin(theta);

    // Aplicar rotação de Jacobi
    for (let i = 0; i < n; i++) {
      const mip = mat[i * n + p];
      const miq = mat[i * n + q];
      mat[i * n + p] = c * mip - s * miq;
      mat[i * n + q] = s * mip + c * miq;
    }
    for (let j = 0; j < n; j++) {
      const mpj = mat[p * n + j];
      const mqj = mat[q * n + j];
      mat[p * n + j] = c * mpj - s * mqj;
      mat[q * n + j] = s * mpj + c * mqj;
    }

    // Atualizar autovetores
    for (let i = 0; i < n; i++) {
      const eip = eigenvectors[i * n + p];
      const eiq = eigenvectors[i * n + q];
      eigenvectors[i * n + p] = c * eip - s * eiq;
      eigenvectors[i * n + q] = s * eip + c * eiq;
    }
  }

  for (let i = 0; i < n; i++) {
    eigenvalues[i] = mat[i * n + i];
  }
}

// ─── MPS Construction ─────────────────────────────────────────────────────────

/**
 * Cria um MPS a partir de um estado de mercado.
 *
 * Mapeamento: cada ativo é um "site" com dimensão física `physDim`
 * (ex: 4 estados = buy/sell/hold/close). O preço normalizado determina
 * as amplitudes iniciais do estado quântico simulado.
 *
 * Compressão via SVD truncada garante bond dimension ≤ maxBondDim.
 */
export function marketToMPS(
  market: MarketState,
  config: MPSConfig,
): MPSTensor {
  const { numSites, physDim, maxBondDim } = config;
  const cores: Float64Array[] = [];
  const shapes: [number, number, number][] = [];

  // Inicializar estado produto: cada site independente
  let currentState: Float64Array = new Float64Array(physDim);
  for (let d = 0; d < physDim; d++) {
    currentState[d] = 1.0 / Math.sqrt(physDim);
  }

  // Construir MPS site por site via SVD iterativa
  for (let site = 0; site < numSites; site++) {
    const price = market.prices[site] ?? 0.5;
    const vol = market.volatilities[site] ?? 0.1;

    const localState = new Float64Array(physDim);
    for (let d = 0; d < physDim; d++) {
      const bias = Math.exp(-0.5 * ((d / (physDim - 1)) - price) ** 2 / (vol + 0.01));
      localState[d] = bias;
    }
    const norm = Math.sqrt(localState.reduce((s, v) => s + v * v, 0));
    for (let d = 0; d < physDim; d++) localState[d] /= norm || 1;

    const prevDim = Math.max(1, Math.floor(currentState.length / physDim));
    const combined = new Float64Array(prevDim * physDim);
    for (let i = 0; i < prevDim; i++) {
      for (let d = 0; d < physDim; d++) {
        combined[i * physDim + d] = currentState[i] * localState[d];
      }
    }

    const matRows = prevDim;
    const chiLeft = Math.min(matRows, maxBondDim);

    if (site < numSites - 1) {
      const { u, s, vt, rank } = truncatedSVD(combined, matRows, physDim, maxBondDim);

      const core = new Float64Array(chiLeft * physDim * rank);
      for (let i = 0; i < chiLeft; i++) {
        for (let d = 0; d < physDim; d++) {
          for (let j = 0; j < rank; j++) {
            core[i * physDim * rank + d * rank + j] = u[i * rank + j] * s[j];
          }
        }
      }

      cores.push(core);
      shapes.push([chiLeft, physDim, rank]);
      currentState = vt;
    } else {
      cores.push(combined);
      shapes.push([prevDim, physDim, 1]);
    }
  }

  return { cores, shapes, numSites, physDim, maxBondDim };
}

// ─── Tensor Contraction ───────────────────────────────────────────────────────

/**
 * Contra dois tensores MPS ao longo de um índice compartilhado.
 * Equivalente a: C[i,k] = Σ_j A[i,j] * B[j,k]
 *
 * Esta é a operação fundamental das Redes Tensoriais.
 */
export function contractTensors(
  a: Float64Array, aRows: number, aCols: number,
  b: Float64Array, bRows: number, bCols: number,
): { result: Float64Array; rows: number; cols: number } {
  if (aCols !== bRows) {
    throw new Error(`Dimensões incompatíveis para contração: ${aCols} != ${bRows}`);
  }

  const result = new Float64Array(aRows * bCols);
  for (let i = 0; i < aRows; i++) {
    for (let k = 0; k < bCols; k++) {
      let sum = 0;
      for (let j = 0; j < aCols; j++) {
        sum += a[i * aCols + j] * b[j * bCols + k];
      }
      result[i * bCols + k] = sum;
    }
  }

  return { result, rows: aRows, cols: bCols };
}

/**
 * Contra dois cores MPS adjacentes para formar um "transfer matrix".
 * Usado para calcular overlaps ⟨ψ|ψ'⟩ e expectativas ⟨ψ|O|ψ⟩.
 */
export function contractMPSCores(
  coreA: Float64Array, shapeA: [number, number, number],
  coreB: Float64Array, shapeB: [number, number, number],
): Float64Array {
  const [chiL_a, d_a, chiR_a] = shapeA;
  const [chiL_b, d_b, chiR_b] = shapeB;

  // Contrair sobre dimensão física compartilhada
  const result = new Float64Array(chiL_a * chiR_a * chiL_b * chiR_b);

  for (let i = 0; i < chiL_a; i++) {
    for (let j = 0; j < chiR_a; j++) {
      for (let k = 0; k < chiL_b; k++) {
        for (let l = 0; l < chiR_b; l++) {
          let sum = 0;
          for (let d = 0; d < Math.min(d_a, d_b); d++) {
            sum += coreA[i * d_a * chiR_a + d * chiR_a + j]
                 * coreB[k * d_b * chiR_b + d * chiR_b + l];
          }
          result[(i * chiR_a + j) * chiL_b * chiR_b + (k * chiR_b + l)] = sum;
        }
      }
    }
  }

  return result;
}

// ─── MPS Observables ──────────────────────────────────────────────────────────

/**
 * Calcula o valor esperado de um observável local em um site do MPS.
 * ⟨ψ|O_site|ψ⟩ = Tr(ρ_site * O)
 *
 * Onde ρ_site é a matriz densidade reduzida obtida por contração
 * de todos os outros cores.
 */
export function expectationValue(
  mps: MPSTensor,
  site: number,
  operator: Float64Array, // d×d matrix
): number {
  const [chiL, d, chiR] = mps.shapes[site];
  const core = mps.cores[site];

  // Aplicar operador ao core: O|ψ⟩
  const opApplied = new Float64Array(chiL * d * chiR);
  for (let i = 0; i < chiL; i++) {
    for (let d1 = 0; d1 < d; d1++) {
      for (let j = 0; j < chiR; j++) {
        let sum = 0;
        for (let d2 = 0; d2 < d; d2++) {
          sum += operator[d1 * d + d2] * core[i * d * chiR + d2 * chiR + j];
        }
        opApplied[i * d * chiR + d1 * chiR + j] = sum;
      }
    }
  }

  // ⟨ψ|O|ψ⟩ = soma de |elemento|² (normalizado)
  let expectation = 0;
  let norm = 0;
  for (let i = 0; i < chiL * d * chiR; i++) {
    expectation += core[i] * opApplied[i];
    norm += core[i] * core[i];
  }

  return norm > 0 ? expectation / norm : 0;
}

// ─── Market → Quantum State Mapping ──────────────────────────────────────────

/**
 * Mapeia estado de mercado para "amplitudes quânticas" simuladas.
 *
 * Cada ativo é um qubit simulado:
 * |0⟩ = preço desce, |1⟩ = preço sobe
 * amplitudes = √(probabilidade) baseada em momentum + volatilidade
 *
 * Isto é uma SIMULAÇÃO CLÁSSICA de um sistema quântico.
 * Não há vantagem quântica real — é álgebra linear otimizada.
 */
export function marketToQuantumAmplitudes(
  prices: number[],
  volatilities: number[],
): Float64Array {
  const n = prices.length;
  const stateSize = 1 << n; // 2^n amplitudes
  const amplitudes = new Float64Array(stateSize);

  // Para cada configuração possível (bitstring)
  for (let config = 0; config < stateSize; config++) {
    let logProb = 0;
    for (let i = 0; i < n; i++) {
      const bit = (config >> i) & 1; // 0 = desce, 1 = sobe
      const momentum = prices[i]; // 0-1 normalizado
      const vol = volatilities[i] || 0.1;

      // P(sobe) = momentum, P(desce) = 1 - momentum
      // Modulado por volatilidade (incerteza)
      const pUp = momentum * (1 - vol) + 0.5 * vol;
      const pBit = bit === 1 ? pUp : (1 - pUp);
      logProb += Math.log(pBit + 1e-10);
    }

    amplitudes[config] = Math.exp(0.5 * logProb); // √(probabilidade)
  }

  // Normalizar
  const norm = Math.sqrt(amplitudes.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < stateSize; i++) amplitudes[i] /= norm || 1;

  return amplitudes;
}
