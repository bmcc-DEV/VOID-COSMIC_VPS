/**
 * VØID Core — Node Signing Key Derivation
 *
 * Deriva chaves de assinatura Ed25519 a partir da identidade do nó.
 * Chaves são determinísticas e reprodutíveis, mas únicas por nó.
 */

import { sha3_512 } from "@noble/hashes/sha3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Deriva uma chave de assinatura Ed25519 a partir da identidade do nó e um namespace.
 * Usa HKDF-like derivation: HKDF(nodeSecret || domainSeparator)
 */
function deriveSigningKey(
  nodeSecretKey: Uint8Array,
  domain: string,
): Uint8Array {
  const ikm = new Uint8Array(nodeSecretKey.length + domain.length);
  ikm.set(nodeSecretKey);
  ikm.set(new TextEncoder().encode(domain), nodeSecretKey.length);

  // HKDF-Expand using SHA3-512 (extract-then-expand)
  const prk = sha3_512(ikm); // 64 bytes
  return prk.slice(0, 32); // Ed25519 seed = 32 bytes
}

/**
 * Cache de chaves derivadas (derivadas uma vez por sessão)
 */
const keyCache = new Map<string, Uint8Array>();

/**
 * Obtém a chave de assinatura para um namespace específico.
 * Se o nó ainda não tem identidade, gera uma chave efêmera.
 */
export function getSigningKey(namespace: string): Uint8Array {
  const cached = keyCache.get(namespace);
  if (cached) return cached;

  // Usa o segredo da identidade do nó (ou gera um efêmero)
  // sessionStorage: zero rastro — destruído ao fechar a aba
  let nodeSecret: Uint8Array;
  try {
    const stored = sessionStorage.getItem("void_node_secret");
    if (stored) {
      nodeSecret = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
    } else {
      nodeSecret = crypto.getRandomValues(new Uint8Array(32));
      sessionStorage.setItem("void_node_secret", btoa(String.fromCharCode(...nodeSecret)));
    }
  } catch {
    nodeSecret = crypto.getRandomValues(new Uint8Array(32));
  }

  const key = deriveSigningKey(nodeSecret, namespace);
  keyCache.set(namespace, key);
  return key;
}

/**
 * Assina dados com a chave derivada do namespace.
 * Retorna a assinatura Ed25519 de 64 bytes.
 */
export function signWithNodeKey(
  namespace: string,
  message: Uint8Array,
): Uint8Array {
  const privateKey = getSigningKey(namespace);
  return ed25519.sign(message, privateKey);
}
