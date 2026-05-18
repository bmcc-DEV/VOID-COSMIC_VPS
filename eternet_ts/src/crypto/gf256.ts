/**
 * VØID Core — GF(256) Galois Field Arithmetic
 *
 * Tabelas de logaritmo e exponenciação para operações em GF(2^8).
 * Usado por Shamir Secret Sharing (QEL, CryptoTestament, DoubleSpendDefense).
 */

/** Multiplicação em GF(256) */
export function gfMul(a: number, b: number): number {
  let x = a & 0xff;
  let y = b & 0xff;
  let result = 0;

  for (let i = 0; i < 8; i++) {
    if (y & 1) result ^= x;
    const carry = x & 0x80;
    x = (x << 1) & 0xff;
    if (carry) x ^= 0x1b; // redução por x^8 + x^4 + x^3 + x + 1 (0x11b)
    y >>= 1;
  }

  return result;
}

/** Inverso em GF(256) */
export function gfInv(a: number): number {
  if (a === 0) throw new Error("GF inverse of zero");
  // Em GF(2^8), a^-1 = a^254 para qualquer a != 0.
  let result = 1;
  let base = a & 0xff;
  let exp = 254;

  while (exp > 0) {
    if (exp & 1) result = gfMul(result, base);
    base = gfMul(base, base);
    exp >>= 1;
  }

  return result;
}
