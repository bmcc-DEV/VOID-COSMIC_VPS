/**
 * PoH — Proof-of-Homotopy (economia de créditos computacionais)
 *
 * Quem oferece CPU ganha créditos UTXO-like.
 * Preço auto-regulado por métrica de Sobolev simplificada.
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Créditos de computação (unidade mínima)
pub type PohCredits = u64;

#[derive(Clone, Serialize, Deserialize)]
pub struct PohLedger {
    balances: HashMap<String, PohCredits>,
    /// Coerência de mercado [0.0, 1.0] — alta = computação mais cara
    pub market_coherence: f64,
    /// Total de ciclos oferecidos na rede
    pub total_cycles_offered: u64,
    /// Total de ciclos consumidos
    pub total_cycles_consumed: u64,
}

impl Default for PohLedger {
    fn default() -> Self {
        Self {
            balances: HashMap::new(),
            market_coherence: 0.5,
            total_cycles_offered: 0,
            total_cycles_consumed: 0,
        }
    }
}

impl PohLedger {
    /// Créditos ganhos por oferecer ciclos de CPU
    pub fn earn(&mut self, node_id: &str, cycles: u64) {
        let reward = (cycles as f64 * (1.0 + self.market_coherence)) as u64;
        *self.balances.entry(node_id.to_string()).or_insert(0) += reward;
        self.total_cycles_offered += cycles;
        self.update_coherence();
    }

    /// Debita créditos para executar tarefa. Retorna false se saldo insuficiente.
    pub fn spend(&mut self, node_id: &str, cycles: u64) -> bool {
        let cost = self.compute_price(cycles);
        let balance = self.balances.entry(node_id.to_string()).or_insert(0);
        if *balance < cost {
            return false;
        }
        *balance -= cost;
        self.total_cycles_consumed += cycles;
        self.update_coherence();
        true
    }

    pub fn balance(&self, node_id: &str) -> PohCredits {
        *self.balances.get(node_id).unwrap_or(&0)
    }

    /// Preço em créditos — métrica de Sobolev simplificada
    pub fn compute_price(&self, cycles: u64) -> PohCredits {
        let base = cycles;
        let sobolev_factor = 1.0 + self.market_coherence.powi(2);
        (base as f64 * sobolev_factor) as u64
    }

    fn update_coherence(&mut self) {
        if self.total_cycles_offered == 0 {
            self.market_coherence = 0.5;
            return;
        }
        let demand = self.total_cycles_consumed as f64;
        let supply = self.total_cycles_offered as f64;
        self.market_coherence = (demand / supply).clamp(0.0, 1.0);
    }
}
