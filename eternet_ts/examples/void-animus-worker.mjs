#!/usr/bin/env node
/**
 * Nó ANIMUS — escuta tarefas VOID no NOSTR e executa void-runner.
 *
 * Terminal 1: npm run example:animus
 * Terminal 2 (só depois de ver "Pronto"): npm run example:nostr
 */
import { NostrBus } from "../dist/transport/nostrBus.js";
import { VoidAnimusWorker } from "../dist/vps/voidAnimusWorker.js";
import { setupVoidRunnerPath, VOID_RELAYS, VOID_RELAY_WARMUP_MS, sleep } from "./_void-env.mjs";

setupVoidRunnerPath();

const ghostFilter = process.argv[2] || undefined;
const nostr = new NostrBus({ relays: VOID_RELAYS });
const worker = new VoidAnimusWorker({ nostr, ghostIdFilter: ghostFilter });

console.log("ANIMUS pubkey:", nostr.nodePubkey);
if (ghostFilter) console.log("Filtro ghost:", ghostFilter);

nostr.start();
worker.start();

await sleep(VOID_RELAY_WARMUP_MS);
console.log("Pronto — à espera de tarefas VOID (kind 31222).");
console.log("Noutro terminal: npm run example:nostr");

process.on("SIGINT", () => {
  worker.stop();
  process.exit(0);
});
