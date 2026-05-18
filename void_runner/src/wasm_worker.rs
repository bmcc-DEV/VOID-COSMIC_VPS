/**
 * WASM Distributed Task Executor — wasmtime
 */

use anyhow::{anyhow, Context, Result};
use wasmtime::{Instance, Module, Store, TypedFunc};

pub struct WasmWorker {
    engine: wasmtime::Engine,
    module: Module,
}

impl WasmWorker {
    pub fn from_bytes(wasm_bytes: &[u8]) -> Result<Self> {
        let engine = wasmtime::Engine::default();
        let module = Module::new(&engine, wasm_bytes).context("falha ao compilar WASM")?;
        Ok(Self { engine, module })
    }

    pub fn from_file(path: &std::path::Path) -> Result<Self> {
        let bytes = std::fs::read(path).context("falha ao ler arquivo WASM")?;
        Self::from_bytes(&bytes)
    }

    /// Executa função com assinatura `(u32) -> u64` — ex.: calculate_pi
    pub fn execute_u32_u64(&self, func_name: &str, input: u32) -> Result<u64> {
        let mut store = Store::new(&self.engine, ());
        let instance = Instance::new(&mut store, &self.module, &[])
            .context("falha ao instanciar WASM")?;

        let func: TypedFunc<u32, u64> = instance
            .get_typed_func(&mut store, func_name)
            .with_context(|| format!("função '{}' não encontrada", func_name))?;

        func.call(&mut store, input)
            .context("falha ao executar WASM")
    }

    /// Executa função `(u64) -> u64` — ex.: leibniz_packed(packed)
    pub fn execute_u64_u64(&self, func_name: &str, input: u64) -> Result<u64> {
        let mut store = Store::new(&self.engine, ());
        let instance = Instance::new(&mut store, &self.module, &[])
            .context("falha ao instanciar WASM")?;

        let func: TypedFunc<u64, u64> = instance
            .get_typed_func(&mut store, func_name)
            .with_context(|| format!("função '{}' não encontrada", func_name))?;

        func.call(&mut store, input)
            .context("falha ao executar WASM")
    }

    /// Executa função `(i32, i32) -> i64` — ABI wasm32
    pub fn execute_i32_i32_i64(&self, func_name: &str, a: i32, b: i32) -> Result<u64> {
        let mut store = Store::new(&self.engine, ());
        let instance = Instance::new(&mut store, &self.module, &[])
            .context("falha ao instanciar WASM")?;

        let func: TypedFunc<(i32, i32), i64> = instance
            .get_typed_func(&mut store, func_name)
            .with_context(|| format!("função '{}' não encontrada", func_name))?;

        let result = func.call(&mut store, (a, b))?;
        Ok(result as u64)
    }

    /// Executa via memória linear: alloc + void_execute
    pub fn execute_json(&self, input_json: &[u8]) -> Result<Vec<u8>> {
        let mut store = Store::new(&self.engine, ());
        let instance = Instance::new(&mut store, &self.module, &[])
            .context("falha ao instanciar WASM")?;

        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| anyhow!("módulo não exporta 'memory'"))?;

        let alloc: TypedFunc<i32, i32> = instance
            .get_typed_func(&mut store, "alloc")
            .context("módulo não exporta 'alloc'")?;

        let void_execute: TypedFunc<(i32, i32), i32> = instance
            .get_typed_func(&mut store, "void_execute")
            .context("módulo não exporta 'void_execute'")?;

        let input_ptr = alloc.call(&mut store, input_json.len() as i32)?;
        memory.write(&mut store, input_ptr as usize, input_json)?;

        let output_len = void_execute.call(&mut store, (input_ptr, input_json.len() as i32))?;
        if output_len <= 0 {
            return Err(anyhow!("void_execute retornou {}", output_len));
        }

        let mut output = vec![0u8; output_len as usize];
        memory.read(&store, input_ptr as usize, &mut output)?;
        Ok(output)
    }

    pub fn list_exports(&self) -> Vec<String> {
        self.module.exports().map(|e| e.name().to_string()).collect()
    }
}
