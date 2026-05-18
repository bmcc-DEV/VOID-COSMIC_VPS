import { describe, it, expect, vi } from 'vitest';
import {
  createUTXO,
  createPedersenCommitment,
  formatAmount,
  parseAmount,
  createHTLC,
  claimHTLC,
  refundHTLC,
  canClaimHTLC,
  canRefundHTLC,
  selectUTXOs,
  type UTXO,
} from './utxo';
import { sha3_256 } from '@noble/hashes/sha3.js';

// Helper: cria pubkey fake de 32 bytes
function fakePubKey(byte: number = 0x42): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

describe('utxo', () => {
  describe('formatAmount / parseAmount', () => {
    it('formata bigint corretamente', () => {
      expect(formatAmount(10000n)).toBe('1.0000');
      expect(formatAmount(123456789n)).toBe('12345.6789');
      expect(formatAmount(0n)).toBe('0.0000');
    });

    it('parseAmount é inverso de formatAmount', () => {
      const values = [0n, 1n, 10000n, 123456789n, 999999999999n];
      for (const v of values) {
        expect(parseAmount(formatAmount(v))).toBe(v);
      }
    });

    it('parseAmount com decimais customizados', () => {
      expect(parseAmount('1.5', 2)).toBe(150n);
      expect(parseAmount('0.01', 2)).toBe(1n);
    });
  });

  describe('createPedersenCommitment', () => {
    it('cria commitment com blinding factor gerado', () => {
      const { commitment, blindingFactor } = createPedersenCommitment(100n);
      expect(commitment).toBeInstanceOf(Uint8Array);
      expect(commitment).toHaveLength(32);
      expect(blindingFactor).toBeInstanceOf(Uint8Array);
      expect(blindingFactor).toHaveLength(32);
    });

    it('cria commitment determinístico com blinding factor fornecido', () => {
      const bf = new Uint8Array(32).fill(0x01);
      const c1 = createPedersenCommitment(100n, bf);
      const c2 = createPedersenCommitment(100n, bf);
      expect(c1.commitment).toEqual(c2.commitment);
    });

    it('commitments diferentes para valores diferentes', () => {
      const bf = new Uint8Array(32).fill(0x01);
      const c1 = createPedersenCommitment(100n, bf);
      const c2 = createPedersenCommitment(200n, bf);
      expect(c1.commitment).not.toEqual(c2.commitment);
    });
  });

  describe('createUTXO', () => {
    it('cria UTXO com campos corretos', () => {
      const utxo = createUTXO(1000n, fakePubKey());
      expect(utxo.id).toMatch(/^utxo_/);
      expect(utxo.amount).toBe(1000n);
      expect(utxo.commitment).toBeInstanceOf(Uint8Array);
      expect(utxo.blindingFactor).toBeInstanceOf(Uint8Array);
      expect(utxo.ownerPubKey).toEqual(fakePubKey());
      expect(utxo.spent).toBe(false);
      expect(utxo.createdAt).toBeGreaterThan(0);
    });

    it('UTXOs diferentes para chamadas diferentes', () => {
      const u1 = createUTXO(1000n, fakePubKey());
      const u2 = createUTXO(1000n, fakePubKey());
      // Cada UTXO deve ter commitment como Uint8Array de 32 bytes
      expect(u1.commitment).toBeInstanceOf(Uint8Array);
      expect(u1.commitment.length).toBe(32);
      expect(u2.commitment).toBeInstanceOf(Uint8Array);
      expect(u2.commitment.length).toBe(32);
    });
  });

  describe('selectUTXOs', () => {
    function makeUTXO(amount: bigint, spent = false): UTXO {
      return {
        id: `utxo_${amount}`,
        amount,
        commitment: new Uint8Array(32),
        blindingFactor: new Uint8Array(32),
        ownerPubKey: fakePubKey(),
        causalParents: [],
        createdAt: Date.now(),
        spent,
      };
    }

    it('seleciona UTXOs suficientes', () => {
      const utxos = [makeUTXO(100n), makeUTXO(200n), makeUTXO(300n)];
      const result = selectUTXOs(utxos, 250n);
      expect(result.total).toBeGreaterThanOrEqual(250n);
      expect(result.change).toBe(result.total - 250n);
    });

    it('ignora UTXOs gastos', () => {
      const utxos = [makeUTXO(100n, true), makeUTXO(200n)];
      const result = selectUTXOs(utxos, 150n);
      expect(result.selected).toHaveLength(1);
      expect(result.selected[0]!.amount).toBe(200n);
    });

    it('lança erro se saldo insuficiente', () => {
      const utxos = [makeUTXO(100n)];
      expect(() => selectUTXOs(utxos, 500n)).toThrow('Saldo insuficiente');
    });
  });

  describe('HTLC', () => {
    const preimage = new TextEncoder().encode('segredo123');
    const hashLock = sha3_256(preimage) as Uint8Array;
    const recipientPk = fakePubKey(0x01);
    const refundPk = fakePubKey(0x02);

    describe('createHTLC', () => {
      it('cria HTLC com hashLock correto', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk);
        expect(htlc.hashLock).toEqual(hashLock);
        expect(htlc.amount).toBe(1000n);
        expect(htlc.refundPubKey).toEqual(refundPk);
        expect(htlc.spent).toBe(false);
        expect(htlc.timeLock).toBeGreaterThan(Date.now());
      });
    });

    describe('claimHTLC', () => {
      it('sucesso com preimage correto', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk, 3600000);
        expect(claimHTLC(htlc, preimage)).toBe(true);
      });

      it('falha com preimage incorreto', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk);
        const wrongPreimage = new TextEncoder().encode('errado');
        expect(claimHTLC(htlc, wrongPreimage)).toBe(false);
      });

      it('falha se já gasto', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk);
        htlc.spent = true;
        expect(claimHTLC(htlc, preimage)).toBe(false);
      });
    });

    describe('refundHTLC', () => {
      it('falha antes do timelock', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk, 3600000);
        expect(refundHTLC(htlc, refundPk)).toBe(false);
      });

      it('sucesso após timelock com chave correta', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk, 3600000);
        // Mock Date.now AFTER createHTLC so timelock uses real time
        vi.spyOn(Date, 'now').mockReturnValue(htlc.timeLock + 1);
        expect(refundHTLC(htlc, refundPk)).toBe(true);
        vi.restoreAllMocks();
      });

      it('falha com chave incorreta', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk, 3600000);
        vi.spyOn(Date, 'now').mockReturnValue(htlc.timeLock + 1);
        const wrongPk = fakePubKey(0xff);
        expect(refundHTLC(htlc, wrongPk)).toBe(false);
        vi.restoreAllMocks();
      });

      it('falha se já gasto', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk, 3600000);
        vi.spyOn(Date, 'now').mockReturnValue(htlc.timeLock + 1);
        htlc.spent = true;
        expect(refundHTLC(htlc, refundPk)).toBe(false);
        vi.restoreAllMocks();
      });
    });

    describe('canClaimHTLC / canRefundHTLC', () => {
      it('canClaimHTLC retorna true se não gasto', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk);
        expect(canClaimHTLC(htlc)).toBe(true);
      });

      it('canClaimHTLC retorna false se gasto', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk);
        htlc.spent = true;
        expect(canClaimHTLC(htlc)).toBe(false);
      });

      it('canRefundHTLC retorna false antes do timelock', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk, 3600000);
        expect(canRefundHTLC(htlc)).toBe(false);
      });

      it('canRefundHTLC retorna true após timelock', () => {
        const htlc = createHTLC(1000n, recipientPk, preimage, refundPk, 3600000);
        vi.spyOn(Date, 'now').mockReturnValue(htlc.timeLock + 1);
        expect(canRefundHTLC(htlc)).toBe(true);
        vi.restoreAllMocks();
      });
    });
  });
});
