/**
 * QEL MapReduce Cifrado — orquestração de tarefas paralelas
 *
 * 1. Divide payload da tarefa em N shards (Shamir-like chunking para MapReduce)
 * 2. Distribui para workers (local paralelo no MVP)
 * 3. Agrega resultados parciais
 *
 * A cifragem QEL completa fica no void_core (WASM); aqui fazemos
 * chunking determinístico + hash de integridade por shard.
 */

use anyhow::Result;
use blake3::hash;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};

use crate::ghost_docker::GhostDockerSandbox;

/// Soma parcial Leibniz escalada 1e12 (MapReduce nativo)
fn native_leibniz_partial(start: u32, count: u32) -> i128 {
    const SCALE: i128 = 1_000_000_000_000_i128;
    let mut sum: i128 = 0;
    for i in start..start.saturating_add(count) {
        let denom = 2_i128 * i as i128 + 1;
        let sign: i128 = if i % 2 == 0 { 1 } else { -1 };
        sum += sign * SCALE / denom;
    }
    sum
}

#[derive(Clone, Serialize, Deserialize)]
pub struct MapReduceJob {
    pub job_id: String,
    pub func_name: String,
    pub input: serde_json::Value,
    pub shard_count: usize,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ShardResult {
    pub shard_index: usize,
    pub output: serde_json::Value,
    pub integrity_hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct MapReduceResult {
    pub job_id: String,
    pub shards: Vec<ShardResult>,
    pub aggregated: serde_json::Value,
}

/// Divide input JSON em N sub-inputs para map paralelo
pub fn split_input(input: &serde_json::Value, n: usize) -> Vec<serde_json::Value> {
    if n <= 1 {
        return vec![input.clone()];
    }

    // Para calculate_pi: divide intervalo de termos da série
    if let Some(iterations) = input.get("iterations").and_then(|v| v.as_u64()) {
        let total = iterations as u32;
        let per_shard = (total / n as u32).max(1);
        return (0..n)
            .map(|i| {
                let start = i as u32 * per_shard;
                let count = if i == n - 1 {
                    total.saturating_sub(start)
                } else {
                    per_shard
                };
                serde_json::json!({
                    "start_term": start,
                    "count": count,
                    "shard": i,
                    "total_shards": n
                })
            })
            .collect();
    }

    // Fallback: replica input com shard id
    (0..n)
        .map(|i| serde_json::json!({ "shard": i, "total_shards": n, "payload": input }))
        .collect()
}

/// Agrega resultados de shards (soma para calculate_pi)
pub fn aggregate_results(func_name: &str, partials: &[ShardResult]) -> serde_json::Value {
    match func_name {
        "calculate_pi" => {
            let term_sum: i128 = partials
                .iter()
                .filter_map(|s| {
                    s.output
                        .get("partial_scaled")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<i128>().ok())
                })
                .sum();
            // partial_scaled = sum(termos) * 1e12; π = 4 * sum / 1e12
            let pi = 4.0 * (term_sum as f64 / 1_000_000_000_000.0);
            serde_json::json!({
                "result": (pi * 1_000_000.0).round() as u64,
                "method": "mapreduce_leibniz"
            })
        }
        _ => serde_json::json!({
            "partials": partials.iter().map(|s| &s.output).collect::<Vec<_>>(),
        }),
    }
}

/// Executa MapReduce localmente em sandbox GhostDocker
pub fn run_local_mapreduce(
    wasm_bytes: &[u8],
    host_entropy: &[u8],
    job: &MapReduceJob,
) -> Result<MapReduceResult> {
    let inputs = split_input(&job.input, job.shard_count);
    let mut shards = Vec::with_capacity(inputs.len());

    for (i, shard_input) in inputs.iter().enumerate() {
        let result = if job.func_name == "calculate_pi" {
            let start = shard_input
                .get("start_term")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let count = shard_input
                .get("count")
                .and_then(|v| v.as_u64())
                .unwrap_or(1) as u32;
            // Map nativo; reduce agrega partial_sum
            let partial = native_leibniz_partial(start, count);
            serde_json::json!({ "partial_scaled": partial.to_string(), "engine": "native" })
        } else {
            let mut sandbox = GhostDockerSandbox::spawn(wasm_bytes, host_entropy)?;
            let out = sandbox.execute_json(shard_input.to_string().as_bytes())?;
            sandbox.destroy();
            serde_json::from_slice(&out).unwrap_or(serde_json::json!({ "raw": hex::encode(&out) }))
        };

        let integrity = hex::encode(hash(result.to_string().as_bytes()).as_bytes());

        shards.push(ShardResult {
            shard_index: i,
            output: result,
            integrity_hash: integrity,
        });
    }

    let aggregated = aggregate_results(&job.func_name, &shards);

    let mut h = Sha3_256::new();
    h.update(job.job_id.as_bytes());
    h.update(aggregated.to_string().as_bytes());
    let _job_proof = hex::encode(h.finalize());

    Ok(MapReduceResult {
        job_id: job.job_id.clone(),
        shards,
        aggregated,
    })
}
