import { describe, expect, it, vi } from 'vitest';
import { DistanceBridge, type DistanceBridgeDeps } from './distanceBridge';
import type { Shard } from '../crypto/qel';

function makeShard(): Shard {
  return {
    index: 0,
    data: new Uint8Array([1, 2, 3]),
    nonce: new Uint8Array(12).fill(0xaa),
    tag: new Uint8Array(16).fill(0xbb),
    commitment: '0x1234abcd',
  };
}

function makeDeps(overrides: Partial<DistanceBridgeDeps> = {}): DistanceBridgeDeps {
  return {
    ble: {
      isSupported: vi.fn(() => true),
      startAdvertising: vi.fn(async () => {}),
    },
    lora: {
      isSupported: vi.fn(() => true),
      sendData: vi.fn(async () => {}),
    },
    meshChannel: {
      postMessage: vi.fn(),
    },
    broadcastWebRTC: vi.fn(),
    meshSender: () => 'ghost_test',
    ...overrides,
  };
}

describe('distanceBridge', () => {
  it('usa canal preferido BLE quando disponível', async () => {
    const deps = makeDeps();
    const bridge = new DistanceBridge(deps);
    const result = await bridge.routeShard(makeShard(), 0);

    expect(result.channel).toBe('BLE');
    expect(result.preferred).toBe('BLE');
    expect(result.fallbackUsed).toBe(false);
    expect(result.attempted).toEqual(['BLE']);
    expect(deps.ble.startAdvertising).toHaveBeenCalledTimes(1);
  });

  it('faz fallback para LoRa quando BLE falha', async () => {
    const deps = makeDeps({
      ble: {
        isSupported: vi.fn(() => true),
        startAdvertising: vi.fn(async () => { throw new Error('BLE falhou'); }),
      },
    });
    const bridge = new DistanceBridge(deps);
    const result = await bridge.routeShard(makeShard(), 0);

    expect(result.channel).toBe('LoRa');
    expect(result.preferred).toBe('BLE');
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempted).toEqual(['BLE', 'LoRa']);
    expect(deps.lora.sendData).toHaveBeenCalledTimes(1);
  });

  it('faz fallback para HCN_MESH quando BLE e LoRa indisponíveis', async () => {
    const deps = makeDeps({
      ble: {
        isSupported: vi.fn(() => false),
        startAdvertising: vi.fn(async () => {}),
      },
      lora: {
        isSupported: vi.fn(() => false),
        sendData: vi.fn(async () => {}),
      },
    });
    const bridge = new DistanceBridge(deps);
    const result = await bridge.routeShard(makeShard(), 0);

    expect(result.channel).toBe('HCN_MESH');
    expect(result.preferred).toBe('BLE');
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempted).toEqual(['BLE', 'LoRa', 'HCN_MESH']);
    expect(deps.meshChannel.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SHARD_BROADCAST',
        sender: 'ghost_test',
      }),
    );
  });

  it('seleciona WEBRTC como canal preferido para índice 3', async () => {
    const deps = makeDeps();
    const bridge = new DistanceBridge(deps);
    const result = await bridge.routeShard(makeShard(), 3);

    expect(result.channel).toBe('WEBRTC');
    expect(result.preferred).toBe('WEBRTC');
    expect(result.fallbackUsed).toBe(false);
    expect(result.attempted).toEqual(['WEBRTC']);
    expect(deps.broadcastWebRTC).toHaveBeenCalledTimes(1);
  });

  it('acumula e reseta métricas de roteamento', async () => {
    const deps = makeDeps({
      ble: {
        isSupported: vi.fn(() => true),
        startAdvertising: vi.fn(async () => { throw new Error('BLE falhou'); }),
      },
    });
    const bridge = new DistanceBridge(deps);

    await bridge.routeShard(makeShard(), 0); // BLE falha, LoRa sucesso
    await bridge.routeShard(makeShard(), 3); // WEBRTC sucesso

    const metrics = bridge.getMetrics();
    expect(metrics.totalRouted).toBe(2);
    expect(metrics.totalFallbacks).toBe(1);
    expect(metrics.channels.BLE.attempts).toBe(1);
    expect(metrics.channels.BLE.failures).toBe(1);
    expect(metrics.channels.LoRa.successes).toBe(1);
    expect(metrics.channels.WEBRTC.successes).toBe(1);
    expect(metrics.recentRoutes).toHaveLength(2);
    expect(metrics.recentRoutes[0]?.fallbackUsed).toBe(true);
    expect(metrics.recentRoutes[1]?.selected).toBe('WEBRTC');
    expect(metrics.recentRoutes[0]?.durationMs).toBeGreaterThanOrEqual(0);

    bridge.resetMetrics();
    const reset = bridge.getMetrics();
    expect(reset.totalRouted).toBe(0);
    expect(reset.totalFallbacks).toBe(0);
    expect(reset.channels.BLE.attempts).toBe(0);
    expect(reset.recentRoutes).toHaveLength(0);
  });

  it('mantém apenas a janela mais recente de rotas', async () => {
    const deps = makeDeps();
    const bridge = new DistanceBridge(deps);
    for (let i = 0; i < 50; i++) {
      await bridge.routeShard(makeShard(), i);
    }

    const metrics = bridge.getMetrics();
    expect(metrics.totalRouted).toBe(50);
    expect(metrics.recentRoutes).toHaveLength(40);
  });
});

