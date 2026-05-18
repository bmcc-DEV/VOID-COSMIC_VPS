#!/usr/bin/env node
/**
 * Cliente VOID-VPS remoto — publica tarefa no NOSTR e espera ANIMUS.
 *
 * Requer worker ativo noutro terminal: npm run example:animus
 */
import { derive_ghost_id } from "../dist/wasm/void_core.js";
import { loadVoidCore } from "../dist/wasm/loadVoidCore.js";
import { NostrBus } from "../dist/transport/nostrBus.js";
import { VoidRunnerBridge } from "../dist/vps/voidRunnerBridge.js";
import {
  setupVoidRunnerPath,
  wasmPath,
  VOID_RELAYS,
  VOID_RELAY_WARMUP_MS,
  sleep,
} from "./_void-env.mjs";

const shards = Number(process.env.VOID_SHARDS ?? 1);
const timeoutMs = Number(process.env.VOID_TIMEOUT_MS ?? 120_000);

setupVoidRunnerPath();

await loadVoidCore();
const ghost = derive_ghost_id(crypto.getRandomValues(new Uint8Array(32)));

const nostr = new NostrBus({ relays: VOID_RELAYS });
nostr.start();
console.log("Cliente pubkey:", nostr.nodePubkey);
console.log("GhostID:", ghost.handle);
console.log(
  `Aquecendo relays (${VOID_RELAY_WARMUP_MS}ms) — confirma que o worker ANIMUS já está activo…`,
);
await sleep(VOID_RELAY_WARMUP_MS);

const bridge = new VoidRunnerBridge({
  ghostId: ghost.handle,
  nostr,
  localRunner: false,
});

bridge.vps.listenForResults();
console.log(`Publicando tarefa (localRunner=false, shards=${shards})…`);

const started = Date.now();
const result = await bridge.submitTask(
  {
    wasmFile: wasmPath,
    funcName: "calculate_pi",
    input: { iterations: 500_000 },
  },
  { parallelShards: shards },
);

console.log("Task:", result.taskId);
console.log("π × 10⁶:", result.output);
console.log(`Latência ~${Math.round((Date.now() - started) / 1000)}s`);

nostr.stop();
process.exit(0);
