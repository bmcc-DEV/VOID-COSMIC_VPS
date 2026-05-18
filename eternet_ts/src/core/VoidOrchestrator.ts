/**
 * VØID Core — System Orchestrator
 *
 * O "Cérebro" do ecossistema. Unifica Identidade, Memória (HCN) e Sensaçāo (Drivers).
 * Resolve "The Glue Problem" centralizando o estado e o fluxo de dados.
 */

import { spawnGhostId, destroyGhostId, type GhostIdentity, type SpawnProgress } from "../crypto/ghostid";
import { fragmentMessage, type FragmentResult } from "../crypto/qel";
import { HCNStore, type HCNShard } from "../storage/hcnStore";
import { BluetoothDriver, NFCDriver, SerialUWBDriver } from "../network/localDrivers";
import { LoRaDriver } from "../network/loraDriver";
import { AcousticDriver } from "../network/acousticDriver";
import { nostrMesh } from "../network/nostrMesh";
import { DistanceBridge, type DistanceBridgeMetrics } from "../network/distanceBridge";
import {
  hybridEncrypt,
  generateMLKEMKeypair, generateMLDSAKeypair,
  mlDsaSign,
  type PQCKeyPair,
} from "../crypto/pqc";

// === Novos motores: O Livro do ETRNET ===

/** Resultado de envio com PQC (extensão de FragmentResult) */
export interface PQCSendResult extends FragmentResult {
  encapsulatedKey: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  senderMLKEMPubKey: Uint8Array;
  senderMLDSAPubKey: Uint8Array;
  signature: Uint8Array;
}

export type VoidEvent =
// ... (rest is same)
  | { type: "GHOST_SPAWNED"; identity: GhostIdentity }
  | { type: "GHOST_DESTROYED" }
  | { type: "SHARD_RECEIVED"; shard: HCNShard }
  | { type: "SHARD_SENT"; commitment: string; channel: string }
  | { type: "KARMA_UPDATED"; balance: number }
  | { type: "NETWORK_STATUS_CHANGE"; driver: string; status: "online" | "offline" | "scanning" }
  | { type: "COLLAPSE_EVENT"; operator: string; irreversibility: number }
  | { type: "LSC_UPDATE"; C_epsilon: number; P_current: number; K_eff: number };

export type VoidListener = (event: VoidEvent) => void;

export class VoidOrchestrator {
  private static instance: VoidOrchestrator;
  
  // State
  private identity: GhostIdentity | null = null;
  private hcnStore = new HCNStore();
  private listeners: Set<VoidListener> = new Set();

  // PQC State (C3 — Criptografia de Malha Causal)
  private pqcKeypair: PQCKeyPair | null = null;          // ML-KEM-1024
  private pqcSigningKeypair: PQCKeyPair | null = null;   // ML-DSA-87
  private knownRecipientKeys: Map<string, Uint8Array> = new Map();

  // Drivers
  public readonly ble = new BluetoothDriver();
  public readonly nfc = new NFCDriver();
  public readonly uwb = new SerialUWBDriver();
  public readonly lora = new LoRaDriver();
  public readonly acoustic = new AcousticDriver();

  // Cross-Tab Mesh (Real Peer Simulation)
  private meshChannel = new BroadcastChannel("void_omega_mesh");
  private distanceBridge = new DistanceBridge({
    ble: this.ble,
    lora: this.lora,
    meshChannel: this.meshChannel,
    broadcastWebRTC: (shard) => nostrMesh.broadcastShard(shard),
    meshSender: () => this.identity?.handle || "anon_node",
  });

  private constructor() {
    this.initNetworkListeners();
    this.initMeshChannel();
  }

  private initMeshChannel() {
    this.meshChannel.onmessage = (event) => {
      const { type, payload, sender } = event.data;
      
      if (type === "PEER_DISCOVERY") {
        this.notify({ type: "NETWORK_STATUS_CHANGE", driver: `MESH:${sender}`, status: "online" });
      } else if (type === "SHARD_BROADCAST") {
        this.handleIncomingShard(payload, `MESH:${sender}`);
      }
    };

    // Broadcast our presence every 5s
    setInterval(() => {
      if (this.identity) {
        this.meshChannel.postMessage({
          type: "PEER_DISCOVERY",
          sender: this.identity.handle
        });
      }
    }, 5000);
  }

  public static getInstance(): VoidOrchestrator {
    if (!VoidOrchestrator.instance) {
      VoidOrchestrator.instance = new VoidOrchestrator();
    }
    return VoidOrchestrator.instance;
  }

  // --- Identity Management ---

  public getIdentity(): GhostIdentity | null {
    return this.identity;
  }

  public async spawn(onProgress?: (p: SpawnProgress) => void): Promise<GhostIdentity> {
    const id = await spawnGhostId(onProgress);
    this.identity = id;

    // Inicializar chaves Pós-Quânticas (C3)
    this.pqcKeypair = generateMLKEMKeypair();
    this.pqcSigningKeypair = generateMLDSAKeypair();

    this.notify({ type: "GHOST_SPAWNED", identity: id });
    return id;
  }

  public destroy(): void {
    if (this.identity) {
      destroyGhostId(this.identity);
      this.identity = null;
      // Zero PQC keys
      if (this.pqcKeypair) {
        this.pqcKeypair.publicKey.fill(0);
        this.pqcKeypair.privateKey.fill(0);
        this.pqcKeypair = null;
      }
      if (this.pqcSigningKeypair) {
        this.pqcSigningKeypair.publicKey.fill(0);
        this.pqcSigningKeypair.privateKey.fill(0);
        this.pqcSigningKeypair = null;
      }
      this.knownRecipientKeys.clear();
      this.notify({ type: "GHOST_DESTROYED" });
    }
  }

  /** Registra a chave ML-KEM pública de um destinatário conhecido. */
  public registerRecipientKey(handle: string, publicKey: Uint8Array): void {
    this.knownRecipientKeys.set(handle, publicKey);
  }

  /** Retorna a chave ML-KEM pública do próprio nó (para compartilhar). */
  public getMLKEMPublicKey(): Uint8Array | null {
    return this.pqcKeypair?.publicKey ?? null;
  }

  /** Retorna a chave ML-DSA pública do próprio nó (para verificação). */
  public getMLDSAPublicKey(): Uint8Array | null {
    return this.pqcSigningKeypair?.publicKey ?? null;
  }

  // --- Messaging & Routing ---

  /**
   * Envia uma mensagem fragmentada através dos melhores canais disponíveis.
   * Se recipientMLKEMPubKey for fornecido, aplica criptografia Pós-Quântica (C3)
   * antes da fragmentação Shamir.
   */
  public async send(
    message: string,
    recipientMLKEMPubKey?: Uint8Array,
  ): Promise<FragmentResult | PQCSendResult> {
    if (!this.identity) throw new Error("GHOSTID_REQUIRED");

    let dataToFragment: string;
    let pqcMeta: Pick<PQCSendResult, "encapsulatedKey" | "nonce" | "tag" | "senderMLKEMPubKey" | "senderMLDSAPubKey" | "signature"> | null = null;

    if (recipientMLKEMPubKey && this.pqcKeypair && this.pqcSigningKeypair) {
      // C3: Criptografia Pós-Quântica antes de fragmentar
      const plaintext = new TextEncoder().encode(message);

      // Assinar payload com ML-DSA-87
      const pqcSig = mlDsaSign(this.pqcSigningKeypair.privateKey, plaintext);

      // Encriptar com ML-KEM + ChaCha20-Poly1305
      const encrypted = hybridEncrypt(recipientMLKEMPubKey, plaintext);

      // Conversão chunked para evitar stack overflow em mensagens grandes
      let binary = "";
      const chunk = 8192;
      for (let i = 0; i < encrypted.ciphertext.length; i += chunk) {
        binary += String.fromCharCode(...encrypted.ciphertext.subarray(i, i + chunk));
      }
      dataToFragment = btoa(binary);

      pqcMeta = {
        encapsulatedKey: encrypted.encapsulatedKey,
        nonce: encrypted.nonce,
        tag: encrypted.tag,
        senderMLKEMPubKey: this.pqcKeypair.publicKey,
        senderMLDSAPubKey: this.pqcSigningKeypair.publicKey,
        signature: pqcSig.signature,
      };
    } else {
      // Compatibilidade: envio sem PQC (plaintext Shamir)
      dataToFragment = message;
    }

    const result = fragmentMessage(dataToFragment);

    // Roteamento inteligente: distribui shards por canais com fallback
    for (let i = 0; i < result.shards.length; i++) {
      const shard = result.shards[i];
      if (!shard) continue;
      const route = await this.distanceBridge.routeShard(shard, i);
      const channel = route.channel;
      if (route.fallbackUsed) {
        console.warn(
          `[Orchestrator] Fallback de transporte: preferido=${route.preferred} escolhido=${route.channel} tentativas=${route.attempted.join("->")}`,
        );
      }

      // Store in local HCN for relay (Carrier logic)
      await this.hcnStore.storeShard({
        commitment: shard.commitment,
        payload: btoa(JSON.stringify(shard)),
        channel,
      });

      this.notify({ type: "SHARD_SENT", commitment: shard.commitment, channel });
    }

    if (pqcMeta) {
      return { ...result, ...pqcMeta };
    }

    return result;
  }

  // --- Network Event Loop ---

  private initNetworkListeners() {
    // Configura os drivers para reportar shards recebidos de volta ao orquestrador
    this.lora.onMessageReceived((sender, payload) => {
      try {
        const shard = JSON.parse(atob(payload));
        this.handleIncomingShard(shard, `LoRa:${sender}`);
      } catch { /* não é um shard VØID válido */ }
    });

    // Acoustic Scanner agora é ativado apenas via UI (gesto do usuário)
  }

  public async handleIncomingShard(shard: any, source: string) {
    if (!shard || !shard.commitment) return;
    console.log(`[Orchestrator] Shard recebido de ${source}: ${shard.commitment}`);
    
    // 1. Salva no HCN Store (OPFS)
    await this.hcnStore.storeShard({
      commitment: shard.commitment,
      payload: btoa(JSON.stringify(shard)),
      channel: source,
    });

    // 2. Notifica o sistema
    this.notify({ 
      type: "SHARD_RECEIVED", 
      shard: {
        commitment: shard.commitment,
        payload: btoa(JSON.stringify(shard)),
        channel: source,
        createdAt: Date.now(),
        expiresAt: Date.now() + 48 * 3600 * 1000
      }
    });

    // 3. Recompensa o Carrier (Karma)
    const newBalance = await this.hcnStore.awardKarma(shard.commitment, 5);
    this.notify({ type: "KARMA_UPDATED", balance: newBalance });
  }

  // --- Event System ---

  public subscribe(listener: VoidListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Retorna métricas agregadas do DistanceBridge.
   */
  public getTransportMetrics(): DistanceBridgeMetrics {
    return this.distanceBridge.getMetrics();
  }

  /**
   * Reseta métricas de transporte (útil para benchmark/sessão).
   */
  public resetTransportMetrics(): void {
    this.distanceBridge.resetMetrics();
  }

  private notify(event: VoidEvent) {
    this.listeners.forEach(l => l(event));
  }
}

export const voidOrchestrator = VoidOrchestrator.getInstance();
