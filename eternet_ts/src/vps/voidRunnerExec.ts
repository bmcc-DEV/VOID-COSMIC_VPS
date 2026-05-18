/**
 * Execução local via CLI void-runner (run / map-reduce)
 */

import type { EcoNetClient } from "./ecoNet.js";
import type { VoidTask } from "./VoidVPS.js";

function spawnRunner(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    import("node:child_process")
      .then(({ spawn }) => {
        const child = spawn("void-runner", args, { env: process.env });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr || `void-runner exit ${code}`));
        });
      })
      .catch(reject);
  });
}

export async function executeVoidTask(
  task: VoidTask,
  taskId: string,
  parallelShards: number,
  ecoNet: EcoNetClient,
): Promise<unknown> {
  let wasmPath = task.wasmFile;
  if (task.wasmFile.startsWith("ipfs://")) {
    const bytes = ecoNet.get(task.wasmFile);
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    wasmPath = path.join(os.tmpdir(), `void-${taskId}.wasm`);
    await fs.writeFile(wasmPath, bytes);
  }

  const iterations = String(task.input.iterations ?? 1_000_000);
  const args =
    parallelShards > 1
      ? [
          "map-reduce",
          wasmPath,
          "--func",
          task.funcName,
          "--iterations",
          iterations,
          "--shards",
          String(parallelShards),
        ]
      : ["run", wasmPath, "--func", task.funcName, "--iterations", iterations];

  const stdout = await spawnRunner(args);
  const parsed = JSON.parse(stdout) as {
    output?: unknown;
    aggregated?: unknown;
  };
  return parsed.output ?? parsed.aggregated ?? parsed;
}
