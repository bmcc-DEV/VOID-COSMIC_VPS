/**
 * ETΞRNET — Merkle Tree para UTXO Set
 *
 * Árvore Merkle calculada localmente a partir do conjunto de UTXOs.
 * A raiz é publicada periodicamente no contrato ETRNETAnchor (L2 testnet)
 * para fornecer finalidade contra reorganizações profundas.
 *
 * Usa SHA3-256 para hashing (consistente com o resto do projeto).
 */

import { sha3_256 } from "@noble/hashes/sha3.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface MerkleProof {
  leaf: Uint8Array;
  path: Uint8Array[];
  indices: number[]; // 0 = left, 1 = right
  root: Uint8Array;
}

// ─── Merkle Tree ─────────────────────────────────────────────────────────────

class MerkleTree {
  private leaves: Uint8Array[] = [];
  private layers: Uint8Array[][] = [];

  /** Adiciona uma folha (hash do commitment do UTXO) */
  addLeaf(data: Uint8Array): void {
    const hash = sha3_256(data) as Uint8Array;
    this.leaves.push(hash);
    this.rebuild();
  }

  /** Adiciona múltiplas folhas de uma vez */
  addLeaves(items: Uint8Array[]): void {
    for (const item of items) {
      this.leaves.push(sha3_256(item) as Uint8Array);
    }
    this.rebuild();
  }

  /** Remove todas as folhas */
  clear(): void {
    this.leaves = [];
    this.layers = [];
  }

  /** Retorna a raiz Merkle */
  getRoot(): Uint8Array | null {
    if (this.layers.length === 0 || this.layers[0].length === 0) return null;
    return this.layers[0][0];
  }

  /** Retorna a raiz como string hexadecimal */
  getRootHex(): string {
    const root = this.getRoot();
    if (!root) return "";
    return Array.from(root)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /** Gera prova de Merkle para uma folha no índice especificado */
  getProof(index: number): MerkleProof | null {
    if (index < 0 || index >= this.leaves.length) return null;
    if (this.layers.length === 0) return null;

    const path: Uint8Array[] = [];
    const indices: number[] = [];
    let idx = index;

    for (let layer = this.layers.length - 1; layer > 0; layer--) {
      const currentLayer = this.layers[layer];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      if (siblingIdx < currentLayer.length) {
        path.push(currentLayer[siblingIdx]);
        indices.push(isRight ? 1 : 0);
      } else {
        // Folha ímpar — irmão é ela mesma
        path.push(currentLayer[idx]);
        indices.push(isRight ? 1 : 0);
      }

      idx = Math.floor(idx / 2);
    }

    return {
      leaf: this.leaves[index],
      path,
      indices,
      root: this.layers[0][0],
    };
  }

  /** Verifica uma prova de Merkle */
  static verifyProof(proof: MerkleProof): boolean {
    let current = proof.leaf;

    for (let i = 0; i < proof.path.length; i++) {
      const sibling = proof.path[i];
      const isRight = proof.indices[i] === 1;

      const combined = new Uint8Array(64);
      if (isRight) {
        combined.set(sibling, 0);
        combined.set(current, 32);
      } else {
        combined.set(current, 0);
        combined.set(sibling, 32);
      }

      current = sha3_256(combined) as Uint8Array;
    }

    return current.every((b, i) => b === proof.root[i]);
  }

  /** Número de folhas na árvore */
  size(): number {
    return this.leaves.length;
  }

  /** Reconstrói a árvore a partir das folhas */
  private rebuild(): void {
    if (this.leaves.length === 0) {
      this.layers = [];
      return;
    }

    // Camada de folhas
    let currentLayer = [...this.leaves];
    this.layers = [currentLayer];

    while (currentLayer.length > 1) {
      const nextLayer: Uint8Array[] = [];

      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right =
          i + 1 < currentLayer.length ? currentLayer[i + 1] : currentLayer[i];

        const combined = new Uint8Array(64);
        combined.set(left, 0);
        combined.set(right, 32);

        nextLayer.push(sha3_256(combined) as Uint8Array);
      }

      currentLayer = nextLayer;
      this.layers.unshift(currentLayer);
    }
  }
}

// ─── Instância Singleton ─────────────────────────────────────────────────────

export const utxoMerkleTree = new MerkleTree();

// ─── Utilidades ──────────────────────────────────────────────────────────────

/**
 * Constrói uma Merkle Tree a partir de um conjunto de UTXOs.
 * Cada folha é SHA3-256(utxo.commitment).
 */
export function buildUTXOMerkleTree(
  utxos: { commitment: Uint8Array }[],
): MerkleTree {
  const tree = new MerkleTree();
  tree.addLeaves(utxos.map((u) => u.commitment));
  return tree;
}

/**
 * Gera um bytes32 root compatível com o contrato Solidity.
 * Retorna a raiz como string hex com prefixo 0x.
 */
export function getContractRoot(tree: MerkleTree): string {
  const hex = tree.getRootHex();
  return hex ? `0x${hex}` : `0x${"0".repeat(64)}`;
}
