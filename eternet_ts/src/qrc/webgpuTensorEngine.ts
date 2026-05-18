/**
 * ETΞRNET — WebGPU Tensor Engine (Aceleração de Redes Tensoriais)
 *
 * Compute shaders WGSL para contração de tensores em paralelo via WebGPU.
 * Segue o padrão de gpuMiner.ts para inicialização e dispatch.
 *
 * O que é REAL:
 * - WebGPU compute shaders para multiplicação de matrizes paralela
 * - Buffer management (storage, uniform, read-back)
 * - Padrão de dispatch idêntico ao gpuMiner.ts existente
 *
 * O que é TEÓRICO:
 * - "Swarma computing" (distribuir para navegadores remotos) — seria via WebRTC
 * - Vantagem quântica real — isso é aceleração GPU clássica
 */

// ─── WGSL Compute Shader ─────────────────────────────────────────────────────

/**
 * Shader WGSL para multiplicação de matrizes paralela (tensor contraction).
 * Cada workgroup calcula um bloco da matriz resultado.
 *
 * Binding layout (idêntico ao gpuMiner.ts):
 *   @group(0) @binding(0) var<storage, read>       matrixA: array<f32>;
 *   @group(0) @binding(1) var<storage, read>       matrixB: array<f32>;
 *   @group(0) @binding(2) var<storage, read_write> result:  array<f32>;
 *   @group(0) @binding(3) var<uniform>             params:  array<u32, 4>;
 */
const TENSOR_MULTIPLY_SHADER = /* wgsl */ `
// Parâmetros: [rowsA, colsA, colsB, unused]
@group(0) @binding(0) var<storage, read>       matrixA: array<f32>;
@group(0) @binding(1) var<storage, read>       matrixB: array<f32>;
@group(0) @binding(2) var<storage, read_write> result:  array<f32>;
@group(0) @binding(3) var<uniform>             params:  array<u32, 4>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let rowsA = params[0];
    let colsA = params[1];
    let colsB = params[2];

    let row = gid.x;
    let col = gid.y;

    if (row >= rowsA || col >= colsB) {
        return;
    }

    var sum: f32 = 0.0;
    for (var k: u32 = 0u; k < colsA; k = k + 1u) {
        sum = sum + matrixA[row * colsA + k] * matrixB[k * colsB + col];
    }

    result[row * colsB + col] = sum;
}
`;

/**
 * Shader WGSL para aplicação de operador quântico simulado a um estado.
 * Simula U|ψ⟩ multiplicando matriz de operador pelo vetor de estado.
 */
const APPLY_OPERATOR_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read>       operator: array<f32>;
@group(0) @binding(1) var<storage, read>       state:    array<f32>;
@group(0) @binding(2) var<storage, read_write> output:   array<f32>;
@group(0) @binding(3) var<uniform>             params:   array<u32, 4>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dim = params[0]; // Dimensão do estado (2^n)
    let idx = gid.x;

    if (idx >= dim) {
        return;
    }

    var sum: f32 = 0.0;
    for (var j: u32 = 0u; j < dim; j = j + 1u) {
        sum = sum + operator[idx * dim + j] * state[j];
    }

    output[idx] = sum;
}
`;

// ─── Engine ───────────────────────────────────────────────────────────────────

export interface WebGPUTensorDevice {
  device: any; // GPUDevice (evita erro de tipo sem @webgpu/types)
  adapter: any; // GPUAdapter
}

export interface MatrixMultiplyResult {
  result: Float32Array;
  rows: number;
  cols: number;
  gpuTimeMs: number;
}

/**
 * Inicializa WebGPU para operações tensoriais.
 * Segue o padrão exato de gpuMiner.ts.
 */
export async function initWebGPUTensor(): Promise<WebGPUTensorDevice | null> {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) {
    console.warn("[WebGPU Tensor] WebGPU não disponível neste ambiente");
    return null;
  }

  try {
    const adapter = await (navigator as any).gpu.requestAdapter();
    if (!adapter) {
      console.warn("[WebGPU Tensor] Nenhum adaptador GPU encontrado");
      return null;
    }

    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
      },
    });

    return { device, adapter };
  } catch (err) {
    console.warn("[WebGPU Tensor] Falha na inicialização:", err);
    return null;
  }
}

/**
 * Multiplica matrizes via WebGPU compute shader.
 * A * B = C, onde A é [rowsA × colsA] e B é [colsA × colsB].
 *
 * @returns Float32Array resultado [rowsA × colsB]
 */
export async function gpuMatrixMultiply(
  gpu: WebGPUTensorDevice,
  matrixA: Float32Array,
  matrixB: Float32Array,
  rowsA: number,
  colsA: number,
  colsB: number,
): Promise<MatrixMultiplyResult> {
  const { device } = gpu;
  const t0 = performance.now();

  // Flags hexadecimais (padrão gpuMiner.ts)
  const USAGE = { STORAGE: 0x80, COPY_DST: 0x01, COPY_SRC: 0x04, UNIFORM: 0x40, MAP_READ: 0x0008 };

  // Criar shader module
  const shaderModule = device.createShaderModule({ code: TENSOR_MULTIPLY_SHADER });

  // Criar pipeline
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: shaderModule, entryPoint: "main" },
  });

  // Criar buffers
  const bufferA = device.createBuffer({
    size: matrixA.byteLength,
    usage: USAGE.STORAGE | USAGE.COPY_DST,
  });

  const bufferB = device.createBuffer({
    size: matrixB.byteLength,
    usage: USAGE.STORAGE | USAGE.COPY_DST,
  });

  const resultSize = rowsA * colsB * 4;
  const bufferResult = device.createBuffer({
    size: resultSize,
    usage: USAGE.STORAGE | USAGE.COPY_SRC,
  });

  const params = new Uint32Array([rowsA, colsA, colsB, 0]);
  const bufferParams = device.createBuffer({
    size: params.byteLength,
    usage: USAGE.UNIFORM | USAGE.COPY_DST,
  });

  // Upload data
  device.queue.writeBuffer(bufferA, 0, matrixA);
  device.queue.writeBuffer(bufferB, 0, matrixB);
  device.queue.writeBuffer(bufferParams, 0, params);

  // Bind group
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bufferA } },
      { binding: 1, resource: { buffer: bufferB } },
      { binding: 2, resource: { buffer: bufferResult } },
      { binding: 3, resource: { buffer: bufferParams } },
    ],
  });

  // Dispatch (16×16 workgroups para cobrir a matriz resultado)
  const workgroupsX = Math.ceil(rowsA / 16);
  const workgroupsY = Math.ceil(colsB / 16);

  const commandEncoder = device.createCommandEncoder();
  const computePass = commandEncoder.beginComputePass();
  computePass.setPipeline(pipeline);
  computePass.setBindGroup(0, bindGroup);
  computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
  computePass.end();

  // Read-back buffer
  const readBuffer = device.createBuffer({
    size: resultSize,
    usage: USAGE.MAP_READ | USAGE.COPY_DST,
  });
  commandEncoder.copyBufferToBuffer(bufferResult, 0, readBuffer, 0, resultSize);

  device.queue.submit([commandEncoder.finish()]);

  // Ler resultado
  await readBuffer.mapAsync(0x0001); // MAP_MODE.READ
  const resultArray = new Float32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();

  // Cleanup
  bufferA.destroy();
  bufferB.destroy();
  bufferResult.destroy();
  bufferParams.destroy();
  readBuffer.destroy();

  return {
    result: resultArray,
    rows: rowsA,
    cols: colsB,
    gpuTimeMs: performance.now() - t0,
  };
}

/**
 * Aplica operador quântico simulado a um estado via WebGPU.
 * output = operator * state
 *
 * Usado pelo Quantum Switch para calcular U|ψ⟩ em paralelo.
 */
export async function gpuApplyOperator(
  gpu: WebGPUTensorDevice,
  operator: Float32Array,
  state: Float32Array,
  dim: number,
): Promise<Float32Array> {
  const { device } = gpu;
  const USAGE = { STORAGE: 0x80, COPY_DST: 0x01, COPY_SRC: 0x04, UNIFORM: 0x40, MAP_READ: 0x0008 };

  const shaderModule = device.createShaderModule({ code: APPLY_OPERATOR_SHADER });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: shaderModule, entryPoint: "main" },
  });

  const bufferOp = device.createBuffer({ size: operator.byteLength, usage: USAGE.STORAGE | USAGE.COPY_DST });
  const bufferState = device.createBuffer({ size: state.byteLength, usage: USAGE.STORAGE | USAGE.COPY_DST });
  const bufferOut = device.createBuffer({ size: dim * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
  const bufferParams = device.createBuffer({ size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST });

  device.queue.writeBuffer(bufferOp, 0, operator);
  device.queue.writeBuffer(bufferState, 0, state);
  const params = new Uint32Array([dim, 0, 0, 0]);
  device.queue.writeBuffer(bufferParams, 0, params);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bufferOp } },
      { binding: 1, resource: { buffer: bufferState } },
      { binding: 2, resource: { buffer: bufferOut } },
      { binding: 3, resource: { buffer: bufferParams } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(dim / 256));
  pass.end();

  const readBuf = device.createBuffer({ size: dim * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST });
  encoder.copyBufferToBuffer(bufferOut, 0, readBuf, 0, dim * 4);
  device.queue.submit([encoder.finish()]);

  await readBuf.mapAsync(0x0001); // MAP_MODE.READ
  const result = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  bufferOp.destroy();
  bufferState.destroy();
  bufferOut.destroy();
  bufferParams.destroy();
  readBuf.destroy();

  return result;
}

/**
 * Cleanup: libera dispositivo WebGPU.
 */
export function destroyWebGPUTensor(gpu: WebGPUTensorDevice): void {
  gpu.device.destroy();
}
