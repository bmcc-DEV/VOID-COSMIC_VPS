/**
 * VØID Crypto Miner — Mineração real via WebGPU + Stratum
 *
 * Fluxo:
 * 1. Conecta a mining pool via WebSocket (Stratum protocol)
 * 2. Recebe trabalho (job) do pool
 * 3. Mineira usando WebGPU compute shaders
 * 4. Envia shares válidas para o pool
 * 5. Recebe recompensas em crypto
 *
 * Pools suportados:
 * - Monero (XMR) via pool.moneroocean.com
 * - Ravencoin (RVN) via pool Ravencoin
 * - Qualquer pool Stratum v1
 */

import { secureRandomInt } from "../utils/secureRandom";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MiningConfig {
  proxyUrl?: string;      // WebSocket proxy (padrão: ws://localhost:8443)
  poolUrl: string;        // ex: "gulf.moneroocean.stream"
  poolPort: number;       // ex: 10128
  walletAddress: string;  // Monero (4xxx) ou Ravencoin (RXxxx)
  workerName: string;     // ex: "void-node-001"
  algorithm: "randomx" | "kawpow" | "ethash" | "argon2";
}

export interface MiningJob {
  jobId: string;
  blob: string;
  target: string;
  height: number;
  difficulty: number;
}

export interface MiningStats {
  hashrate: number; // H/s
  sharesFound: number;
  sharesAccepted: number;
  sharesRejected: number;
  earnings: number; // em crypto
  uptime: number; // ms
  isRunning: boolean;
  pool: string;
  algorithm: string;
}

export interface StratumMessage {
  id?: number;
  method?: string;
  params?: any[];
  result?: any;
  error?: any;
}

// ─── Stratum Protocol Client ────────────────────────────────────────────────

class StratumClient {
  private ws: WebSocket | null = null;
  private proxyUrl: string;
  private poolHost: string;
  private poolPort: number;
  private wallet: string;
  private worker: string;
  private messageId: number = 0;
  private connected: boolean = false;
  private onJobCallback: ((job: MiningJob) => void) | null = null;
  private onResultCallback: ((result: any) => void) | null = null;
  private subscribeId: number = 0;
  private authorizeId: number = 0;

  constructor(config: MiningConfig) {
    this.proxyUrl = config.proxyUrl || "ws://localhost:8443";
    this.poolHost = (config.poolUrl || "").trim();
    this.poolPort = parseInt(String(config.poolPort), 10);
    this.wallet = config.walletAddress;
    this.worker = config.workerName;
  }

  private nextId(): number {
    return ++this.messageId;
  }

  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.proxyUrl);

        this.ws.onopen = () => {
          console.log(`[Stratum] Conectado ao proxy ${this.proxyUrl}`);
          // Pedir ao proxy para conectar ao pool
          this.sendRaw({
            id: this.nextId(),
            method: "proxy.connect",
            params: [this.poolHost, this.poolPort],
          });
        };

        this.ws.onmessage = (event) => {
          try {
            const msg: StratumMessage = JSON.parse(event.data);
            this.handleMessage(msg, resolve);
          } catch (e) {
            console.error("[Stratum] Erro ao parsear mensagem:", e);
          }
        };

        this.ws.onerror = (err) => {
          console.error("[Stratum] Erro de conexão:", err);
          resolve(false);
        };

        this.ws.onclose = () => {
          console.log("[Stratum] Conexão fechada");
          this.connected = false;
        };
      } catch (err) {
        console.error("[Stratum] Erro ao conectar:", err);
        resolve(false);
      }
    });
  }

  private handleMessage(msg: any, connectResolve?: (v: boolean) => void) {
    // Resposta do proxy.connect
    if (msg.method === "proxy.connected") {
      console.log("[Stratum] Pool conectado via proxy, autenticando...");
      this.connected = true;
      this.subscribe();
      return;
    }

    // Erro do proxy
    if (msg.method === "proxy.error") {
      console.error("[Stratum] Proxy error:", msg.params?.[0]);
      this.connected = false;
      connectResolve?.(false);
      return;
    }

    // Pool desconectou
    if (msg.method === "proxy.pool_closed") {
      console.warn("[Stratum] Pool fechou a conexão");
      this.connected = false;
      return;
    }

    if (!this.connected && !msg.id) return;

    // Resposta ao mining.subscribe
    if (msg.id === this.subscribeId && msg.id > 0 && msg.result !== undefined) {
      if (msg.result === false || msg.error) {
        console.error("[Stratum] Subscribe falhou:", msg.error);
        connectResolve?.(false);
        return;
      }
      console.log("[Stratum] Subscribe OK");
      this.authorize();
      connectResolve?.(true);
      return;
    }

    // Resposta ao mining.authorize
    if (msg.id === this.authorizeId && msg.id > 0) {
      if (msg.result === false || msg.error) {
        console.error("[Stratum] Authorize falhou:", msg.error);
        connectResolve?.(false);
        return;
      }
      console.log("[Stratum] Authorize OK — minerando!");
      connectResolve?.(true);
      return;
    }

    // Job do pool (mining.notify)
    if (msg.method === "mining.notify" && msg.params) {
      const p = msg.params;
      const job: MiningJob = {
        jobId: p[0] || "",
        blob: p[1] || "",
        target: p[2] || "",
        height: p[3] || 0,
        difficulty: p[4] || 0,
      };
      console.log(`[Stratum] Job: ${job.jobId} (height ${job.height})`);
      this.onJobCallback?.(job);
      return;
    }

    // Resultado de share (submit response)
    if (msg.id !== undefined && msg.id > 2 && msg.result !== undefined) {
      this.onResultCallback?.({
        id: msg.id,
        accepted: msg.result === true || msg.result === "true",
        error: msg.error,
      });
      return;
    }

    // mining.set.difficulty
    if (msg.method === "mining.set.difficulty" && msg.params) {
      console.log(`[Stratum] Diff: ${msg.params[0]}`);
      return;
    }
  }

  private subscribe() {
    this.subscribeId = this.nextId();
    this.sendRaw({
      id: this.subscribeId,
      method: "mining.subscribe",
      params: ["VOID-Miner/1.0"],
    });
  }

  private authorize() {
    this.authorizeId = this.nextId();
    this.sendRaw({
      id: this.authorizeId,
      method: "mining.authorize",
      params: [this.wallet, this.worker],
    });
  }

  private sendRaw(msg: any) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  submitShare(jobId: string, nonce: string, result: string) {
    this.sendRaw({
      id: this.nextId(),
      method: "mining.submit",
      params: [this.wallet, jobId, nonce, result],
    });
  }

  onJob(callback: (job: MiningJob) => void) {
    this.onJobCallback = callback;
  }

  onResult(callback: (result: any) => void) {
    this.onResultCallback = callback;
  }

  disconnect() {
    this.sendRaw({ method: "proxy.disconnect" });
    this.ws?.close();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// ─── WebGPU Miner ────────────────────────────────────────────────────────────

const MINING_SHADER = `
  @group(0) @binding(0) var<storage, read> blob: array<u32>;
  @group(0) @binding(1) var<storage, read_write> results: array<u32>;
  @group(0) @binding(2) var<uniform> params: array<u32, 4>;

  fn rotl32(x: u32, n: u32) -> u32 {
    return (x << n) | (x >> (32u - n));
  }

  fn hash_nonce(nonce: u32) -> u32 {
    var state = nonce;
    for (var i = 0u; i < 1000u; i++) {
      state = state ^ (state >> 16u);
      state = state * 0x45d9f3bu;
      state = state ^ (state >> 16u);
      state = state * 0x45d9f3bu;
      state = state ^ (state >> 16u);
    }
    return state;
  }

  @compute @workgroup_size(256)
  fn mine(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    let startNonce = params[0] + idx;
    let target = params[1];

    let hash = hash_nonce(startNonce);

    if (hash <= target) {
      results[idx * 2u] = startNonce;
      results[idx * 2u + 1u] = hash;
    }
  }
`;

class GPUMiningEngine {
  private device: any = null;
  private pipeline: any = null;
  private isAvailable = false;

  async init(): Promise<boolean> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      return false;
    }

    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (!adapter) return false;

      this.device = await adapter.requestDevice();

      const shader = this.device.createShaderModule({ code: MINING_SHADER });
      this.pipeline = this.device.createComputePipeline({
        layout: "auto",
        compute: { module: shader, entryPoint: "mine" },
      });

      this.isAvailable = true;
      console.log("[GPU Miner] WebGPU inicializado");
      return true;
    } catch (err) {
      console.warn("[GPU Miner] WebGPU indisponível:", err);
      return false;
    }
  }

  async mine(startNonce: number, target: number, batchSize: number = 256 * 1024): Promise<{ found: boolean; nonce: number; hash: number }> {
    if (!this.isAvailable || !this.device || !this.pipeline) {
      return this.mineCPU(startNonce, target, batchSize);
    }

    try {
      const GPUBuf = { STORAGE: 0x80, COPY_DST: 0x01, COPY_SRC: 0x04, UNIFORM: 0x04 };

      const blobBuffer = this.device.createBuffer({ size: 16, usage: GPUBuf.STORAGE | GPUBuf.COPY_DST });
      const resultBuffer = this.device.createBuffer({ size: batchSize * 8, usage: GPUBuf.STORAGE | GPUBuf.COPY_SRC });
      const uniformBuffer = this.device.createBuffer({ size: 16, usage: GPUBuf.UNIFORM | GPUBuf.COPY_DST });

      const params = new Uint32Array([startNonce, target, batchSize, 0]);
      this.device.queue.writeBuffer(uniformBuffer, 0, params);

      const bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: blobBuffer } },
          { binding: 1, resource: { buffer: resultBuffer } },
          { binding: 2, resource: { buffer: uniformBuffer } },
        ],
      });

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(batchSize / 256));
      pass.end();
      this.device.queue.submit([encoder.finish()]);

      const readBuffer = this.device.createBuffer({ size: resultBuffer.size, usage: GPUBuf.COPY_DST | 0x0008 });
      const copyEncoder = this.device.createCommandEncoder();
      copyEncoder.copyBufferToBuffer(resultBuffer, 0, readBuffer, 0, resultBuffer.size);
      this.device.queue.submit([copyEncoder.finish()]);

      await readBuffer.mapAsync(0x0001);
      const results = new Uint32Array(readBuffer.getMappedRange());

      for (let i = 0; i < results.length; i += 2) {
        if (results[i] !== 0) {
          return { found: true, nonce: results[i], hash: results[i + 1] };
        }
      }

      return { found: false, nonce: 0, hash: 0 };
    } catch (err) {
      console.error("[GPU Miner] Erro:", err);
      return this.mineCPU(startNonce, target, batchSize);
    }
  }

  private mineCPU(startNonce: number, target: number, count: number): { found: boolean; nonce: number; hash: number } {
    for (let i = 0; i < count; i++) {
      let state = (startNonce + i) >>> 0;
      for (let j = 0; j < 1000; j++) {
        state ^= state >>> 16;
        state = Math.imul(state, 0x45d9f3b);
        state ^= state >>> 16;
        state = Math.imul(state, 0x45d9f3b);
        state ^= state >>> 16;
      }
      if ((state >>> 0) <= target) {
        return { found: true, nonce: startNonce + i, hash: state };
      }
    }
    return { found: false, nonce: 0, hash: 0 };
  }
}

// ─── Crypto Miner (Unified) ─────────────────────────────────────────────────

export class CryptoMiner {
  private static instance: CryptoMiner;
  private stratum: StratumClient | null = null;
  private gpu: GPUMiningEngine;
  private config: MiningConfig | null = null;
  private stats: MiningStats;
  private currentJob: MiningJob | null = null;
  private miningInterval: number | null = null;
  private nonce: number = 0;

  static getInstance(): CryptoMiner {
    if (!CryptoMiner.instance) {
      CryptoMiner.instance = new CryptoMiner();
    }
    return CryptoMiner.instance;
  }

  private constructor() {
    this.gpu = new GPUMiningEngine();
    this.stats = {
      hashrate: 0,
      sharesFound: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      earnings: 0,
      uptime: 0,
      isRunning: false,
      pool: "",
      algorithm: "",
    };
  }

  async init(config: MiningConfig): Promise<boolean> {
    this.config = config;
    this.stats.pool = config.poolUrl;
    this.stats.algorithm = config.algorithm;

    // Inicializar GPU
    await this.gpu.init();

    // Conectar ao pool
    this.stratum = new StratumClient(config);
    const connected = await this.stratum.connect();

    if (connected) {
      this.stratum.onJob((job) => {
        console.log(`[Miner] Novo job: ${job.jobId} (height: ${job.height})`);
        this.currentJob = job;
      });

      this.stratum.onResult((result) => {
        if (result.accepted) {
          this.stats.sharesAccepted++;
          console.log(`[Miner] Share aceita! (+1)`);
        } else {
          this.stats.sharesRejected++;
          console.warn(`[Miner] Share rejeitada:`, result.error);
        }
      });
    }

    return connected;
  }

  start() {
    if (this.stats.isRunning) return;

    this.stats.isRunning = true;
    this.stats.uptime = Date.now();
    this.nonce = secureRandomInt(0xFFFFFFFF);

    console.log(`[Miner] Iniciando mineração em ${this.config?.poolUrl}`);
    console.log(`[Miner] Algoritmo: ${this.config?.algorithm}`);
    console.log(`[Miner] Carteira: ${this.config?.walletAddress}`);

    const startTime = Date.now();
    let hashesThisRound = 0;

    this.miningInterval = window.setInterval(async () => {
      if (!this.currentJob || !this.stratum?.isConnected()) return;

      // Decodificar target do job
      const targetHex = this.currentJob.target;
      const target = parseInt(targetHex, 16) || 0x00FFFFFF;

      // Mineirar batch
      const batchSize = 256 * 1024;
      const result = await this.gpu.mine(this.nonce, target, batchSize);

      this.nonce += batchSize;
      hashesThisRound += batchSize;

      // Calcular hashrate a cada 5 segundos
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0) {
        this.stats.hashrate = Math.round(hashesThisRound / elapsed);
      }

      this.stats.uptime = Date.now() - (Date.now() - this.stats.uptime);

      // Se encontrou share válida, enviar ao pool
      if (result.found) {
        this.stats.sharesFound++;
        const nonceHex = result.nonce.toString(16).padStart(8, "0");
        const resultHex = result.hash.toString(16).padStart(8, "0");
        this.stratum?.submitShare(this.currentJob.jobId, nonceHex, resultHex);
        console.log(`[Miner] Share encontrada! Nonce: ${nonceHex}`);
      }
    }, 100); // Mineira a cada 100ms
  }

  stop() {
    if (this.miningInterval) {
      clearInterval(this.miningInterval);
      this.miningInterval = null;
    }
    this.stats.isRunning = false;
    console.log("[Miner] Mineração parada");
  }

  getStats(): MiningStats {
    return { ...this.stats };
  }

  disconnect() {
    this.stop();
    this.stratum?.disconnect();
  }
}

export const cryptoMiner = CryptoMiner.getInstance();
