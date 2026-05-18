import { afterEach, describe, expect, it } from 'vitest';
import { EcoNet } from './econet';
import { C3Engine, uint8ArrayToBase64 } from './c3Engine';
import type { RangeProofLike } from './zkCompressor';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function makeProof(seed: number): RangeProofLike {
  return {
    proof: new Uint8Array(64).fill(seed),
    commitment: new Uint8Array(32).fill(seed + 1),
  };
}

describe('C3Engine', () => {
  const econet = EcoNet.getInstance();

  afterEach(() => {
    econet.destroy();
  });

  it('inicializa submódulos principais com health check positivo', () => {
    const engine = new C3Engine();
    const health = engine.healthCheck();

    expect(health.pqcReady).toBe(true);
    expect(health.shamirReady).toBe(true);
    expect(health.zkReady).toBe(true);
    expect(health.ghostIdReady).toBe(true);

    engine.destroy();
  });

  it('envia e recebe payload string via PQC + QEL + assinatura ML-DSA', () => {
    const engine = new C3Engine();
    const result = engine.send({
      payload: 'valor e informação são indistinguíveis',
      recipientMLKEMPubKey: engine.getPublicKey(),
    });

    const plaintext = engine.receive(
      result.shards.slice(0, 2),
      result.sessionKey,
      result.senderMLKEMPubKey,
      result.senderMLDSAPubKey,
      result.encapsulatedKey,
      result.nonce,
      result.tag,
      result.signature,
    );

    expect(decode(plaintext)).toBe('valor e informação são indistinguíveis');
    expect(result.senderMLKEMPubKey).toHaveLength(1568);
    expect(result.senderMLDSAPubKey).toHaveLength(2592);
    expect(result.signature).toHaveLength(4627);

    engine.destroy();
  });

  it('rejeita assinatura adulterada no recebimento', () => {
    const engine = new C3Engine();
    const result = engine.send({
      payload: new TextEncoder().encode('payload protegido'),
      recipientMLKEMPubKey: engine.getPublicKey(),
    });
    const tamperedSignature = new Uint8Array(result.signature);
    tamperedSignature[0] ^= 0xff;

    expect(() => engine.receive(
      result.shards.slice(0, 2),
      result.sessionKey,
      result.senderMLKEMPubKey,
      result.senderMLDSAPubKey,
      result.encapsulatedKey,
      result.nonce,
      result.tag,
      tamperedSignature,
    )).toThrow('Assinatura ML-DSA-87 inválida');

    engine.destroy();
  });

  it('comprime e fossiliza proofs ZK quando fornecidas', () => {
    const engine = new C3Engine();
    const result = engine.send({
      payload: 'estado com proofs',
      recipientMLKEMPubKey: engine.getPublicKey(),
      rangeProofs: [makeProof(0x10), makeProof(0x20)],
      utxoIds: ['utxo_a', 'utxo_b'],
    });

    expect(result.compressedState).toBeDefined();
    expect(result.compressedState?.proofCount).toBe(2);
    expect(result.compressedState?.utxoIds).toEqual(['utxo_a', 'utxo_b']);
    expect(result.compressedState?.econetEntryId).toBeDefined();
    expect(econet.getStats().totalEntries).toBeGreaterThanOrEqual(1);

    engine.destroy();
  });

  it('converte bytes grandes para base64 sem spread global', () => {
    const bytes = new Uint8Array(20_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

    const b64 = uint8ArrayToBase64(bytes);
    const restored = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    expect(restored).toEqual(bytes);
  });
});
