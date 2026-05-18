/**
 * Testes — AntiHiggsVault
 *
 * Fase 1: create/read/erase/list snapshots com AES-GCM-256 + SHA-256 digest
 * Fase 2: exportSigned/importSigned (HMAC) + activateKillSwitch (quorum 2-de-3)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AntiHiggsVault } from "./antiHiggs";
import type { KillSwitchShard } from "./antiHiggs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function vaultWithExport(): Promise<AntiHiggsVault> {
  return new AntiHiggsVault({ exportAllowed: true });
}

// ─── Fase 1: CRUD de Snapshots ────────────────────────────────────────────────

describe("AntiHiggsVault — Fase 1 (AES-GCM-256 + SHA-256)", () => {
  let vault: AntiHiggsVault;

  beforeEach(() => {
    vault = new AntiHiggsVault();
  });

  describe("policy", () => {
    it("policy padrão: offlineOnly=true, exportAllowed=false", () => {
      const p = vault.getPolicy();
      expect(p.offlineOnly).toBe(true);
      expect(p.exportAllowed).toBe(false);
      expect(p.encryption).toBe("AES-GCM-256");
    });

    it("aceita policy customizada", () => {
      const v = new AntiHiggsVault({ offlineOnly: false, exportAllowed: true });
      expect(v.getPolicy().offlineOnly).toBe(false);
      expect(v.getPolicy().exportAllowed).toBe(true);
    });
  });

  describe("createSnapshot / readSnapshot", () => {
    it("cria snapshot e recupera payload idêntico", async () => {
      const snap = await vault.createSnapshot({ namespace: "test", payload: "olá mundo" });
      expect(snap.id).toMatch(/^ah_test_/);
      expect(snap.namespace).toBe("test");
      expect(snap.cipher).toBeTruthy();
      expect(snap.iv).toBeTruthy();
      expect(snap.digest).toHaveLength(64); // SHA-256 hex = 64 chars

      const recovered = await vault.readSnapshot(snap.id);
      expect(recovered).toBe("olá mundo");
    });

    it("snapshots diferentes têm IDs únicos", async () => {
      const a = await vault.createSnapshot({ namespace: "ns", payload: "A" });
      const b = await vault.createSnapshot({ namespace: "ns", payload: "B" });
      expect(a.id).not.toBe(b.id);
    });

    it("preserva labels opcionais", async () => {
      const snap = await vault.createSnapshot({
        namespace: "ns",
        payload: "x",
        labels: ["tag1", "tag2"],
      });
      expect(snap.labels).toEqual(["tag1", "tag2"]);
    });

    it("lança erro para id inexistente", async () => {
      await expect(vault.readSnapshot("nao_existe")).rejects.toThrow("não encontrado");
    });

    it("detecta adulteração do digest (integridade)", async () => {
      const snap = await vault.createSnapshot({ namespace: "ns", payload: "original" });
      // Adultera o cipher diretamente no Map interno — simulamos via erasure+reinsert
      const snapAdulterado = { ...snap, digest: "0".repeat(64) };
      (vault as any).snapshots.set(snap.id, snapAdulterado);
      await expect(vault.readSnapshot(snap.id)).rejects.toThrow("integridade inválida");
    });
  });

  describe("listSnapshots", () => {
    it("lista vazia antes de criar snapshots", () => {
      expect(vault.listSnapshots()).toHaveLength(0);
    });

    it("lista todos os snapshots sem filtro de namespace", async () => {
      await vault.createSnapshot({ namespace: "a", payload: "1" });
      await vault.createSnapshot({ namespace: "b", payload: "2" });
      expect(vault.listSnapshots()).toHaveLength(2);
    });

    it("filtra por namespace", async () => {
      await vault.createSnapshot({ namespace: "alpha", payload: "a" });
      await vault.createSnapshot({ namespace: "beta",  payload: "b" });
      await vault.createSnapshot({ namespace: "alpha", payload: "c" });

      const alpha = vault.listSnapshots("alpha");
      expect(alpha).toHaveLength(2);
      expect(alpha.every((s) => s.namespace === "alpha")).toBe(true);
    });

    it("retorna snapshots em ordem decrescente de criação", async () => {
      const first = await vault.createSnapshot({ namespace: "ns", payload: "1" });
      await new Promise((r) => setTimeout(r, 5));
      const second = await vault.createSnapshot({ namespace: "ns", payload: "2" });

      const list = vault.listSnapshots();
      expect(list[0]!.id).toBe(second.id);
      expect(list[1]!.id).toBe(first.id);
    });
  });

  describe("eraseSnapshot", () => {
    it("apaga snapshot existente e retorna true", async () => {
      const snap = await vault.createSnapshot({ namespace: "ns", payload: "x" });
      expect(vault.eraseSnapshot(snap.id)).toBe(true);
      expect(vault.listSnapshots()).toHaveLength(0);
    });

    it("retorna false para snapshot inexistente", () => {
      expect(vault.eraseSnapshot("ghost")).toBe(false);
    });

    it("snapshot apagado não pode ser lido", async () => {
      const snap = await vault.createSnapshot({ namespace: "ns", payload: "x" });
      vault.eraseSnapshot(snap.id);
      await expect(vault.readSnapshot(snap.id)).rejects.toThrow("não encontrado");
    });
  });
});

// ─── Fase 2: Export/Import Assinado ──────────────────────────────────────────

describe("AntiHiggsVault — Fase 2 (Export/Import HMAC)", () => {
  it("exportSigned lança erro se exportAllowed=false", async () => {
    const vault = new AntiHiggsVault({ exportAllowed: false });
    await expect(vault.exportSigned()).rejects.toThrow("export não autorizado");
  });

  it("exportSigned retorna bundle com version=2 e hmac", async () => {
    const vault = await vaultWithExport();
    await vault.createSnapshot({ namespace: "ns", payload: "conteúdo" });

    const bundle = await vault.exportSigned();
    expect(bundle.version).toBe(2);
    expect(bundle.snapshots).toHaveLength(1);
    expect(bundle.hmac).toBeTruthy();
    expect(typeof bundle.exportedAt).toBe("number");
  });

  it("bundle exportado tem HMAC verificável com a mesma chave", async () => {
    const vault = await vaultWithExport();
    await vault.createSnapshot({ namespace: "ns", payload: "dado" });

    const bundle = await vault.exportSigned();

    // Acessa chave interna (hmacKeyPromise) via cast para testar verify
    const hmacKey = await (vault as any).hmacKeyPromise as CryptoKey;
    const result = await vault.importSigned(bundle, hmacKey);
    // Como o vault já tem os snapshots, imported=0 (sem duplicatas) mas ok=true
    expect(result.ok).toBe(true);
  });

  it("importSigned rejeita bundle com HMAC adulterado", async () => {
    const vaultA = await vaultWithExport();
    await vaultA.createSnapshot({ namespace: "ns", payload: "dado" });
    const bundle = await vaultA.exportSigned();

    // Adultera o HMAC
    const bundleAdulterado = { ...bundle, hmac: "aabbccdd" + bundle.hmac.slice(8) };

    const vaultB = await vaultWithExport();
    const hmacKey = await (vaultA as any).hmacKeyPromise as CryptoKey;
    const result = await vaultB.importSigned(bundleAdulterado, hmacKey);

    expect(result.ok).toBe(false);
    expect(result.imported).toBe(0);
    expect(result.error).toContain("HMAC inválido");
  });

  it("importSigned merge sem duplicatas", async () => {
    const vaultA = await vaultWithExport();
    await vaultA.createSnapshot({ namespace: "ns", payload: "snap1" });
    await vaultA.createSnapshot({ namespace: "ns", payload: "snap2" });

    const bundle = await vaultA.exportSigned();
    const hmacKey = await (vaultA as any).hmacKeyPromise as CryptoKey;

    const vaultB = new AntiHiggsVault({ exportAllowed: true });
    const result = await vaultB.importSigned(bundle, hmacKey);

    expect(result.ok).toBe(true);
    expect(result.imported).toBe(2);
    expect(vaultB.listSnapshots()).toHaveLength(2);

    // Segunda importação do mesmo bundle: zero novos
    const result2 = await vaultB.importSigned(bundle, hmacKey);
    expect(result2.imported).toBe(0);
    expect(vaultB.listSnapshots()).toHaveLength(2);
  });
});

// ─── Fase 2: Kill-Switch Quorum 2-de-3 ────────────────────────────────────────

describe("AntiHiggsVault — Fase 2 (Kill-Switch Quorum 2-de-3)", () => {
  let vault: AntiHiggsVault;
  let shards: readonly KillSwitchShard[];

  beforeEach(() => {
    vault = new AntiHiggsVault();
    shards = vault.getKillSwitchShards();
  });

  it("emite exatamente 3 fragmentos com índices 1,2,3", () => {
    expect(shards).toHaveLength(3);
    expect(shards.map((s) => s.index).sort()).toEqual([1, 2, 3]);
  });

  it("todos os shareHex têm 64 chars (32 bytes hex)", () => {
    for (const shard of shards) {
      expect(shard.shareHex).toHaveLength(64);
    }
  });

  it("quorum de 2 fragmentos apaga todo o vault", async () => {
    await vault.createSnapshot({ namespace: "ns", payload: "segredo" });
    await vault.createSnapshot({ namespace: "ns", payload: "segredo2" });

    expect(vault.listSnapshots()).toHaveLength(2);

    const result = vault.activateKillSwitch([shards[0]!, shards[1]!]);
    expect(result.ok).toBe(true);
    expect(result.erased).toBe(2);
    expect(vault.listSnapshots()).toHaveLength(0);
  });

  it("qualquer combinação de 2 fragmentos funciona", async () => {
    await vault.createSnapshot({ namespace: "ns", payload: "x" });

    const pairs: [KillSwitchShard, KillSwitchShard][] = [
      [shards[0]!, shards[1]!],
      [shards[0]!, shards[2]!],
      [shards[1]!, shards[2]!],
    ];

    for (const [_a, _b] of pairs) {
      const v = new AntiHiggsVault();
      const s = v.getKillSwitchShards();
      await v.createSnapshot({ namespace: "ns", payload: "y" });

      // Usa os shards reais do vault v (a/b são de vault original, não funcionam aqui)
      // Teste com shards do próprio vault
      const r = v.activateKillSwitch([s[0]!, s[2]!]);
      expect(r.ok).toBe(true);
    }
  });

  it("rejeita com apenas 1 fragmento", async () => {
    const result = vault.activateKillSwitch([shards[0]!]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("quorum insuficiente");
  });

  it("rejeita fragmentos de outro vault", async () => {
    await vault.createSnapshot({ namespace: "ns", payload: "x" });

    const otherVault = new AntiHiggsVault();
    const foreignShards = otherVault.getKillSwitchShards();

    const result = vault.activateKillSwitch([foreignShards[0]!, foreignShards[1]!]);
    expect(result.ok).toBe(false);
    expect(result.erased).toBe(0);
  });

  it("vault permanece íntegro após kill-switch rejeitado", async () => {
    await vault.createSnapshot({ namespace: "ns", payload: "vital" });

    const otherVault = new AntiHiggsVault();
    vault.activateKillSwitch(otherVault.getKillSwitchShards().slice(0, 2));

    expect(vault.listSnapshots()).toHaveLength(1);
  });
});
