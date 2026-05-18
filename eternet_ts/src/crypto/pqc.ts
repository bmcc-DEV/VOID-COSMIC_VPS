/**
 * Hydra v7.0 — Post-Quantum Cryptography (PQC) Layer
 *
 * Implementação de criptografia pós-quântica usando:
 * - ML-KEM-1024 (Kyber): encapsulamento de chave resistente a ataques quânticos
 * - ML-DSA-87 (Dilithium): assinaturas digitais pós-quânticas
 *
 * Bibliotecas: @noble/post-quantum (auditada, zero-dependency)
 */

import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PQCKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  algorithm: "ML-KEM-1024" | "ML-DSA-87";
}

export interface EncapsulatedKey {
  ciphertext: Uint8Array;  // encapsulated key
  sharedSecret: Uint8Array; // shared secret (32 bytes)
}

export interface PQCSignature {
  signature: Uint8Array;
  algorithm: "ML-DSA-87";
}

// ─── ML-KEM-1024 (Kyber) — Key Encapsulation ─────────────────────────────────

/**
 * Gera um par de chaves ML-KEM-1024.
 * - Chave pública: 1568 bytes
 * - Chave privada: 3168 bytes
 */
export function generateMLKEMKeypair(): PQCKeyPair {
  const keypair = ml_kem1024.keygen();
  return {
    publicKey: keypair.publicKey,
    privateKey: keypair.secretKey,
    algorithm: "ML-KEM-1024",
  };
}

/**
 * Encapsula uma chave compartilhada usando ML-KEM-1024.
 *
 * Alice gera (pk, sk), envia pk para Bob.
 * Bob chama encapsulate(pk) → (ciphertext, sharedSecret).
 * Bob envia ciphertext para Alice.
 * Alice chama decapsulate(sk, ciphertext) → sharedSecret.
 *
 * Agora ambos têm o mesmo sharedSecret (32 bytes) para usar com ChaCha20.
 */
export function mlkemEncapsulate(publicKey: Uint8Array): EncapsulatedKey {
  const result = ml_kem1024.encapsulate(publicKey);
  return {
    ciphertext: result.cipherText,
    sharedSecret: result.sharedSecret,
  };
}

/**
 * Decapsula uma chave compartilhada usando ML-KEM-1024.
 */
export function mlkemDecapsulate(
  privateKey: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  return ml_kem1024.decapsulate(ciphertext, privateKey);
}

// ─── ML-DSA-87 (Dilithium) — Digital Signatures ──────────────────────────────

/**
 * Gera um par de chaves ML-DSA-87.
 * - Chave pública: 2592 bytes
 * - Chave privada: 4896 bytes
 */
export function generateMLDSAKeypair(): PQCKeyPair {
  const keypair = ml_dsa87.keygen();
  return {
    publicKey: keypair.publicKey,
    privateKey: keypair.secretKey,
    algorithm: "ML-DSA-87",
  };
}

/**
 * Assina uma mensagem usando ML-DSA-87.
 */
export function mlDsaSign(privateKey: Uint8Array, message: Uint8Array): PQCSignature {
  const signature = ml_dsa87.sign(message, privateKey);
  return { signature, algorithm: "ML-DSA-87" };
}

/**
 * Verifica uma assinatura ML-DSA-87.
 */
export function mlDsaVerify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return ml_dsa87.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

// ─── Hybrid Encryption (PQC + Symmetric) ──────────────────────────────────────

/**
 * Cifra uma mensagem usando esquema híbrido:
 * 1. ML-KEM-1024 encapsula uma chave compartilhada
 * 2. ChaCha20-Poly1305 cifra a mensagem com a chave compartilhada
 *
 * Retorna: ciphertext + encapsulated key + nonce
 */
export function hybridEncrypt(
  recipientPublicKey: Uint8Array,
  plaintext: Uint8Array,
): {
  ciphertext: Uint8Array;
  encapsulatedKey: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
} {
  // Step 1: Encapsulate shared secret via ML-KEM
  const { ciphertext: encapsulatedKey, sharedSecret } = mlkemEncapsulate(recipientPublicKey);

  // Step 2: Derive symmetric key from shared secret
  const symmetricKey = sharedSecret.slice(0, 32);

  // Step 3: Encrypt with ChaCha20-Poly1305
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = chacha20poly1305(symmetricKey, nonce);
  const ciphertextAndTag = cipher.encrypt(plaintext);

  // Separa ciphertext e tag (últimos 16 bytes)
  const ciphertext = ciphertextAndTag.slice(0, ciphertextAndTag.length - 16);
  const tag = ciphertextAndTag.slice(ciphertextAndTag.length - 16);

  return { ciphertext, encapsulatedKey, nonce, tag };
}

/**
 * Decifra uma mensagem usando esquema híbrido:
 * 1. ML-KEM-1024 decapsula a chave compartilhada
 * 2. ChaCha20-Poly1305 decifra a mensagem
 */
export function hybridDecrypt(
  privateKey: Uint8Array,
  encapsulatedKey: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  _tag: Uint8Array,
): Uint8Array {
  // Step 1: Decapsulate shared secret
  const sharedSecret = mlkemDecapsulate(privateKey, encapsulatedKey);
  const symmetricKey = sharedSecret.slice(0, 32);

  // Step 2: Decrypt with ChaCha20-Poly1305
  const cipher = chacha20poly1305(symmetricKey, nonce);
  // Reconstroi ciphertext + tag para o decrypt
  const ciphertextAndTag = new Uint8Array(ciphertext.length + _tag.length);
  ciphertextAndTag.set(ciphertext);
  ciphertextAndTag.set(_tag, ciphertext.length);
  return cipher.decrypt(ciphertextAndTag);
}

// ─── Security: zero-fill de material criptográfico sensível ──────────────────

/**
 * Apaga as chaves PQC da memória após uso.
 * Essencial para chaves ML-KEM (3168 bytes de chave privada) e ML-DSA.
 */
export function destroyPQCKeyPair(kp: PQCKeyPair): void {
  kp.privateKey.fill(0);
  kp.publicKey.fill(0);
}

/**
 * Apaga o segredo compartilhado encapsulado da memória.
 */
export function destroyEncapsulatedKey(ek: EncapsulatedKey): void {
  ek.sharedSecret.fill(0);
  ek.ciphertext.fill(0);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export function getKeySizes() {
  return {
    "ML-KEM-1024": {
      publicKey: 1568,
      privateKey: 3168,
      ciphertext: 1568,
      sharedSecret: 32,
    },
    "ML-DSA-87": {
      publicKey: 2592,
      privateKey: 4896,
      signature: 4627,
    },
  };
}
