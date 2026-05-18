# @eternet/core — ETΞRNET / VOID-VPS (TypeScript)

Camada TypeScript do VOID-COSMIC: criptografia ET-RNET, transporte NOSTR, orquestração VOID-VPS e ponte para `void-runner`.

Documentação completa: [../README.md](../README.md).

## Instalação e build

```bash
npm install
npm run build
```

## Scripts

| Script | Ficheiro |
|--------|----------|
| `npm run example:pi` | `examples/pi-task.mjs` |
| `npm run example:mapreduce` | `examples/pi-mapreduce.mjs` |
| `npm run example:animus` | `examples/void-animus-worker.mjs` |
| `npm run example:nostr` | `examples/nostr-pi-client.mjs` |

## Módulos VOID-VPS

| Módulo | Export principal |
|--------|------------------|
| `vps/VoidVPS.ts` | Publicar tarefa, runner local, escutar resultados |
| `vps/voidAnimusWorker.ts` | Worker NOSTR (kind 31222 → 31223) |
| `vps/voidRunnerBridge.ts` | MirageCompute + VoidVPS |
| `vps/voidRunnerExec.ts` | Spawn `void-runner` CLI |
| `wasm/loadVoidCore.ts` | Init WASM (browser + Node) |
| `transport/nostrBus.ts` | Bus NOSTR ETΞRNET |
| `transport/voidRelays.ts` | Relays de dev |

## Uso em Node

```javascript
import { loadVoidCore } from "./dist/wasm/loadVoidCore.js";
import { derive_ghost_id } from "./dist/wasm/void_core.js";
import { VoidRunnerBridge } from "./dist/vps/voidRunnerBridge.js";

await loadVoidCore();
```

Evitar `import from "./dist/index.js"` em scripts CLI se não precisar do barrel completo.
