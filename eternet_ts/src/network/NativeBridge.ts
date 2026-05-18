/**
 * VØID — Native Hardware Bridge
 *
 * Conecta TypeScript/WASM com o OS nativo via Capacitor.
 * Suporta dois modos:
 *
 * Modo A — Capacitor (Android/iOS):
 *   Detectado via `window.Capacitor.isNativePlatform()`.
 *   Usa `@capacitor/core` para comunicação com plugins nativos.
 *   Plugin necessário no Android: VoidAnimusPlugin (Foreground Service + BLE adv).
 *
 * Modo B — Stub (browser puro):
 *   Loga aviso, não quebra. Advertising fica a cargo do BluetoothDriver.
 *
 * Para criar o plugin Android:
 *   npx @capacitor/cli plugin:generate
 *   Implementar VoidAnimusPlugin.kt com startAnimusService() e updateBleAdvertisingData()
 */

import { type HCNShard } from "../storage/hcnStore";
import { voidOrchestrator } from "../core/VoidOrchestrator";

// Detecta Capacitor sem import estático (opcional — só instalado com o build nativo)
function getCapacitor() {
  return (window as any).Capacitor ?? null;
}

function getCapacitorPlugins() {
  const cap = getCapacitor();
  return cap?.Plugins ?? null;
}

export class NativeBridge {
  private static instance: NativeBridge;

  public static getInstance(): NativeBridge {
    if (!NativeBridge.instance) {
      NativeBridge.instance = new NativeBridge();
    }
    return NativeBridge.instance;
  }

  private constructor() {
    this.listenToNativeEvents();
  }

  /**
   * Verdadeiro quando rodando dentro do Capacitor (Android/iOS).
   */
  public isNative(): boolean {
    return getCapacitor()?.isNativePlatform?.() === true;
  }

  /** @deprecated Use isNative() */
  public isAvailable(): boolean {
    return this.isNative();
  }

  /**
   * Ativa o Foreground Service Android que mantém BLE vivo com tela apagada.
   * Requer plugin VoidAnimusPlugin registrado no MainActivity.kt.
   */
  public async activateCarrierService(): Promise<void> {
    if (!this.isNative()) {
      console.warn("[NativeBridge] Não é ambiente Capacitor — Foreground Service indisponível.");
      return;
    }

    const plugins = getCapacitorPlugins();
    try {
      if (plugins?.VoidAnimus) {
        await plugins.VoidAnimus.startAnimusService();
        console.log("[NativeBridge] Foreground Service ativado via Capacitor.");
      } else {
        console.warn("[NativeBridge] Plugin VoidAnimus não registrado. Instalar e sync.");
      }
    } catch (err) {
      console.error("[NativeBridge] Falha ao ativar Foreground Service:", err);
    }
  }

  /**
   * Passa shards para o Android Foreground Service anunciar via BLE
   * mesmo com a WebView suspensa (tela apagada).
   */
  public async pushShardsToNativeCache(shards: HCNShard[]): Promise<void> {
    if (!this.isNative()) return;

    const plugins = getCapacitorPlugins();
    if (!plugins?.VoidAnimus) return;

    try {
      const payload = JSON.stringify(
        shards.map(s => ({ id: s.commitment, data: s.payload })),
      );
      await plugins.VoidAnimus.updateBleAdvertisingData({ payload });
    } catch (err) {
      console.error("[NativeBridge] Falha ao injetar shards:", err);
    }
  }

  /**
   * Escuta eventos do plugin nativo (peer BLE descoberto, shard recebido).
   */
  private listenToNativeEvents(): void {
    window.addEventListener("NATIVE_BLE_PEER", (e: Event) => {
      const { address, rssi } = (e as CustomEvent).detail ?? {};
      console.log(`[NativeBridge] Peer BLE descoberto: ${address} (${rssi}dBm)`);
      voidOrchestrator.handleIncomingShard({}, `NATIVE_BLE:${address}`);
    });

    window.addEventListener("NATIVE_SHARD_RECEIVED", (e: Event) => {
      const { shard } = (e as CustomEvent).detail ?? {};
      console.log("[NativeBridge] Shard recebido em background.");
      voidOrchestrator.handleIncomingShard(shard, "NATIVE_BACKGROUND");
    });

    // Capacitor plugin events (alternativa aos DOM events acima)
    const plugins = getCapacitorPlugins();
    plugins?.VoidAnimus?.addListener?.("blePeerDiscovered", (data: { address: string; rssi: number }) => {
      voidOrchestrator.handleIncomingShard({}, `NATIVE_BLE:${data.address}`);
    });
  }
}

export const nativeBridge = NativeBridge.getInstance();
