/**
 * Nó ANIMUS — escuta tarefas VOID (kind 31222) no NOSTR e executa via void-runner
 */

import { NostrBus } from "../transport/nostrBus.js";
import { EcoNetClient } from "./ecoNet.js";
import {
  VOID_TASK_KIND,
  VOID_TASK_RESULT_KIND,
  type VoidTask,
  type VoidTaskResult,
} from "./VoidVPS.js";
import { executeVoidTask } from "./voidRunnerExec.js";

export interface VoidTaskMessage {
  taskId: string;
  ghostId: string;
  requesterPubkey: string;
  wasmFile: string;
  funcName: string;
  input: Record<string, unknown>;
  parallelShards: number;
  region?: string;
}

export interface VoidAnimusWorkerOptions {
  nostr: NostrBus;
  /** Só aceita tarefas deste GhostID (opcional) */
  ghostIdFilter?: string;
  ecoNet?: EcoNetClient;
  subscriptionId?: string;
}

export class VoidAnimusWorker {
  private readonly ecoNet: EcoNetClient;
  private readonly processed = new Set<string>();
  /** Margem para relógio / propagação NOSTR */
  private readonly startedAt = Math.floor(Date.now() / 1000) - 5;
  private subId: string | null = null;

  constructor(private options: VoidAnimusWorkerOptions) {
    this.ecoNet = options.ecoNet ?? new EcoNetClient();
  }

  start(): void {
    this.options.nostr.start();
    this.subId = this.options.nostr.subscribe(
      { kinds: [VOID_TASK_KIND], since: this.startedAt },
      (event) => void this.onTaskEvent(event).catch((err) => {
        console.warn("[VoidAnimusWorker]", err instanceof Error ? err.message : err);
      }),
      this.options.subscriptionId,
    );
  }

  stop(): void {
    if (this.subId) {
      this.options.nostr.unsubscribe(this.subId);
      this.subId = null;
    }
    this.options.nostr.stop();
  }

  private async onTaskEvent(event: {
    id: string;
    content: string;
    pubkey: string;
    created_at: number;
  }): Promise<void> {
    if (event.created_at < this.startedAt) return;
    let msg: VoidTaskMessage;
    try {
      msg = JSON.parse(event.content) as VoidTaskMessage;
    } catch {
      return;
    }

    if (!msg.taskId || !msg.requesterPubkey || !msg.wasmFile || !msg.funcName) return;
    if (this.options.ghostIdFilter && msg.ghostId !== this.options.ghostIdFilter) return;
    if (this.processed.has(msg.taskId)) return;
    this.processed.add(msg.taskId);

    console.log(
      `[VoidAnimusWorker] tarefa ${msg.taskId} (${msg.funcName}, shards=${msg.parallelShards ?? 1})`,
    );

    const task: VoidTask = {
      wasmFile: msg.wasmFile,
      funcName: msg.funcName,
      input: msg.input ?? {},
    };

    try {
      const output = await executeVoidTask(
        task,
        msg.taskId,
        msg.parallelShards ?? 1,
        this.ecoNet,
      );

      const result: VoidTaskResult = {
        success: true,
        output,
        taskId: msg.taskId,
        wasmFile: msg.wasmFile,
        region: msg.region,
      };

      await this.publishResult(
        result,
        msg.requesterPubkey,
        event.id,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: VoidTaskResult = {
        success: false,
        output: { error: message },
        taskId: msg.taskId,
        wasmFile: msg.wasmFile,
        region: msg.region,
      };
      await this.publishResult(result, msg.requesterPubkey);
    }
  }

  private async publishResult(
    result: VoidTaskResult,
    requesterPubkey: string,
    taskEventId?: string,
  ): Promise<void> {
    const tags: string[][] = [
      ["p", requesterPubkey],
      ["protocol", "eternet-v1"],
      ["nonce", `${Date.now()}-${Math.random().toString(36).slice(2)}`],
    ];
    if (taskEventId) tags.push(["e", taskEventId]);

    const outcomes = await this.options.nostr.publish(
      VOID_TASK_RESULT_KIND as never,
      JSON.stringify(result),
      tags,
    );
    const ok = outcomes.filter((o) => o.success).length;
    console.log(
      `[VoidAnimusWorker] resultado ${result.taskId} → ${requesterPubkey.slice(0, 8)}… (${ok}/${outcomes.length} relays)`,
    );
    if (ok === 0) {
      console.warn("[VoidAnimusWorker] publish sem sucesso:", outcomes);
    }
  }
}
