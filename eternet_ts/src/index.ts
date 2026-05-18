/**
 * ETΞRNET / VOID-COSMIC — API unificada
 */

// ─── Criptografia (ET-RNET) ───────────────────────────────────────────────────
export * from "./crypto/ghostid.js";
export {
  fragmentMessage,
  reconstituteMessage,
  type Shard,
  type FragmentResult,
} from "./crypto/qel.js";
export * from "./crypto/gf256.js";
export * from "./crypto/pqc.js";
export * from "./crypto/doubleRatchet.js";
export * from "./crypto/antiSybil.js";
export * from "./crypto/powFaucet.js";
export { EcoNet as CryptoEcoNet, type EcoNetEntry as CryptoEcoNetEntry } from "./crypto/econet.js";
export * from "./crypto/utxo.js";
export * from "./crypto/mirageCompute.js";
export * from "./crypto/nostrTransaction.js";
export * from "./crypto/nostrDEX.js";

// ─── Rede (ET-RNET) ───────────────────────────────────────────────────────────
export * from "./network/distanceBridge.js";
export { nostrMesh } from "./network/nostrMesh.js";

// ─── Core VOID (ET-RNET) ──────────────────────────────────────────────────────
export { VoidOrchestrator } from "./core/VoidOrchestrator.js";
export { PowerGovernor as EternetPowerGovernor } from "./core/PowerGovernor.js";
export * from "./core/VoidProtocol.js";
export { GhostDockOrchestrator } from "./core/ghostDock.js";

// ─── Storage ──────────────────────────────────────────────────────────────────
export * from "./storage/hcnStore.js";
export * from "./storage/utxoStore.js";

// ─── Transporte + NOSTR (VOID-COSMIC) ─────────────────────────────────────────
export * from "./transport/nostrBus.js";
export { VOID_DEV_RELAYS } from "./transport/voidRelays.js";
export {
  DistanceBridge as DistanceBridgeMulti,
  type TransportChannel,
} from "./transport/distanceBridge.void-vps.js";

// ─── VOID-VPS (void_runner + API local) ───────────────────────────────────────
export * from "./vps/VoidVPS.js";
export { VoidOrchestrator as VoidVpsOrchestrator } from "./vps/voidOrchestrator.js";
export { PowerGovernor } from "./vps/powerGovernor.js";
export { EcoNetClient } from "./vps/ecoNet.js";
export * from "./vps/phantomPipeline.js";
export * from "./vps/higgsGit.js";
export * from "./vps/voidRunnerBridge.js";
export { VoidAnimusWorker, type VoidAnimusWorkerOptions, type VoidTaskMessage } from "./vps/voidAnimusWorker.js";

// ─── WASM void_core (QEL, PQC, PoW, VDF, UTXO) ─────────────────────────────────
export { loadVoidCore as initVoidCore } from "./wasm/loadVoidCore.js";
export {
  init_void_core,
  derive_ghost_id,
  qel_split,
  qel_reconstruct,
  mlkem_keygen,
  mlkem_encapsulate,
  mlkem_decapsulate,
  mldsa_keygen,
  mldsa_sign,
  mldsa_verify,
  pow_solve,
  pow_verify,
  vdf_evaluate,
  create_pedersen_commitment,
  create_range_proof,
} from "./wasm/void_core.js";
