#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:${PATH}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export CARGO_TARGET_DIR="$ROOT/target"

echo "==> Compilando pi_worker (wasm32-unknown-unknown)"
rustup target add wasm32-unknown-unknown 2>/dev/null || true
cargo build -p pi_worker --release --target wasm32-unknown-unknown

WASM_OUT="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/pi_worker.wasm"
mkdir -p "$ROOT/artifacts"
cp "$WASM_OUT" "$ROOT/artifacts/pi_worker.wasm"
echo "    → artifacts/pi_worker.wasm"

echo "==> Compilando void_runner (native)"
cargo build -p void_runner --release
export PATH="$CARGO_TARGET_DIR/release:$PATH"
echo "    → target/release/void-runner"

echo "==> Verificando void_core"
cargo check -p void_core

echo "==> void_core WASM (wasm-pack)"
export PATH="${HOME}/.cargo/bin:${HOME}/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:${PATH}"
cd "$ROOT/void_core"
rustup target add wasm32-unknown-unknown 2>/dev/null || true
wasm-pack build --target web --out-dir ../eternet_ts/src/wasm

echo "==> TypeScript (+ WASM em dist/wasm)"
cd "$ROOT/eternet_ts" && npm run build

echo "==> Teste rápido void-runner"
"$ROOT/target/release/void-runner" run "$ROOT/artifacts/pi_worker.wasm" --func calculate_pi --iterations 100000

echo "OK"
