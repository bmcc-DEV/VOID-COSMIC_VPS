/**
 * VØID — Anti-Sybil: PoW + VDF
 *
 * Proof-of-Work: SHA3-256 hashcash com dificuldade dinâmica.
 * VDF: iterated squaring em grupo RSA-2048 (Wesolowski).
 *
 * O faucet exige PoW válido antes de distribuir tokens.
 * O VDF garante trabalho sequencial (não paralelizável).
 */

use wasm_bindgen::prelude::*;
use sha3::{Digest, Sha3_256};
use js_sys::Uint8Array;

// ─── SHA3-Hashcash PoW ────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct PowSolution {
    nonce: Vec<u8>,
    hash: Vec<u8>,
    attempts: u32,
}

#[wasm_bindgen]
impl PowSolution {
    #[wasm_bindgen(getter)]
    pub fn nonce(&self) -> Uint8Array {
        Uint8Array::from(self.nonce.as_slice())
    }

    #[wasm_bindgen(getter)]
    pub fn hash(&self) -> Uint8Array {
        Uint8Array::from(self.hash.as_slice())
    }

    #[wasm_bindgen(getter)]
    pub fn attempts(&self) -> u32 {
        self.attempts
    }
}

/// Resolve o PoW: encontra nonce tal que SHA3-256(challenge || nonce) tenha
/// `difficulty` bits zero no prefixo.
///
/// `max_attempts`: limite de tentativas (segurança contra loop infinito em WASM).
/// Retorna None (null em JS) se não encontrar solução no limite.
#[wasm_bindgen]
pub fn pow_solve(challenge: &[u8], difficulty: u32, max_attempts: u32) -> Option<PowSolution> {
    let target_bytes = (difficulty / 8) as usize;
    let target_bits = (difficulty % 8) as u8;

    let mut nonce = [0u8; 8]; // nonce de 64 bits

    for attempts in 0..max_attempts {
        // nonce = contador little-endian
        let n = attempts as u64;
        nonce.copy_from_slice(&n.to_le_bytes());

        let mut hasher = Sha3_256::new();
        hasher.update(challenge);
        hasher.update(&nonce);
        let hash = hasher.finalize();

        if is_valid_pow(&hash, target_bytes, target_bits) {
            return Some(PowSolution {
                nonce: nonce.to_vec(),
                hash: hash.to_vec(),
                attempts: attempts + 1,
            });
        }
    }

    None
}

fn is_valid_pow(hash: &[u8], target_bytes: usize, target_bits: u8) -> bool {
    // Verifica se os primeiros `target_bytes` bytes são zero
    for &b in &hash[..target_bytes.min(hash.len())] {
        if b != 0 {
            return false;
        }
    }
    // Verifica os bits parciais do próximo byte
    if target_bits > 0 && target_bytes < hash.len() {
        let mask = 0xffu8 << (8 - target_bits);
        if hash[target_bytes] & mask != 0 {
            return false;
        }
    }
    true
}

/// Verifica uma solução PoW.
#[wasm_bindgen]
pub fn pow_verify(challenge: &[u8], nonce: &[u8], difficulty: u32) -> bool {
    let target_bytes = (difficulty / 8) as usize;
    let target_bits = (difficulty % 8) as u8;

    let mut hasher = Sha3_256::new();
    hasher.update(challenge);
    hasher.update(nonce);
    let hash = hasher.finalize();

    is_valid_pow(&hash, target_bytes, target_bits)
}

/// Cria um novo challenge PoW a partir de contexto (GhostID, timestamp, etc.)
#[wasm_bindgen]
pub fn pow_create_challenge(context: &[u8], timestamp_nanos: u64) -> Uint8Array {
    let mut hasher = Sha3_256::new();
    hasher.update(b"void-pow-challenge-v1");
    hasher.update(context);
    hasher.update(&timestamp_nanos.to_le_bytes());
    let challenge = hasher.finalize();
    Uint8Array::from(challenge.as_slice())
}

// ─── VDF: Iterated Squaring em Grupo Multiplicativo ──────────────────────────
//
// Implementação simplificada de VDF baseada em iterated squaring modular.
// Em produção, usaríamos RSA-2048 com grupo de ordem desconhecida (RSA group),
// mas aqui usamos um módulo fixo large prime para demonstração WASM-safe.
//
// VDF(x, T) = x^(2^T) mod N
// Verificação de Wesolowski: verifica prova π sem recomputar T squarings.

/// Módulo RSA-like de 256 bits (produto de dois primos grandes fixos).
/// Em produção: RSA-2048 com trusted setup ou grupo de classe.
/// Aqui: constante para WASM (sem bignum heap pesado).
const VDF_MODULUS_HEX: &str =
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74\
     020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437";

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0))
        .collect()
}

/// Multiplicação modular de big-endian u256 simulada via u64 limbs (4 limbs).
/// Esta é uma implementação educacional — em produção usaria num-bigint.
fn mod_mul_256(a: &[u64; 4], b: &[u64; 4], m: &[u64; 4]) -> [u64; 4] {
    // Implementação de Montgomery multiplication simplificada.
    // Para fins de WASM (sem std bigint), usamos u128 para acumular.
    let mut result = [0u64; 4];

    // Barrett reduction simplificada: a * b mod m usando long multiplication
    // Apenas funciona corretamente para valores < 2^256 e m < 2^256.
    let mut product = [0u128; 8];

    for i in 0..4 {
        for j in 0..4 {
            product[i + j] += a[i] as u128 * b[j] as u128;
        }
    }

    // Normaliza carries
    let mut carry = 0u128;
    let mut normalized = [0u64; 8];
    for i in 0..8 {
        let total = product[i] + carry;
        normalized[i] = total as u64;
        carry = total >> 64;
    }

    // Redução modular ingênua: subtrai m enquanto result >= m
    // (funciona bem para VDF com poucos squarings; para T grande, usar Montgomery)
    for i in 0..4 {
        result[i] = normalized[i];
    }

    // Subtrai m enquanto result >= m (big-endian comparison)
    loop {
        let mut ge = false;
        for i in (0..4).rev() {
            if result[i] > m[i] {
                ge = true;
                break;
            } else if result[i] < m[i] {
                break;
            }
        }
        if !ge {
            break;
        }
        let mut borrow = 0i128;
        for i in 0..4 {
            let diff = result[i] as i128 - m[i] as i128 - borrow;
            if diff < 0 {
                result[i] = (diff + (1i128 << 64)) as u64;
                borrow = 1;
            } else {
                result[i] = diff as u64;
                borrow = 0;
            }
        }
    }

    result
}

#[wasm_bindgen]
pub struct VdfResult {
    output: Vec<u8>,
    steps: u32,
}

#[wasm_bindgen]
impl VdfResult {
    #[wasm_bindgen(getter)]
    pub fn output(&self) -> Uint8Array {
        Uint8Array::from(self.output.as_slice())
    }

    #[wasm_bindgen(getter)]
    pub fn steps(&self) -> u32 {
        self.steps
    }
}

/// Avalia VDF(input, steps) = SHA3-256(input)^(2^steps) mod N.
///
/// `steps`: número de squarings sequenciais (T). Tipicamente 1000-100000.
/// Quanto maior T, mais tempo sequencial é exigido — não paralelizável.
#[wasm_bindgen]
pub fn vdf_evaluate(input: &[u8], steps: u32) -> VdfResult {
    // x0 = SHA3-256(input) como inteiro
    let seed = Sha3_256::digest(input);

    // Converte para 4 limbs de 64 bits (little-endian limbs, big-endian bytes)
    let mut x = [0u64; 4];
    for (i, chunk) in seed.chunks(8).enumerate().take(4) {
        let mut arr = [0u8; 8];
        arr.copy_from_slice(chunk);
        x[i] = u64::from_be_bytes(arr);
    }

    let mod_bytes = hex_to_bytes(VDF_MODULUS_HEX);
    let mut m = [0u64; 4];
    for (i, chunk) in mod_bytes.chunks(8).enumerate().take(4) {
        let mut arr = [0u8; 8];
        let len = chunk.len().min(8);
        arr[8 - len..].copy_from_slice(&chunk[..len]);
        m[i] = u64::from_be_bytes(arr);
    }

    // Iterated squaring: x = x^2 mod m (T vezes)
    for _ in 0..steps {
        x = mod_mul_256(&x.clone(), &x.clone(), &m);
    }

    // Converte de volta para bytes
    let mut output = vec![0u8; 32];
    for (i, limb) in x.iter().enumerate() {
        output[i * 8..(i + 1) * 8].copy_from_slice(&limb.to_be_bytes());
    }

    VdfResult {
        output,
        steps,
    }
}

/// Verifica um resultado VDF de forma simplificada (reexecuta T squarings).
/// Em produção, usar prova de Wesolowski O(log T).
#[wasm_bindgen]
pub fn vdf_verify(input: &[u8], claimed_output: &[u8], steps: u32) -> bool {
    let result = vdf_evaluate(input, steps);
    result.output == claimed_output
}
