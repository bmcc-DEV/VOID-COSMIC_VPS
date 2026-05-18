import { describe, expect, it, vi } from "vitest";
import { C3Engine } from "../crypto/c3Engine";
import { destroyGhostId, spawnGhostId } from "../crypto/ghostid";
import type { Shard } from "../crypto/qel";
import { HCNStore } from "../storage/hcnStore";

class InMemoryFileHandle {
  constructor(private readonly files: Map<string, string>, private readonly name: string) {}

  async createWritable() {
    return {
      write: async (content: string) => {
        this.files.set(this.name, content);
      },
      close: async () => undefined,
    };
  }

  async getFile() {
    const content = this.files.get(this.name) ?? "";
    return {
      text: async () => content,
    };
  }
}

class InMemoryDirectoryHandle {
  private readonly files = new Map<string, string>();
  private readonly directories = new Map<string, InMemoryDirectoryHandle>();

  constructor(private readonly rootMap: Map<string, InMemoryDirectoryHandle>, private readonly fullPath: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const nextPath = `${this.fullPath}/${name}`;
    let dir = this.directories.get(name);
    if (!dir) {
      if (!options?.create) throw new Error(`Diretório ausente: ${nextPath}`);
      dir = new InMemoryDirectoryHandle(this.rootMap, nextPath);
      this.directories.set(name, dir);
      this.rootMap.set(nextPath, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name) && !options?.create) {
      throw new Error(`Arquivo ausente: ${this.fullPath}/${name}`);
    }
    if (!this.files.has(name)) this.files.set(name, "");
    return new InMemoryFileHandle(this.files, name);
  }

  async removeEntry(name: string) {
    this.files.delete(name);
    this.directories.delete(name);
    this.rootMap.delete(`${this.fullPath}/${name}`);
  }

  async *entries(): AsyncGenerator<[string, { kind: "file"; getFile: () => Promise<{ text: () => Promise<string> }> }]> {
    for (const [name] of this.files.entries()) {
      const handle = new InMemoryFileHandle(this.files, name);
      yield [name, { kind: "file", getFile: () => handle.getFile() }];
    }
  }
}

function installStorageMock() {
  const allDirs = new Map<string, InMemoryDirectoryHandle>();
  const root = new InMemoryDirectoryHandle(allDirs, "root");
  allDirs.set("root", root);

  Object.defineProperty(globalThis.navigator, "storage", {
    configurable: true,
    value: {
      getDirectory: vi.fn(async () => root),
    },
  });
}

function serializeShard(shard: Shard): string {
  return JSON.stringify({
    index: shard.index,
    data: Array.from(shard.data),
    nonce: Array.from(shard.nonce),
    tag: Array.from(shard.tag),
    commitment: shard.commitment,
  });
}

function deserializeShard(payload: string): Shard {
  const parsed = JSON.parse(payload) as {
    index: number;
    data: number[];
    nonce: number[];
    tag: number[];
    commitment: string;
  };
  return {
    index: parsed.index,
    data: Uint8Array.from(parsed.data),
    nonce: Uint8Array.from(parsed.nonce),
    tag: Uint8Array.from(parsed.tag),
    commitment: parsed.commitment,
  };
}

describe("Integração leve GhostID -> C3 -> QEL -> HCNStore", () => {
  it("envia, persiste shards no HCN e reconstitui payload no receptor", { timeout: 20_000 }, async () => {
    installStorageMock();

    const senderIdentity = await spawnGhostId();
    const senderEngine = new C3Engine();
    const receiverEngine = new C3Engine();
    const hcnStore = new HCNStore();

    const message = `${senderIdentity.handle}: payload causal protegido`;
    const sendResult = senderEngine.send({
      payload: message,
      recipientMLKEMPubKey: receiverEngine.getPublicKey(),
    });

    for (const [index, shard] of sendResult.shards.entries()) {
      await hcnStore.storeShard({
        commitment: shard.commitment,
        payload: serializeShard(shard),
        channel: sendResult.routingInfo[index]?.channel ?? "HCN",
      });
    }

    const persisted = await hcnStore.getValidShards();
    expect(persisted).toHaveLength(3);

    const recoveredShards = persisted.map((entry) => deserializeShard(entry.payload)).slice(0, 2);
    const plaintext = receiverEngine.receive(
      recoveredShards,
      sendResult.sessionKey,
      sendResult.senderMLKEMPubKey,
      sendResult.senderMLDSAPubKey,
      sendResult.encapsulatedKey,
      sendResult.nonce,
      sendResult.tag,
      sendResult.signature,
    );

    expect(new TextDecoder().decode(plaintext)).toBe(message);
    expect(senderIdentity.handle.startsWith("ghost_") || senderIdentity.handle.startsWith("ghost")).toBe(true);

    destroyGhostId(senderIdentity);
    senderEngine.destroy();
    receiverEngine.destroy();
  });
});
