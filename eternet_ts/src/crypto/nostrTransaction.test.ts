import { describe, it, expect, vi } from 'vitest';
import {
  createTransactionEvent,
  validateTransaction,
  processIncomingTransaction,
  ETRNET_TX_KIND,
  type ETRTransactionData,
  type NostrTransaction,
} from './nostrTransaction';

// Mock WASM-dependent modules
vi.mock('./utxo', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    verifyRangeProof: vi.fn().mockReturnValue(true),
    verifyBalanceProof: vi.fn().mockReturnValue(true),
  };
});

vi.mock('./pqc', () => ({
  mlDsaVerify: vi.fn().mockReturnValue(true),
}));

// Import NullifierStore via the singleton (it's not exported as a class, only the instance)
// We'll test through validateTransaction and processIncomingTransaction

function makeTxData(overrides: Partial<ETRTransactionData> = {}): ETRTransactionData {
  return {
    inputs: ['aa'.repeat(32)],
    outputs: ['bb'.repeat(32)],
    rangeProofs: ['cc'.repeat(64)],
    balanceProof: 'dd'.repeat(32),
    nullifiers: ['ee'.repeat(32)],
    signature: '',
    senderPubKey: '',
    version: 1,
    ...overrides,
  };
}

describe('nostrTransaction', () => {
  describe('createTransactionEvent', () => {
    it('cria evento com kind 31214', () => {
      const txData = makeTxData();
      const event = createTransactionEvent(txData);
      expect(event.kind).toBe(ETRNET_TX_KIND);
      expect(event.kind).toBe(31214);
    });

    it('inclui tags de nullifiers', () => {
      const txData = makeTxData({ nullifiers: ['aa'.repeat(32), 'bb'.repeat(32)] });
      const event = createTransactionEvent(txData);
      const nullifierTags = event.tags.filter(t => t[0] === 'nullifier');
      expect(nullifierTags).toHaveLength(2);
    });

    it('inclui tag eternet_tx', () => {
      const txData = makeTxData();
      const event = createTransactionEvent(txData);
      expect(event.tags).toContainEqual(['t', 'eternet_tx']);
    });

    it('content é JSON válido dos dados da transação', () => {
      const txData = makeTxData();
      const event = createTransactionEvent(txData);
      const parsed = JSON.parse(event.content);
      expect(parsed.version).toBe(1);
      expect(parsed.nullifiers).toEqual(txData.nullifiers);
    });

    it('inclui sender_pubkey na tag', () => {
      const txData = makeTxData({ senderPubKey: 'ff'.repeat(32) });
      const event = createTransactionEvent(txData);
      expect(event.tags).toContainEqual(['sender_pubkey', 'ff'.repeat(32)]);
    });
  });

  describe('NullifierStore (via validateTransaction)', () => {
    it('aceita transação com nullifier novo', () => {
      const txData = makeTxData({ nullifiers: ['11'.repeat(32)] });
      const event = createTransactionEvent(txData);
      // Usamos uma store fresca criando um novo módulo — como NullifierStore não é
      // exportado, testamos via processIncomingTransaction que usa o singleton.
      // Para isolation, testamos validateTransaction com uma store vazia.
      // Como NullifierStore é classe interna, vamos testar via comportamento.
      const result = validateTransaction(event, { has: () => false } as any);
      // Pode falhar na verificação criptográfica (WASM mock), mas não em nullifier
      // Se WASM falha, retorna valid:true (fallback)
      expect(result.valid).toBe(true);
    });

    it('rejeita transação com nullifier duplicado (double-spend)', () => {
      const nullifier = '11'.repeat(32);
      const txData = makeTxData({ nullifiers: [nullifier] });
      const event = createTransactionEvent(txData);

      // Mock store que já tem o nullifier
      const mockStore = { has: (n: string) => n === nullifier };
      const result = validateTransaction(event, mockStore as any);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Nullifier já visto');
    });
  });

  describe('validateTransaction', () => {
    it('rejeita versão desconhecida', () => {
      const txData = makeTxData({ version: 99 });
      const event = createTransactionEvent(txData);
      const result = validateTransaction(event, { has: () => false } as any);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Versão desconhecida');
    });

    it('rejeita sem inputs', () => {
      const txData = makeTxData({ inputs: [] });
      const event = createTransactionEvent(txData);
      const result = validateTransaction(event, { has: () => false } as any);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Sem inputs');
    });

    it('rejeita sem outputs', () => {
      const txData = makeTxData({ outputs: [] });
      const event = createTransactionEvent(txData);
      const result = validateTransaction(event, { has: () => false } as any);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Sem outputs');
    });

    it('rejeita range proofs com contagem errada', () => {
      const txData = makeTxData({
        outputs: ['aa'.repeat(32), 'bb'.repeat(32)],
        rangeProofs: ['cc'.repeat(64)], // só 1, mas 2 outputs
      });
      const event = createTransactionEvent(txData);
      const result = validateTransaction(event, { has: () => false } as any);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('range proofs');
    });

    it('aceita transação válida (com WASM mock)', () => {
      const txData = makeTxData();
      const event = createTransactionEvent(txData);
      const result = validateTransaction(event, { has: () => false } as any);
      expect(result.valid).toBe(true);
    });

    it('rejeita JSON inválido no content', () => {
      const event: NostrTransaction = {
        kind: ETRNET_TX_KIND,
        tags: [],
        content: 'not json',
        created_at: Math.floor(Date.now() / 1000),
      };
      const result = validateTransaction(event, { has: () => false } as any);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('inválidos');
    });
  });

  describe('processIncomingTransaction', () => {
    it('retorna txData para transação válida', () => {
      const txData = makeTxData({ nullifiers: ['aa'.repeat(32)] });
      const event = createTransactionEvent(txData);
      // Usar store que não tem o nullifier
      const mockStore = {
        has: () => false,
        add: () => true,
      };
      const result = processIncomingTransaction(event, mockStore as any, 'wss://test.relay');
      expect(result).not.toBeNull();
      expect(result!.version).toBe(1);
    });

    it('retorna null para transação inválida', () => {
      const txData = makeTxData({ version: 99 });
      const event = createTransactionEvent(txData);
      const mockStore = { has: () => false, add: () => true };
      const result = processIncomingTransaction(event, mockStore as any, 'wss://test.relay');
      expect(result).toBeNull();
    });

    it('senderPubKey vazio permanece vazio se ausente do content', () => {
      const txData = makeTxData({ senderPubKey: '' });
      const event = createTransactionEvent(txData);
      const mockStore = { has: () => false, add: () => true };
      const result = processIncomingTransaction(event, mockStore as any, 'wss://test.relay');
      expect(result).not.toBeNull();
      expect(result!.senderPubKey).toBe('');
    });
  });
});
