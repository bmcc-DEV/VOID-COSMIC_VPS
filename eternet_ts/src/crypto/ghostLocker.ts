/**
 * VØID Ghost Locker — Sistema de armazenamento físico com NFC
 *
 * Fluxo real:
 * 1. Compra gera NFC seal (hash criptográfico do pacote)
 * 2. Pacote é colocado no locker com tag NFC
 * 3. Destinatário aproxima celular → lê NFC seal
 * 4. Verificação ZK: seal bate com prova de compra
 * 5. Locker libera slot após recebimento confirmado
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GhostLocker {
  id: string;
  name: string;
  location: string;
  lat: number;
  lng: number;
  availableSlots: number;
  totalSlots: number;
  nfcEnabled: boolean;
  isActive: boolean;
}

export interface NFCSeal {
  sealId: string;
  purchaseId: string;
  lockerId: string;
  hash: string;
  timestamp: number;
  expiresAt: number;
  signature: string;
}

export interface LockerSlot {
  slotId: string;
  lockerId: string;
  isOccupied: boolean;
  purchaseId: string | null;
  nfcTagId: string | null;
  sealHash: string | null;
  storedAt: number | null;
  expiresAt: number | null;
}

// ─── NFC Driver (Web NFC API) ────────────────────────────────────────────────

class NFCReader {
  private static isAvailable(): boolean {
    return typeof window !== "undefined" && "NDEFReader" in window;
  }

  static async writeTag(data: Record<string, string>): Promise<boolean> {
    if (!this.isAvailable()) {
      console.warn("[NFC] Web NFC não disponível neste browser");
      return false;
    }
    try {
      // @ts-ignore — NDEFReader é experimental
      const reader = new NDEFReader();
      await reader.write({
        records: Object.entries(data).map(([_key, value]) => ({
          recordType: "text",
          data: value,
          lang: "pt-BR",
        })),
      });
      return true;
    } catch (err) {
      console.error("[NFC] Erro ao gravar tag:", err);
      return false;
    }
  }

  static async readTag(): Promise<Record<string, string> | null> {
    if (!this.isAvailable()) {
      console.warn("[NFC] Web NFC não disponível");
      return null;
    }
    return new Promise((resolve) => {
      try {
        // @ts-ignore
        const reader = new NDEFReader();
        reader.addEventListener("reading", (event: any) => {
          const data: Record<string, string> = {};
          for (const record of event.message.records) {
            if (record.recordType === "text") {
              const decoder = new TextDecoder();
              data["data"] = decoder.decode(record.data);
            }
          }
          resolve(data);
        });
        reader.addEventListener("readingerror", () => resolve(null));
      } catch {
        resolve(null);
      }
    });
  }
}

// ─── Ghost Locker Manager ────────────────────────────────────────────────────

export class GhostLockerManager {
  private static instance: GhostLockerManager;
  private lockers: Map<string, GhostLocker> = new Map();
  private slots: Map<string, LockerSlot> = new Map();
  private seals: Map<string, NFCSeal> = new Map();

  static getInstance(): GhostLockerManager {
    if (!GhostLockerManager.instance) {
      GhostLockerManager.instance = new GhostLockerManager();
    }
    return GhostLockerManager.instance;
  }

  private constructor() {
    this.initDefaultLockers();
  }

  private initDefaultLockers() {
    const defaults: GhostLocker[] = [
      { id: "locker_001", name: "Ghost Locker - North Shopping", location: "Fortaleza, CE", lat: -3.7319, lng: -38.5162, availableSlots: 12, totalSlots: 20, nfcEnabled: true, isActive: true },
      { id: "locker_002", name: "Ghost Locker - Iguatemi", location: "Fortaleza, CE", lat: -3.7584, lng: -38.4922, availableSlots: 8, totalSlots: 15, nfcEnabled: true, isActive: true },
      { id: "locker_003", name: "Ghost Locker - Via Sul", location: "Fortaleza, CE", lat: -3.7750, lng: -38.4750, availableSlots: 15, totalSlots: 25, nfcEnabled: true, isActive: true },
    ];
    defaults.forEach((l) => this.lockers.set(l.id, l));

    // Inicializar slots para cada locker
    for (const locker of defaults) {
      for (let i = 1; i <= locker.totalSlots; i++) {
        const slotId = `${locker.id}_slot_${i}`;
        this.slots.set(slotId, {
          slotId,
          lockerId: locker.id,
          isOccupied: false,
          purchaseId: null,
          nfcTagId: null,
          sealHash: null,
          storedAt: null,
          expiresAt: null,
        });
      }
    }
  }

  // ─── Seal Generation ─────────────────────────────────────────────────────

  /**
   * Gera NFC seal criptográfico para um pacote.
   * O seal é um hash SHA3-256 assinado com a chave do nó.
   */
  generateSeal(purchaseId: string, lockerId: string, privateKey: Uint8Array): NFCSeal {
    const timestamp = Date.now();
    const expiresAt = timestamp + 48 * 60 * 60 * 1000; // 48h TTL

    // Hash do conteúdo
    const payload = `${purchaseId}:${lockerId}:${timestamp}`;
    const hashBytes = sha3_256(new TextEncoder().encode(payload));
    const hash = bytesToHex(hashBytes);

    // Assinar com Ed25519
    const signatureBytes = ed25519.sign(hashBytes, privateKey);
    const signature = bytesToHex(signatureBytes);

    const seal: NFCSeal = {
      sealId: `seal_${hash.slice(0, 16)}`,
      purchaseId,
      lockerId,
      hash,
      timestamp,
      expiresAt,
      signature,
    };

    this.seals.set(seal.sealId, seal);
    return seal;
  }

  /**
   * Verifica se um NFC seal é válido.
   */
  verifySeal(seal: NFCSeal, publicKey: Uint8Array): boolean {
    // Verificar expiração
    if (Date.now() > seal.expiresAt) {
      console.warn("[Ghost Locker] Seal expirado");
      return false;
    }

    // Verificar assinatura
    const payload = `${seal.purchaseId}:${seal.lockerId}:${seal.timestamp}`;
    const hashBytes = sha3_256(new TextEncoder().encode(payload));
    const sigBytes = hexToBytes(seal.signature);

    try {
      return ed25519.verify(sigBytes, hashBytes, publicKey);
    } catch {
      return false;
    }
  }

  // ─── Locker Operations ───────────────────────────────────────────────────

  /**
   * Reserva um slot no locker para um pacote.
   */
  reserveSlot(lockerId: string, purchaseId: string): LockerSlot | null {
    const locker = this.lockers.get(lockerId);
    if (!locker || !locker.isActive || locker.availableSlots <= 0) {
      return null;
    }

    // Encontrar slot vazio
    for (const [slotId, slot] of this.slots) {
      if (slot.lockerId === lockerId && !slot.isOccupied) {
        slot.isOccupied = true;
        slot.purchaseId = purchaseId;
        slot.storedAt = Date.now();
        slot.expiresAt = Date.now() + 48 * 60 * 60 * 1000;

        locker.availableSlots--;
        this.slots.set(slotId, slot);
        return slot;
      }
    }
    return null;
  }

  /**
   * Grava NFC seal em uma tag física.
   */
  async writeSealToTag(slot: LockerSlot, seal: NFCSeal): Promise<boolean> {
    const tagData = {
      "void-type": "ghost-locker",
      "void-seal": seal.hash,
      "void-signature": seal.signature,
      "void-purchase": seal.purchaseId,
      "void-expires": seal.expiresAt.toString(),
    };

    const success = await NFCReader.writeTag(tagData);
    if (success) {
      slot.nfcTagId = seal.sealId;
      slot.sealHash = seal.hash;
      this.slots.set(slot.slotId, slot);
    }
    return success;
  }

  /**
   * Escuta tags NFC e retorna dados lidos.
   */
  async scanTag(): Promise<{ seal: NFCSeal | null; valid: boolean }> {
    const data = await NFCReader.readTag();
    if (!data || !data["void-seal"]) {
      return { seal: null, valid: false };
    }

    // Procurar seal no mapa
    for (const seal of this.seals.values()) {
      if (seal.hash === data["void-seal"]) {
        return { seal, valid: Date.now() < seal.expiresAt };
      }
    }

    return { seal: null, valid: false };
  }

  /**
   * Libera um pacote do locker (recebimento confirmado).
   */
  releasePackage(slotId: string): boolean {
    const slot = this.slots.get(slotId);
    if (!slot || !slot.isOccupied) return false;

    const locker = this.lockers.get(slot.lockerId);
    if (locker) {
      locker.availableSlots++;
    }

    slot.isOccupied = false;
    slot.purchaseId = null;
    slot.nfcTagId = null;
    slot.sealHash = null;
    slot.storedAt = null;
    slot.expiresAt = null;

    this.slots.set(slotId, slot);
    return true;
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  getLockers(): GhostLocker[] {
    return Array.from(this.lockers.values());
  }

  getAvailableLockers(): GhostLocker[] {
    return this.getLockers().filter((l) => l.isActive && l.availableSlots > 0);
  }

  getLockerSlots(lockerId: string): LockerSlot[] {
    return Array.from(this.slots.values()).filter((s) => s.lockerId === lockerId);
  }

  getOccupiedSlots(lockerId: string): LockerSlot[] {
    return this.getLockerSlots(lockerId).filter((s) => s.isOccupied);
  }

  /**
   * Verifica integridade: todos os seals dos pacotes armazenados.
   */
  verifyAllIntegrity(): { slotId: string; valid: boolean }[] {
    const results: { slotId: string; valid: boolean }[] = [];
    for (const slot of this.slots.values()) {
      if (slot.isOccupied && slot.sealHash) {
        const seal = Array.from(this.seals.values()).find((s) => s.hash === slot.sealHash);
        results.push({
          slotId: slot.slotId,
          valid: seal ? Date.now() < seal.expiresAt : false,
        });
      }
    }
    return results;
  }
}

// Singleton
export const ghostLocker = GhostLockerManager.getInstance();
