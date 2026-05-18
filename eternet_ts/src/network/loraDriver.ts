/**
 * VØID Core — LoRa (868/915 MHz) Transceiver Driver
 *
 * Implementação real da ponte serial com transceptores LoRa baseados em comandos AT
 * (ex: chips Reyax RYLR896/RYLR998 ou módulos Ebyte/Meshtastic).
 *
 * Permite que o browser converse diretamente com o rádio conectado via USB
 * usando a Web Serial API.
 */

// Web Serial API types (não incluídas nos types padrão do TS)
interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

export interface LoRaConfig {
  baudRate: number;
  address: number;   // endereço do rádio local (0-65535)
  networkId: number; // ID da rede (0-16)
  frequency: number; // 868Mhz ou 915Mhz
  spreadingFactor: number; // SF7-SF12
  bandwidth: number; // 0-9 (125kHz, 250kHz, 500kHz)
}

export class LoRaDriver {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private onMessageReceivedCallback: ((senderAddr: number, payload: string) => void) | null = null;

  public isSupported(): boolean {
    return "serial" in navigator;
  }

  /**
   * Solicita acesso à porta USB/Serial e abre conexão com o transceptor LoRa.
   */
  public async connect(config: LoRaConfig): Promise<void> {
    if (!this.isSupported()) throw new Error("Web Serial API não suportada.");

    try {
      this.port = await (navigator as any).serial.requestPort();
      await this.port!.open({ baudRate: config.baudRate });
      console.log("[LoRa Driver] Conectado ao hardware LoRa via Serial.");

      // Inicializa configurações AT
      await this.sendATCommand(`AT+ADDRESS=${config.address}`);
      await this.sendATCommand(`AT+BAND=${config.frequency}`);
      await this.sendATCommand(`AT+NETWORKID=${config.networkId}`);
      await this.sendATCommand(`AT+PARAMETER=${config.spreadingFactor},${config.bandwidth},4,5`);

      // Inicia leitura assíncrona
      this.startListeningLoop();
    } catch (err) {
      console.error("[LoRa Driver] Falha ao configurar rádio:", err);
      throw err;
    }
  }

  /**
   * Envia comando AT e lê a resposta do rádio com timeout.
   * O rádio Reyax responde em até ~300ms após receber o comando.
   */
  public async sendATCommand(cmd: string, timeoutMs = 500): Promise<string> {
    if (!this.port || !this.port.writable || !this.port.readable) {
      throw new Error("Porta serial LoRa inativa.");
    }

    const encoder = new TextEncoder();
    const fullCmd = `${cmd}\r\n`;

    // Escrever comando
    const writer = this.port.writable.getWriter();
    await writer.write(encoder.encode(fullCmd));
    writer.releaseLock();
    console.log(`[LoRa TX] Comando AT enviado: ${cmd}`);

    // Ler resposta com timeout
    const reader = this.port.readable.getReader();
    const decoder = new TextDecoder();
    let response = "";
    const deadline = Date.now() + timeoutMs;

    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const timeoutPromise = new Promise<{ value: undefined; done: true }>(
          (_, reject) => setTimeout(() => reject(new Error("timeout")), remaining),
        );
        const { value, done } = await Promise.race([
          reader.read() as Promise<{ value: Uint8Array; done: false }>,
          timeoutPromise,
        ]);
        if (done) break;
        response += decoder.decode(value, { stream: true });
        // Resposta AT termina com \r\n — linha completa recebida
        if (response.includes("\n")) break;
      }
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message === "timeout")) throw err;
    } finally {
      reader.releaseLock();
    }

    const trimmed = response.trim();
    if (!trimmed) {
      console.warn(`[LoRa AT] Sem resposta para "${cmd}" em ${timeoutMs}ms`);
      return "TIMEOUT";
    }

    if (trimmed.startsWith("ERR")) {
      throw new Error(`[LoRa AT] Erro do rádio: ${trimmed}`);
    }

    console.log(`[LoRa AT] Resposta: ${trimmed}`);
    return trimmed;
  }

  /**
   * Transmite uma mensagem/shard via rádio LoRa para um endereço específico.
   * @param destAddress Endereço destino (0 = broadcast)
   * @param payload Dados em Base64 ou Texto puro
   */
  public async sendData(destAddress: number, payload: string): Promise<void> {
    // Comando padrão Reyax: AT+SEND=<dest>,<length>,<payload>
    const len = payload.length;
    await this.sendATCommand(`AT+SEND=${destAddress},${len},${payload}`);
    console.log(`[LoRa TX] Payload enviado para [${destAddress}]: ${payload.slice(0, 20)}...`);
  }

  /**
   * Callback de recepção de novas mensagens de rádio.
   */
  public onMessageReceived(cb: (senderAddr: number, payload: string) => void): void {
    this.onMessageReceivedCallback = cb;
  }

  /**
   * Loop assíncrono que lê a linha serial e analisa eventos recebidos do rádio.
   */
  private async startListeningLoop(): Promise<void> {
    if (!this.port || !this.port.readable) return;

    this.reader = this.port.readable.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        if (value) {
          buffer += decoder.decode(value);
          // Analisa linhas terminadas em \r\n
          let lineEndIdx;
          while ((lineEndIdx = buffer.indexOf("\r\n")) >= 0) {
            const line = buffer.slice(0, lineEndIdx).trim();
            buffer = buffer.slice(lineEndIdx + 2);
            this.parseLoRaIncomingLine(line);
          }
        }
      }
    } catch (err) {
      console.error("[LoRa RX] Loop de escuta interrompido:", err);
    } finally {
      if (this.reader) {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
  }

  /**
   * Analisa mensagens recebidas via rádio.
   * Padrão Reyax: "+RCV=<addr>,<len>,<data>,<rssi>,<snr>"
   */
  private parseLoRaIncomingLine(line: string): void {
    if (line.startsWith("+RCV=")) {
      const parts = line.slice(5).split(",");
      if (parts.length >= 3) {
        const sender = parseInt(parts[0], 10);
        const data = parts[2];
        console.log(`[LoRa RX] Pacote recebido de [${sender}]: ${data}`);
        if (this.onMessageReceivedCallback) {
          this.onMessageReceivedCallback(sender, data);
        }
      }
    }
  }

  public async close(): Promise<void> {
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
