import { secureRandomInt } from "../utils/secureRandom";
import { gfMul, gfInv } from "./gf256";

export interface AntiHiggsSnapshotInput {
  readonly namespace: string;
  readonly payload: string;
  readonly labels?: readonly string[];
}

export interface AntiHiggsSnapshot {
  readonly id: string;
  readonly namespace: string;
  readonly createdAt: number;
  readonly cipher: string;
  readonly iv: string;
  readonly digest: string;
  readonly labels: readonly string[];
}

export interface AntiHiggsPolicy {
  readonly offlineOnly: boolean;
  readonly encryption: "AES-GCM-256";
  readonly exportAllowed: boolean;
}

// ─── Fase 2: Export/Import Assinado ───────────────────────────────────────────

/** Bundle exportável: snapshots + HMAC-SHA256 de integridade */
export interface AntiHiggsBundle {
  readonly version: 2;
  readonly exportedAt: number;
  readonly snapshots: readonly AntiHiggsSnapshot[];
  /** HMAC-SHA256 sobre exportedAt+snapshots (hex) */
  readonly hmac: string;
}

/** Resultado da verificação de import */
export interface AntiHiggsImportResult {
  readonly ok: boolean;
  readonly imported: number;
  readonly error?: string;
}

// ─── Fase 2: Kill-Switch com Quorum 2-de-3 ────────────────────────────────────

/** Fragmento de kill-switch (Shamir-like sobre chave de 32 bytes) */
export interface KillSwitchShard {
  readonly index: number; // 1, 2 ou 3
  readonly shareHex: string;
}

/** Resultado da ativação do kill-switch */
export interface KillSwitchResult {
  readonly erased: number;
  readonly ok: boolean;
  readonly reason: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function newSnapshotId(namespace: string): string {
  return `ah_${namespace}_${Date.now()}_${secureRandomInt(1_000_000).toString().padStart(6, "0")}`;
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  const bytes = new Uint8Array(hash);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class AntiHiggsVault {
  private readonly policy: AntiHiggsPolicy;
  private readonly snapshots = new Map<string, AntiHiggsSnapshot>();
  private readonly keyPromise: Promise<CryptoKey>;
  private readonly hmacKeyPromise: Promise<CryptoKey>;

  // Kill-switch: precisa de 2 de 3 shards para zerar tudo
  private readonly killSwitchKey: Uint8Array;
  private readonly killSwitchShards: KillSwitchShard[];

  constructor(policy?: Partial<AntiHiggsPolicy>) {
    this.policy = {
      offlineOnly: policy?.offlineOnly ?? true,
      encryption: "AES-GCM-256",
      exportAllowed: policy?.exportAllowed ?? false,
    };
    this.keyPromise = crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    this.hmacKeyPromise = crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );

    // Gera chave de kill-switch e fragmenta 2-de-3 (Shamir GF(256) simplificado)
    this.killSwitchKey = crypto.getRandomValues(new Uint8Array(32));
    this.killSwitchShards = generateKillSwitchShards(this.killSwitchKey);
  }

  getPolicy(): AntiHiggsPolicy {
    return this.policy;
  }

  /** Retorna os 3 fragmentos do kill-switch (distribuir para custódios independentes) */
  getKillSwitchShards(): readonly KillSwitchShard[] {
    return this.killSwitchShards;
  }

  async createSnapshot(input: AntiHiggsSnapshotInput): Promise<AntiHiggsSnapshot> {
    const key = await this.keyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = encoder.encode(input.payload);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data,
    );
    const digest = await sha256Hex(input.payload);
    const snapshot: AntiHiggsSnapshot = {
      id: newSnapshotId(input.namespace),
      namespace: input.namespace,
      createdAt: Date.now(),
      cipher: bytesToBase64(new Uint8Array(encrypted)),
      iv: bytesToBase64(iv),
      digest,
      labels: input.labels ?? [],
    };
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  listSnapshots(namespace?: string): readonly AntiHiggsSnapshot[] {
    const all = Array.from(this.snapshots.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (!namespace) return all;
    return all.filter((item) => item.namespace === namespace);
  }

  async readSnapshot(id: string): Promise<string> {
    const item = this.snapshots.get(id);
    if (!item) throw new Error(`AntiHiggs snapshot não encontrado: ${id}`);
    const key = await this.keyPromise;
    const iv = base64ToBytes(item.iv);
    const ivBuffer = toArrayBuffer(iv);
    const cipher = base64ToBytes(item.cipher);
    const cipherBuffer = toArrayBuffer(cipher);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBuffer },
      key,
      cipherBuffer,
    );
    const text = decoder.decode(plain);
    const digest = await sha256Hex(text);
    if (digest !== item.digest) {
      throw new Error("AntiHiggs integridade inválida: digest não confere.");
    }
    return text;
  }

  eraseSnapshot(id: string): boolean {
    return this.snapshots.delete(id);
  }

  // ─── Fase 2: Export/Import Assinado ────────────────────────────────────────

  /**
   * Exporta todos os snapshots como bundle assinado (HMAC-SHA256).
   * Permite transferência auditável entre nós VØID.
   */
  async exportSigned(): Promise<AntiHiggsBundle> {
    if (!this.policy.exportAllowed) {
      throw new Error("AntiHiggs: export não autorizado pela policy.");
    }
    const hmacKey = await this.hmacKeyPromise;
    const exportedAt = Date.now();
    const snapshots = Array.from(this.snapshots.values());

    const body = encoder.encode(JSON.stringify({ exportedAt, snapshots }));
    const rawHmac = await crypto.subtle.sign("HMAC", hmacKey, body);
    const hmac = bytesToBase64(new Uint8Array(rawHmac));

    return { version: 2, exportedAt, snapshots, hmac };
  }

  /**
   * Importa bundle externo verificando HMAC.
   * Merge de snapshots sem sobrescrever existentes (id-safe).
   */
  async importSigned(
    bundle: AntiHiggsBundle,
    hmacKey: CryptoKey,
  ): Promise<AntiHiggsImportResult> {
    try {
      const body = encoder.encode(
        JSON.stringify({ exportedAt: bundle.exportedAt, snapshots: bundle.snapshots }),
      );
      const sig = base64ToBytes(bundle.hmac);
      const sigBuf = toArrayBuffer(sig);
      const valid = await crypto.subtle.verify("HMAC", hmacKey, sigBuf, body);

      if (!valid) {
        return { ok: false, imported: 0, error: "HMAC inválido — bundle adulterado ou chave errada." };
      }

      let imported = 0;
      for (const snap of bundle.snapshots) {
        if (!this.snapshots.has(snap.id)) {
          this.snapshots.set(snap.id, snap);
          imported++;
        }
      }
      return { ok: true, imported };
    } catch (e) {
      return { ok: false, imported: 0, error: String(e) };
    }
  }

  // ─── Fase 2: Kill-Switch Quorum 2-de-3 ─────────────────────────────────────

  /**
   * Apaga todo o vault fornecendo 2 de 3 fragmentos de kill-switch.
   * Reconstrói a chave via Lagrange GF(256) e verifica contra `killSwitchKey`.
   */
  activateKillSwitch(shards: readonly KillSwitchShard[]): KillSwitchResult {
    if (shards.length < 2) {
      return { erased: 0, ok: false, reason: "quorum insuficiente (mínimo 2 de 3 fragmentos)" };
    }

    try {
      const recovered = recoverKillSwitchKey(shards.slice(0, 2));

      // Verificação constant-time
      let match = recovered.length === this.killSwitchKey.length;
      for (let i = 0; i < recovered.length && i < this.killSwitchKey.length; i++) {
        if (recovered[i] !== this.killSwitchKey[i]) match = false;
      }

      if (!match) {
        return { erased: 0, ok: false, reason: "fragmentos inválidos — quorum rejeitado" };
      }

      const count = this.snapshots.size;
      this.snapshots.clear();
      return { erased: count, ok: true, reason: "kill-switch ativado — vault zerado" };
    } catch (e) {
      return { erased: 0, ok: false, reason: String(e) };
    }
  }
}

// ─── Kill-Switch: Shamir 2-de-3 por byte ─────────────────────────────────────

/**
 * Fragmenta chave de 32 bytes em 3 shares usando polinômio linear GF(256).
 * f(x) = secret + a1*x  →  shares em x=1,2,3
 * Qualquer 2 de 3 shares reconstroem o segredo.
 */
function generateKillSwitchShards(secret: Uint8Array): KillSwitchShard[] {
  const shareBytes = [
    new Uint8Array(secret.length),
    new Uint8Array(secret.length),
    new Uint8Array(secret.length),
  ];

  for (let i = 0; i < secret.length; i++) {
    const s = secret[i]!;
    const a1 = secureRandomInt(255) + 1; // coeficiente aleatório não-zero
    shareBytes[0]![i] = s ^ gfMul(a1, 1); // f(1)
    shareBytes[1]![i] = s ^ gfMul(a1, 2); // f(2)
    shareBytes[2]![i] = s ^ gfMul(a1, 3); // f(3)
  }

  return shareBytes.map((bytes, idx) => ({
    index: idx + 1,
    shareHex: Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""),
  }));
}

/**
 * Reconstrói segredo a partir de 2 shares via interpolação de Lagrange em GF(256).
 */
function recoverKillSwitchKey(shards: readonly KillSwitchShard[]): Uint8Array {
  if (shards.length < 2) throw new Error("Necessário mínimo 2 fragmentos");

  const s1 = shards[0]!;
  const s2 = shards[1]!;

  const x1 = s1.index;
  const x2 = s2.index;
  const b1 = hexToBytes(s1.shareHex);
  const b2 = hexToBytes(s2.shareHex);

  if (b1.length !== b2.length) throw new Error("Fragmentos com tamanhos incompatíveis");

  const secret = new Uint8Array(b1.length);

  // Coeficientes de Lagrange: l1 = x2/(x2-x1), l2 = x1/(x1-x2)
  // Em GF(256): subtração é XOR, divisão é gfMul(a, gfInv(b))
  const xorDiff12 = x1 ^ x2; // x1 - x2 em GF(256) = XOR
  const xorDiff21 = x2 ^ x1;
  const l1 = gfMul(x2, gfInv(xorDiff12)); // Lagrange para x1
  const l2 = gfMul(x1, gfInv(xorDiff21)); // Lagrange para x2

  for (let i = 0; i < secret.length; i++) {
    // secret = l1*y1 XOR l2*y2 em GF(256)
    secret[i] = gfMul(l1, b1[i]!) ^ gfMul(l2, b2[i]!);
  }

  return secret;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
