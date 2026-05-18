/**
 * EcoNet — Sistema de arquivos imortal (stub IPFS)
 *
 * URI: ipfs://ETRNET/<GhostID>/<shard_hash>
 * TTL renovado por acesso; decai se não acessado.
 */

use anyhow::{anyhow, Result};
use blake3::hash;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

const DEFAULT_TTL_SECS: u64 = 3600;
const PROTOCOL_PREFIX: &str = "ipfs://ETRNET/";

#[derive(Clone, Serialize, Deserialize)]
pub struct EcoNetObject {
    pub ghost_id: String,
    pub cid: String,
    pub data: Vec<u8>,
    pub ttl_secs: u64,
    #[serde(skip)]
    pub last_access: Option<Instant>,
}

#[derive(Clone, Default)]
pub struct EcoNet {
    store: Arc<RwLock<HashMap<String, EcoNetObject>>>,
}

impl EcoNet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Armazena blob e retorna URI EcoNet
    pub fn put(&self, ghost_id: &str, data: &[u8], ttl_secs: Option<u64>) -> String {
        let cid = hash(data).to_hex().to_string();
        let uri = format!("{}{}/{}", PROTOCOL_PREFIX, ghost_id, cid);

        let obj = EcoNetObject {
            ghost_id: ghost_id.to_string(),
            cid: cid.clone(),
            data: data.to_vec(),
            ttl_secs: ttl_secs.unwrap_or(DEFAULT_TTL_SECS),
            last_access: Some(Instant::now()),
        };

        self.store.write().unwrap().insert(uri.clone(), obj);
        uri
    }

    /// Resolve URI EcoNet → bytes (renova TTL)
    pub fn get(&self, uri: &str) -> Result<Vec<u8>> {
        let mut store = self.store.write().unwrap();
        let obj = store
            .get_mut(uri)
            .ok_or_else(|| anyhow!("EcoNet: objeto não encontrado: {}", uri))?;

        if Self::is_expired(obj) {
            store.remove(uri);
            return Err(anyhow!("EcoNet: objeto expirou (decay)"));
        }

        obj.last_access = Some(Instant::now());
        Ok(obj.data.clone())
    }

    /// Remove objetos expirados (garbage collection)
    pub fn decay(&self) -> usize {
        let mut store = self.store.write().unwrap();
        let expired: Vec<String> = store
            .iter()
            .filter(|(_, obj)| Self::is_expired(obj))
            .map(|(k, _)| k.clone())
            .collect();

        let count = expired.len();
        for k in expired {
            store.remove(&k);
        }
        count
    }

    fn is_expired(obj: &EcoNetObject) -> bool {
        match obj.last_access {
            Some(t) => t.elapsed() > Duration::from_secs(obj.ttl_secs),
            None => true,
        }
    }

    pub fn parse_uri(uri: &str) -> Result<(String, String)> {
        if !uri.starts_with(PROTOCOL_PREFIX) {
            return Err(anyhow!("URI EcoNet inválida: {}", uri));
        }
        let rest = &uri[PROTOCOL_PREFIX.len()..];
        let parts: Vec<&str> = rest.splitn(2, '/').collect();
        if parts.len() != 2 {
            return Err(anyhow!("URI EcoNet malformada: {}", uri));
        }
        Ok((parts[0].to_string(), parts[1].to_string()))
    }
}
