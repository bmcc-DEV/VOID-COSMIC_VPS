import { describe, it, expect } from 'vitest';
import {
  createStock,
  superpositionValue,
  collapseMeasurement,
  QRMarket,
} from './qrStocks';

describe('qrStocks', () => {
  describe('createStock', () => {
    it('cria ação em superposição', () => {
      const stock = createStock('ETBTC', 50000);

      expect(stock.symbol).toBe('ETBTC');
      expect(stock.priceAmplitudes.size).toBe(5);
      expect(stock.volumeAmplitudes.size).toBe(5);
    });

    it('amplitudes são uniformes', () => {
      const stock = createStock('ETBTC', 50000);
      const amps = Array.from(stock.priceAmplitudes.values());
      const first = amps[0];
      for (const a of amps) {
        expect(a).toBeCloseTo(first, 10);
      }
    });
  });

  describe('superpositionValue', () => {
    it('calcula valor esperado', () => {
      const stock = createStock('ETBTC', 50000);
      const value = superpositionValue(stock);

      expect(value).toBeGreaterThan(0);
    });
  });

  describe('collapseMeasurement', () => {
    it('colapsa superposição em valores definidos', () => {
      const stock = createStock('ETBTC', 50000);
      const result = collapseMeasurement(stock);

      expect(result.collapsedPrice).toBeGreaterThan(0);
      expect(result.collapsedVolume).toBeGreaterThan(0);
      expect(result.probability).toBeGreaterThan(0);
      expect(result.probability).toBeLessThanOrEqual(1);
    });
  });

  describe('QRMarket (singleton)', () => {
    it('lista ação no mercado', () => {
      const market = QRMarket.getInstance();
      const stock = market.listStock('ETTEST', 1000);

      expect(stock.symbol).toBe('ETTEST');
      expect(stock.priceAmplitudes.size).toBe(5);
    });

    it('rejeita ação duplicada', () => {
      const market = QRMarket.getInstance();
      // ETTEST já listada no teste anterior
      expect(() => market.listStock('ETTEST', 1000)).toThrow('já listada');
    });

    it('submete ordem causal', () => {
      const market = QRMarket.getInstance();
      const order = market.submitOrder('ETTEST', 'BUY', 950, 100);

      expect(order.side).toBe('BUY');
      expect(order.price).toBe(950);
      expect(order.volume).toBe(100);
      expect(order.amplitude).toBeGreaterThan(0);
      expect(order.amplitude).toBeLessThanOrEqual(1);
    });

    it('ordem perto do valor esperado tem maior amplitude', () => {
      const market = QRMarket.getInstance();
      const sym = `ETAMP${Date.now()}`;
      market.listStock(sym, 1000);

      // valor esperado ≈ 1000 (média das amplitudes)
      const orderClose = market.submitOrder(sym, 'BUY', 1000, 100);
      const orderFar = market.submitOrder(sym, 'BUY', 5000, 100);

      expect(orderClose.amplitude).toBeGreaterThan(orderFar.amplitude);
    });
  });
});
