//! Worker WASM — estimativa de π via série de Leibniz
//!
//! - `calculate_pi(iterations)` → π * 1e6
//! - `leibniz_partial(start, count)` → soma parcial dos termos * 1e6 (para MapReduce)

/// Soma parcial com aritmética inteira escalada (evita cancelamento f64 em tails longos)
fn leibniz_sum_scaled(start: u32, count: u32) -> i128 {
    const SCALE: i128 = 1_000_000_000_000; // 1e12
    let mut sum: i128 = 0;
    for i in start..start.saturating_add(count) {
        let denom = 2_i128 * i as i128 + 1;
        let sign: i128 = if i % 2 == 0 { 1 } else { -1 };
        sum += sign * SCALE / denom;
    }
    sum
}

fn leibniz_sum_range(start: u32, count: u32) -> f64 {
    leibniz_sum_scaled(start, count) as f64 / 1_000_000_000_000.0
}

/// Retorna π * 1_000_000
#[no_mangle]
pub extern "C" fn calculate_pi(iterations: u32) -> u64 {
    let pi = 4.0 * leibniz_sum_range(0, iterations);
    (pi * 1_000_000.0) as u64
}

/// Soma parcial escalada * 1e6 (MapReduce) — agregar: π = 4 * sum(partials) / 1e6
#[no_mangle]
pub extern "C" fn leibniz_partial(start_term: i32, count: i32) -> i64 {
    let start = start_term.max(0) as u32;
    let count = count.max(0) as u32;
    let scaled = leibniz_sum_scaled(start, count);
    // scaled é sum(termos) * 1e12; queremos partial * 1e6 para agregação
    (scaled / 1_000_000) as i64
}
