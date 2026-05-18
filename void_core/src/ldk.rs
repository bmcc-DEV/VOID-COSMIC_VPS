/**
 * VØID-LN — BOLT11 Invoice Bridge (WASM)
 *
 * Minimal WASM module for BOLT11 invoice parsing and generation
 * via the `lightning-invoice` crate. No full LDK — just invoice support.
 *
 * LDK WASM was removed because secp256k1-sys (required by `lightning` crate)
 * does not compile for wasm32-unknown-unknown (requires C compilation).
 */

use wasm_bindgen::prelude::*;
use lightning_invoice::{Currency, Bolt11Invoice};

// ─── Invoice Parsing ─────────────────────────────────────────────────────────

/// Parse a BOLT11 invoice string and return a JSON summary.
///
/// Returns: { amount_sat, description, payment_hash, timestamp, expiry, network }
/// Or: { error: "..." }
#[wasm_bindgen]
pub fn parse_bolt11(bolt11_str: &str) -> Result<String, JsValue> {
    let invoice: Bolt11Invoice = bolt11_str.parse()
        .map_err(|e| JsValue::from_str(&format!("Failed to parse BOLT11: {}", e)))?;

    let amount_sat = invoice.amount_milli_satoshis().unwrap_or(0) / 1000;
    let description = match invoice.description() {
        lightning_invoice::Bolt11InvoiceDescriptionRef::Direct(s) => s.to_string(),
        lightning_invoice::Bolt11InvoiceDescriptionRef::Hash(_) => "[hash]".to_string(),
    };
    let payment_hash = invoice.payment_hash().to_string();
    let timestamp = invoice.duration_since_epoch().as_secs();
    let expiry = invoice.expiry_time().as_secs();
    let network = match invoice.currency() {
        Currency::Bitcoin => "bitcoin",
        Currency::BitcoinTestnet => "testnet",
        Currency::Regtest => "regtest",
        Currency::Simnet => "simnet",
        Currency::Signet => "signet",
    };

    Ok(format!(
        r#"{{"amount_sat":{},"description":"{}","payment_hash":"{}","timestamp":{},"expiry":{},"network":"{}"}}"#,
        amount_sat,
        description.replace('"', "\\\""),
        payment_hash,
        timestamp,
        expiry,
        network,
    ))
}

// ─── Invoice Generation ──────────────────────────────────────────────────────

/// Generate a BOLT11 invoice.
///
/// Parameters:
/// - private_key: 32 bytes (serialized as hex string)
/// - amount_sat: amount in satoshis
/// - description: invoice description
/// - expiry_secs: expiry in seconds
/// - network: "bitcoin", "testnet", or "regtest"
///
/// Returns: BOLT11 invoice string
#[wasm_bindgen]
pub fn create_bolt11(
    _private_key: &str,
    _amount_sat: u64,
    _description: &str,
    _expiry_secs: u64,
    _network: &str,
) -> Result<String, JsValue> {
    // Invoice generation requires secp256k1 signing, which needs secp256k1-sys.
    // This cannot work in WASM without a pure-Rust secp256k1 implementation.
    // Use NWC (NIP-47) to generate real invoices via external Lightning wallet.
    Err(JsValue::from_str(
        "BOLT11 generation requires secp256k1 signing. Use NWC (NIP-47) instead.",
    ))
}

/// Validate a BOLT11 invoice string.
///
/// Returns: true if valid, false otherwise
#[wasm_bindgen]
pub fn validate_bolt11(bolt11_str: &str) -> bool {
    bolt11_str.parse::<Bolt11Invoice>().is_ok()
}

/// Extract the payment hash from a BOLT11 invoice.
///
/// Returns: hex-encoded 32-byte payment hash
#[wasm_bindgen]
pub fn extract_payment_hash(bolt11_str: &str) -> Result<String, JsValue> {
    let invoice: Bolt11Invoice = bolt11_str.parse()
        .map_err(|e| JsValue::from_str(&format!("Failed to parse BOLT11: {}", e)))?;

    Ok(invoice.payment_hash().to_string())
}
