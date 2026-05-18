import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Watchtower, createWatchtowerRegistration, type WatchtowerRegistration } from './watchtower';

describe('watchtower', () => {
  describe('Watchtower', () => {
    it('cria watchtower com config padrão', () => {
      const wt = new Watchtower();
      expect(wt.getRegistrationCount()).toBe(0);
    });

    it('registra canal', () => {
      const wt = new Watchtower();
      wt.register({
        id: 'wt_test_1',
        channelId: 'aabbccdd',
        clientPubkey: '11223344',
        encryptedState: new Uint8Array(32),
        justiceTx: new Uint8Array(64),
        commitmentTxid: 'deadbeef',
        fundingOutpoint: 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344:0',
        breachPenaltySat: 1000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
      });

      expect(wt.getRegistrationCount()).toBe(1);
    });

    it('rejeita quando cheio', () => {
      const wt = new Watchtower({ maxRegistrations: 2 });
      wt.register({ id: '1', channelId: 'a', clientPubkey: '', encryptedState: new Uint8Array(0), justiceTx: new Uint8Array(0), commitmentTxid: '', fundingOutpoint: 'aa:0', breachPenaltySat: 0, createdAt: 0, expiresAt: Date.now() + 86400000 });
      wt.register({ id: '2', channelId: 'b', clientPubkey: '', encryptedState: new Uint8Array(0), justiceTx: new Uint8Array(0), commitmentTxid: '', fundingOutpoint: 'bb:0', breachPenaltySat: 0, createdAt: 0, expiresAt: Date.now() + 86400000 });
      expect(() => wt.register({ id: '3', channelId: 'c', clientPubkey: '', encryptedState: new Uint8Array(0), justiceTx: new Uint8Array(0), commitmentTxid: '', fundingOutpoint: 'cc:0', breachPenaltySat: 0, createdAt: 0, expiresAt: Date.now() + 86400000 }))
        .toThrow('at capacity');
    });

    it('start e stop sem erro', () => {
      const wt = new Watchtower({ pollIntervalMs: 100 });
      wt.start();
      wt.stop();
    });

    it('notifica listener em caso de breach', async () => {
      const wt = new Watchtower();
      const alerts: any[] = [];
      wt.onBreach(alert => alerts.push(alert));

      const reg: WatchtowerRegistration = {
        id: 'wt_breach_test',
        channelId: 'aabbccdd',
        clientPubkey: '11223344',
        encryptedState: new Uint8Array(32),
        justiceTx: new Uint8Array(64),
        commitmentTxid: 'old_txid',
        fundingOutpoint: 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344:0',
        breachPenaltySat: 1000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
      };

      const alert = await wt.handleBreach(reg, 'new_txid');
      expect(alert.breachTxid).toBe('new_txid');
      expect(alert.channelId).toBe('aabbccdd');
      expect(alerts).toHaveLength(1);
    });
  });

  // ── Detecção de breach com mempool.space mockado ──────────────────────────

  describe('detecção de breach (mempool.space mockado)', () => {
    const FUNDING_TXID = 'a'.repeat(64);
    const EXPECTED_COMMITMENT = 'b'.repeat(64);
    const BREACH_TXID        = 'c'.repeat(64);

    function makeReg(overrides: Partial<WatchtowerRegistration> = {}): WatchtowerRegistration {
      return {
        id:              'wt_breach_1',
        channelId:       'chan_abc',
        clientPubkey:    '11223344',
        encryptedState:  new Uint8Array(32),
        justiceTx:       new Uint8Array(64),
        commitmentTxid:  EXPECTED_COMMITMENT,
        fundingOutpoint: `${FUNDING_TXID}:0`,
        breachPenaltySat: 5000,
        createdAt:       Date.now(),
        expiresAt:       Date.now() + 86_400_000,
        ...overrides,
      };
    }

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('detecta breach quando outpoint gasto com txid diferente', async () => {
      const wt = new Watchtower({ pollIntervalMs: 9999 });
      const alerts: any[] = [];
      wt.onBreach(a => alerts.push(a));
      wt.register(makeReg());

      // Mock 1: outspend retorna breach txid
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ spent: true, txid: BREACH_TXID }),
        })
        // Mock 2: broadcastJusticeTx (POST /api/tx)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => 'justice_' + BREACH_TXID,
        })
        // Mock 3: fetchTxHeight (GET /api/tx/:txid)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: { block_height: 850_000 } }),
        });

      // Dispara o ciclo de monitoramento internamente
      await (wt as any).checkForBreaches();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].breachTxid).toBe(BREACH_TXID);
      expect(alerts[0].channelId).toBe('chan_abc');
      expect(alerts[0].justiceBroadcast).toBe(true);
      expect(alerts[0].breachHeight).toBe(850_000);
    });

    it('não alerta quando outpoint gasto com txid correto (cooperativo)', async () => {
      const wt = new Watchtower({ pollIntervalMs: 9999 });
      const alerts: any[] = [];
      wt.onBreach(a => alerts.push(a));
      wt.register(makeReg());

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ spent: true, txid: EXPECTED_COMMITMENT }),
      });

      await (wt as any).checkForBreaches();
      expect(alerts).toHaveLength(0);
    });

    it('não alerta quando outpoint ainda não foi gasto', async () => {
      const wt = new Watchtower({ pollIntervalMs: 9999 });
      const alerts: any[] = [];
      wt.onBreach(a => alerts.push(a));
      wt.register(makeReg());

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ spent: false }),
      });

      await (wt as any).checkForBreaches();
      expect(alerts).toHaveLength(0);
    });

    it('expira registro vencido automaticamente no próximo ciclo', async () => {
      const wt = new Watchtower({ pollIntervalMs: 9999 });
      wt.register(makeReg({ expiresAt: Date.now() - 1000 })); // já expirado

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ spent: false }),
      });

      expect(wt.getRegistrationCount()).toBe(1);
      await (wt as any).checkForBreaches();
      expect(wt.getRegistrationCount()).toBe(0);
    });

    it('justice tx broadcast falha graciosamente (sem crash)', async () => {
      const wt = new Watchtower({ pollIntervalMs: 9999 });
      const alerts: any[] = [];
      wt.onBreach(a => alerts.push(a));
      wt.register(makeReg());

      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ spent: true, txid: BREACH_TXID }),
        })
        .mockResolvedValueOnce({ ok: false, text: async () => 'mempool full' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: { block_height: 850_001 } }),
        });

      await (wt as any).checkForBreaches();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].justiceBroadcast).toBe(false);
      expect(alerts[0].justiceTxid).toBeUndefined();
    });

    it('múltiplos canais: detecta breach só no correto', async () => {
      const wt = new Watchtower({ pollIntervalMs: 9999 });
      const alerts: any[] = [];
      wt.onBreach(a => alerts.push(a));

      wt.register(makeReg({ id: 'reg1', channelId: 'chan1', fundingOutpoint: 'aaa1:0' }));
      wt.register(makeReg({ id: 'reg2', channelId: 'chan2', fundingOutpoint: 'bbb2:0' }));

      (global.fetch as any)
        // reg1 — não gasto
        .mockResolvedValueOnce({ ok: true, json: async () => ({ spent: false }) })
        // reg2 — breach
        .mockResolvedValueOnce({ ok: true, json: async () => ({ spent: true, txid: BREACH_TXID }) })
        .mockResolvedValueOnce({ ok: true, text: async () => 'justice_ok' })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: { block_height: 850_002 } }) });

      await (wt as any).checkForBreaches();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].channelId).toBe('chan2');
    });
  });

  describe('createWatchtowerRegistration', () => {
    it('cria registro com state criptografado', () => {
      const reg = createWatchtowerRegistration(
        'aabbccdd',
        'deadbeef',
        'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344:0',
        '11223344',
        new Uint8Array(32).fill(0x42),
        new Uint8Array(64).fill(0x43),
        1000,
        'watchtower_pubkey',
      );

      expect(reg.channelId).toBe('aabbccdd');
      expect(reg.commitmentTxid).toBe('deadbeef');
      expect(reg.encryptedState.length).toBeGreaterThan(0);
      expect(reg.justiceTx).toHaveLength(64);
      expect(reg.breachPenaltySat).toBe(1000);
    });

    it('criptografa o state (diferente do original)', () => {
      const original = new Uint8Array(32).fill(0x42);
      const reg = createWatchtowerRegistration(
        'aabbccdd',
        'deadbeef',
        'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344:0',
        '11223344',
        original,
        new Uint8Array(64),
        1000,
        'watchtower_pubkey',
      );

      expect(reg.encryptedState).not.toEqual(original);
    });
  });
});
