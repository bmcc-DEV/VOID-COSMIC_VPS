import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const wasmPath = join(repoRoot, "artifacts/pi_worker.wasm");

export function setupVoidRunnerPath() {
  process.env.PATH = `${join(repoRoot, "target/release")}:${process.env.PATH ?? ""}`;
}

export const VOID_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Espera relays NOSTR antes de publicar (worker deve já estar activo) */
export const VOID_RELAY_WARMUP_MS = Number(process.env.VOID_RELAY_WARMUP_MS ?? 5_000);
