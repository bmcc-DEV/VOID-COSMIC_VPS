#!/usr/bin/env node
/** MapReduce Leibniz — 4 shards via void-runner */
import { derive_ghost_id } from "../dist/wasm/void_core.js";
import { loadVoidCore } from "../dist/wasm/loadVoidCore.js";
import { VoidRunnerBridge } from "../dist/vps/voidRunnerBridge.js";
import { setupVoidRunnerPath, wasmPath } from "./_void-env.mjs";

const shards = Number(process.env.VOID_SHARDS ?? 4);

setupVoidRunnerPath();
await loadVoidCore();
const ghost = derive_ghost_id(crypto.getRandomValues(new Uint8Array(32)));
console.log("GhostID:", ghost.handle);
console.log("Shards:", shards);

const bridge = new VoidRunnerBridge({ ghostId: ghost.handle });
const result = await bridge.submitTask(
  {
    wasmFile: wasmPath,
    funcName: "calculate_pi",
    input: { iterations: 2_000_000 },
  },
  { parallelShards: shards },
);

console.log("Task:", result.taskId);
console.log("π × 10⁶:", result.output);
