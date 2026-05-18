import { afterEach, describe, expect, it } from 'vitest';
import { EcoNet } from './econet';
import {
  compressState,
  fossilizeState,
  recoverCompressedState,
  verifyCompressedState,
  type RangeProofLike,
} from './zkCompressor';

function makeProof(seed: number): RangeProofLike {
  return {
    proof: new Uint8Array(64).fill(seed),
    commitment: new Uint8Array(32).fill(seed + 1),
  };
}

describe('zkCompressor', () => {
  const econet = EcoNet.getInstance();

  afterEach(() => {
    econet.destroy();
  });

  it('retorna estado vazio válido sem proofs', () => {
    const state = compressState(['utxo_empty'], []);

    expect(state.proofCount).toBe(0);
    expect(state.merkleRoot).toEqual(new Uint8Array(32));
    expect(state.totalCommitment).toEqual(new Uint8Array(32));
    expect(state.utxoIds).toEqual(['utxo_empty']);
    expect(verifyCompressedState(state)).toBe(true);
  });

  it('agrega proofs em raiz Merkle e commitment total', () => {
    const proofs = [makeProof(0x10), makeProof(0x20)];
    const state = compressState(['utxo_a', 'utxo_b'], proofs);

    expect(state.proofCount).toBe(2);
    expect(state.merkleRoot).toHaveLength(32);
    expect(state.merkleRoot.every(b => b === 0)).toBe(false);
    expect(state.totalCommitment).toEqual(new Uint8Array(32).fill(0x11 ^ 0x21));
    expect(verifyCompressedState(state)).toBe(true);
  });

  it('rejeita estado estruturalmente inválido', () => {
    const invalid = compressState(['utxo_bad'], [makeProof(0x01)]);
    invalid.merkleRoot = new Uint8Array(32);

    expect(verifyCompressedState(invalid)).toBe(false);
  });

  it('fossiliza e recupera estado pela EcoNet', () => {
    const state = compressState(['utxo_a'], [makeProof(0x33)]);
    const entryId = fossilizeState(state, econet);
    const recovered = recoverCompressedState(entryId, econet);

    expect(entryId).toBe(state.econetEntryId);
    expect(recovered).not.toBeNull();
    expect(recovered?.proofCount).toBe(state.proofCount);
    expect(recovered?.utxoIds).toEqual(state.utxoIds);
    expect(recovered?.merkleRoot).toEqual(state.merkleRoot);
    expect(recovered?.totalCommitment).toEqual(state.totalCommitment);
  });
});
