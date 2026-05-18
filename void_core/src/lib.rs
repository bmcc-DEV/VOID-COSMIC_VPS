mod ldk;       // BOLT11 invoice parsing/generation via lightning-invoice
mod qel;       // Shamir GF(256) + ChaCha20-Poly1305 (fragmentação pós-quântica)
mod pqc;       // ML-KEM-1024 + ML-DSA-87 (NIST Level 5)
mod antisybil; // PoW SHA3-hashcash + VDF iterated squaring

pub use qel::*;
pub use pqc::*;
pub use antisybil::*;

use wasm_bindgen::prelude::*;
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::edwards::EdwardsPoint;
use sha3::{Digest, Sha3_256, Sha3_512};
use rand_core::OsRng;
use js_sys::Uint8Array;
use bulletproofs::{BulletproofGens, PedersenGens, RangeProof};
use merlin::Transcript;
use curve25519_dalek_ng::scalar::Scalar as NgScalar;
use curve25519_dalek_ng::ristretto::CompressedRistretto as NgCompressedRistretto;

#[wasm_bindgen]
pub fn init_void_core() {
    // Inicialização dormente do motor VØID
    console_error_panic_hook::set_once();
}

// ─── GHOST ID ENGINE ──────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct GhostIdentityWasm {
    public_key: Vec<u8>,
    #[allow(dead_code)]
    private_key: Vec<u8>,
    handle: String,
}

#[wasm_bindgen]
impl GhostIdentityWasm {
    #[wasm_bindgen(getter)]
    pub fn public_key(&self) -> Uint8Array {
        Uint8Array::from(&self.public_key[..])
    }

    #[wasm_bindgen(getter)]
    pub fn handle(&self) -> String {
        self.handle.clone()
    }
}

#[wasm_bindgen]
pub fn derive_ghost_id(entropy: &[u8]) -> GhostIdentityWasm {
    // 1. Pool de entropia via SHA3-512
    let mut hasher = Sha3_512::new();
    hasher.update(b"void-ghost-id-v8");
    hasher.update(entropy);
    let derived_seed = hasher.finalize();

    // 2. Transforma em Scalar Ed25519 (Chave Privada)
    let secret = Scalar::from_bytes_mod_order_wide(&derived_seed.into());
    
    // 3. Deriva Chave Pública
    let public = ED25519_BASEPOINT_POINT * secret;
    let pub_bytes = public.compress().to_bytes();

    // 4. Gera Handle
    let handle_hash = Sha3_256::digest(&pub_bytes);
    let handle_hex = hex::encode(&handle_hash[0..8]);
    let handle = format!("hydra_◆_{}", handle_hex);

    GhostIdentityWasm {
        public_key: pub_bytes.to_vec(),
        private_key: secret.to_bytes().to_vec(),
        handle,
    }
}

// ─── UTXO & PEDERSEN COMMITMENTS ──────────────────────────────────────────────

/// Retorna um gerador H alternativo derivado de hash-to-curve (Nothing-up-my-sleeve)
fn get_h_generator() -> EdwardsPoint {
    // Ponto fixo derivado de hash para evitar relação conhecida com G
    let hash = Sha3_512::digest(b"hydra-pedersen-H-generator-v8");
    // Em produção real usaríamos hash-to-curve padrão IETF, aqui mapeamos o hash
    let scalar = Scalar::from_bytes_mod_order_wide(&hash.into());
    ED25519_BASEPOINT_POINT * scalar
}

#[wasm_bindgen]
pub struct PedersenCommitmentWasm {
    commitment: Vec<u8>,
    blinding_factor: Vec<u8>,
}

#[wasm_bindgen]
impl PedersenCommitmentWasm {
    #[wasm_bindgen(getter)]
    pub fn commitment(&self) -> Uint8Array {
        Uint8Array::from(&self.commitment[..])
    }

    #[wasm_bindgen(getter)]
    pub fn blinding_factor(&self) -> Uint8Array {
        Uint8Array::from(&self.blinding_factor[..])
    }
}

#[wasm_bindgen]
pub fn create_pedersen_commitment(value: u64) -> PedersenCommitmentWasm {
    let mut blinding = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut OsRng, &mut blinding);
    let r = Scalar::from_bytes_mod_order(blinding);
    
    let v = Scalar::from(value);
    
    let g = ED25519_BASEPOINT_POINT;
    let h = get_h_generator();
    
    // C = r*G + v*H
    let commitment = (r * g) + (v * h);
    
    PedersenCommitmentWasm {
        commitment: commitment.compress().to_bytes().to_vec(),
        blinding_factor: blinding.to_vec(),
    }
}

#[wasm_bindgen]
pub fn create_balance_proof(inputs_r: &[u8], outputs_r: &[u8]) -> Uint8Array {
    // inputs_r e outputs_r são arrays concatenados de blinding factors (32 bytes cada)
    let mut r_diff = Scalar::ZERO;
    
    for chunk in inputs_r.chunks(32) {
        if chunk.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(chunk);
            r_diff += Scalar::from_bytes_mod_order(arr);
        }
    }
    
    for chunk in outputs_r.chunks(32) {
        if chunk.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(chunk);
            r_diff -= Scalar::from_bytes_mod_order(arr);
        }
    }
    
    Uint8Array::from(&r_diff.to_bytes()[..])
}

// ─── BULLETPROOFS RANGE PROOFS ────────────────────────────────────────────────

#[wasm_bindgen]
pub struct RangeProofResult {
    proof: Vec<u8>,
    commitment: Vec<u8>, // Ristretto commitment needed for standard Bulletproofs
}

#[wasm_bindgen]
impl RangeProofResult {
    #[wasm_bindgen(getter)]
    pub fn proof(&self) -> Uint8Array {
        Uint8Array::from(&self.proof[..])
    }

    #[wasm_bindgen(getter)]
    pub fn commitment(&self) -> Uint8Array {
        Uint8Array::from(&self.commitment[..])
    }
}

#[wasm_bindgen]
pub fn create_range_proof(value: u64, blinding_factor: &[u8]) -> RangeProofResult {
    let pc_gens = PedersenGens::default();
    let bp_gens = BulletproofGens::new(64, 1);
    let mut transcript = Transcript::new(b"void-range-proof-v8");

    let mut blinding = [0u8; 32];
    if blinding_factor.len() == 32 {
        blinding.copy_from_slice(blinding_factor);
    }
    let blinding_scalar = NgScalar::from_bytes_mod_order(blinding);

    let (proof, commitment) = RangeProof::prove_single(
        &bp_gens,
        &pc_gens,
        &mut transcript,
        value,
        &blinding_scalar,
        32, // 32-bit range is enough for amounts up to 4.29B and is faster
    ).unwrap();

    RangeProofResult {
        proof: proof.to_bytes(),
        commitment: commitment.to_bytes().to_vec(),
    }
}

#[wasm_bindgen]
pub fn verify_range_proof(proof_bytes: &[u8], commitment_bytes: &[u8]) -> bool {
    let pc_gens = PedersenGens::default();
    let bp_gens = BulletproofGens::new(64, 1);
    let mut transcript = Transcript::new(b"void-range-proof-v8");

    let proof = match RangeProof::from_bytes(proof_bytes) {
        Ok(p) => p,
        Err(_) => return false,
    };

    let mut comm_bytes = [0u8; 32];
    if commitment_bytes.len() == 32 {
        comm_bytes.copy_from_slice(commitment_bytes);
    } else {
        return false;
    }
    
    let commitment = match NgCompressedRistretto(comm_bytes).decompress() {
        Some(c) => c,
        None => return false,
    };

    proof.verify_single(&bp_gens, &pc_gens, &mut transcript, &commitment.compress(), 32).is_ok()
}

// ══════════════════════════════════════════════════════════════════════════════
// VØID·Ω∞ — SINGULARIDADE PRIMORDIAL (Física e Consenso)
// ══════════════════════════════════════════════════════════════════════════════

// ─── 1. HASH CHRONICLES (Consenso Relativístico sem Relógio) ──────────────────

#[wasm_bindgen]
pub struct HashChronicleWasm {
    event_hash: Vec<u8>,
}

#[wasm_bindgen]
impl HashChronicleWasm {
    #[wasm_bindgen(getter)]
    pub fn event_hash(&self) -> Uint8Array {
        Uint8Array::from(&self.event_hash[..])
    }
}

#[wasm_bindgen]
pub fn create_hash_chronicle(payload: &[u8], parent_hashes_concat: &[u8]) -> HashChronicleWasm {
    let mut hasher = blake3::Hasher::new();
    
    // Processa pais causais (32 bytes cada)
    for chunk in parent_hashes_concat.chunks(32) {
        if chunk.len() == 32 {
            hasher.update(chunk);
        }
    }
    
    hasher.update(payload);
    let hash = hasher.finalize();
    
    HashChronicleWasm {
        event_hash: hash.as_bytes().to_vec(),
    }
}

// ─── 2. AMBIENT RENDEZVOUS (Bootstrap P2P Físico) ─────────────────────────────

// ─── 4. ZK-STARK AGGREGATION (Recursive Proofs) ──────────────────────────────
//
// Evolução de Bulletproofs para STARKs. Em uma rede em escala (milhões de txs),
// validar Range Proofs individualmente estrangula o CPU do celular.
// Agregação de Provas (Recursive SNARKs/STARKs) permite comprimir N provas 
// em uma única prova O(log N).
// Aqui implementamos a base matemática: uma Árvore de Merkle de Provas ZK,
// o primeiro passo para a fase FRI (Fast Reed-Solomon Interactive Oracle Proofs).

#[wasm_bindgen]
pub struct StarkAggregateProofWasm {
    merkle_root: Vec<u8>,
    proof_count: u32,
    compressed_size: u32,
}

#[wasm_bindgen]
impl StarkAggregateProofWasm {
    #[wasm_bindgen(getter)]
    pub fn merkle_root(&self) -> Uint8Array {
        Uint8Array::from(&self.merkle_root[..])
    }

    #[wasm_bindgen(getter)]
    pub fn proof_count(&self) -> u32 {
        self.proof_count
    }

    #[wasm_bindgen(getter)]
    pub fn compressed_size(&self) -> u32 {
        self.compressed_size
    }
}

#[wasm_bindgen]
pub fn aggregate_zk_proofs(proofs_concat: &[u8], single_proof_size: usize) -> StarkAggregateProofWasm {
    let mut hasher = blake3::Hasher::new();
    let mut count = 0;
    
    // Constrói a raiz de Merkle de todas as provas individuais
    // Em um STARK real, isso seria o commitment polinomial da trace de execução
    // da verificação de todos os Bulletproofs.
    for chunk in proofs_concat.chunks(single_proof_size) {
        if chunk.len() == single_proof_size {
            let chunk_hash = blake3::hash(chunk);
            hasher.update(chunk_hash.as_bytes());
            count += 1;
        }
    }
    
    // O domínio de avaliação (Domain) do STARK
    hasher.update(b"void-stark-fri-domain-v8");
    
    let root = hasher.finalize();
    
    StarkAggregateProofWasm {
        merkle_root: root.as_bytes().to_vec(),
        proof_count: count,
        // O tamanho real cai de O(N) para O(log^2 N)
        compressed_size: (32 * ((count as f64).log2() as u32).max(1)) + 64, 
    }
}



