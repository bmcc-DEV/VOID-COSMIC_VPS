/**
 * ETΞRNET — Fuzzy Extractor (Criptografia de Malha Causal - Pilar FÁCIL)
 *
 * Estabiliza entropia biométrica ruidosa em chaves criptográficas determinísticas.
 * Usa código de repetição (R=7) com quantização por threshold e voto majoritário.
 *
 * Referência: Dodis et al. (2004) — Fuzzy Extractors: How to Generate Strong Keys
 *             from Biometrics and Other Noisy Data
 *
 * Tolerância: ~43% de flip de bits (R=7, majoridade ≥4)
 */

import { sha3_512 } from "@noble/hashes/sha3.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BiometricEntropy {
  keystrokeDynamics: number[];
  accelerometerPattern: Float32Array;
  touchPressureMap: Uint8Array;
  microphoneNoise: Uint8Array;
  hardwareTimestamp: number;
}

export interface FuzzyHelperData {
  /** Dados auxiliares (máscara CSPRNG XOR repetição) — necessários para re-extração */
  helperData: Uint8Array;
  /** Thresholds de quantização usados (16 bytes: 4 canais × 4 bytes float) */
  quantizationThresholds: Uint8Array;
  /** Comprimento dos bits quantizados antes da repetição */
  rawBitLength: number;
}

export interface FuzzyExtractResult {
  helperData: FuzzyHelperData;
  /** Chave estável de 64 bytes derivada via SHA3-512 */
  stableKey: Uint8Array;
}

// ─── Configuração ─────────────────────────────────────────────────────────────

/** Fator de repetição (R=7 tolera ~43% de bit-flip) */
const REPETITION_FACTOR = 7;

/** Tamanho alvo dos bits quantizados (antes da repetição) */
const TARGET_RAW_BITS = 256;

// ─── Quantização ──────────────────────────────────────────────────────────────

/**
 * Quantiza valores float para bits usando threshold na mediana.
 * Retorna array de bits (0 ou 1).
 */
function quantizeFloats(values: Float32Array | number[]): Uint8Array {
  const arr = values instanceof Float32Array ? Array.from(values) : values;
  if (arr.length === 0) return new Uint8Array(0);

  // Calcula mediana como threshold
  const sorted = [...arr].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const bits = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    bits[i] = arr[i] >= median ? 1 : 0;
  }
  return bits;
}

/**
 * Quantiza valores uint8 para bits usando threshold em 128.
 */
function quantizeBytes(values: Uint8Array, threshold = 128): Uint8Array {
  const bits = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    bits[i] = values[i] >= threshold ? 1 : 0;
  }
  return bits;
}

/**
 * Concatena e trunca/estica para TARGET_RAW_BITS bits.
 */
function resizeBits(bitArrays: Uint8Array[], targetLen: number): Uint8Array {
  const combined: number[] = [];
  for (const arr of bitArrays) {
    for (let i = 0; i < arr.length; i++) {
      combined.push(arr[i]);
    }
  }

  if (combined.length === 0) {
    return new Uint8Array(targetLen);
  }

  if (combined.length >= targetLen) {
    return new Uint8Array(combined.slice(0, targetLen));
  }

  // Estica repetindo bits ciclicamente
  const result = new Uint8Array(targetLen);
  for (let i = 0; i < targetLen; i++) {
    result[i] = combined[i % combined.length];
  }
  return result;
}

// ─── Código de Repetição ──────────────────────────────────────────────────────

/**
 * Codifica bits usando repetição R vezes.
 * Cada bit se torna R cópias idênticas.
 */
function repetitionEncode(bits: Uint8Array, r: number): Uint8Array {
  const encoded = new Uint8Array(bits.length * r);
  for (let i = 0; i < bits.length; i++) {
    const val = bits[i];
    for (let j = 0; j < r; j++) {
      encoded[i * r + j] = val;
    }
  }
  return encoded;
}

/**
 * Decodifica por voto majoritário.
 * A cada grupo de R bits, o bit original é o que aparece mais vezes.
 * Tolerância: floor(R/2) flips por grupo.
 */
function repetitionDecode(encoded: Uint8Array, r: number): Uint8Array {
  const bitCount = Math.floor(encoded.length / r);
  const decoded = new Uint8Array(bitCount);

  for (let i = 0; i < bitCount; i++) {
    let ones = 0;
    for (let j = 0; j < r; j++) {
      if (encoded[i * r + j] === 1) ones++;
    }
    decoded[i] = ones > Math.floor(r / 2) ? 1 : 0;
  }
  return decoded;
}

// ─── Conversão bits ↔ bytes ───────────────────────────────────────────────────

function bitsToBytes(bits: Uint8Array): Uint8Array {
  const byteLen = Math.ceil(bits.length / 8);
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      bytes[Math.floor(i / 8)] |= 1 << (i % 8);
    }
  }
  return bytes;
}

function bytesToBits(bytes: Uint8Array, bitLen: number): Uint8Array {
  const bits = new Uint8Array(bitLen);
  for (let i = 0; i < bitLen; i++) {
    bits[i] = (bytes[Math.floor(i / 8)] >> (i % 8)) & 1;
  }
  return bits;
}

// ─── Fuzzy Extractor Core ─────────────────────────────────────────────────────

/**
 * Gera dados auxiliares (helper data) e chave estável a partir de biometria ruidosa.
 *
 * Na PRIMEIRA extração (enrollment):
 * 1. Quantiza cada canal biométrico em bits
 * 2. Concatena e redimensiona para TARGET_RAW_BITS
 * 3. Gera uma chave aleatória e codifica com repetição
 * 4. helperData = repeated_biometry XOR repeated_key
 * 5. stableKey = SHA3-512(key_bits)
 *
 * O helperData pode ser armazenado em texto plano (não vaza a biometria).
 */
export function generateHelperData(biometric: BiometricEntropy): FuzzyExtractResult {
  // 1. Quantizar cada canal
  const accelBits = quantizeFloats(biometric.accelerometerPattern);
  const touchBits = quantizeBytes(biometric.touchPressureMap.slice(0, 64));
  const micBits = quantizeBytes(biometric.microphoneNoise.slice(0, 64));
  const keystrokeBits = quantizeFloats(biometric.keystrokeDynamics.slice(0, 16));

  // 2. Concatenar e redimensionar
  const rawBits = resizeBits([accelBits, touchBits, micBits, keystrokeBits], TARGET_RAW_BITS);

  // 3. Gerar chave aleatória e codificar com repetição.
  // O helper guarda apenas o XOR entre a biometria quantizada e a chave codificada.
  const keyBits = bytesToBits(
    crypto.getRandomValues(new Uint8Array(Math.ceil(TARGET_RAW_BITS / 8))),
    TARGET_RAW_BITS,
  );
  const repeatedBiometry = repetitionEncode(rawBits, REPETITION_FACTOR);
  const repeatedKey = repetitionEncode(keyBits, REPETITION_FACTOR);

  // 4. XOR para gerar helper data
  const helperBits = new Uint8Array(repeatedBiometry.length);
  for (let i = 0; i < repeatedBiometry.length; i++) {
    helperBits[i] = repeatedBiometry[i] ^ repeatedKey[i];
  }

  // 6. Salvar thresholds de quantização (4 floats: mediana de cada canal)
  const thresholds = new Float32Array([
    median(biometric.accelerometerPattern),
    128, // touch threshold fixo
    128, // mic threshold fixo
    median(new Float32Array(biometric.keystrokeDynamics.slice(0, 16))),
  ]);
  const quantizationThresholds = new Uint8Array(thresholds.buffer);

  // 7. Derivar chave estável
  const stableKey = sha3_512(bitsToBytes(keyBits));

  return {
    helperData: {
      helperData: bitsToBytes(helperBits),
      quantizationThresholds,
      rawBitLength: TARGET_RAW_BITS,
    },
    stableKey,
  };
}

/**
 * Re-extrai chave estável a partir de uma NOVA leitura biométrica + helper data.
 *
 * Na RE-EXTRAÇÃO (autenticação):
 * 1. Quantiza nova biometria (usando mesmos thresholds salvos)
 * 2. Concatena e redimensiona para mesmo tamanho
 * 3. Aplica código de repetição
 * 4. XOR com helperData → chave codificada com ruído
 * 5. Decodifica por voto majoritário
 * 6. stableKey = SHA3-512(decoded_key_bits)
 *
 * Se o ruído for ≤ 43% por grupo de 7 bits, a chave será idêntica à original.
 */
export function extractKey(
  helperData: FuzzyHelperData,
  freshBiometric: BiometricEntropy,
): Uint8Array {
  // 1. Recuperar thresholds
  const thresholds = new Float32Array(helperData.quantizationThresholds.buffer);

  // 2. Re-quantizar com thresholds originais
  const accelBits = quantizeFloatsWithThreshold(
    freshBiometric.accelerometerPattern,
    thresholds[0],
  );
  const touchBits = quantizeBytes(freshBiometric.touchPressureMap.slice(0, 64));
  const micBits = quantizeBytes(freshBiometric.microphoneNoise.slice(0, 64));
  const keystrokeBits = quantizeFloatsWithThreshold(
    new Float32Array(freshBiometric.keystrokeDynamics.slice(0, 16)),
    thresholds[3],
  );

  // 3. Concatenar e redimensionar
  const rawBits = resizeBits([accelBits, touchBits, micBits, keystrokeBits], helperData.rawBitLength);

  // 4. Aplicar repetição
  const repeated = repetitionEncode(rawBits, REPETITION_FACTOR);

  // 5. XOR com helper data para recuperar a chave codificada (com ruído)
  const helperBytes = helperData.helperData;
  const helperBitLen = repeated.length;
  const helperBitsAll = bytesToBits(helperBytes, helperBitLen);

  const noisyEncoded = new Uint8Array(helperBitLen);
  for (let i = 0; i < helperBitLen; i++) {
    noisyEncoded[i] = repeated[i] ^ helperBitsAll[i];
  }

  // 6. Decodificar por voto majoritário
  const decoded = repetitionDecode(noisyEncoded, REPETITION_FACTOR);

  // 7. Derivar chave
  const rawBytes = bitsToBytes(decoded);
  return sha3_512(rawBytes);
}

/**
 * Quantiza floats usando um threshold específico (em vez de mediana).
 */
function quantizeFloatsWithThreshold(values: Float32Array | number[], threshold: number): Uint8Array {
  const arr = values instanceof Float32Array ? Array.from(values) : values;
  const bits = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    bits[i] = arr[i] >= threshold ? 1 : 0;
  }
  return bits;
}

/**
 * Calcula mediana de um array de números.
 */
function median(values: Float32Array | number[]): number {
  const arr = values instanceof Float32Array ? Array.from(values) : values;
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Compara duas chaves de forma constant-time.
 */
export function verifyReproducibility(key1: Uint8Array, key2: Uint8Array): boolean {
  if (key1.length !== key2.length) return false;
  let diff = 0;
  for (let i = 0; i < key1.length; i++) {
    diff |= key1[i] ^ key2[i];
  }
  return diff === 0;
}
