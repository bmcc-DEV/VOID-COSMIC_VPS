/**
 * VØID Quantum Bridge — Conexão TypeScript ↔ Python CQR Engine
 *
 * Expõe operações quânticas reais (quimb + BB84) para o frontend.
 * O backend Python roda em localhost:8472.
 *
 * Modo "simulado": retorna dados locais quando o servidor está offline.
 * Modo "real": exige servidor Python rodando.
 */

const QUANTUM_API = "http://localhost:8472";

// ─── Modo de operação ────────────────────────────────────────────────────────

type QuantumMode = "real" | "simulated";
let quantumMode: QuantumMode = "simulated";
let serverAvailable: boolean | null = null; // null = não verificado

/** Define o modo de operação quântica */
export function setQuantumMode(mode: QuantumMode): void {
  quantumMode = mode;
  console.log(`[Quantum] Modo alterado para: ${mode}`);
}

/** Retorna o modo atual */
export function getQuantumMode(): QuantumMode {
  return quantumMode;
}

/** Verifica se o servidor quântico está disponível (com cache de 30s) */
export async function isServerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${QUANTUM_API}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    serverAvailable = res.ok;
  } catch {
    serverAvailable = false;
  }
  return serverAvailable;
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface QuantumEntropy {
  entropy_hex: string;
  sha3_256: string;
  bits: number;
  source: string;
  n_measurements: number;
}

export interface BellPairResult {
  bell_type: string;
  measurements: Record<string, number>;
  chsh: {
    S_value: number;
    S_theoretical_max: number;
    chsh_violated: boolean;
    correlations: Record<string, number>;
  };
  fidelity: number;
  is_entangled: boolean;
}

export interface BB84Result {
  success: boolean;
  key_length?: number;
  final_key?: string;
  qber?: number;
  eve_detected?: boolean;
  reason?: string;
  steps?: {
    photons_sent: number;
    sifted_key_length: number;
    matching_bases: number;
    errors_corrected: number;
  };
}

export interface PachnerResult {
  original: string;
  result: string;
  move_type: string;
  triangulation_preserved: boolean;
  topology_invariant: number;
}

// ─── API Client com fallback ─────────────────────────────────────────────────

async function quantumFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${QUANTUM_API}${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[Quantum] HTTP ${res.status}: ${res.statusText}`);
      return null;
    }
    serverAvailable = true;
    return res.json();
  } catch (err) {
    serverAvailable = false;
    if (quantumMode === "real") {
      console.warn("[Quantum] Servidor offline e modo=real. Retornando null.");
    }
    return null;
  }
}

// ─── Entropia quântica ───────────────────────────────────────────────────────

/**
 * Gera entropia quântica via medições de Bell states.
 * Retorna null se o servidor estiver offline (modo simulado).
 */
export async function generateQuantumEntropy(
  bits: number = 256,
): Promise<QuantumEntropy | null> {
  return quantumFetch<QuantumEntropy>(`/quantum/entropy?bits=${bits}`);
}

/**
 * Cria par entrelaçado e mede propriedades (CHSH test).
 * Retorna null se o servidor estiver offline.
 */
export async function createBellPair(
  bellType: "phi_plus" | "phi_minus" | "psi_plus" | "psi_minus" = "phi_plus",
): Promise<BellPairResult | null> {
  return quantumFetch<BellPairResult>(`/quantum/bell/${bellType}`);
}

/**
 * Mede todos os 4 estados de Bell e compara fidelidades.
 * Retorna null se o servidor estiver offline.
 */
export async function measureAllBellStates(): Promise<Record<
  string,
  { measurements: Record<string, number>; fidelity: number }
> | null> {
  return quantumFetch(`/quantum/bell/all`);
}

/**
 * Move de Pachner — transformação topológica da rede de spin.
 * Retorna null se o servidor estiver offline.
 */
export async function pachnerMove(
  networkId: string = "initial",
  moveType: "2-3" | "3-2" = "2-3",
): Promise<PachnerResult | null> {
  return quantumFetch<PachnerResult>(
    `/quantum/pachner?network_id=${networkId}&move_type=${moveType}`,
  );
}

/**
 * Executa protocolo BB84 completo (QKD).
 * Retorna null se o servidor estiver offline.
 */
export async function runBB84(
  keyLength: number = 256,
  intercept: boolean = false,
): Promise<BB84Result | null> {
  return quantumFetch<BB84Result>(
    `/quantum/bb84?key_length=${keyLength}&intercept=${intercept}`,
  );
}

/**
 * Compara BB84 com e sem Eve — demonstra detecção de intrusão.
 * Retorna null se o servidor estiver offline.
 */
export async function compareBB84(): Promise<{
  no_eve: BB84Result;
  with_eve: BB84Result;
} | null> {
  return quantumFetch(`/quantum/bb84/compare`);
}

/**
 * Verifica se o servidor quântico está disponível.
 * Alias de isServerAvailable() com retorno boolean simples.
 */
export async function quantumHealth(): Promise<boolean> {
  return isServerAvailable();
}
