import { describe, expect, it } from 'vitest';
import { gfInv, gfMul } from './gf256';
import {
  fragmentMessage,
  generateRoutingInfo,
  reconstituteMessage,
  shamirReconstruct,
  shamirSplit,
} from './qel';

describe('qel', () => {
  it('multiplica e inverte elementos não nulos em GF(256)', () => {
    for (const value of [1, 2, 3, 17, 53, 128, 255]) {
      expect(gfMul(value, gfInv(value))).toBe(1);
    }
  });

  it('reconstrói segredo com quaisquer 2 de 3 shares', () => {
    const secret = new TextEncoder().encode('fragmentação causal');
    const shares = shamirSplit(secret, 2, 3);

    expect(Array.from(shamirReconstruct([shares[0]!, shares[1]!], [0, 1]))).toEqual(Array.from(secret));
    expect(Array.from(shamirReconstruct([shares[0]!, shares[2]!], [0, 2]))).toEqual(Array.from(secret));
    expect(Array.from(shamirReconstruct([shares[1]!, shares[2]!], [1, 2]))).toEqual(Array.from(secret));
  });

  it('fragmenta e reconstitui mensagem via AEAD + Shamir', () => {
    const result = fragmentMessage('valor trafega como informação');
    const restored = reconstituteMessage(result.shards.slice(0, 2), result.sessionKey);

    expect(restored).toBe('valor trafega como informação');
    expect(result.threshold).toBe(2);
    expect(result.total).toBe(3);
  });

  it('detecta adulteração de commitment de shard', () => {
    const result = fragmentMessage('mensagem protegida');
    const shards = result.shards.slice(0, 2);
    shards[0] = { ...shards[0]!, commitment: '0xdeadbeef' };

    expect(() => reconstituteMessage(shards, result.sessionKey)).toThrow('commit mismatch');
  });

  it('gera rotas disjuntas para os três shards padrão', () => {
    const routes = generateRoutingInfo(3);

    expect(routes).toHaveLength(3);
    expect(new Set(routes.map(route => route.channel)).size).toBe(3);
    expect(routes.map(route => route.shardIndex)).toEqual([0, 1, 2]);
  });
});
