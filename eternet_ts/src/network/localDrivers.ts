/**
 * VØID Core — Local Communication Drivers (BLE, NFC, Serial-UWB)
 *
 * Implementação real dos drivers físicos usando APIs modernas do browser:
 * - Web Bluetooth API: Transmissão GATT Server (BLE) para vizinhança.
 * - Web NFC API: Troca física CLT (Contact Line Tokens) / OBALP via antenas de toque.
 * - Web Serial API: Interface direta com transceptores UWB/USB.
 *
 * Em caso de ausência de suporte no hardware/browser, oferece fallback elegante
 * mantendo a fidelidade das interfaces e chamadas de sistema.
 */

// ─── Web Bluetooth GATT Service Configuration ────────────────────────────────

export const VOID_BLE_SERVICE_UUID = "cafe0001-0000-1000-8000-00805f9b34fb";
export const VOID_BLE_SHARD_CHAR_UUID = "cafe0002-0000-1000-8000-00805f9b34fb";

// Declarando interfaces customizadas para evitar quebras do compilador TS em APIs Web experimentais
export interface WebBluetoothDevice {
  id: string;
  name?: string;
  gatt?: {
    connect: () => Promise<any>;
    connected: boolean;
    disconnect: () => void;
  };
}

export interface BLEPeer {
  id: string;
  name: string;
  rssi: number | null;
  device: WebBluetoothDevice;
}

export class BluetoothDriver {
  private activeServer: any = null;

  public isSupported(): boolean {
    return typeof navigator !== "undefined" && ("bluetooth" in navigator);
  }

  /**
   * Inicia o scan BLE por dispositivos rodando o serviço VØID.
   */
  public async scanForPeers(onPeerDiscovered: (peer: BLEPeer) => void): Promise<void> {
    if (!this.isSupported()) throw new Error("Web Bluetooth não é suportado neste browser/dispositivo.");

    try {
      console.log("[BLE Scanner] Iniciando busca por nós ETΞRNET...");
      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ services: [VOID_BLE_SERVICE_UUID] }],
        optionalServices: [VOID_BLE_SERVICE_UUID],
      });

      const peer: BLEPeer = {
        id: device.id,
        name: device.name || "Nó VØID",
        rssi: null,
        device,
      };

      onPeerDiscovered(peer);
      console.log(`[BLE Scanner] Nó descoberto: ${peer.name} (${peer.id})`);
    } catch (err) {
      if ((err as Error).name === 'NotFoundError') {
        console.log("[BLE Scanner] Nenhum dispositivo encontrado ou cancelado pelo usuário.");
      } else {
        console.warn("[BLE Scanner] Erro ao buscar dispositivos:", err);
      }
      throw err;
    }
  }

  /**
   * Transmite (Advertising/Peripheral) um Shard via BLE.
   *
   * Caminho 1 — Capacitor nativo (Android/iOS):
   *   Usa o plugin @capacitor-community/bluetooth-le em modo periférico.
   *   Requer: npx cap sync android + plugin instalado no MainActivity.
   *
   * Caminho 2 — Chrome Bluetooth GATT Server (experimental):
   *   Disponível apenas no Chrome Dev com flag #enable-experimental-web-platform-features.
   *
   * Caminho 3 — Stub (todos os outros ambientes):
   *   Regista no log e retorna. O NativeBridge delega ao Android Foreground Service.
   */
  public async startAdvertising(shardData: Uint8Array): Promise<void> {
    // Caminho 1: Capacitor nativo
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.()) {
      try {
        const { BleClient } = await import(
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore — plugin opcional: npm i @capacitor-community/bluetooth-le
          "@capacitor-community/bluetooth-le"
        );
        await BleClient.initialize({ androidNeverForLocation: true });
        // Modo periférico: anunciar serviço VOID com os dados do shard
        await (BleClient as any).startAdvertising?.({
          services: [VOID_BLE_SERVICE_UUID],
          localName: "VOID-NODE",
          manufacturerData: Array.from(shardData.slice(0, 26)), // max 26 bytes no payload BLE
        });
        console.log(`[BLE Adv] Capacitor: advertising iniciado (${shardData.length} bytes)`);
        return;
      } catch (err) {
        console.warn("[BLE Adv] Capacitor plugin indisponível — tentando Web API:", err);
      }
    }

    // Caminho 2: Chrome GATT Server experimental
    const bluetooth = (navigator as any).bluetooth;
    if (bluetooth && typeof bluetooth.requestLEScan === "function") {
      try {
        // Web Bluetooth GATT Server (flag experimental no Chrome Dev)
        const server = await bluetooth.requestGATTServer?.();
        if (server) {
          const service = await server.addService(VOID_BLE_SERVICE_UUID);
          const char = await service.addCharacteristic(VOID_BLE_SHARD_CHAR_UUID, {
            properties: ["read", "notify"],
            value: shardData,
          });
          await char.startNotifications();
          this.activeServer = server;
          console.log(`[BLE Adv] GATT Server experimental: OK (${shardData.length} bytes)`);
          return;
        }
      } catch (err) {
        console.warn("[BLE Adv] GATT Server experimental falhou:", err);
      }
    }

    // Caminho 3: Stub — NativeBridge assume o advertising via Foreground Service
    console.log(
      `[BLE Adv] Ambiente sem suporte nativo. ` +
      `Delegar ao NativeBridge (Android Foreground Service) ou instalar ` +
      `@capacitor-community/bluetooth-le. Shard size: ${shardData.length} bytes`,
    );
  }

  /**
   * Envia dados de Shard para um nó conectado.
   */
  public async sendShardToPeer(peer: BLEPeer, shardData: Uint8Array): Promise<void> {
    try {
      console.log(`[BLE Connection] Conectando ao par: ${peer.name}`);
      const server = await peer.device.gatt?.connect();
      if (!server) throw new Error("Falha ao abrir canal GATT com o peer.");
      this.activeServer = server;

      const service = await server.getPrimaryService(VOID_BLE_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(VOID_BLE_SHARD_CHAR_UUID);

      // Envia os dados em pedaços (chunking MTU padrão de 512 bytes)
      const mtu = 500;
      for (let offset = 0; offset < shardData.length; offset += mtu) {
        const chunk = shardData.slice(offset, offset + mtu);
        await characteristic.writeValue(chunk);
      }
      console.log(`[BLE Transmission] Shard enviado com sucesso: ${shardData.length} bytes.`);
    } catch (err) {
      console.error("[BLE Transmission] Erro ao transmitir para par:", err);
      throw err;
    } finally {
      if (this.activeServer) {
        this.activeServer.disconnect();
        this.activeServer = null;
      }
    }
  }
}

// ─── Web NFC API (OBALP / CLT Handler) ────────────────────────────────────────

export class NFCDriver {
  public isSupported(): boolean {
    return typeof window !== "undefined" && "NDEFReader" in window;
  }

  /**
   * Grava um Shard em uma tag NFC (ou transmissão P2P NFC de encosto).
   */
  public async writeShard(shardBytes: Uint8Array): Promise<void> {
    if (!this.isSupported()) throw new Error("Web NFC não é suportado neste dispositivo.");

    try {
      // @ts-ignore NDEFReader é experimental e pode não ter definição TS estrita
      const reader = new NDEFReader();
      await reader.write({
        records: [
          {
            recordType: "mime",
            mediaType: "application/octet-stream",
            data: shardBytes,
          },
        ],
      });
      console.log("[NFC Driver] Shard gravado via indução NFC.");
    } catch (err) {
      console.error("[NFC Driver] Falha ao gravar via NFC:", err);
      throw err;
    }
  }

  /**
   * Escuta tags NFC aproximadas para carregar Shards na mempool local.
   */
  public async startScanning(onShardRead: (shardBytes: Uint8Array) => void): Promise<void> {
    if (!this.isSupported()) throw new Error("Web NFC não suportado.");

    try {
      // @ts-ignore
      const reader = new NDEFReader();
      await reader.scan();
      console.log("[NFC Scanner] Receptor NFC ativado. Aguardando aproximação...");

      reader.onreading = (event: any) => {
        for (const record of event.message.records) {
          if (record.recordType === "mime" && record.mediaType === "application/octet-stream") {
            const bytes = new Uint8Array(record.data.buffer);
            onShardRead(bytes);
          }
        }
      };
    } catch (err) {
      console.error("[NFC Scanner] Falha ao iniciar escuta NFC:", err);
      throw err;
    }
  }
}

// ─── Web Serial API (UWB/Custom Radio Interface) ──────────────────────────────

export class SerialUWBDriver {
  private port: any = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  public isSupported(): boolean {
    return typeof navigator !== "undefined" && ("serial" in navigator);
  }

  /**
   * Conecta a um transceptor serial UWB (ex: Decawave DWM1000 via USB).
   */
  public async connectUWB(baudRate = 115200): Promise<void> {
    if (!this.isSupported()) throw new Error("Web Serial API não é suportada.");

    try {
      const ports = await (navigator as any).serial.getPorts();
      this.port = ports[0] || (await (navigator as any).serial.requestPort());
      await this.port.open({ baudRate });
      console.log("[Serial UWB] Conectado à porta serial do transceptor.");
    } catch (err) {
      console.error("[Serial UWB] Erro de conexão serial:", err);
      throw err;
    }
  }

  /**
   * Envia pacotes de rádio UWB.
   */
  public async sendUWBPayload(payload: Uint8Array): Promise<void> {
    if (!this.port || !this.port.writable) throw new Error("Porta serial UWB não está ativa.");

    try {
      const writer = this.port.writable.getWriter();
      // Framing: [START_BYTE (0x56), LENGTH (2 bytes), PAYLOAD, END_BYTE (0x0D)]
      const framed = new Uint8Array(4 + payload.length);
      framed[0] = 0x56; // 'V'
      framed[1] = (payload.length >> 8) & 0xff;
      framed[2] = payload.length & 0xff;
      framed.set(payload, 3);
      framed[framed.length - 1] = 0x0d; // '\r'

      await writer.write(framed);
      writer.releaseLock();
      console.log(`[Serial UWB] Frame enviado: ${framed.length} bytes.`);
    } catch (err) {
      console.error("[Serial UWB] Erro ao transmitir frame:", err);
      throw err;
    }
  }

  /**
   * Inicia escuta serial em segundo plano.
   */
  public async startListening(onDataReceived: (payload: Uint8Array) => void): Promise<void> {
    if (!this.port || !(this.port as any).readable) throw new Error("Porta serial UWB não legível.");

    try {
      this.reader = (this.port as any).readable.getReader();
      console.log("[Serial UWB] Escutando dados de rádio...");

      while (true) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        if (value) {
          // Processa o frame e envia o payload
          if (value[0] === 0x56 && value[value.length - 1] === 0x0d) {
            const length = (value[1] << 8) | value[2];
            const payload = value.slice(3, 3 + length);
            onDataReceived(payload);
          }
        }
      }
    } catch (err) {
      console.error("[Serial UWB] Erro de leitura serial:", err);
    } finally {
      if (this.reader) {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
  }

  public async disconnect(): Promise<void> {
    if (this.reader) {
      await this.reader.cancel();
      this.reader = null;
    }
    if (this.port) {
      await this.port.close();
      this.port = null;
    }
  }
}
