import { describe, it, expect } from 'vitest';
import {
  tokenizeSite,
  tokenizeSoftware,
  tokenizePhysicalObject,
  UTUManager,
} from './utuTokens';

describe('utuTokens', () => {
  describe('tokenizeSite', () => {
    it('tokeniza site com valuation anualizada', () => {
      const token = tokenizeSite('https://example.com', 1000);

      expect(token.id).toMatch(/^utu_site_/);
      expect(token.category).toBe('SITE_SAAS');
      expect(token.name).toBe('https://example.com');
      expect(token.valuation).toBe(12000); // 1000 * 12
      expect(token.proofHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('tokenizeSoftware', () => {
    it('tokeniza software com hash de repo', () => {
      const token = tokenizeSoftware('abc123def456', 500);

      expect(token.category).toBe('SOFTWARE');
      expect(token.name).toBe('abc123def456'.substring(0, 16));
      expect(token.valuation).toBe(5000); // 500 * 10
    });
  });

  describe('tokenizePhysicalObject', () => {
    it('tokeniza objeto com testemunhas', () => {
      const token = tokenizePhysicalObject('Sensor IoT', ['w1', 'w2', 'w3']);

      expect(token.category).toBe('PHYSICAL_OBJECT');
      expect(token.name).toBe('Sensor IoT');
      expect(token.valuation).toBe(300); // 3 witnesses * 100
    });

    it('falha com menos de 3 testemunhas', () => {
      expect(() => tokenizePhysicalObject('Obj', ['w1', 'w2']))
        .toThrow('pelo menos 3 testemunhas');
    });
  });

  describe('UTUManager', () => {
    it('cria manager e registra token', () => {
      const manager = UTUManager.getInstance();
      const token = tokenizeSite('https://test.com', 500);
      const registered = manager.createToken(token);

      expect(registered.id).toMatch(/^utu_site_/);
      expect(manager.getAllTokens().length).toBeGreaterThanOrEqual(1);
    });
  });
});
