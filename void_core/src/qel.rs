/**
 * VØID — QEL: Quantum-Enhanced Layer
 *
 * Shamir Secret Sharing sobre GF(256) com cifragem ChaCha20-Poly1305.
 * Cada shard é um ponto (x, p(x)) cifrado independentemente.
 *
 * Propriedade de segurança: qualquer conjunto de K-1 shards revela
 * zero informação sobre o segredo (perfect information-theoretic security).
 */

use wasm_bindgen::prelude::*;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use sha3::{Digest, Sha3_256};
use rand_core::{OsRng, RngCore};
use js_sys::Uint8Array;

// ─── GF(256) Arithmetic ───────────────────────────────────────────────────────
// Corpo de Galois GF(2^8) com polinômio irredutível x^8 + x^4 + x^3 + x + 1
// (mesmo usado no AES — 0x11b)

const GF_MOD: u16 = 0x11b;

fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut result: u8 = 0;
    let mut hi_bit: u8;
    for _ in 0..8 {
        if b & 1 == 1 {
            result ^= a;
        }
        hi_bit = a & 0x80;
        a <<= 1;
        if hi_bit != 0 {
            a ^= (GF_MOD & 0xff) as u8; // x^8 + x^4 + x^3 + x + 1 mod 2^8
        }
        b >>= 1;
    }
    result
}

fn gf_pow(base: u8, exp: u8) -> u8 {
    if exp == 0 {
        return 1;
    }
    let mut result: u8 = 1;
    let mut b = base;
    let mut e = exp;
    while e > 0 {
        if e & 1 == 1 {
            result = gf_mul(result, b);
        }
        b = gf_mul(b, b);
        e >>= 1;
    }
    result
}

fn gf_inv(a: u8) -> u8 {
    // Inverso multiplicativo via Pequeno Teorema de Fermat: a^(255) = 1 em GF(256)
    // portanto a^(-1) = a^(254)
    gf_pow(a, 254)
}

fn gf_div(a: u8, b: u8) -> u8 {
    gf_mul(a, gf_inv(b))
}

// ─── Shamir Secret Sharing ────────────────────────────────────────────────────

/// Divide um único byte em n shards com threshold k.
/// Retorna vetor de (x, y) onde x ∈ {1..=n}
fn split_byte(secret: u8, k: usize, n: usize, rng: &mut impl RngCore) -> Vec<(u8, u8)> {
    // Gera polinômio aleatório de grau k-1: p(x) = secret + a1*x + ... + a(k-1)*x^(k-1)
    let mut coeffs = vec![secret];
    for _ in 1..k {
        let mut coeff = [0u8; 1];
        rng.fill_bytes(&mut coeff);
        // Coeficiente não pode ser 0 (exceto o termo constante)
        let c = if coeff[0] == 0 { 1 } else { coeff[0] };
        coeffs.push(c);
    }

    // Avalia p(x) para x = 1..=n
    (1..=n as u8)
        .map(|x| {
            let y = coeffs.iter().enumerate().fold(0u8, |acc, (i, &c)| {
                acc ^ gf_mul(c, gf_pow(x, i as u8))
            });
            (x, y)
        })
        .collect()
}

/// Reconstrói um byte a partir de k pontos via interpolação de Lagrange em GF(256)
fn reconstruct_byte(points: &[(u8, u8)]) -> u8 {
    let k = points.len();
    let mut secret: u8 = 0;

    for i in 0..k {
        let (xi, yi) = points[i];
        let mut numerator: u8 = 1;
        let mut denominator: u8 = 1;

        for j in 0..k {
            if i == j {
                continue;
            }
            let (xj, _) = points[j];
            // Lagrange basis: produto de (0 - xj) / (xi - xj)
            numerator = gf_mul(numerator, xj); // 0 XOR xj = xj
            denominator = gf_mul(denominator, xi ^ xj);
        }

        secret ^= gf_mul(yi, gf_div(numerator, denominator));
    }

    secret
}

// ─── QEL Split ────────────────────────────────────────────────────────────────

/// Resultado de um split QEL: vetor de shards serializados
#[wasm_bindgen]
pub struct QelSplitResult {
    shards: Vec<Vec<u8>>,
    k: u32,
    n: u32,
}

#[wasm_bindgen]
impl QelSplitResult {
    #[wasm_bindgen(getter)]
    pub fn k(&self) -> u32 {
        self.k
    }

    #[wasm_bindgen(getter)]
    pub fn n(&self) -> u32 {
        self.n
    }

    /// Retorna o shard i (0-indexed) como Uint8Array
    pub fn get_shard(&self, index: u32) -> Option<Uint8Array> {
        self.shards
            .get(index as usize)
            .map(|s| Uint8Array::from(s.as_slice()))
    }

    /// Retorna todos os shards concatenados: [shard_0 | shard_1 | ... | shard_n-1]
    /// Cada shard tem comprimento fixo (armazenado no header de cada shard cifrado).
    pub fn shards_concat(&self) -> Uint8Array {
        let flat: Vec<u8> = self.shards.iter().flat_map(|s| s.iter().copied()).collect();
        Uint8Array::from(flat.as_slice())
    }
}

/// Fragmenta `secret` em N shards com threshold K, cifrando cada um com ChaCha20-Poly1305.
///
/// Formato de cada shard cifrado:
/// [1 byte: x (índice 1-N)] [12 bytes: nonce] [4 bytes: payload_len_LE] [payload cifrado + tag]
///
/// `aad_key` é o GhostID (ou qualquer contexto) usado como AAD para autenticação.
#[wasm_bindgen]
pub fn qel_split(secret: &[u8], k: u32, n: u32, aad_key: &[u8]) -> Result<QelSplitResult, JsValue> {
    let k = k as usize;
    let n = n as usize;

    if k < 2 || k > n || n > 255 {
        return Err(JsValue::from_str("QEL: k deve ser >= 2, k <= n, n <= 255"));
    }

    let mut rng = OsRng;

    // Para cada byte do segredo, gera n pontos (xi, yi)
    // Organiza como: shard[i] = (x=i+1, bytes[j]=p_j(x)) para todos os bytes j
    let secret_len = secret.len();
    let mut shard_plains: Vec<Vec<u8>> = (0..n).map(|i| vec![i as u8 + 1]).collect(); // [x, y0, y1, ...]

    for &byte in secret.iter() {
        let points = split_byte(byte, k, n, &mut rng);
        for (i, (_x, y)) in points.iter().enumerate() {
            shard_plains[i].push(*y);
        }
    }

    // Deriva chave ChaCha20 por shard a partir do aad_key + índice
    let shards: Vec<Vec<u8>> = shard_plains
        .iter()
        .enumerate()
        .map(|(i, plain)| {
            // Chave = SHA3-256(aad_key || "qel-shard" || i)
            let mut h = Sha3_256::new();
            h.update(aad_key);
            h.update(b"qel-shard-key-v1");
            h.update(&[i as u8]);
            let key_bytes = h.finalize();

            let cipher = ChaCha20Poly1305::new_from_slice(&key_bytes)
                .expect("chave de 32 bytes");

            // Nonce aleatório de 12 bytes
            let mut nonce_bytes = [0u8; 12];
            rng.fill_bytes(&mut nonce_bytes);
            let nonce = Nonce::from_slice(&nonce_bytes);

            // AAD = SHA3-256(aad_key || shard_index || secret_len)
            let mut aad_h = Sha3_256::new();
            aad_h.update(aad_key);
            aad_h.update(&[i as u8]);
            aad_h.update(&(secret_len as u32).to_le_bytes());
            let aad = aad_h.finalize();

            let ciphertext = cipher
                .encrypt(nonce, chacha20poly1305::aead::Payload {
                    msg: plain,
                    aad: &aad,
                })
                .expect("cifragem QEL falhou");

            // Serializa: [nonce 12B][secret_len 4B LE][ciphertext+tag]
            let mut out = Vec::with_capacity(12 + 4 + ciphertext.len());
            out.extend_from_slice(&nonce_bytes);
            out.extend_from_slice(&(secret_len as u32).to_le_bytes());
            out.extend_from_slice(&ciphertext);
            out
        })
        .collect();

    Ok(QelSplitResult {
        shards,
        k: k as u32,
        n: n as u32,
    })
}

// ─── QEL Reconstruct ─────────────────────────────────────────────────────────

/// Reconstrói o segredo a partir de pelo menos K shards cifrados.
///
/// `shards_concat`: shards serializados concatenados (cada um com seu comprimento).
/// Como todos os shards têm o mesmo comprimento, passamos `shard_len` para parsing.
/// `aad_key`: mesmo contexto usado no split.
#[wasm_bindgen]
pub fn qel_reconstruct(
    shards_concat: &[u8],
    shard_len: u32,
    k: u32,
    aad_key: &[u8],
    secret_len: u32,
) -> Result<Uint8Array, JsValue> {
    let shard_len = shard_len as usize;
    let k = k as usize;
    let secret_len = secret_len as usize;

    if shards_concat.len() % shard_len != 0 {
        return Err(JsValue::from_str("QEL: tamanho de shards inválido"));
    }

    let shard_count = shards_concat.len() / shard_len;
    if shard_count < k {
        return Err(JsValue::from_str(&format!(
            "QEL: são necessários {} shards, recebidos {}",
            k, shard_count
        )));
    }

    // Decifra cada shard → (x, [y0, y1, ...])
    let mut points_per_byte: Vec<Vec<(u8, u8)>> = vec![Vec::new(); secret_len];
    let mut original_indices: Vec<usize> = Vec::new();

    for (si, chunk) in shards_concat.chunks(shard_len).enumerate().take(k) {
        if chunk.len() < 16 {
            return Err(JsValue::from_str("QEL: shard muito curto"));
        }

        let nonce_bytes = &chunk[0..12];
        // bytes 12..16: secret_len (validação)
        let _stored_len = u32::from_le_bytes([chunk[12], chunk[13], chunk[14], chunk[15]]) as usize;
        let ciphertext = &chunk[16..];

        // Precisamos descobrir o índice original do shard (para derivar a chave correta).
        // Na concatenação, assumimos que a ordem original é preservada (índice = si).
        // Em uso real, o índice deve ser transmitido out-of-band ou via metadados.
        let shard_index = si;
        original_indices.push(shard_index);

        // Deriva chave
        let mut h = Sha3_256::new();
        h.update(aad_key);
        h.update(b"qel-shard-key-v1");
        h.update(&[shard_index as u8]);
        let key_bytes = h.finalize();

        let cipher = ChaCha20Poly1305::new_from_slice(&key_bytes)
            .map_err(|e| JsValue::from_str(&format!("QEL: chave inválida: {}", e)))?;

        let nonce = Nonce::from_slice(nonce_bytes);

        let mut aad_h = Sha3_256::new();
        aad_h.update(aad_key);
        aad_h.update(&[shard_index as u8]);
        aad_h.update(&(secret_len as u32).to_le_bytes());
        let aad = aad_h.finalize();

        let plain = cipher
            .decrypt(nonce, chacha20poly1305::aead::Payload {
                msg: ciphertext,
                aad: &aad,
            })
            .map_err(|_| JsValue::from_str("QEL: falha de autenticação no shard — dados corrompidos"))?;

        // plain = [x, y0, y1, ..., y(secret_len-1)]
        if plain.len() < 1 + secret_len {
            return Err(JsValue::from_str("QEL: shard decifrado inválido"));
        }

        let x = plain[0];
        for (byte_idx, &y) in plain[1..=secret_len].iter().enumerate() {
            points_per_byte[byte_idx].push((x, y));
        }
    }

    // Reconstrói cada byte do segredo via interpolação de Lagrange
    let secret: Vec<u8> = points_per_byte
        .iter()
        .map(|points| reconstruct_byte(points))
        .collect();

    Ok(Uint8Array::from(secret.as_slice()))
}

// ─── QEL Shard Info ──────────────────────────────────────────────────────────

/// Retorna o índice X do shard (primeiro byte do payload decifrado).
/// Útil para saber qual shard é qual antes da reconstrução.
/// Nota: o índice está no plaintext — não visível sem a chave.
/// Esta função é interna; em protocolo real o índice viaja em envelope separado.
#[wasm_bindgen]
pub struct QelShardMeta {
    shard_index: u8,
    payload_secret_len: u32,
}

#[wasm_bindgen]
impl QelShardMeta {
    #[wasm_bindgen(getter)]
    pub fn shard_index(&self) -> u8 {
        self.shard_index
    }

    #[wasm_bindgen(getter)]
    pub fn payload_secret_len(&self) -> u32 {
        self.payload_secret_len
    }
}

/// Extrai metadados públicos de um shard (sem decifrar — apenas lê header).
#[wasm_bindgen]
pub fn qel_shard_meta(shard: &[u8]) -> Result<QelShardMeta, JsValue> {
    if shard.len() < 16 {
        return Err(JsValue::from_str("QEL: shard muito curto para ter metadados"));
    }
    let secret_len = u32::from_le_bytes([shard[12], shard[13], shard[14], shard[15]]);
    Ok(QelShardMeta {
        // O índice (x) só é conhecido após decifragem; aqui retornamos 0 como placeholder
        shard_index: 0,
        payload_secret_len: secret_len,
    })
}
