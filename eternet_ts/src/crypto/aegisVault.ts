/**
 * ETΞRNET — Aegis Vault: O Cofre que Só Existe no Instante do Consenso
 *
 * A chave privada é o XOR de N streams de entropia que só convergem
 * durante uma janela de 500ms.
 *
 * Componentes:
 * - Assembleia de Testemunhas Causais: nós aleatórios transmitem fatias de entropia
 * - Prova de Vida Biométrica: desafio-resposta efêmero (padrão de vibração)
 * - Herança Fantasma: se a entropia biométrica sumir por 365 dias, shards vão a herdeiros
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { type GhostIdentity } from "./ghostid";
import { secureRandomId } from "../utils/secureRandom";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EntropyStream {
  streamId: string;
  sourceNodeId: string;
  entropySlice: Uint8Array;
  timestamp: number;
  signature: Uint8Array;
}

export interface AegisVaultConfig {
  convergenceWindowMs: number;   // Janela de convergência (padrão: 500ms)
  requiredStreams: number;       // Número mínimo de streams (padrão: 3)
  biometricChallengeInterval: number; // Intervalo de desafio biométrico (ms)
  inheritanceDelay: number;     // Delay para herança fantasma (ms)
}

export interface VaultState {
  id: string;
  ownerPk: string;
  isActive: boolean;
  lastConvergence: number;
  lastBiometricProof: number;
  entropyStreams: EntropyStream[];
  derivedKey: Uint8Array | null;
  heirs: string[];              // GhostIDs herdeiros
  inheritanceTriggered: boolean;
  createdAt: number;
}

export interface BiometricChallenge {
  challengeId: string;
  pattern: Uint8Array;          // Padrão de vibração/aceleiração
  expectedResponse: Uint8Array;
  expiresAt: number;
}

export interface InheritanceProof {
  vaultId: string;
  heirId: string;
  proofHash: string;
  timestamp: number;
  entropyMissing: boolean;      // Se a entropia biométrica sumiu
}

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AegisVaultConfig = {
  convergenceWindowMs: 500,
  requiredStreams: 3,
  biometricChallengeInterval: 30000, // 30 segundos
  inheritanceDelay: 365 * 24 * 60 * 60 * 1000, // 365 dias
};

// ─── Aegis Vault Engine ──────────────────────────────────────────────────────

export class AegisVault {
  private static instance: AegisVault;
  private vaults: Map<string, VaultState> = new Map();
  private config: AegisVaultConfig;

  public static getInstance(config?: Partial<AegisVaultConfig>): AegisVault {
    if (!AegisVault.instance) {
      AegisVault.instance = new AegisVault(config);
    }
    return AegisVault.instance;
  }

  private constructor(config?: Partial<AegisVaultConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Vault Creation ──────────────────────────────────────────────────────

  /**
   * Cria um novo cofre Aegis para um GhostID.
   */
  createVault(owner: GhostIdentity, heirs: string[] = []): VaultState {
    const vaultId = `vault_${Date.now()}_${secureRandomId(4)}`;

    const vault: VaultState = {
      id: vaultId,
      ownerPk: Array.from(owner.publicKey).map(b => b.toString(16).padStart(2, "0")).join(""),
      isActive: true,
      lastConvergence: 0,
      lastBiometricProof: 0,
      entropyStreams: [],
      derivedKey: null,
      heirs,
      inheritanceTriggered: false,
      createdAt: Date.now(),
    };

    this.vaults.set(vaultId, vault);
    console.log(`[Aegis] Vault ${vaultId} criado para ${owner.handle}`);
    return vault;
  }

  // ─── Entropy Convergence ─────────────────────────────────────────────────

  /**
   * Adiciona uma fatia de entropia de um nó testemunha.
   * Quando N streams convergem em 500ms, a chave é derivada.
   */
  addEntropyStream(vaultId: string, stream: EntropyStream): Uint8Array | null {
    const vault = this.vaults.get(vaultId);
    if (!vault || !vault.isActive) return null;

    // Adiciona o stream
    vault.entropyStreams.push(stream);

    // Filtra streams dentro da janela de convergência
    const now = Date.now();
    const recentStreams = vault.entropyStreams.filter(
      s => now - s.timestamp < this.config.convergenceWindowMs
    );

    // Se temos streams suficientes, deriva a chave
    if (recentStreams.length >= this.config.requiredStreams) {
      const derivedKey = this.deriveKeyFromStreams(recentStreams);
      vault.derivedKey = derivedKey;
      vault.lastConvergence = now;

      console.log(`[Aegis] Vault ${vaultId} convergiu com ${recentStreams.length} streams!`);

      // Limpa streams antigos
      vault.entropyStreams = recentStreams;
      return derivedKey;
    }

    // Agarda próxima janela
    return null;
  }

  /**
   * Deriva a chave XOR de N streams de entropia.
   */
  private deriveKeyFromStreams(streams: EntropyStream[]): Uint8Array {
    const key = new Uint8Array(32);

    for (const stream of streams) {
      const hash = sha3_256(stream.entropySlice);
      for (let i = 0; i < 32; i++) {
        key[i] ^= hash[i];
      }
    }

    return key;
  }

  // ─── Biometric Proof of Life ─────────────────────────────────────────────

  /**
   * Gera desafio biométrico (padrão de vibração/acceleração).
   */
  generateBiometricChallenge(vaultId: string): BiometricChallenge | null {
    const vault = this.vaults.get(vaultId);
    if (!vault || !vault.isActive) return null;

    const challenge: BiometricChallenge = {
      challengeId: `bio_${Date.now()}_${secureRandomId(3)}`,
      pattern: crypto.getRandomValues(new Uint8Array(16)),
      expectedResponse: new Uint8Array(32), // Será preenchido pelo owner
      expiresAt: Date.now() + 10000, // 10 segundos para responder
    };

    // Gera resposta esperada baseada no padrão
    const patternHash = sha3_256(challenge.pattern);
    challenge.expectedResponse = patternHash;

    console.log(`[Aegis] Desafio biométrico ${challenge.challengeId} gerado para vault ${vaultId}`);
    return challenge;
  }

  /**
   * Verifica resposta biométrica.
   */
  verifyBiometricResponse(
    vaultId: string,
    _challengeId: string,
    response: Uint8Array,
  ): boolean {
    const vault = this.vaults.get(vaultId);
    if (!vault) return false;

    // Simula verificação de padrão de vibração
    const responseHash = sha3_256(response);
    const isValid = responseHash[0] === response[0]; // Simplificado

    if (isValid) {
      vault.lastBiometricProof = Date.now();
      console.log(`[Aegis] Vault ${vaultId} verificou vida biométrica.`);
    } else {
      console.warn(`[Aegis] Vault ${vaultId} falhou na verificação biométrica.`);
    }

    return isValid;
  }

  // ─── Inheritance ─────────────────────────────────────────────────────────

  /**
   * Registra herdeiros para o vault.
   */
  setHeirs(vaultId: string, heirIds: string[]): boolean {
    const vault = this.vaults.get(vaultId);
    if (!vault) return false;

    vault.heirs = heirIds;
    console.log(`[Aegis] Vault ${vaultId} configurado com ${heirIds.length} herdeiros.`);
    return true;
  }

  /**
   * Verifica se a herança fantasma deve ser acionada.
   * Se a entropia biométrica sumir por 365 dias, os shards vão aos herdeiros.
   */
  checkInheritance(vaultId: string): InheritanceProof | null {
    const vault = this.vaults.get(vaultId);
    if (!vault || vault.inheritanceTriggered || vault.heirs.length === 0) return null;

    const timeSinceLastBiometric = Date.now() - vault.lastBiometricProof;
    if (timeSinceLastBiometric > this.config.inheritanceDelay) {
      // Aciona herança
      vault.inheritanceTriggered = true;
      vault.isActive = false;

      const proof: InheritanceProof = {
        vaultId,
        heirId: vault.heirs[0]!, // Primeiro herdeiro
        proofHash: Array.from(sha3_256(new TextEncoder().encode(`${vaultId}_inheritance`)))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 32),
        timestamp: Date.now(),
        entropyMissing: true,
      };

      console.log(`[Aegis] HERANÇA FANTASMA acionada para vault ${vaultId}. Herdeiro: ${proof.heirId}`);
      return proof;
    }

    return null;
  }

  // ─── Vault Operations ───────────────────────────────────────────────────

  /**
   * Cifra dados usando a chave derivada do vault.
   */
  encrypt(vaultId: string, data: Uint8Array): Uint8Array | null {
    const vault = this.vaults.get(vaultId);
    if (!vault || !vault.derivedKey || !vault.isActive) return null;

    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const cipher = chacha20poly1305(vault.derivedKey, nonce);
    const encrypted = cipher.encrypt(data);

    // Prepend nonce ao ciphertext
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted as Uint8Array, nonce.length);
    return result;
  }

  /**
   * Decifra dados usando a chave derivada do vault.
   */
  decrypt(vaultId: string, data: Uint8Array): Uint8Array | null {
    const vault = this.vaults.get(vaultId);
    if (!vault || !vault.derivedKey || !vault.isActive) return null;

    try {
      const nonce = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const cipher = chacha20poly1305(vault.derivedKey, nonce);
      return cipher.decrypt(ciphertext) as Uint8Array;
    } catch {
      console.error(`[Aegis] Vault ${vaultId}: falha ao decifrar.`);
      return null;
    }
  }

  /**
   * Destrói o vault e limpa todas as chaves.
   */
  destroyVault(vaultId: string): boolean {
    const vault = this.vaults.get(vaultId);
    if (!vault) return false;

    // Secure wipe
    if (vault.derivedKey) vault.derivedKey.fill(0);
    vault.entropyStreams.forEach(s => s.entropySlice.fill(0));
    vault.isActive = false;

    this.vaults.delete(vaultId);
    console.log(`[Aegis] Vault ${vaultId} destruído e memória limpa.`);
    return true;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getVault(id: string): VaultState | null {
    return this.vaults.get(id) || null;
  }

  getAllVaults(): VaultState[] {
    return Array.from(this.vaults.values());
  }

  getStats() {
    const vaults = Array.from(this.vaults.values());
    return {
      totalVaults: vaults.length,
      activeVaults: vaults.filter(v => v.isActive).length,
      inheritedVaults: vaults.filter(v => v.inheritanceTriggered).length,
      avgStreamsPerVault: vaults.length > 0
        ? vaults.reduce((sum, v) => sum + v.entropyStreams.length, 0) / vaults.length
        : 0,
    };
  }
}

export const aegisVault = AegisVault.getInstance();
