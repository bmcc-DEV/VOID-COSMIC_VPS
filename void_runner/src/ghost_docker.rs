/**
 * GhostDocker — Sandbox efêmera para workers WASM
 *
 * - Zero-Disk: WASM só em RAM, sem persistência
 * - GhostID: contexto derivado do host
 * - Shatter-ready: aceita WASM já remontado de shards QEL
 */

use anyhow::Result;
use sha3::{Digest, Sha3_256};

use crate::wasm_worker::WasmWorker;

pub struct GhostDockerSandbox {
    /// ID efêmero da sandbox (derivado de entropia do host + timestamp)
    pub sandbox_id: String,
    worker: WasmWorker,
    destroyed: bool,
}

impl GhostDockerSandbox {
    /// Cria sandbox a partir de bytes WASM (já remontados de shards QEL)
    pub fn spawn(wasm_bytes: &[u8], host_entropy: &[u8]) -> Result<Self> {
        let worker = WasmWorker::from_bytes(wasm_bytes)?;

        let mut h = Sha3_256::new();
        h.update(b"ghostdocker-sandbox-v1");
        h.update(host_entropy);
        h.update(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_le_bytes(),
        );
        let id = hex::encode(&h.finalize()[..16]);

        Ok(Self {
            sandbox_id: format!("gd_{}", id),
            worker,
            destroyed: false,
        })
    }

    pub fn execute_json(&mut self, input_json: &[u8]) -> Result<Vec<u8>> {
        if self.destroyed {
            anyhow::bail!("GhostDocker: sandbox destruída");
        }
        self.worker.execute_json(input_json)
    }

    pub fn execute_u32_u64(&mut self, func_name: &str, input: u32) -> Result<u64> {
        if self.destroyed {
            anyhow::bail!("GhostDocker: sandbox destruída");
        }
        self.worker.execute_u32_u64(func_name, input)
    }

    pub fn execute_leibniz_partial(&mut self, start: u32, count: u32) -> Result<u64> {
        if self.destroyed {
            anyhow::bail!("GhostDocker: sandbox destruída");
        }
        self.worker.execute_i32_i32_i64("leibniz_partial", start as i32, count as i32)
    }

    /// Destrói a sandbox (zero-disk: libera referências)
    pub fn destroy(&mut self) {
        self.destroyed = true;
    }
}

impl Drop for GhostDockerSandbox {
    fn drop(&mut self) {
        self.destroyed = true;
    }
}
