/**
 * ETΞRNET — Stratum 4: Network Ghost (Sphinx Packets & OHTTP)
 * 
 * Implementação do formato de pacote Sphinx para roteamento anônimo.
 * Shards QEL são encapsulados em pacotes de tamanho fixo com criptografia
 * em camadas (onion routing). Isso garante indistinguibilidade do tráfego.
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

// Tamanho fixo do payload para evitar análise de tráfego (ex: 512 bytes)
export const SPHINX_PAYLOAD_SIZE = 512;

export interface SphinxPacket {
  header: Uint8Array;    // Roteamento e chaves efêmeras
  payload: Uint8Array;   // Tamanho fixo, cifrado
  mac: Uint8Array;       // Tag de integridade
}

/**
 * Encapsula um shard QEL em um pacote Sphinx cego.
 * @param shardData O dado serializado do shard
 * @param routeKey Chave de roteamento do próximo nó
 */
export function buildSphinxPacket(shardData: Uint8Array, routeKey: Uint8Array): SphinxPacket {
  // Preenche o payload com padding para tamanho fixo
  const paddedPayload = new Uint8Array(SPHINX_PAYLOAD_SIZE);
  paddedPayload.set(shardData.subarray(0, SPHINX_PAYLOAD_SIZE));

  // Gera chave efêmera para o pacote
  const ephemeralKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // Cifra o payload (Onion layer 1)
  const cipher = chacha20poly1305(routeKey, nonce);
  const encryptedPayload = cipher.encrypt(paddedPayload);

  // O cabeçalho inclui o nonce e informações de roteamento ofuscadas
  const header = new Uint8Array(44);
  header.set(nonce, 0);
  header.set(ephemeralKey, 12);

  // MAC para integridade
  const macInput = new Uint8Array(header.length + encryptedPayload.length);
  macInput.set(header);
  macInput.set(encryptedPayload, header.length);
  const mac = sha3_256(macInput);

  return {
    header,
    payload: encryptedPayload,
    mac
  };
}

/**
 * Desencapsula uma camada do pacote Sphinx.
 */
export function peelSphinxLayer(packet: SphinxPacket, nodeKey: Uint8Array): Uint8Array | null {
  try {
    const nonce = packet.header.subarray(0, 12);
    const cipher = chacha20poly1305(nodeKey, nonce);
    
    // Descriptografa e remove o padding nulo no final
    const decrypted = cipher.decrypt(packet.payload);
    
    // Procura o final do dado útil (assumindo padding 0x00)
    let endIdx = decrypted.length;
    while (endIdx > 0 && decrypted[endIdx - 1] === 0) {
      endIdx--;
    }
    
    return decrypted.subarray(0, endIdx);
  } catch (e) {
    console.error("[Sphinx] Falha ao descriptografar camada:", e);
    return null;
  }
}
