/**
 * VOID-VPS — O Servidor que Não Existe
 */

import { NostrBus } from "../transport/nostrBus.js";
import { EcoNetClient } from "./ecoNet.js";
import { PowerGovernor } from "./powerGovernor.js";
import { executeVoidTask } from "./voidRunnerExec.js";

export const VOID_TASK_KIND = 31222;
export const VOID_TASK_RESULT_KIND = 31223;

export interface VoidTask {
  wasmFile: string;
  funcName: string;
  input: Record<string, unknown>;
}

export interface VoidTaskResult {
  success: boolean;
  output: unknown;
  taskId: string;
  wasmFile: string;
  region?: string;
}

export interface VoidVPSOptions {
  runnerEndpoint?: string;
  defaultShards?: number;
  /** false = só publica no NOSTR e espera nó ANIMUS remoto */
  localRunner?: boolean;
  /** Tempo máximo à espera do resultado NOSTR (ms) */
  remoteTimeoutMs?: number;
}

export class VoidVPS {
  readonly nostr: NostrBus;
  private taskResolvers = new Map<
    string,
    { resolve: (r: VoidTaskResult) => void; reject: (e: Error) => void }
  >();
  private resultSubId: string | null = null;

  constructor(
    private ghostId: string,
    nostr: NostrBus,
    private ecoNet: EcoNetClient,
    private governor: PowerGovernor,
    private options: VoidVPSOptions = {}
  ) {
    this.nostr = nostr;
  }

  /** Subscreve resultados (kind 31223) — chamar após `nostr.start()` */
  listenForResults(): void {
    if (this.resultSubId) return;
    this.resultSubId = this.nostr.subscribe(
      { kinds: [VOID_TASK_RESULT_KIND], "#p": [this.nostr.nodePubkey] },
      (event) => {
        try {
          const data = JSON.parse(event.content) as VoidTaskResult & { taskId: string };
          const pending = this.taskResolvers.get(data.taskId);
          if (pending) {
            pending.resolve(data);
            this.taskResolvers.delete(data.taskId);
          }
        } catch {
          /* ignore */
        }
      },
      "void-vps-results",
    );
  }

  async publishWasm(wasmBytes: Uint8Array): Promise<string> {
    return this.ecoNet.putAsync(this.ghostId, wasmBytes);
  }

  async submitTask(
    task: VoidTask,
    options?: { preferredRegion?: string; parallelShards?: number }
  ): Promise<VoidTaskResult> {
    const taskId = `void-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const parallelShards = options?.parallelShards ?? this.options.defaultShards ?? 1;

    this.listenForResults();

    const published = await this.nostr.publish(
      VOID_TASK_KIND as never,
      JSON.stringify({
        taskId,
        ghostId: this.ghostId,
        requesterPubkey: this.nostr.nodePubkey,
        wasmFile: task.wasmFile,
        funcName: task.funcName,
        input: task.input,
        parallelShards,
        region: options?.preferredRegion,
      }),
      [
        ["protocol", "eternet-v1"],
        ["region", options?.preferredRegion ?? "any"],
        ["ghost", this.ghostId],
        ["task", taskId],
      ],
    );

    const okRelays = published.filter((p) => p.success).map((p) => p.relay);
    if (okRelays.length === 0) {
      throw new Error(
        `VOID-VPS: falha ao publicar tarefa em todos os relays: ${published.map((p) => p.error ?? p.relay).join("; ")}`,
      );
    }

    const useLocal =
      this.options.localRunner !== false &&
      typeof process !== "undefined" &&
      process.versions?.node;

    if (useLocal) {
      const local = await this.runLocalRunner(task, taskId, parallelShards, options?.preferredRegion);
      if (local) return local;
    }

    const waitMs =
      this.options.remoteTimeoutMs ??
      Number(process.env.VOID_TIMEOUT_MS ?? 120_000);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.taskResolvers.delete(taskId);
        reject(
          new Error(
            `VOID-VPS: timeout aguardando nó ANIMUS (${waitMs}ms). Worker activo? npm run example:animus`,
          ),
        );
      }, waitMs);

      this.taskResolvers.set(taskId, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private async runLocalRunner(
    task: VoidTask,
    taskId: string,
    parallelShards: number,
    region?: string,
  ): Promise<VoidTaskResult | null> {
    try {
      const output = await executeVoidTask(task, taskId, parallelShards, this.ecoNet);
      this.governor.updateMarketCoherence(1, 1);
      return {
        success: true,
        output,
        taskId,
        wasmFile: task.wasmFile,
        region,
      };
    } catch {
      return null;
    }
  }

  async publishTaskResult(result: VoidTaskResult, requesterPubkey: string): Promise<void> {
    await this.nostr.publish(
      VOID_TASK_RESULT_KIND as never,
      JSON.stringify(result),
      [["p", requesterPubkey], ["protocol", "eternet-v1"]]
    );
  }
}
