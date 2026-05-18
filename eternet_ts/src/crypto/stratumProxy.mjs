#!/usr/bin/env node
/**
 * VØID Stratum Proxy — WebSocket ↔ TCP Bridge
 *
 * Ponte entre o navegador (WebSocket) e mining pools (TCP Stratum v1).
 * O navegador conecta via ws://localhost:8443 e o proxy repassa para
 * o pool via TCP, traduzindo entre os dois transports.
 *
 * Uso:
 *   node src/crypto/stratumProxy.mjs [--port 8443]
 *
 * Variáveis de ambiente:
 *   PROXY_PORT  — porta WebSocket do proxy (padrão: 8443)
 */

import { createConnection } from "node:net";
import { resolve as dnsResolve, Resolver } from "node:dns";
import { WebSocketServer } from "ws";

const PROXY_PORT = parseInt(process.env.PROXY_PORT || "8443", 10);

// ─── DNS com fallback para Google DNS (bypass bloqueio ISP) ────────────────

const googleDns = new Resolver();
googleDns.setServers(["8.8.8.8", "1.1.1.1"]);

function resolveWithFallback(hostname) {
  return new Promise((resolve, reject) => {
    // Tenta DNS local primeiro
    dnsResolve(hostname, (err, addrs) => {
      if (!err && addrs?.length > 0) {
        resolve(addrs[0]);
        return;
      }
      console.log(`[Proxy] DNS local falhou para ${hostname}, tentando Google DNS...`);
      googleDns.resolve4(hostname, (err2, addrs2) => {
        if (!err2 && addrs2?.length > 0) {
          console.log(`[Proxy] Google DNS: ${hostname} -> ${addrs2[0]}`);
          resolve(addrs2[0]);
        } else {
          console.error(`[Proxy] DNS falhou para ${hostname}:`, err2?.code);
          reject(new Error(`DNS resolution failed for ${hostname}`));
        }
      });
    });
  });
}

// ─── TCP ↔ JSON helpers ────────────────────────────────────────────────────

function parseMessages(buffer) {
  const messages = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const nlIndex = buffer.indexOf(0x0a, cursor); // \n
    if (nlIndex === -1) break;

    const line = buffer.subarray(cursor, nlIndex).toString("utf8").trim();
    cursor = nlIndex + 1;

    if (line.length > 0) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // linha inválida, ignora
      }
    }
  }

  return { messages, remaining: buffer.subarray(cursor) };
}

function encodeMessage(msg) {
  return JSON.stringify(msg) + "\n";
}

// ─── WebSocket Server ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PROXY_PORT });
console.log(`[Stratum Proxy] Escutando em ws://localhost:${PROXY_PORT}`);

wss.on("connection", (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[Proxy] Nova conexão de ${clientIp}`);

  let poolSocket = null;
  let poolBuffer = Buffer.alloc(0);
  let poolHost = "";
  let poolPort = 0;

  // ─── Mensagens do navegador → pool ───────────────────────────────────

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error("[Proxy] Mensagem inválida do cliente:", raw.toString().slice(0, 200));
      return;
    }

    // Comando especial do cliente: conectar ao pool
    if (msg.method === "proxy.connect") {
      const [rawHost, rawPort] = msg.params || [];
      const host = (rawHost || "").trim();
      const port = Number(rawPort);
      if (!host || !port) {
        ws.send(JSON.stringify({
          id: msg.id,
          error: { message: "proxy.connect requer [host, port]" },
        }));
        return;
      }

      poolHost = host;
      poolPort = port;

      console.log(`[Proxy] Conectando ao pool ${host}:${port}...`);

      // Resolve DNS com fallback para Google DNS
      resolveWithFallback(host).then((ip) => {
        console.log(`[Proxy] DNS: ${host} -> ${ip}, conectando...`);
        poolSocket = createConnection({ host: ip, port }, () => {
          console.log(`[Proxy] Conectado ao pool ${ip}:${port}`);

          // Envia subscribe automaticamente para manter a conexão viva
          // (pool tem timeout curto antes de receber dados do browser)
          const subscribeMsg = JSON.stringify({id: 999, method: "mining.subscribe", params: ["VOID-Miner/1.0"]}) + "\n";
          poolSocket.write(subscribeMsg);
          console.log(`[Proxy] Subscribe automático enviado`);

          ws.send(JSON.stringify({
            id: msg.id,
            result: true,
            method: "proxy.connected",
          }));
        });

        poolSocket.setKeepAlive(true, 30000);
        poolSocket.setNoDelay(true);

        poolSocket.on("data", (data) => {
          poolBuffer = Buffer.concat([poolBuffer, data]);
          const { messages, remaining } = parseMessages(poolBuffer);
          poolBuffer = remaining;

          for (const m of messages) {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify(m));
            }
          }
        });

        poolSocket.on("error", (err) => {
          console.error(`[Proxy] Erro no pool:`, err.message);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              method: "proxy.error",
              params: [err.message],
            }));
          }
        });

        poolSocket.on("close", () => {
          console.log(`[Proxy] Pool ${host}:${port} desconectou`);
          poolBuffer = Buffer.alloc(0);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ method: "proxy.pool_closed" }));
          }
        });
      }).catch((err) => {
        console.error(`[Proxy] Não conseguiu resolver ${host}:`, err.message);
        ws.send(JSON.stringify({
          id: msg.id,
          error: { message: `DNS resolution failed: ${err.message}` },
        }));
      });

      return;
    }

    // Comando especial: desconectar do pool
    if (msg.method === "proxy.disconnect") {
      if (poolSocket) {
        poolSocket.destroy();
        poolSocket = null;
      }
      return;
    }

    // Qualquer outra mensagem: repassa ao pool
    if (poolSocket && !poolSocket.destroyed) {
      poolSocket.write(encodeMessage(msg));
    } else {
      console.warn("[Proxy] Pool não conectado, mensagem ignorada:", msg.method || msg.id);
    }
  });

  // ─── Desconexão do navegador ─────────────────────────────────────────

  ws.on("close", () => {
    console.log(`[Proxy] Cliente ${clientIp} desconectou`);
    if (poolSocket) {
      poolSocket.destroy();
      poolSocket = null;
    }
    poolBuffer = Buffer.alloc(0);
  });

  ws.on("error", (err) => {
    console.error(`[Proxy] Erro WebSocket:`, err.message);
    if (poolSocket) {
      poolSocket.destroy();
      poolSocket = null;
    }
  });
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n[Proxy] Encerrando...");
  wss.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  wss.close();
  process.exit(0);
});
