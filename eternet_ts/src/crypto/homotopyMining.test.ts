import { describe, it, expect } from 'vitest';
import {
  sobolevMetric,
  homotopyWork,
  verifyHomotopyWork,
  HomotopyMiner,
  type HomotopyBlock,
} from './homotopyMining';

describe('homotopyMining', () => {
  describe('sobolevMetric', () => {
    it('calcula métrica de Sobolev para campo', () => {
      const field = [1, 2, 3, 4, 5];
      const metric = sobolevMetric(field);

      expect(metric.h1Norm).toBeGreaterThanOrEqual(0);
      expect(metric.h2Norm).toBeGreaterThanOrEqual(0);
      expect(metric.spectrumHash).toMatch(/^[0-9a-f]+$/);
    });

    it('campo vazio retorna zeros', () => {
      const metric = sobolevMetric([]);
      expect(metric.h1Norm).toBe(0);
      expect(metric.h2Norm).toBe(0);
    });
  });

  describe('homotopyWork', () => {
    it('gera hash SHA3-256 para campo e nonce', () => {
      const field = [1, 2, 3, 4, 5];
      const hash = homotopyWork(field, 42);

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('hash muda com nonce diferente', () => {
      const field = [1, 2, 3, 4, 5];
      const h1 = homotopyWork(field, 1);
      const h2 = homotopyWork(field, 2);

      expect(h1).not.toBe(h2);
    });
  });

  describe('verifyHomotopyWork', () => {
    it('verifica bloco com hash válido', () => {
      const block: HomotopyBlock = {
        index: 0,
        previousHash: '0'.repeat(64),
        sobolevHash: '00' + 'a'.repeat(62), // starts with 2 zeros
        nonce: 42,
        timestamp: Date.now(),
      };

      expect(verifyHomotopyWork(block, 2)).toBe(true);
    });

    it('rejeita bloco com dificuldade insuficiente', () => {
      const block: HomotopyBlock = {
        index: 0,
        previousHash: '0'.repeat(64),
        sobolevHash: 'a'.repeat(64), // no leading zeros
        nonce: 42,
        timestamp: Date.now(),
      };

      expect(verifyHomotopyWork(block, 2)).toBe(false);
    });

    it('rejeita hash com tamanho errado', () => {
      const block: HomotopyBlock = {
        index: 0,
        previousHash: '0'.repeat(64),
        sobolevHash: '00aabb',
        nonce: 42,
        timestamp: Date.now(),
      };

      expect(verifyHomotopyWork(block, 1)).toBe(false);
    });
  });

  describe('HomotopyMiner', () => {
    it('existe como classe', () => {
      expect(HomotopyMiner).toBeDefined();
    });
  });
});
