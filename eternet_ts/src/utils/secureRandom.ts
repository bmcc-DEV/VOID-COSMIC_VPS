/** Gera string hex aleatória de `bytes` bytes (default: 4 = 8 hex chars). */
export function secureRandomId(bytes: number = 4): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Gera inteiro aleatório seguro em [0, max) — sem modulo bias (rejection sampling). */
export function secureRandomInt(max: number): number {
  if (max <= 0) return 0;
  // Rejection sampling: descarta valores que causariam bias
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

/** Gera float aleatório seguro em [0, 1). */
export function secureRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / (0xFFFFFFFF + 1);
}
