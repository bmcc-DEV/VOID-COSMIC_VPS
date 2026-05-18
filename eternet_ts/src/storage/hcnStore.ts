/**
 * VØID Core — Human Carrier Network (HCN) Storage Engine
 *
 * Banco de dados offline-first robusto usando o Origin Private File System (OPFS)
 * nativo do browser, com fallback para IndexedDB em browsers sem suporte completo.
 * Gerencia Shards carregados pelos portadores (Carriers).
 *
 * Características:
 * - Persistência binária e segura em sandbox isolada da CPU/Browser.
 * - TTL (Time-To-Live) de 48 horas gerenciado por varredura automática.
 * - Registro anônimo de créditos de karma para recompensas.
 * - Fallback IndexedDB para Firefox e browsers sem OPFS completo.
 */

export interface HCNShard {
  commitment: string;       // SHA3-256 hash (ID único do shard)
  payload:    string;       // dados criptografados em base64
  channel:    string;       // canal recomendado (BLE/LoRa/etc)
  createdAt:  number;       // timestamp de criação
  expiresAt:  number;       // timestamp de expiração (createdAt + 48h)
}

export interface KarmaWallet {
  publicKey:  string;       // chave pública anônima do carrier
  balance:    number;       // balanço acumulado de karma
  claims:     string[];     // hashes de provas de entrega
}

const IDB_NAME = "void_hcn_db";
const IDB_VERSION = 1;
const IDB_STORE = "shards";

async function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "commitment" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class HCNStore {
  private static STORAGE_FOLDER = "hcn_shards";
  private useOPFS: boolean | null = null;

  /**
   * Detecta se OPFS está disponível (suporte completo com createWritable).
   */
  private async checkOPFS(): Promise<boolean> {
    if (this.useOPFS !== null) return this.useOPFS;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("test_opfs_support", { create: true });
      const fileHandle = await dir.getFileHandle("test.txt", { create: true });
      const writable = await fileHandle.createWritable();
      await writable.close();
      await root.removeEntry("test_opfs_support");
      this.useOPFS = true;
    } catch {
      this.useOPFS = false;
      console.warn("[HCN Store] OPFS indisponível, usando IndexedDB como fallback.");
    }
    return this.useOPFS;
  }

  /**
   * Inicializa o OPFS e cria a estrutura de diretórios se necessário.
   */
  private async getDirectory(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(HCNStore.STORAGE_FOLDER, { create: true });
  }

  /**
   * Salva um Shard no armazenamento (OPFS ou IndexedDB).
   */
  public async storeShard(shard: Omit<HCNShard, "createdAt" | "expiresAt">): Promise<void> {
    const createdAt = Date.now();
    const expiresAt = createdAt + 48 * 60 * 60 * 1000;
    const fullShard: HCNShard = { ...shard, createdAt, expiresAt };

    try {
      if (await this.checkOPFS()) {
        const dir = await this.getDirectory();
        const filename = `${shard.commitment}.json`;
        const fileHandle = await dir.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(fullShard));
        await writable.close();
        console.log(`[HCN Store] Shard ${shard.commitment} salvo no OPFS. Expira em 48h.`);
      } else {
        const db = await openIDB();
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(fullShard);
        console.log(`[HCN Store] Shard ${shard.commitment} salvo no IndexedDB (fallback). Expira em 48h.`);
      }
    } catch (err) {
      console.error("[HCN Store] Erro ao salvar shard:", err);
      throw err;
    }
  }

  /**
   * Retorna todos os Shards válidos (não expirados).
   */
  public async getValidShards(): Promise<HCNShard[]> {
    const validShards: HCNShard[] = [];
    const now = Date.now();

    try {
      if (await this.checkOPFS()) {
        const dir = await this.getDirectory();
        for await (const [name, handle] of (dir as any).entries()) {
          if (handle.kind === "file") {
            const file = await (handle as FileSystemFileHandle).getFile();
            const text = await file.text();
            const shard: HCNShard = JSON.parse(text);
            if (shard.expiresAt < now) {
              await dir.removeEntry(name);
              console.log(`[HCN Store] Shard expirado ${shard.commitment} limpo via sweeper.`);
            } else {
              validShards.push(shard);
            }
          }
        }
      } else {
        const db = await openIDB();
        const tx = db.transaction(IDB_STORE, "readonly");
        const all: HCNShard[] = await new Promise((res, rej) => {
          const req = tx.objectStore(IDB_STORE).getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        for (const shard of all) {
          if (shard.expiresAt < now) {
            const delTx = db.transaction(IDB_STORE, "readwrite");
            delTx.objectStore(IDB_STORE).delete(shard.commitment);
            console.log(`[HCN Store] Shard expirado ${shard.commitment} limpo via sweeper.`);
          } else {
            validShards.push(shard);
          }
        }
      }
    } catch (err) {
      console.error("[HCN Store] Erro ao listar shards:", err);
    }

    return validShards;
  }

  /**
   * Deleta manualmente um shard após entrega bem sucedida.
   */
  public async deleteShard(commitment: string): Promise<void> {
    try {
      if (await this.checkOPFS()) {
        const dir = await this.getDirectory();
        await dir.removeEntry(`${commitment}.json`);
      } else {
        const db = await openIDB();
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(commitment);
      }
      console.log(`[HCN Store] Shard ${commitment} entregue e removido.`);
    } catch (err) {
      console.warn(`[HCN Store] Shard ${commitment} já foi limpo ou não existe.`, err);
    }
  }

  // ─── Anonymous Karma Ledger (Proof-of-Delivery) ───────────────────────────

  /**
   * Concede créditos de Karma ao Carrier por fatiar ou entregar shards.
   */
  public async awardKarma(proofHash: string, amount = 10): Promise<number> {
    try {
      const root = await navigator.storage.getDirectory();
      const karmaHandle = await root.getFileHandle("karma_ledger.json", { create: true });

      let wallet: KarmaWallet = { publicKey: "anon_carrier", balance: 0, claims: [] };

      try {
        const file = await karmaHandle.getFile();
        const text = await file.text();
        if (text) wallet = JSON.parse(text);
      } catch { /* primeira execução — usar padrão */ }

      if (wallet.claims.includes(proofHash)) {
        return wallet.balance;
      }

      wallet.balance += amount;
      wallet.claims.push(proofHash);

      const writable = await karmaHandle.createWritable();
      await writable.write(JSON.stringify(wallet));
      await writable.close();

      console.log(`[HCN Karma] +${amount} Karma concedido! Novo saldo: ${wallet.balance}`);
      return wallet.balance;
    } catch (err) {
      console.error("[HCN Karma] Erro ao atualizar saldo de karma:", err);
      return 0;
    }
  }

  /**
   * Retorna o saldo de Karma acumulado na carteira anônima local.
   */
  public async getKarmaBalance(): Promise<number> {
    try {
      const root = await navigator.storage.getDirectory();
      const karmaHandle = await root.getFileHandle("karma_ledger.json", { create: true });
      const file = await karmaHandle.getFile();
      const text = await file.text();
      if (text) {
        const wallet: KarmaWallet = JSON.parse(text);
        return wallet.balance;
      }
    } catch { /* Ledger vazio */ }
    return 0;
  }
}

// Singleton instance for direct imports
export const hcnStore = new HCNStore();
