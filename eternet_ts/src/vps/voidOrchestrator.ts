/**
 * VoidOrchestrator — coordena módulos sem ponto central
 */

import { NostrBus } from "../transport/nostrBus.js";
import { DistanceBridge } from "../transport/distanceBridge.void-vps.js";
import { PowerGovernor } from "./powerGovernor.js";
import { EcoNetClient } from "./ecoNet.js";
import { VoidVPS, type VoidTask, type VoidTaskResult } from "./VoidVPS.js";

export type ModuleHealth = "healthy" | "degraded" | "offline";

export interface ModuleStatus {
  name: string;
  health: ModuleHealth;
  lastCheck: number;
}

export class VoidOrchestrator {
  private modules = new Map<string, ModuleStatus>();
  readonly governor: PowerGovernor;
  readonly ecoNet: EcoNetClient;
  readonly vps: VoidVPS;
  readonly bridge: DistanceBridge;

  constructor(
    ghostId: string,
    nostrBus: NostrBus,
    options?: { runnerEndpoint?: string }
  ) {
    this.governor = new PowerGovernor();
    this.ecoNet = new EcoNetClient();
    this.bridge = new DistanceBridge(nostrBus);
    this.vps = new VoidVPS(ghostId, nostrBus, this.ecoNet, this.governor, {
      runnerEndpoint: options?.runnerEndpoint,
    });

    this.registerModule("nostr");
    this.registerModule("distanceBridge");
    this.registerModule("voidVps");
    this.registerModule("ecoNet");
    this.registerModule("powerGovernor");
  }

  private registerModule(name: string): void {
    this.modules.set(name, {
      name,
      health: "healthy",
      lastCheck: Date.now(),
    });
  }

  async healthCheck(): Promise<ModuleStatus[]> {
    const statuses: ModuleStatus[] = [];

    const nostrOk = this.vps.nostr.healthyRelays.length > 0;
    this.setHealth("nostr", nostrOk ? "healthy" : "degraded");

    const channels = await this.bridge.getChannelStatus();
    const bridgeOk = Object.values(channels).some(Boolean);
    this.setHealth("distanceBridge", bridgeOk ? "healthy" : "degraded");

    for (const [, status] of this.modules) {
      statuses.push({ ...status });
    }
    return statuses;
  }

  private setHealth(name: string, health: ModuleHealth): void {
    const m = this.modules.get(name);
    if (m) {
      m.health = health;
      m.lastCheck = Date.now();
    }
  }

  async submitTask(
    task: VoidTask,
    options?: { preferredRegion?: string; parallelShards?: number }
  ): Promise<VoidTaskResult> {
    const start = Date.now();
    try {
      const result = await this.vps.submitTask(task, options);
      this.governor.recordLatency(Date.now() - start);
      return result;
    } catch (err) {
      this.setHealth("voidVps", "degraded");
      throw err;
    }
  }

  start(): void {
    this.vps.nostr.start();
  }

  stop(): void {
    this.vps.nostr.stop();
  }
}
