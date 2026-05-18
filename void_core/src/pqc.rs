/**
 * VØID — PQC: Post-Quantum Cryptography
 *
 * ML-KEM-1024 (NIST FIPS 203) — Key Encapsulation Mechanism, Level 5
 * ML-DSA-87   (NIST FIPS 204) — Digital Signature Algorithm, Level 5
 */

use wasm_bindgen::prelude::*;
use js_sys::Uint8Array;
use hybrid_array::Array;

// ─── ML-KEM-1024 ─────────────────────────────────────────────────────────────

use ml_kem::{
    MlKem1024,
    kem::{Kem, Encapsulate, Decapsulate},
    DecapsulationKey1024, EncapsulationKey1024,
    KeyExport,
    Ciphertext,
};

const MLKEM1024_EK_BYTES: usize = 1568;
const MLKEM1024_SEED_BYTES: usize = 64;
const MLKEM1024_CT_BYTES: usize = 1568;

#[wasm_bindgen]
pub struct KemKeyPairWasm {
    /// Chave pública (1568 bytes)
    public_key: Vec<u8>,
    /// Seed privada (64 bytes)
    private_seed: Vec<u8>,
}

#[wasm_bindgen]
impl KemKeyPairWasm {
    #[wasm_bindgen(getter)]
    pub fn public_key(&self) -> Uint8Array {
        Uint8Array::from(self.public_key.as_slice())
    }

    #[wasm_bindgen(getter)]
    pub fn private_seed(&self) -> Uint8Array {
        Uint8Array::from(self.private_seed.as_slice())
    }
}

/// Gera par de chaves ML-KEM-1024.
#[wasm_bindgen]
pub fn mlkem_keygen() -> KemKeyPairWasm {
    let (dk, ek) = MlKem1024::generate_keypair();

    KemKeyPairWasm {
        public_key: ek.to_bytes().as_slice().to_vec(),
        private_seed: dk.to_bytes().as_slice().to_vec(),
    }
}

#[wasm_bindgen]
pub struct KemEncapResult {
    ciphertext: Vec<u8>,
    shared_secret: Vec<u8>,
}

#[wasm_bindgen]
impl KemEncapResult {
    #[wasm_bindgen(getter)]
    pub fn ciphertext(&self) -> Uint8Array {
        Uint8Array::from(self.ciphertext.as_slice())
    }

    #[wasm_bindgen(getter)]
    pub fn shared_secret(&self) -> Uint8Array {
        Uint8Array::from(self.shared_secret.as_slice())
    }
}

/// Encapsula: gera ciphertext + shared_secret a partir da chave pública.
#[wasm_bindgen]
pub fn mlkem_encapsulate(public_key_bytes: &[u8]) -> Result<KemEncapResult, JsValue> {
    if public_key_bytes.len() != MLKEM1024_EK_BYTES {
        return Err(JsValue::from_str(&format!(
            "ML-KEM-1024: chave pública deve ter {} bytes, recebidos {}",
            MLKEM1024_EK_BYTES, public_key_bytes.len()
        )));
    }

    let key_arr = Array::<u8, _>::try_from(public_key_bytes)
        .map_err(|_| JsValue::from_str("ML-KEM-1024: tamanho de chave pública inválido"))?;
    let ek = EncapsulationKey1024::new(&key_arr)
        .map_err(|_| JsValue::from_str("ML-KEM-1024: chave pública inválida"))?;

    // encapsulate() retorna (Ciphertext, SharedKey) — infalivelmente
    let (ct, ss) = ek.encapsulate();

    Ok(KemEncapResult {
        ciphertext: ct.as_slice().to_vec(),
        shared_secret: ss.as_slice().to_vec(),
    })
}

/// Decapsula: recupera shared_secret a partir do ciphertext e seed privada.
#[wasm_bindgen]
pub fn mlkem_decapsulate(
    private_seed_bytes: &[u8],
    ciphertext_bytes: &[u8],
) -> Result<Uint8Array, JsValue> {
    if private_seed_bytes.len() != MLKEM1024_SEED_BYTES {
        return Err(JsValue::from_str(&format!(
            "ML-KEM-1024: seed privada deve ter {} bytes",
            MLKEM1024_SEED_BYTES
        )));
    }
    if ciphertext_bytes.len() != MLKEM1024_CT_BYTES {
        return Err(JsValue::from_str(&format!(
            "ML-KEM-1024: ciphertext deve ter {} bytes",
            MLKEM1024_CT_BYTES
        )));
    }

    let seed_arr = Array::<u8, _>::try_from(private_seed_bytes)
        .map_err(|_| JsValue::from_str("ML-KEM-1024: seed inválida"))?;
    let dk = DecapsulationKey1024::from_seed(seed_arr);

    let ct_arr = Array::<u8, _>::try_from(ciphertext_bytes)
        .map_err(|_| JsValue::from_str("ML-KEM-1024: ciphertext inválido"))?;
    let ct = Ciphertext::<MlKem1024>::from(ct_arr);

    let ss = dk.decapsulate(&ct);

    Ok(Uint8Array::from(ss.as_slice()))
}

// ─── ML-DSA-87 ───────────────────────────────────────────────────────────────

use ml_dsa::{
    MlDsa87,
    SigningKey, VerifyingKey,
    Generate, Keypair,
    EncodedVerifyingKey,
    Seed as DsaSeed,
    SignatureEncoding,
};
use ml_dsa::signature::{Signer, Verifier};

const MLDSA87_VK_BYTES: usize = 2592;
const MLDSA87_SEED_BYTES: usize = 32;
const MLDSA87_SIG_BYTES: usize = 4627;

#[wasm_bindgen]
pub struct DsaKeyPairWasm {
    /// Chave pública (2592 bytes)
    public_key: Vec<u8>,
    /// Seed privada (32 bytes)
    signing_seed: Vec<u8>,
}

#[wasm_bindgen]
impl DsaKeyPairWasm {
    #[wasm_bindgen(getter)]
    pub fn public_key(&self) -> Uint8Array {
        Uint8Array::from(self.public_key.as_slice())
    }

    #[wasm_bindgen(getter)]
    pub fn signing_seed(&self) -> Uint8Array {
        Uint8Array::from(self.signing_seed.as_slice())
    }
}

/// Gera par de chaves ML-DSA-87.
#[wasm_bindgen]
pub fn mldsa_keygen() -> DsaKeyPairWasm {
    let sk = SigningKey::<MlDsa87>::generate();
    let vk = sk.verifying_key();

    DsaKeyPairWasm {
        public_key: vk.to_bytes().as_slice().to_vec(),
        signing_seed: sk.to_bytes().as_slice().to_vec(),
    }
}

/// Assina com ML-DSA-87. Retorna assinatura de 4627 bytes.
#[wasm_bindgen]
pub fn mldsa_sign(signing_seed_bytes: &[u8], message: &[u8]) -> Result<Uint8Array, JsValue> {
    if signing_seed_bytes.len() != MLDSA87_SEED_BYTES {
        return Err(JsValue::from_str(&format!(
            "ML-DSA-87: seed deve ter {} bytes",
            MLDSA87_SEED_BYTES
        )));
    }

    let seed = DsaSeed::try_from(signing_seed_bytes)
        .map_err(|_| JsValue::from_str("ML-DSA-87: seed inválida"))?;
    let sk = SigningKey::<MlDsa87>::from_seed(&seed);

    let sig = sk.try_sign(message)
        .map_err(|e| JsValue::from_str(&format!("ML-DSA-87: assinatura falhou: {}", e)))?;

    Ok(Uint8Array::from(sig.to_bytes().as_slice()))
}

/// Verifica assinatura ML-DSA-87. Retorna `true` se válida.
#[wasm_bindgen]
pub fn mldsa_verify(
    public_key_bytes: &[u8],
    message: &[u8],
    signature_bytes: &[u8],
) -> bool {
    use ml_dsa::Signature;

    if public_key_bytes.len() != MLDSA87_VK_BYTES
        || signature_bytes.len() != MLDSA87_SIG_BYTES
    {
        return false;
    }

    let enc_vk = match EncodedVerifyingKey::<MlDsa87>::try_from(public_key_bytes) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let vk = VerifyingKey::<MlDsa87>::decode(&enc_vk);

    let sig = match Signature::<MlDsa87>::try_from(signature_bytes) {
        Ok(s) => s,
        Err(_) => return false,
    };

    vk.verify(message, &sig).is_ok()
}
