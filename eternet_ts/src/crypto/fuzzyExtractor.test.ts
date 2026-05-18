import { describe, expect, it } from 'vitest';
import {
  extractKey,
  generateHelperData,
  verifyReproducibility,
  type BiometricEntropy,
} from './fuzzyExtractor';

function makeBiometricEntropy(): BiometricEntropy {
  return {
    keystrokeDynamics: [12, 13, 14, 15, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101],
    accelerometerPattern: new Float32Array([
      -0.9, -0.8, -0.7, -0.6, -0.5, -0.4, -0.3, -0.2,
      0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
    ]),
    touchPressureMap: new Uint8Array([
      ...new Array(32).fill(20),
      ...new Array(32).fill(230),
      ...new Array(192).fill(0),
    ]),
    microphoneNoise: new Uint8Array([
      ...new Array(32).fill(30),
      ...new Array(32).fill(220),
      ...new Array(64).fill(0),
    ]),
    hardwareTimestamp: 123456.789,
  };
}

describe('fuzzyExtractor', () => {
  it('gera helper data e chave de 64 bytes', () => {
    const result = generateHelperData(makeBiometricEntropy());

    expect(result.stableKey).toBeInstanceOf(Uint8Array);
    expect(result.stableKey).toHaveLength(64);
    expect(result.helperData.rawBitLength).toBe(256);
    expect(result.helperData.helperData.length).toBeGreaterThan(0);
    expect(result.helperData.quantizationThresholds).toHaveLength(16);
  });

  it('re-extrai a mesma chave com a mesma biometria', () => {
    const biometric = makeBiometricEntropy();
    const { helperData, stableKey } = generateHelperData(biometric);
    const recoveredKey = extractKey(helperData, biometric);

    expect(verifyReproducibility(stableKey, recoveredKey)).toBe(true);
  });

  it('mantém a chave quando ruído pequeno não cruza thresholds', () => {
    const biometric = makeBiometricEntropy();
    const noisyBiometric = makeBiometricEntropy();
    noisyBiometric.accelerometerPattern[0] = -0.85;
    noisyBiometric.accelerometerPattern[15] = 0.85;
    noisyBiometric.keystrokeDynamics[0] = 13;
    noisyBiometric.touchPressureMap[0] = 21;
    noisyBiometric.microphoneNoise[63] = 219;

    const { helperData, stableKey } = generateHelperData(biometric);
    const recoveredKey = extractKey(helperData, noisyBiometric);

    expect(verifyReproducibility(stableKey, recoveredKey)).toBe(true);
  });

  it('compara chaves em tempo constante por tamanho e conteúdo', () => {
    const key = new Uint8Array(64).fill(0x42);
    const same = new Uint8Array(64).fill(0x42);
    const different = new Uint8Array(64).fill(0x42);
    different[63] = 0x43;

    expect(verifyReproducibility(key, same)).toBe(true);
    expect(verifyReproducibility(key, different)).toBe(false);
    expect(verifyReproducibility(key, new Uint8Array(32))).toBe(false);
  });
});
