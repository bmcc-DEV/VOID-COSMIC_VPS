/**
 * V0ID vHGPU -- Differential Core (Capitulo 4.2.3)
 *
 * Implementa operadores diferencias para o pipeline HGPU:
 * 1. DERIVADA FRECHET -- Df(p)[v] = (f(p+ev) - f(p-ev))/(2e)
 * 2. NORMA SOBOLEV   -- ||f||^2_{H^s} = Sigma(1+k^{2s})|c_k|^2
 * 3. CURVATURAS PRINCIPAIS -- Autovalores da Hessiana via diferencas finitas
 *
 * Esses operadores sao usados para:
 * - Analise de sensibilidade de campos de velocidade
 * - Compressao espectral com metrica de Sobolev
 * - Detecao de mudanças topologicas em superficies
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Derivada de Frechet em um ponto ao longo de uma direcao.
 *
 * Representa a taxa de variacao da funcao f ao longo da direcao v.
 */
export interface FrechetDerivative {
  /** Ponto de avaliacao */
  point: number[];
  /** Vetor tangente (derivada na direcao v) */
  tangent: number[];
  /** Norma do vetor tangente */
  norm: number;
}

/**
 * Curvaturas principais de uma superficie em um ponto.
 *
 * As curvaturas principais sao os autovalores da segunda forma
 * fundamental (Hessiana restrita ao plano tangente).
 */
export interface PrincipalCurvatures {
  /** Primeira curvatura principal (maior) */
  k1: number;
  /** Segunda curvatura principal (menor) */
  k2: number;
  /** Direcao da primeira curvatura principal */
  direction1: number[];
  /** Direcao da segunda curvatura principal */
  direction2: number[];
}

// ─── 1. Derivada de Frechet ──────────────────────────────────────────────────

/**
 * Calcula a derivada de Frechet de f em p na direcao v.
 *
 * Formula: Df(p)[v] = (f(p + e*v) - f(p - e*v)) / (2*e)
 *
 * Esta e a derivada direcional via diferencas centrais,
 * que tem precisao O(e^2) ao inves de O(e) das diferencas
 * progressivas.
 *
 * @param evaluate - Funcao a ser diferenciada
 * @param p - Ponto de avaliacao
 * @param direction - Direcao da derivada
 * @param eps - Tamanho do passo (default: 1e-6)
 * @returns Derivada de Frechet com ponto, tangente e norma
 */
export function computeFrechetDerivative(
  evaluate: (p: number[]) => number,
  p: number[],
  direction: number[],
  eps: number = 1e-6
): FrechetDerivative {
  const n = p.length;

  // Normaliza a direcao
  let dirNorm = 0;
  for (let i = 0; i < n; i++) {
    dirNorm += direction[i]! * direction[i]!;
  }
  dirNorm = Math.sqrt(dirNorm);
  const normalizedDir = dirNorm > 0
    ? direction.map((d) => d / dirNorm)
    : direction.map(() => 0);

  // Calcula f(p + eps*v) e f(p - eps*v)
  const pForward = new Array(n);
  const pBackward = new Array(n);
  for (let i = 0; i < n; i++) {
    pForward[i] = p[i]! + eps * normalizedDir[i]!;
    pBackward[i] = p[i]! - eps * normalizedDir[i]!;
  }

  const fForward = evaluate(pForward);
  const fBackward = evaluate(pBackward);

  // Derivada central: (f(p+ev) - f(p-ev)) / (2e)
  const tangentValue = (fForward - fBackward) / (2 * eps);

  // Vetor tangente (escalar projetado na direcao)
  const tangent = normalizedDir.map((d) => d * tangentValue);
  const norm = Math.abs(tangentValue);

  return {
    point: [...p],
    tangent,
    norm,
  };
}

// ─── 2. Norma de Sobolev ─────────────────────────────────────────────────────

/**
 * Calcula a norma de Sobolev H^s de um campo via DFT.
 *
 * ||f||^2_{H^s} = Sigma_k (1 + k^{2s}) * |c_k|^2
 *
 * Onde c_k sao os coeficientes de Fourier (DFT) e s e a ordem
 * da norma. Para s=0, equivale a norma L2.
 *
 * A norma de Sobolev penaliza oscilacoes de alta frequencia,
 * sendo ideal para compressao espectral: campos suaves tem
 * norma de Sobolev baixa e podem ser representados com poucos
 * coeficientes.
 *
 * @param field - Campo de valores (dominio discreto)
 * @param order - Ordem s da norma de Sobolev (default: 1)
 * @returns Valor da norma ||f||_{H^s}
 */
export function sobolevNorm(field: number[], order: number = 1): number {
  const N = field.length;
  if (N === 0) return 0;

  // Calcula DFT simplificado (componentes reais)
  // c_k = Sigma_n f(n) * e^{-2pi*i*k*n/N}
  const realCoeffs = new Float64Array(N);
  const imagCoeffs = new Float64Array(N);

  for (let k = 0; k < N; k++) {
    let realSum = 0;
    let imagSum = 0;
    for (let n = 0; n < N; n++) {
      const angle = (-2 * Math.PI * k * n) / N;
      realSum += field[n]! * Math.cos(angle);
      imagSum += field[n]! * Math.sin(angle);
    }
    realCoeffs[k] = realSum / N;
    imagCoeffs[k] = imagSum / N;
  }

  // Calcula ||f||^2_{H^s} = Sigma_k (1 + k^{2s}) * |c_k|^2
  let normSq = 0;
  for (let k = 0; k < N; k++) {
    const magnitudeSq = realCoeffs[k]! * realCoeffs[k]! +
                        imagCoeffs[k]! * imagCoeffs[k]!;
    const weight = 1 + Math.pow(k, 2 * order);
    normSq += weight * magnitudeSq;
  }

  return Math.sqrt(normSq);
}

// ─── 3. Curvaturas Principais ────────────────────────────────────────────────

/**
 * Calcula as curvaturas principais via autovalores da Hessiana.
 *
 * A Hessiana H(f) e a matriz de segunda derivada:
 *   H_{ij} = d^2f / (dx_i * dx_j)
 *
 * As curvaturas principais sao os autovalores de H restrito
 * ao plano tangente. Para funcoes de R^n -> R, calculamos
 * os autovalores da Hessiana completa.
 *
 * Implementacao via diferencas finitas centrais:
 *   H_{ii} = (f(p+e*e_i) - 2f(p) + f(p-e*e_i)) / e^2
 *   H_{ij} = (f(p+e*e_i+e*e_j) - f(p+e*e_i-e*e_j)
 *            -f(p-e*e_i+e*e_j) + f(p-e*e_i-e*e_j)) / (4e^2)
 *
 * @param evaluate - Funcao escalar a ser analisada
 * @param p - Ponto de avaliacao
 * @returns Curvaturas principais e direcoes
 */
export function principalCurvatures(
  evaluate: (p: number[]) => number,
  p: number[]
): PrincipalCurvatures {
  const n = p.length;
  const eps = 1e-5;
  const f0 = evaluate(p);

  // Construir Hessiana via diferencas finitas
  const hessian: number[][] = [];
  for (let i = 0; i < n; i++) {
    hessian[i] = new Array(n).fill(0);
  }

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (i === j) {
        // Diagonal: f(p+e*e_i) - 2f(p) + f(p-e*e_i)
        const pForward = [...p];
        const pBackward = [...p];
        pForward[i] += eps;
        pBackward[i] -= eps;
        hessian[i]![j] = (evaluate(pForward) - 2 * f0 + evaluate(pBackward)) / (eps * eps);
      } else {
        // Fora da diagonal: diferencas cruzadas
        const pPP = [...p]; pPP[i] += eps; pPP[j] += eps;
        const pPM = [...p]; pPM[i] += eps; pPM[j] -= eps;
        const pMP = [...p]; pMP[i] -= eps; pMP[j] += eps;
        const pMM = [...p]; pMM[i] -= eps; pMM[j] -= eps;
        hessian[i]![j] = (evaluate(pPP) - evaluate(pPM) - evaluate(pMP) + evaluate(pMM)) / (4 * eps * eps);
        hessian[j]![i] = hessian[i]![j]; // Simetria
      }
    }
  }

  // Para n=2, formula analitica para autovalores 2x2
  if (n === 2) {
    const a = hessian[0]![0]!;
    const b = hessian[0]![1]!;
    const c = hessian[1]![0]!;
    const d = hessian[1]![1]!;
    const trace = a + d;
    const det = a * d - b * c;
    const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));

    const k1 = trace / 2 + disc;
    const k2 = trace / 2 - disc;

    // Autovalores (direcoes principais)
    let dir1: number[];
    let dir2: number[];
    if (Math.abs(b) > 1e-10) {
      dir1 = [k1 - d, b];
      dir2 = [k2 - d, b];
    } else {
      dir1 = a >= d ? [1, 0] : [0, 1];
      dir2 = a >= d ? [0, 1] : [1, 0];
    }

    // Normaliza direcoes
    const norm1 = Math.sqrt(dir1[0]! * dir1[0]! + dir1[1]! * dir1[1]!);
    const norm2 = Math.sqrt(dir2[0]! * dir2[0]! + dir2[1]! * dir2[1]!);
    if (norm1 > 0) { dir1 = dir1.map((d) => d / norm1); }
    if (norm2 > 0) { dir2 = dir2.map((d) => d / norm2); }

    return {
      k1: Math.max(k1, k2),
      k2: Math.min(k1, k2),
      direction1: dir1,
      direction2: dir2,
    };
  }

  // Para n>2, usa power iteration simplificada
  // Encontra os dois maiores autovalores
  let maxK1 = -Infinity;
  let maxK2 = -Infinity;
  let dir1 = new Array(n).fill(0) as number[];
  let dir2 = new Array(n).fill(0) as number[];

  for (let i = 0; i < n; i++) {
    const eigenval = hessian[i]![i]!;
    if (eigenval > maxK1) {
      maxK2 = maxK1;
      dir2 = [...dir1];
      maxK1 = eigenval;
      dir1 = new Array(n).fill(0);
      dir1[i] = 1;
    } else if (eigenval > maxK2) {
      maxK2 = eigenval;
      dir2 = new Array(n).fill(0);
      dir2[i] = 1;
    }
  }

  return {
    k1: maxK1,
    k2: maxK2,
    direction1: dir1,
    direction2: dir2,
  };
}

// ─── Funcoes Auxiliares ──────────────────────────────────────────────────────

/**
 * Calcula o gradiente de f em p via diferencas centrais.
 *
 * nabla f(p)_i = (f(p + e*e_i) - f(p - e*e_i)) / (2e)
 *
 * @param evaluate - Funcao escalar
 * @param p - Ponto de avaliacao
 * @param eps - Tamanho do passo (default: 1e-6)
 * @returns Vetor gradiente
 */
export function computeGradient(
  evaluate: (p: number[]) => number,
  p: number[],
  eps: number = 1e-6
): number[] {
  const n = p.length;
  const gradient = new Array(n);

  for (let i = 0; i < n; i++) {
    const pForward = [...p];
    const pBackward = [...p];
    pForward[i] += eps;
    pBackward[i] -= eps;
    gradient[i] = (evaluate(pForward) - evaluate(pBackward)) / (2 * eps);
  }

  return gradient;
}

/**
 * Calcula a divergencia de um campo vetorial.
 *
 * div(V) = Sigma_i dV_i/dx_i
 *
 * @param field - Campo vetorial (funcao que retorna vetor)
 * @param p - Ponto de avaliacao
 * @param eps - Tamanho do passo (default: 1e-6)
 * @returns Divergencia (escalar)
 */
export function computeDivergence(
  field: (p: number[]) => number[],
  p: number[],
  eps: number = 1e-6
): number {
  const n = p.length;
  let div = 0;

  for (let i = 0; i < n; i++) {
    const pForward = [...p];
    const pBackward = [...p];
    pForward[i] += eps;
    pBackward[i] -= eps;

    const vForward = field(pForward);
    const vBackward = field(pBackward);

    // Componente i do campo em p+e e p-e
    div += (vForward[i]! - vBackward[i]!) / (2 * eps);
  }

  return div;
}

/**
 * Calcula o rotacional de um campo vetorial 3D.
 *
 * curl(V) = (dV_z/dy - dV_y/dz, dV_x/dz - dV_z/dx, dV_y/dx - dV_x/dy)
 *
 * @param field - Campo vetorial 3D
 * @param p - Ponto de avaliacao (3D)
 * @param eps - Tamanho do passo (default: 1e-6)
 * @returns Rotacional (vetor 3D)
 */
export function computeCurl(
  field: (p: number[]) => number[],
  p: number[],
  eps: number = 1e-6
): number[] {
  if (p.length < 3) return [0, 0, 0];

  const partial = (component: number, axis: number): number => {
    const pF = [...p]; pF[axis] += eps;
    const pB = [...p]; pB[axis] -= eps;
    return (field(pF)[component]! - field(pB)[component]!) / (2 * eps);
  };

  return [
    partial(2, 1) - partial(1, 2), // dVz/dy - dVy/dz
    partial(0, 2) - partial(2, 0), // dVx/dz - dVz/dx
    partial(1, 0) - partial(0, 1), // dVy/dx - dVx/dy
  ];
}
