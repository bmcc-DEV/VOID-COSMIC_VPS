/**
 * VOID-VPS Node — coordena executor, EcoNet, PoH e MapReduce
 */

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::eco_net::EcoNet;
use crate::ghost_docker::GhostDockerSandbox;
use crate::mapreduce::{run_local_mapreduce, MapReduceJob};
use crate::poh::PohLedger;

#[derive(Clone, Serialize, Deserialize)]
pub struct VoidTask {
    pub wasm_uri: String,
    pub func_name: String,
    pub input: serde_json::Value,
    #[serde(default)]
    pub parallel_shards: usize,
    #[serde(default)]
    pub preferred_region: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct VoidTaskResult {
    pub success: bool,
    pub output: serde_json::Value,
    pub wasm_uri: String,
    pub region: Option<String>,
    pub poh_cost: u64,
}

pub struct VoidVpsNode {
    pub node_id: String,
    pub ghost_id: String,
    eco_net: EcoNet,
    poh: PohLedger,
    host_entropy: Vec<u8>,
}

impl VoidVpsNode {
    pub fn new(node_id: impl Into<String>, ghost_id: impl Into<String>, host_entropy: Vec<u8>) -> Self {
        Self {
            node_id: node_id.into(),
            ghost_id: ghost_id.into(),
            eco_net: EcoNet::new(),
            poh: PohLedger::default(),
            host_entropy,
        }
    }

    /// Publica WASM na EcoNet e retorna URI
    pub fn publish_wasm(&self, wasm_bytes: &[u8]) -> String {
        self.eco_net.put(&self.ghost_id, wasm_bytes, None)
    }

    pub fn poh_balance(&self) -> u64 {
        self.poh.balance(&self.node_id)
    }

    /// Submete e executa tarefa (local ANIMUS node)
    pub fn submit_task(&mut self, task: &VoidTask) -> Result<VoidTaskResult> {
        let wasm_bytes = if task.wasm_uri.starts_with("ipfs://") {
            self.eco_net.get(&task.wasm_uri)?
        } else {
            std::fs::read(&task.wasm_uri).map_err(|e| anyhow!("WASM não encontrado: {}", e))?
        };

        let estimated_cycles = 1_000_000u64;
        let cost = self.poh.compute_price(estimated_cycles);
        if !self.poh.spend(&self.node_id, estimated_cycles) {
            // Faucet: concede créditos iniciais para dev
            self.poh.earn(&self.node_id, estimated_cycles * 2);
            if !self.poh.spend(&self.node_id, estimated_cycles) {
                return Err(anyhow!("PoH: créditos insuficientes"));
            }
        }

        let output = if task.parallel_shards > 1 {
            let job = MapReduceJob {
                job_id: format!("job-{}", blake3::hash(task.wasm_uri.as_bytes()).to_hex()),
                func_name: task.func_name.clone(),
                input: task.input.clone(),
                shard_count: task.parallel_shards,
            };
            let mr = run_local_mapreduce(&wasm_bytes, &self.host_entropy, &job)?;
            mr.aggregated
        } else {
            let mut sandbox = GhostDockerSandbox::spawn(&wasm_bytes, &self.host_entropy)?;
            let result = if task.func_name == "calculate_pi" {
                let iterations = task
                    .input
                    .get("iterations")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1) as u32;
                let val = sandbox.execute_u32_u64(&task.func_name, iterations)?;
                serde_json::json!({ "result": val })
            } else {
                let out = sandbox.execute_json(task.input.to_string().as_bytes())?;
                serde_json::from_slice(&out).unwrap_or(serde_json::json!({ "raw": hex::encode(&out) }))
            };
            sandbox.destroy();
            result
        };

        // Worker ganha créditos por executar (simula outro nó)
        self.poh.earn(&format!("{}-worker", self.node_id), estimated_cycles);

        Ok(VoidTaskResult {
            success: true,
            output,
            wasm_uri: task.wasm_uri.clone(),
            region: task.preferred_region.clone(),
            poh_cost: cost,
        })
    }

    pub fn eco_net(&self) -> &EcoNet {
        &self.eco_net
    }
}
