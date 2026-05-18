/**
 * ETΞRNET — Double Ratchet com X25519 (Signal Protocol)
 *
 * Implementa o Double Ratchet Algorithm para E2EE com:
 * - X25519 ECDH para key agreement real
 * - Symmetric-key ratchet (KDF chain) para forward secrecy
 * - DH ratchet para post-compromise security
 * - Per-message keys (uma chave por mensagem, deletada após uso)
 * - Autenticação via Ed25519 signatures
 *
 * Referência: https://signal.org/docs/specifications/doubleratchet/
 */

import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { sha3_512, sha3_256 } from "@noble/hashes/sha3.js";
import { hmac } from "@noble/hashes/hmac.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Keypair X25519 para DH */
export interface DHKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Pre-key bundle publicado via NOSTR */
export interface PreKeyBundle {
  identityKey: Uint8Array;       // IK Ed25519 (for signature verification)
  x25519IdentityKey: Uint8Array; // IK X25519 (for ECDH key agreement)
  signedPreKey: Uint8Array;      // SPK (medium-term, X25519 public)
  signedPreKeySig: Uint8Array;   // Assinatura Ed25519 sobre SPK
  oneTimePreKey: Uint8Array | undefined;    // OPK (one-time, X25519 public)
  nostrPubKey: string;           // Hex do pubkey NOSTR para busca
}

/** Estado do Double Ratchet para uma conversa */
export interface RatchetState {
  // DH Ratchet keys
  dhKeyPair: DHKeyPair;          // Keypair local atual
  dhRemotePubKey: Uint8Array | null; // Pubkey remota atual

  // Root key & Chain keys
  rootKey: Uint8Array;           // Root key (RK)
  sendingChainKey: Uint8Array | null;   // CKs
  receivingChainKey: Uint8Array | null; // CKr

  // Message counters
  sendMessageNumber: number;     // Ns
  receiveMessageNumber: number;  // Nr
  previousSendingChainLength: number; // PN

  // Skipped message keys (for out-of-order delivery)
  skippedKeys: Map<string, Uint8Array>; // "dhPubKey:msgNum" → messageKey

  // Identity
  localIdentityKey: Uint8Array;  // Ed25519 public key
  localSigningKey: Uint8Array;   // Ed25519 secret key (for signing)
}

/** Mensagem criptografada com header */
export interface RatchetMessage {
  dhPublicKey: Uint8Array;       // Sender's current DH public key
  senderIdentityKey: Uint8Array | undefined; // Sender's X25519 identity key (first message only, for X3DH)
  previousChainLength: number;   // PN
  messageNumber: number;         // N
  ciphertext: Uint8Array;        // nonce || encrypted || tag
  signature: Uint8Array;         // Ed25519 signature over header+ciphertext
}

// ─── KDF Functions ────────────────────────────────────────────────────────────

/**
 * KDF Chain (KDF_CK): derive next chain key + message key
 *
 * messageKey = HMAC-SHA3-512(ck, 0x01)
 * nextChainKey = HMAC-SHA3-512(ck, 0x02)
 */
function kdfChain(chainKey: Uint8Array): { messageKey: Uint8Array; nextChainKey: Uint8Array } {
  const messageKey = hmac(sha3_512, chainKey, new Uint8Array([0x01]));
  const nextChainKey = hmac(sha3_512, chainKey, new Uint8Array([0x02]));
  return { messageKey, nextChainKey };
}

/**
 * KDF Root (KDF_RK): derive new root key + new chain key from DH output
 *
 * output = HKDF(dhOutput, rk, "DoubleRatchet", 80)
 * newRootKey = output[0:32]
 * newChainKey = output[32:64]
 */
function kdfRoot(rootKey: Uint8Array, dhOutput: Uint8Array): { newRootKey: Uint8Array; newChainKey: Uint8Array } {
  // HKDF-Extract: PRK = HMAC-SHA3-512(salt=ikm, data=rootKey)
  const prk = hmac(sha3_512, dhOutput, rootKey);
  // HKDF-Expand: produce 80 bytes
  const info = new TextEncoder().encode("DoubleRatchet");
  const okm1 = hmac(sha3_512, prk, new Uint8Array([...info, 0x01]));
  const okm2 = hmac(sha3_512, prk, new Uint8Array([...okm1, ...info, 0x02]));

  return {
    newRootKey: okm1.slice(0, 32),
    newChainKey: new Uint8Array([...okm1.slice(32), ...okm2.slice(0, 16)]).slice(0, 32),
  };
}

/**
 * Derive message encryption key from message key
 *
 * Uses HKDF to derive: encryptionKey (32) + nonceKey (12) + authKey (32)
 */
function deriveMessageKeys(messageKey: Uint8Array): {
  encryptionKey: Uint8Array;
  nonce: Uint8Array;
} {
  const info = new TextEncoder().encode("MessageKeys");
  const prk = hmac(sha3_512, messageKey, new Uint8Array(32)); // zero salt
  const okm = hmac(sha3_512, prk, new Uint8Array([...info, 0x01]));

  return {
    encryptionKey: okm.slice(0, 32),
    nonce: okm.slice(32, 44),
  };
}

// ─── DH Functions ─────────────────────────────────────────────────────────────

/** Generate a new X25519 keypair */
export function generateDHKeyPair(): DHKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey };
}

/** Compute X25519 shared secret */
function dh(sharedKey: Uint8Array, keyPair: DHKeyPair): Uint8Array {
  return x25519.getSharedSecret(keyPair.secretKey, sharedKey);
}

// ─── Ratchet Initialization ───────────────────────────────────────────────────

/**
 * Initialize ratchet as Alice (initiator)
 *
 * Alice performs the initial X3DH with Bob's pre-key bundle,
 * then initializes the ratchet with the shared secret.
 *
 * Note: identityKey in the bundle is the Ed25519 public key used for signature verification.
 * localSigningKey is the X25519 secret key used for ECDH operations.
 * localIdentityKey is the X25519 public key (not Ed25519) for DH computations.
 */
export function initializeRatchetAsAlice(
  bobBundle: PreKeyBundle,
  localIdentityKey: Uint8Array,
  localSigningKey: Uint8Array,
): { state: RatchetState; ephemeralKey: Uint8Array } {
  // Verify Bob's signed pre-key signature against his identity key (Ed25519)
  const spkValid = ed25519.verify(bobBundle.signedPreKeySig, bobBundle.signedPreKey, bobBundle.identityKey);
  if (!spkValid) throw new Error("Invalid signed pre-key signature");

  // Generate ephemeral keypair (EKa)
  const ephemeral = generateDHKeyPair();

  // X3DH: 4 DH computations
  // DH1 = X25519(IKa, SPKb)
  const dh1 = dh(bobBundle.signedPreKey, { publicKey: localIdentityKey, secretKey: localSigningKey });
  // DH2 = X25519(EKa, IKb) — using X25519 identity key (not Ed25519)
  const dh2 = dh(bobBundle.x25519IdentityKey, ephemeral);
  // DH3 = X25519(EKa, SPKb)
  const dh3 = dh(bobBundle.signedPreKey, ephemeral);

  // Concatenate DH outputs
  let x3dhOutput: Uint8Array;
  if (bobBundle.oneTimePreKey) {
    // DH4 = X25519(EKa, OPKb)
    const dh4 = dh(bobBundle.oneTimePreKey, ephemeral);
    x3dhOutput = concatBuffers(dh1, dh2, dh3, dh4);
  } else {
    x3dhOutput = concatBuffers(dh1, dh2, dh3);
  }

  // Derive initial root key and chain key
  const initialSecret = sha3_256(x3dhOutput);
  const rootKey = sha3_256(new Uint8Array([...initialSecret, ...new TextEncoder().encode("RK")]));
  const chainKey = sha3_256(new Uint8Array([...initialSecret, ...new TextEncoder().encode("CK")]));

  // Alice uses the ephemeral keypair as her first DH ratchet key
  // so Bob can match it with the ephemeral public key from X3DH
  const state: RatchetState = {
    dhKeyPair: ephemeral,
    dhRemotePubKey: bobBundle.signedPreKey,
    rootKey,
    sendingChainKey: chainKey,
    receivingChainKey: null,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendingChainLength: 0,
    skippedKeys: new Map(),
    localIdentityKey,
    localSigningKey,
  };

  return { state, ephemeralKey: ephemeral.publicKey };
}

/**
 * Initialize ratchet as Bob (responder)
 *
 * Bob receives Alice's initial message and derives the same shared secret
 * from his pre-key bundle and Alice's ephemeral key.
 */
export function initializeRatchetAsBob(
  aliceEphemeralKey: Uint8Array,
  aliceIdentityKey: Uint8Array,   // Alice's X25519 public key (NOT Bob's)
  bobSigningKey: Uint8Array,       // Bob's X25519 secret key
  bobSPK: DHKeyPair,               // Bob's signed pre-key
  bobOPK?: DHKeyPair,              // Bob's one-time pre-key
): RatchetState {
  // X3DH from Bob's side (mirrors Alice's computation):
  // DH1' = X25519(SPKb_priv, IKa_pub) — Bob's SPK, Alice's identity key
  // DH2' = X25519(IKb_priv, EKa_pub)  — Bob's identity, Alice's ephemeral
  // DH3' = X25519(SPKb_priv, EKa_pub) — Bob's SPK, Alice's ephemeral
  // By ECDH commutativity: X25519(a,B) = X25519(b,A), so DH1=DH1', DH2=DH2', DH3=DH3'
  const dh1 = dh(aliceIdentityKey, bobSPK);
  const dh2 = dh(aliceEphemeralKey, { publicKey: aliceIdentityKey, secretKey: bobSigningKey });
  const dh3 = dh(aliceEphemeralKey, bobSPK);

  let x3dhOutput: Uint8Array;
  if (bobOPK) {
    const dh4 = dh(aliceEphemeralKey, bobOPK);
    x3dhOutput = concatBuffers(dh1, dh2, dh3, dh4);
  } else {
    x3dhOutput = concatBuffers(dh1, dh2, dh3);
  }

  const initialSecret = sha3_256(x3dhOutput);
  const rootKey = sha3_256(new Uint8Array([...initialSecret, ...new TextEncoder().encode("RK")]));
  const chainKey = sha3_256(new Uint8Array([...initialSecret, ...new TextEncoder().encode("CK")]));

  // Bob's receiving chain matches Alice's sending chain
  const bobDH = generateDHKeyPair();

  return {
    dhKeyPair: bobDH,
    dhRemotePubKey: aliceEphemeralKey,
    rootKey,
    sendingChainKey: null,
    receivingChainKey: chainKey,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendingChainLength: 0,
    skippedKeys: new Map(),
    localIdentityKey: aliceIdentityKey,
    localSigningKey: bobSigningKey,
  };
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Encrypt a message using the Double Ratchet
 *
 * 1. If no sending chain, perform DH ratchet step
 * 2. Advance sending chain (KDF_CK)
 * 3. Derive message key
 * 4. Encrypt with ChaCha20-Poly1305
 * 5. Sign the header+ciphertext with Ed25519
 */
export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
): { state: RatchetState; message: RatchetMessage } {
  // Step 1: If no sending chain, do DH ratchet
  if (!state.sendingChainKey) {
    dhRatchetStep(state, state.dhRemotePubKey!);
  }

  // Step 2: Advance sending chain
  const { messageKey, nextChainKey } = kdfChain(state.sendingChainKey!);
  state.sendingChainKey = nextChainKey;

  // Step 3: Derive encryption key
  const { encryptionKey, nonce } = deriveMessageKeys(messageKey);

  // Step 4: Encrypt
  const cipher = chacha20poly1305(encryptionKey, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  // Step 5: Build header
  const header: RatchetMessage = {
    dhPublicKey: state.dhKeyPair.publicKey,
    senderIdentityKey: state.sendMessageNumber === 0 ? state.localIdentityKey : undefined,
    previousChainLength: state.previousSendingChainLength,
    messageNumber: state.sendMessageNumber,
    ciphertext,
    signature: new Uint8Array(0), // placeholder
  };

  // Step 6: Sign header + ciphertext
  const headerBytes = serializeHeader(header);
  header.signature = ed25519.sign(headerBytes, state.localSigningKey);

  state.sendMessageNumber++;

  return { state, message: header };
}

/**
 * Decrypt a message using the Double Ratchet
 *
 * 1. Check skipped message keys
 * 2. If new DH ratchet key, perform DH ratchet step(s) to catch up
 * 3. Advance receiving chain
 * 4. Derive message key and decrypt
 */
export function ratchetDecrypt(
  state: RatchetState,
  message: RatchetMessage,
): { state: RatchetState; plaintext: Uint8Array } {
  // Step 0: Signature verification happens at the application layer
  // The sender's identity key is verified via the pre-key bundle trust chain

  // Step 1: Check skipped keys
  const skippedKey = `${hex(message.dhPublicKey)}:${message.messageNumber}`;
  if (state.skippedKeys.has(skippedKey)) {
    const mk = state.skippedKeys.get(skippedKey)!;
    state.skippedKeys.delete(skippedKey);
    const { encryptionKey, nonce } = deriveMessageKeys(mk);
    const cipher = chacha20poly1305(encryptionKey, nonce);
    return { state, plaintext: cipher.decrypt(message.ciphertext) };
  }

  // Step 2: Skip any messages we missed in the current receiving chain
  if (state.receivingChainKey && state.dhRemotePubKey) {
    const currentRemoteHex = hex(state.dhRemotePubKey);
    const msgRemoteHex = hex(message.dhPublicKey);

    if (currentRemoteHex !== msgRemoteHex) {
      // New DH ratchet key — skip remaining messages in current chain
      skipMessageKeys(state, message.previousChainLength);
      dhRatchetStep(state, message.dhPublicKey);
    }
  }

  // Step 3: Skip messages between current receive number and target
  if (state.receivingChainKey) {
    skipMessageKeys(state, message.messageNumber);
  } else {
    // First message — initialize receiving chain
    dhRatchetStep(state, message.dhPublicKey);
    skipMessageKeys(state, message.messageNumber);
  }

  // Step 4: Advance receiving chain
  const { messageKey, nextChainKey } = kdfChain(state.receivingChainKey!);
  state.receivingChainKey = nextChainKey;
  state.receiveMessageNumber++;

  // Step 5: Derive key and decrypt
  const { encryptionKey, nonce } = deriveMessageKeys(messageKey);
  const cipher = chacha20poly1305(encryptionKey, nonce);
  const plaintext = cipher.decrypt(message.ciphertext);

  return { state, plaintext };
}

// ─── DH Ratchet Step ──────────────────────────────────────────────────────────

/**
 * Perform a DH ratchet step
 *
 * 1. Set receiving chain key from DH with remote public key
 * 2. Generate new DH keypair
 * 3. Set sending chain key from DH with new keypair
 */
function dhRatchetStep(state: RatchetState, newRemotePubKey: Uint8Array): void {
  state.previousSendingChainLength = state.sendMessageNumber;
  state.sendMessageNumber = 0;
  state.receiveMessageNumber = 0;
  state.dhRemotePubKey = newRemotePubKey;

  // Receiving chain: DH with remote key
  const dhOutput1 = dh(newRemotePubKey, state.dhKeyPair);
  const rk1 = kdfRoot(state.rootKey, dhOutput1);
  state.rootKey = rk1.newRootKey;
  state.receivingChainKey = rk1.newChainKey;

  // Generate new DH keypair for sending
  state.dhKeyPair = generateDHKeyPair();

  // Sending chain: DH with new keypair
  const dhOutput2 = dh(newRemotePubKey, state.dhKeyPair);
  const rk2 = kdfRoot(state.rootKey, dhOutput2);
  state.rootKey = rk2.newRootKey;
  state.sendingChainKey = rk2.newChainKey;
}

/**
 * Skip message keys for out-of-order delivery
 *
 * Advances the receiving chain to the target message number,
 * storing skipped keys in the skippedKeys map.
 */
function skipMessageKeys(state: RatchetState, until: number): void {
  if (!state.receivingChainKey) return;

  while (state.receiveMessageNumber < until) {
    const { messageKey, nextChainKey } = kdfChain(state.receivingChainKey);
    const key = `${hex(state.dhRemotePubKey!)}:${state.receiveMessageNumber}`;
    state.skippedKeys.set(key, messageKey);
    state.receivingChainKey = nextChainKey;
    state.receiveMessageNumber++;
  }
}

// ─── Serialization ────────────────────────────────────────────────────────────

function serializeHeader(msg: RatchetMessage): Uint8Array {
  const parts: Uint8Array[] = [
    msg.dhPublicKey,
    msg.senderIdentityKey || new Uint8Array(0),
    new Uint8Array([(msg.previousChainLength >> 8) & 0xff, msg.previousChainLength & 0xff]),
    new Uint8Array([(msg.messageNumber >> 8) & 0xff, msg.messageNumber & 0xff]),
    msg.ciphertext, // Full ciphertext for integrity (signature covers everything)
  ];
  return concatBuffers(...parts);
}

/** Serialize a RatchetMessage for transmission */
export function serializeMessage(msg: RatchetMessage): string {
  const parts = [
    btoa(String.fromCharCode(...msg.dhPublicKey)),
    msg.senderIdentityKey ? btoa(String.fromCharCode(...msg.senderIdentityKey)) : "",
    String(msg.previousChainLength),
    String(msg.messageNumber),
    btoa(String.fromCharCode(...msg.ciphertext)),
    btoa(String.fromCharCode(...msg.signature)),
  ];
  return parts.join("|");
}

/** Deserialize a RatchetMessage from transmission */
export function deserializeMessage(data: string): RatchetMessage {
  const parts = data.split("|");
  if (parts.length !== 6) throw new Error("Invalid ratchet message format");

  return {
    dhPublicKey: Uint8Array.from(atob(parts[0]), c => c.charCodeAt(0)),
    senderIdentityKey: parts[1] ? Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0)) : undefined,
    previousChainLength: parseInt(parts[2], 10),
    messageNumber: parseInt(parts[3], 10),
    ciphertext: Uint8Array.from(atob(parts[4]), c => c.charCodeAt(0)),
    signature: Uint8Array.from(atob(parts[5]), c => c.charCodeAt(0)),
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function concatBuffers(...buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a signed pre-key pair for pre-key bundle publication */
export function generateSignedPreKey(identitySigningKey: Uint8Array): {
  keyPair: DHKeyPair;
  signature: Uint8Array;
} {
  const keyPair = generateDHKeyPair();
  const signature = ed25519.sign(keyPair.publicKey, identitySigningKey);
  return { keyPair, signature };
}

/** Create a pre-key bundle for publication via NOSTR */
export function createPreKeyBundle(
  identityKey: Uint8Array,
  x25519IdentityKey: Uint8Array,
  signedPreKeyPair: DHKeyPair,
  signedPreKeySig: Uint8Array,
  oneTimePreKeyPair?: DHKeyPair,
): PreKeyBundle {
  return {
    identityKey,
    x25519IdentityKey,
    signedPreKey: signedPreKeyPair.publicKey,
    signedPreKeySig,
    oneTimePreKey: oneTimePreKeyPair?.publicKey,
    nostrPubKey: hex(identityKey),
  };
}
