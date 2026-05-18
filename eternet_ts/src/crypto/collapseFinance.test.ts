import { describe, it, expect } from 'vitest';
import {
  ccbCoupon,
  hsvDeposit,
  hsvWithdraw,
  coherenceCoupon,
  cohDiversificationRatio,
  CollapseFinanceManager,
  type CollateralizedCollapseBond,
  type HysteresisVault,
  type CoherenceBond,
} from './collapseFinance';

describe('collapseFinance', () => {
  describe('ccbCoupon', () => {
    it('calcula cupom com estresse zero e KL zero', () => {
      const bond: CollateralizedCollapseBond = {
        id: 'ccb_1',
        baseRate: 0.05,
        stressIndex: 0,
        klDivergence: 0,
        principal: 1000,
        maturityDate: Date.now() + 86400000,
        createdAt: Date.now(),
      };
      // cupom = 0.05 * (1+0) * exp(0) = 0.05
      expect(ccbCoupon(bond)).toBe(0.05);
    });

    it('aumenta cupom com estresse', () => {
      const bond: CollateralizedCollapseBond = {
        id: 'ccb_2',
        baseRate: 0.05,
        stressIndex: 0.5,
        klDivergence: 0,
        principal: 1000,
        maturityDate: Date.now() + 86400000,
        createdAt: Date.now(),
      };
      // cupom = 0.05 * 1.5 * 1 = 0.075
      expect(ccbCoupon(bond)).toBe(0.075);
    });

    it('diminui cupom com alta divergência KL', () => {
      const bond: CollateralizedCollapseBond = {
        id: 'ccb_3',
        baseRate: 0.05,
        stressIndex: 0,
        klDivergence: 1,
        principal: 1000,
        maturityDate: Date.now() + 86400000,
        createdAt: Date.now(),
      };
      // cupom = 0.05 * 1 * exp(-1) ≈ 0.0184
      const coupon = ccbCoupon(bond);
      expect(coupon).toBeGreaterThan(0.018);
      expect(coupon).toBeLessThan(0.019);
    });
  });

  describe('hsvDeposit / hsvWithdraw', () => {
    const makeVault = (): HysteresisVault => ({
      id: 'hsv_1',
      balance: 1000,
      hysteresisState: 0,
      lastActionTime: 1000,
      beta: 0.1,
      createdAt: 1000,
    });

    it('deposita e atualiza estado de histerese', () => {
      const vault = makeVault();
      const updated = hsvDeposit(vault, 500, 2000);

      expect(updated.balance).toBe(1500);
      expect(updated.lastActionTime).toBe(2000);
      expect(updated.hysteresisState).toBeGreaterThan(0);
    });

    it('saque aplica penalidade de histerese', () => {
      let vault = makeVault();
      vault = hsvDeposit(vault, 500, 2000);

      const result = hsvWithdraw(vault, 3000);
      expect(result.penalty).toBeGreaterThanOrEqual(0);
      expect(result.amount).toBeLessThanOrEqual(vault.balance + result.penalty);
    });
  });

  describe('coherenceCoupon', () => {
    it('yield é proporcional ao quadrado da coerência', () => {
      const bondLow: CoherenceBond = {
        id: 'cb_1',
        baseRate: 0.05,
        coherenceMeasure: 0.2,
        principal: 1000,
        maturityDate: Date.now() + 86400000,
      };
      const bondHigh: CoherenceBond = {
        id: 'cb_2',
        baseRate: 0.05,
        coherenceMeasure: 0.9,
        principal: 1000,
        maturityDate: Date.now() + 86400000,
      };

      const yieldLow = coherenceCoupon(bondLow);
      const yieldHigh = coherenceCoupon(bondHigh);

      // 0.05 * 0.04 = 0.002 vs 0.05 * 0.81 = 0.0405
      expect(yieldHigh).toBeGreaterThan(yieldLow);
      expect(yieldLow).toBeCloseTo(0.002, 4);
      expect(yieldHigh).toBeCloseTo(0.0405, 3);
    });
  });

  describe('cohDiversificationRatio', () => {
    it('retorna 0 para lista vazia', () => {
      expect(cohDiversificationRatio([])).toBe(0);
    });

    it('retorna 1 quando todos têm H¹ != 0', () => {
      expect(cohDiversificationRatio([0.5, 0.8, 0.3])).toBe(1);
    });

    it('retorna 0 quando todos têm H¹ ≈ 0', () => {
      expect(cohDiversificationRatio([0, 0, 0])).toBe(0);
    });

    it('retorna fração correta', () => {
      expect(cohDiversificationRatio([0.5, 0, 0.3, 0])).toBe(0.5);
    });
  });

  describe('CollapseFinanceManager', () => {
    it('cria CCB via manager', () => {
      const manager = CollapseFinanceManager.getInstance();
      const bond = manager.createCCB(0.05, 0.3, 1000, 86400000);

      expect(bond.baseRate).toBe(0.05);
      expect(bond.stressIndex).toBe(0.3);
      expect(bond.principal).toBe(1000);
      expect(bond.id).toMatch(/^ccb_/);
    });

    it('cria HSV via manager', () => {
      const manager = CollapseFinanceManager.getInstance();
      const vault = manager.createHSV(1000, 0.1);

      expect(vault.beta).toBe(0.1);
      expect(vault.balance).toBe(1000);
      expect(vault.id).toMatch(/^hsv_/);
    });

    it('cria Coherence Bond via manager', () => {
      const manager = CollapseFinanceManager.getInstance();
      const bond = manager.createCoherenceBond(0.05, 0.8, 1000, 86400000);

      expect(bond.baseRate).toBe(0.05);
      expect(bond.coherenceMeasure).toBe(0.8);
      expect(bond.id).toMatch(/^coh_/);
    });

    it('cria Scar Token via manager', () => {
      const manager = CollapseFinanceManager.getInstance();
      const token = manager.createScarToken([0.1, 0.5, 0.9], 100);

      expect(token.defectField).toEqual([0.1, 0.5, 0.9]);
      expect(token.value).toBe(100);
      expect(token.id).toMatch(/^scar_/);
    });

    it('cria Coherence Swap via manager', () => {
      const manager = CollapseFinanceManager.getInstance();
      const swap = manager.createCoherenceSwap(0.9, 0.3);

      expect(swap.partyACoherence).toBe(0.9);
      expect(swap.partyBCoherence).toBe(0.3);
      expect(swap.flowAToB).toBeCloseTo(0.6, 4);
      expect(swap.id).toMatch(/^cswap_/);
    });
  });
});
