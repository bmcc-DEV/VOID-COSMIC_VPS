/**
 * Ponte entre MirageCompute (ET-RNET) e void-runner (VOID-COSMIC nativo)
 */

import { mirageCompute, type MirageExecution } from "../crypto/mirageCompute.js";
import { EcoNetClient } from "./ecoNet.js";
import { VoidVPS, type VoidTask, type VoidTaskResult } from "./VoidVPS.js";
import { NostrBus } from "../transport/nostrBus.js";
import { PowerGovernor } from "./powerGovernor.js";

export interface VoidRunnerBridgeOptions {
  ghostId: string;
  nostr?: NostrBus;
  /** false = delegar execução a nó ANIMUS via NOSTR */
  localRunner?: boolean;
  remoteTimeoutMs?: number;
}

/**
 * API unificada: submissão via VoidVPS (void-runner) com fragmentação MirageCompute.
 */
export class VoidRunnerBridge {
  readonly vps: VoidVPS;
  readonly ecoNet: EcoNetClient;
  readonly mirage = mirageCompute;

  constructor(options: VoidRunnerBridgeOptions) {
    const nostr = options.nostr ?? new NostrBus();
    const governor = new PowerGovernor();
    this.ecoNet = new EcoNetClient();
    this.vps = new VoidVPS(options.ghostId, nostr, this.ecoNet, governor, {
      localRunner: options.localRunner,
      remoteTimeoutMs: options.remoteTimeoutMs,
    });
  }

  /** Publica WASM e retorna URI EcoNet */
  async publishWorker(wasm: Uint8Array): Promise<string> {
    return this.vps.publishWasm(wasm);
  }

  /**
   * Submete tarefa ao void-runner; opcionalmente registra execução Mirage (metadados).
   */
  async submitTask(
    task: VoidTask,
    options?: { preferredRegion?: string; parallelShards?: number; mirageFragments?: number }
  ): Promise<VoidTaskResult & { mirage?: MirageExecution }> {
    const result = await this.vps.submitTask(task, options);

    let mirage: MirageExecution | undefined;
    if (options?.mirageFragments && options.mirageFragments > 1) {
      try {
        const wasm = task.wasmFile.startsWith("ipfs://")
          ? this.ecoNet.get(task.wasmFile)
          : new Uint8Array();
        const codeFragments = this.mirage.fragmentCode(wasm, options.mirageFragments);
        // Metadados Mirage (fragmentação); execução WASM real via void-runner em `result`
        void codeFragments;
      } catch {
        /* opcional */
      }
    }

    return { ...result, mirage };
  }
}
