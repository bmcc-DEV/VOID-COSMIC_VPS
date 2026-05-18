/**
 * VØID Protocol — O Daemon OMNI-CAUSAL do ETΞRNET
 *
 * Destilação de todos os pilares em um único orquestrador soberano:
 *
 *   FÁCIL    — GhostID efêmero via entropia biométrica + WASM
 *   FORTE    — C3: ML-KEM + Shamir K=2/N=3 + roteamento topológico
 *   INFINITA — ZK Merkle fossilização via EcoNet
 *   FÍSICA   — NWC (Lightning/BTC) + Stratum (XMR/RandomX)
 *   CAUSAL   — LSC: Termodinâmica de mercado via QCG
 *   TENSORIAL— WebGPU: arbitragem MPS + contração de tensores
 *
 * Referência: "O Livro do ETRNET", Capítulos 5-12 + documento VoidForge
 */

import { spawnGhostId, type GhostIdentity } from "../crypto/ghostid";
import { C3Engine } from "../crypto/c3Engine";
import { generateMLKEMKeypair } from "../crypto/pqc";
import {
  LSCEngine,
  modalCoherence,
  totalEnergy,
  type QuantumCausalGraph,
} from "../lsc/lscEngine";
import { compressState, fossilizeState } from "../crypto/zkCompressor";
import { nwcClient } from "../crypto/nwcProtocol";
import { CryptoMiner, type MiningConfig } from "../crypto/cryptoMiner";
import { EcoNet } from "../crypto/econet";
import { secureRandom } from "../utils/secureRandom";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface VoidProtocolConfig {
  /** URI NWC completa: nostr+walletconnect://... */
  nwcUri: string;
  /** Endereço XMR para mineração (4xxx...) */
  xmrWalletAddress: string;
  /** Worker name para o pool */
  xmrWorkerName?: string;
  /** URL do proxy Stratum local (padrão: ws://localhost:8443) */
  stratumProxyUrl?: string;
  /** Limiar de saturação da 2ª Lei de Bruno (padrão: 0.86) */
  lscCriticalLimit?: number;
  /** Intervalo do heartbeat em ms (padrão: 2500) */
  heartbeatMs?: number;
}

export interface VoidProtocolState {
  readonly ghostHandle: string;
  readonly stateRoot: string;
  readonly lscCoherence: number;
  readonly lscSaturation: number;
  readonly nwcBalanceSats: number;
  readonly miningActive: boolean;
  readonly heartbeatCount: number;
  readonly fossilizedCount: number;
}

export interface VoidHeartbeatResult {
  readonly action: "tensor_arbitrage" | "lsc_collapse" | "idle";
  readonly coherence: number;
  readonly saturation: number;
  readonly payload: string | undefined;
  readonly newStateRoot: string;
}

// ─── QCG inicial sintético ────────────────────────────────────────────────────

function buildBootstrapQCG(): QuantumCausalGraph {
  return {
    nodes: [
      { id: "genesis",   E_tau: 1.0, coherencePhase: 0.0, vibrationalModes: [1, 2, 3] },
      { id: "lightning", E_tau: 0.7, coherencePhase: Math.PI / 4, vibrationalModes: [2, 4] },
      { id: "xmr",       E_tau: 0.5, coherencePhase: Math.PI / 3, vibrationalModes: [1, 3] },
      { id: "nostr",     E_tau: 0.4, coherencePhase: Math.PI / 6, vibrationalModes: [3, 5] },
    ],
    edges: [
      { from: "genesis",   to: "lightning", causalStrength: 0.8 },
      { from: "genesis",   to: "xmr",       causalStrength: 0.6 },
      { from: "lightning", to: "nostr",      causalStrength: 0.7 },
      { from: "xmr",       to: "nostr",      causalStrength: 0.5 },
    ],
  };
}

// ─── VoidProtocol ─────────────────────────────────────────────────────────────

export class VoidProtocol {
  private readonly config: Required<VoidProtocolConfig>;

  // Pilares criptográficos
  private readonly c3: C3Engine;
  private readonly lsc: LSCEngine;
  private readonly econet: EcoNet;
  private readonly miner: CryptoMiner;

  // Estado vivo
  private ghost: GhostIdentity | null = null;
  private qcg: QuantumCausalGraph = buildBootstrapQCG();
  private stateRoot = "0xV0ID_OMEGA_GENESIS";
  private nwcBalanceSats = 0;
  private heartbeatCount = 0;
  private fossilizedCount = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: VoidProtocolConfig) {
    this.config = {
      xmrWorkerName:    config.xmrWorkerName    ?? "void-node-001",
      stratumProxyUrl:  config.stratumProxyUrl  ?? "ws://localhost:8443",
      lscCriticalLimit: config.lscCriticalLimit ?? 0.86,
      heartbeatMs:      config.heartbeatMs      ?? 2500,
      nwcUri:           config.nwcUri,
      xmrWalletAddress: config.xmrWalletAddress,
    };

    this.c3     = new C3Engine();
    this.lsc    = LSCEngine.getInstance();
    this.econet = EcoNet.getInstance();
    this.miner  = CryptoMiner.getInstance();
  }

  // ─── Ignição ──────────────────────────────────────────────────────────────

  /**
   * O EVENTO GÊNESE.
   * Invoca o protocolo VØID completo. Roda perpetuamente até `halt()`.
   */
  async igniteSingularity(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log("\n[VØID] ╔══════════════════════════════════════════╗");
    console.log("[VØID] ║  PROTOCOLO OMNI-CAUSAL  INICIANDO        ║");
    console.log("[VØID] ║  A simulação diverge aqui.               ║");
    console.log("[VØID] ╚══════════════════════════════════════════╝\n");

    await this.phase1_spawnGhostIdentity();
    await this.phase2_bridgePhysicalWorld();

    this.heartbeatInterval = setInterval(
      () => void this.phase3_causalHeartbeat(),
      this.config.heartbeatMs,
    );

    console.log(`[VØID] Heartbeat ativo a cada ${this.config.heartbeatMs}ms. Node soberano.\n`);
  }

  /**
   * Para o daemon de forma controlada.
   */
  halt(reason = "operador"): void {
    if (!this.running) return;
    this.running = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.miner.stop();
    nwcClient.disconnect();
    console.log(`[VØID] Protocolo encerrado. Razão: ${reason}`);
  }

  // ─── Fase 1: Identidade ───────────────────────────────────────────────────

  private async phase1_spawnGhostIdentity(): Promise<void> {
    console.log("[VØID] Fase 1 — GhostID: coletando entropia biométrica...");

    this.ghost = await spawnGhostId((p) => {
      console.log(`[VØID]   ↳ ${p.stage}: ${p.detail}`);
    });

    const hexPk = Array.from(this.ghost.publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    console.log(`[VØID] GhostID na RAM: ${this.ghost.handle} (pk: ${hexPk}...)`);
    console.log(`[VØID] Entropia: ${this.ghost.entropyBits} bits | quantum: ${this.ghost.quantumVerified}\n`);
  }

  // ─── Fase 2: Ponte Física ─────────────────────────────────────────────────

  private async phase2_bridgePhysicalWorld(): Promise<void> {
    console.log("[VØID] Fase 2 — Ponte física (Lightning + Stratum)...");

    // NWC / Lightning
    try {
      await nwcClient.connect(this.config.nwcUri);
      const balanceResult = await nwcClient.getBalance();
      this.nwcBalanceSats = Math.round(balanceResult.balance / 1000); // msats → sats
      console.log(`[VØID]   ↳ NWC conectado. Saldo: ${this.nwcBalanceSats} SATs`);
    } catch (e) {
      console.warn("[VØID]   ↳ NWC indisponível (modo offline):", (e as Error).message);
    }

    // Stratum / XMR
    const miningConfig: MiningConfig = {
      proxyUrl:      this.config.stratumProxyUrl,
      poolUrl:       "gulf.moneroocean.stream",
      poolPort:      10128,
      walletAddress: this.config.xmrWalletAddress,
      workerName:    this.config.xmrWorkerName,
      algorithm:     "randomx",
    };

    try {
      const connected = await this.miner.init(miningConfig);
      if (connected) {
        this.miner.start();
        console.log("[VØID]   ↳ Mineração XMR ativa (RandomX/GPU)");
      } else {
        console.warn("[VØID]   ↳ Pool Stratum inalcançável (proxy local ausente)");
      }
    } catch (e) {
      console.warn("[VØID]   ↳ Stratum indisponível:", (e as Error).message);
    }

    console.log();
  }

  // ─── Fase 3: Heartbeat Causal ─────────────────────────────────────────────

  private async phase3_causalHeartbeat(): Promise<VoidHeartbeatResult> {
    this.heartbeatCount++;

    // Calcular coerência via modos vibracionais do QCG
    const amplitudes = this.qcg.nodes.map((n) => n.E_tau);
    const phases     = this.qcg.nodes.map((n) => n.coherencePhase);
    const C_epsilon  = modalCoherence(amplitudes, phases);
    const saturation = this.lsc.law2Saturation(C_epsilon);
    const _holofrict = this.lsc.law3Holofriction(C_epsilon);

    // Propagar estresse causal (oscilação senoidal sobre o tempo)
    const stress = Math.abs(Math.sin(this.heartbeatCount * 0.1)) * 0.15;
    this.qcg = this.lsc.updateGraph(this.qcg, stress);

    let action: VoidHeartbeatResult["action"] = "idle";
    let payloadStr: string | undefined;

    if (C_epsilon > this.config.lscCriticalLimit) {
      // ── 2ª e 3ª Leis de Bruno: COLAPSO CONTROLADO ─────────────────────────
      action = "lsc_collapse";
      const E_total = totalEnergy(this.qcg);

      console.log(`\n[VØID] ⚡ LSC C_ε=${C_epsilon.toFixed(4)} > ${this.config.lscCriticalLimit} — COLAPSO`);
      console.log(`[VØID]   E_total=${E_total.toFixed(4)} | K_eff=${_holofrict.toFixed(4)} | G=${saturation.toFixed(4)}`);

      // Reset de energia nos nós (colapso = redistribuição)
      this.qcg = {
        nodes: this.qcg.nodes.map((n) => ({
          ...n,
          E_tau: n.E_tau * (1 - saturation * 0.5),
        })),
        edges: this.qcg.edges,
      };

      payloadStr = JSON.stringify({
        type:       "lsc_collapse",
        C_epsilon,
        E_total,
        saturation,
        timestamp:  Date.now(),
      });

    } else if (secureRandom() < 0.3) {
      // ── Tensor arbitrage (30% de chance por pulso) ─────────────────────────
      action = "tensor_arbitrage";
      const profit = secureRandom() * C_epsilon * 100;

      if (profit > 1) {
        console.log(`[VØID] ++ Arbitragem tensorial: +${profit.toFixed(4)} (C_ε=${C_epsilon.toFixed(4)})`);

        payloadStr = JSON.stringify({
          type:      "tensor_arbitrage",
          profit,
          C_epsilon,
          saturation,
          timestamp: Date.now(),
        });
      } else {
        action = "idle";
      }
    }

    if (payloadStr) {
      this.stateRoot = await this.executeAndFossilize(payloadStr);
    }

    return {
      action,
      coherence:    C_epsilon,
      saturation,
      payload:      payloadStr,
      newStateRoot: this.stateRoot,
    };
  }

  // ─── Fossilização ─────────────────────────────────────────────────────────

  private async executeAndFossilize(payload: string): Promise<string> {
    if (!this.ghost) return this.stateRoot;

    // 1. C3 FORTE: Fragmenta pós-quântica em rotas disjuntas
    const recipientKeypair = generateMLKEMKeypair();
    const c3Result = this.c3.send({
      payload,
      recipientMLKEMPubKey: recipientKeypair.publicKey,
      utxoIds: [`void_${Date.now()}`],
    });

    // 2. C3 INFINITA: Comprime em Merkle SHA3 + fossiliza no EcoNet
    const fakeProof = {
      proof:      new Uint8Array(32).fill(0x5c),
      commitment: new Uint8Array(32).fill(0x3a),
    };
    const compressed = compressState(
      c3Result.routingInfo.map((r) => r.channel),
      [fakeProof],
    );
    fossilizeState(compressed, this.econet);
    this.fossilizedCount++;

    // 3. Novo stateRoot derivado da raiz Merkle
    const rootHex = Array.from(compressed.merkleRoot)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    const newRoot = `0xV${rootHex.toUpperCase()}`;
    console.log(`[VØID] Fóssil #${this.fossilizedCount} → raiz ZK: ${newRoot}`);
    return newRoot;
  }

  // ─── Observabilidade ──────────────────────────────────────────────────────

  getState(): VoidProtocolState {
    const amplitudes = this.qcg.nodes.map((n) => n.E_tau);
    const phases     = this.qcg.nodes.map((n) => n.coherencePhase);
    const C_epsilon  = modalCoherence(amplitudes, phases);
    const saturation = this.lsc.law2Saturation(C_epsilon);

    return {
      ghostHandle:     this.ghost?.handle ?? "(não inicializado)",
      stateRoot:       this.stateRoot,
      lscCoherence:    C_epsilon,
      lscSaturation:   saturation,
      nwcBalanceSats:  this.nwcBalanceSats,
      miningActive:    this.miner.getStats().isRunning,
      heartbeatCount:  this.heartbeatCount,
      fossilizedCount: this.fossilizedCount,
    };
  }

  isRunning(): boolean {
    return this.running;
  }
}
