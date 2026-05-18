import { describe, it, expect } from 'vitest';
import { NWCClient, NWCClientError, parseNWCUri } from './nwcProtocol';

const WALLET_PK = 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344';
const SECRET_HEX = '1122334455667788112233445566778811223344556677881122334455667788';
const URI = `nostr+walletconnect://${WALLET_PK}?relay=wss://relay.example.com&secret=${SECRET_HEX}`;

class FakePool {
  public published: any[] = [];
  private onevent?: (event: any) => void;
  private onclose?: () => void;

  subscribeMany(_relays: string[], _filter: unknown, handlers: { onevent: (event: any) => void; onclose: () => void }): void {
    this.onevent = handlers.onevent;
    this.onclose = handlers.onclose;
  }

  publish(_relays: string[], event: unknown): void {
    this.published.push(event);
  }

  close(_relays: string[]): void {
    this.onclose?.();
  }

  emitResponse(event: any): void {
    this.onevent?.(event);
  }

  lastPublishedEventId(): string {
    const last = this.published[this.published.length - 1];
    return (last?.id as string | undefined) ?? '';
  }
}

describe('nwcProtocol', () => {
  describe('parseNWCUri', () => {
    it('parseia URI válida', () => {
      const uri = 'nostr+walletconnect://aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344?relay=wss://relay.example.com&secret=1122334455667788112233445566778811223344556677881122334455667788';
      const result = parseNWCUri(uri);

      expect(result.walletPubKey).toBe('aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344');
      expect(result.relay).toBe('wss://relay.example.com');
      expect(result.secret).toHaveLength(32);
    });

    it('rejeita URI sem relay', () => {
      const uri = 'nostr+walletconnect://aabbccdd?secret=1122';
      expect(() => parseNWCUri(uri)).toThrow('missing relay');
    });

    it('rejeita URI sem secret', () => {
      const uri = 'nostr+walletconnect://aabbccdd?relay=wss://relay.example.com';
      expect(() => parseNWCUri(uri)).toThrow('missing secret');
    });

    it('rejeita URI com formato inválido', () => {
      expect(() => parseNWCUri('https://example.com')).toThrow('Invalid NWC URI');
    });

    it('rejeita URI sem protocolo nostr+walletconnect', () => {
      expect(() => parseNWCUri('bitcoin:aabbccdd?relay=wss://r.com&secret=1122')).toThrow('Invalid NWC URI');
    });
  });

  describe('NWCClient harness', () => {
    it('retorna erro estruturado em timeout de request', async () => {
      const fakePool = new FakePool();
      const client = new NWCClient({
        poolFactory: () => fakePool,
        serializeRequestContent: (request) => JSON.stringify(request),
        parseResponseEvent: (event) => JSON.parse(event.content),
      });

      await client.connect(URI);
      await expect(client.sendRequest('get_balance', {}, 5)).rejects.toMatchObject({
        name: 'NWCClientError',
        code: 'TIMEOUT',
        method: 'get_balance',
      });
      client.disconnect();
    });

    it('mapeia erro NIP-47 para NWCClientError no pay_invoice', async () => {
      const fakePool = new FakePool();
      const client = new NWCClient({
        poolFactory: () => fakePool,
        serializeRequestContent: (request) => JSON.stringify(request),
        parseResponseEvent: (event) => JSON.parse(event.content),
      });

      await client.connect(URI);
      const promise = client.payInvoice('lnbc1fake');
      const eventId = fakePool.lastPublishedEventId();

      fakePool.emitResponse({
        content: JSON.stringify({
          result_type: 'pay_invoice',
          error: { code: 'PAYMENT_REJECTED', message: 'invoice expirada' },
        }),
        pubkey: WALLET_PK,
        tags: [['e', eventId]],
      });

      try {
        await promise;
        throw new Error('deveria falhar');
      } catch (error) {
        expect(error).toBeInstanceOf(NWCClientError);
        const err = error as NWCClientError;
        expect(err.code).toBe('PAYMENT_REJECTED');
        expect(err.method).toBe('pay_invoice');
      }
      client.disconnect();
    });

    it('processa caminho de sucesso com resposta mockada', async () => {
      const fakePool = new FakePool();
      const client = new NWCClient({
        poolFactory: () => fakePool,
        serializeRequestContent: (request) => JSON.stringify(request),
        parseResponseEvent: (event) => JSON.parse(event.content),
      });

      await client.connect(URI);
      const promise = client.getBalance();
      const eventId = fakePool.lastPublishedEventId();

      fakePool.emitResponse({
        content: JSON.stringify({
          result_type: 'get_balance',
          result: { balance: 123456 },
        }),
        pubkey: WALLET_PK,
        tags: [['e', eventId]],
      });

      await expect(promise).resolves.toEqual({ balance: 123456 });
      expect(eventId.length).toBeGreaterThan(0);
      client.disconnect();
    });

    it('rejeita pendências ao desconectar', async () => {
      const fakePool = new FakePool();
      const client = new NWCClient({
        poolFactory: () => fakePool,
        serializeRequestContent: (request) => JSON.stringify(request),
        parseResponseEvent: (event) => JSON.parse(event.content),
      });

      await client.connect(URI);
      const pending = client.sendRequest('get_info', {}, 5000);
      client.disconnect();

      await expect(pending).rejects.toMatchObject({
        name: 'NWCClientError',
        code: 'DISCONNECTED',
      });
    });
  });
});
