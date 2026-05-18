#!/usr/bin/env bash
# Sincroniza módulos TypeScript do ET-RNET para VOID-COSMIC_VPS
set -euo pipefail

ETRNET="${1:-/home/bruno/Documentos/ET-RNET}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/eternet_ts/src"

echo "==> ET-RNET: $ETRNET"
echo "==> DEST:   $DEST"

cp -r "$ETRNET/src/crypto/"* "$DEST/crypto/"
cp -r "$ETRNET/src/network/"* "$DEST/network/"
cp -r "$ETRNET/src/core/"* "$DEST/core/"
cp -r "$ETRNET/src/storage/"* "$DEST/storage/"
cp "$ETRNET/src/utils/secureRandom.ts" "$DEST/utils/"
cp "$ETRNET/src/utils/cn.ts" "$DEST/utils/" 2>/dev/null || true

if [ -d "$ETRNET/void_core/pkg" ]; then
  cp -r "$ETRNET/void_core/pkg/"* "$DEST/wasm/"
fi

echo "OK — módulos sincronizados ($(find "$DEST/crypto" "$DEST/network" "$DEST/core" -type f | wc -l) arquivos)"
