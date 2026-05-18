#!/usr/bin/env node
/**
 * Smoke test VOID-VPS: GhostID → VoidRunnerBridge → void-runner (calculate_pi)
 *
 * Uso:
 *   npm run build
 *   node examples/pi-task.mjs
 */
import { readFileSync } from "node:fs";
import { derive_ghost_id } from "../dist/wasm/void_core.js";
import { loadVoidCore } from "../dist/wasm/loadVoidCore.js";
import { VoidRunnerBridge } from "../dist/vps/voidRunnerBridge.js";
import { setupVoidRunnerPath, wasmPath } from "./_void-env.mjs";

setupVoidRunnerPath();
await loadVoidCore();
const entropy = crypto.getRandomValues(new Uint8Array(32));
const ghost = derive_ghost_id(entropy);
console.log("GhostID:", ghost.handle);

const bridge = new VoidRunnerBridge({ ghostId: ghost.handle });
const wasmUri = await bridge.publishWorker(readFileSync(wasmPath));
console.log("EcoNet URI:", wasmUri);

const result = await bridge.submitTask(
  {
    wasmFile: wasmPath,
    funcName: "calculate_pi",
    input: { iterations: 1_000_000 },
  },
  { parallelShards: 1 },
);

console.log("Task:", result.taskId);
console.log("π × 10⁶:", result.output);
