/**
 * V0ID vHGPU -- Octree SDF (Capitulo 4.2.1)
 *
 * Representacao hierarquica de campos de distancia assinados (SDF)
 * via octree adaptativa. Cada no armazena:
 * - Bounds (AABB) do subespaco
 * - Valor SDF no centro
 * - Filhos (8 subdivisoes) ou flag de folha
 *
 * Aplicacoes:
 * - Renderizacao SDF em tempo real
 * - Colisao baseada em distancia
 * - Compressao de geometria para transmissao
 * - PoW via trabalho computacional de traverse
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Axis-Aligned Bounding Box (caixa delimitadora alinhada aos eixos).
 *
 * Define os limites de um subespaco 3D.
 */
export interface AABB {
  /** Vertice minimo (canto inferior esquerdo) */
  min: number[];
  /** Vertice maximo (canto superior direito) */
  max: number[];
}

/**
 * No da octree SDF.
 *
 * Cada no representa um subespaco cubico com um valor SDF associado.
 * Se o SDF variar muito dentro do subespaco, o no e subdividido em 8 filhos.
 */
export interface OctreeNode {
  /** Bounds do subespaco */
  bounds: AABB;
  /** Filhos (null se for folha) */
  children: OctreeNode[] | null;
  /** Valor SDF no centro do subespaco */
  sdfValue: number;
  /** Se e uma folha (nao subdividida) */
  isLeaf: boolean;
  /** Profundidade na arvore */
  depth: number;
}

// ─── Funcoes de Utilidade ────────────────────────────────────────────────────

/**
 * Calcula o centro de um AABB.
 */
function aabbCenter(bounds: AABB): number[] {
  const n = bounds.min.length;
  const center = new Array(n);
  for (let i = 0; i < n; i++) {
    center[i] = (bounds.min[i]! + bounds.max[i]!) / 2;
  }
  return center;
}

/**
 * Calcula o tamanho (lado) de um AABB (assumindo cubo).
 */
function aabbSize(bounds: AABB): number {
  return bounds.max[0]! - bounds.min[0]!;
}

/**
 * Divide um AABB em 8 sub-AABBs (octants).
 *
 * Ordem dos octants:
 * 0: (-x, -y, -z), 1: (+x, -y, -z)
 * 2: (-x, +y, -z), 3: (+x, +y, -z)
 * 4: (-x, -y, +z), 5: (+x, -y, +z)
 * 6: (-x, +y, +z), 7: (+x, +y, +z)
 */
function splitAABB(bounds: AABB): AABB[] {
  const center = aabbCenter(bounds);
  const octants: AABB[] = [];

  for (let i = 0; i < 8; i++) {
    const min = new Array(center.length);
    const max = new Array(center.length);
    for (let d = 0; d < center.length; d++) {
      min[d] = (i >> d) & 1 ? center[d] : bounds.min[d];
      max[d] = (i >> d) & 1 ? bounds.max[d] : center[d];
    }
    octants.push({ min, max });
  }

  return octants;
}

/**
 * Verifica se um ponto esta dentro de um AABB.
 */
function pointInAABB(point: number[], bounds: AABB): boolean {
  for (let i = 0; i < point.length; i++) {
    if (point[i]! < bounds.min[i]! || point[i]! > bounds.max[i]!) {
      return false;
    }
  }
  return true;
}

// ─── OctreeSDF Class ─────────────────────────────────────────────────────────

/**
 * OctreeSDF -- Gerencia a construcao, avaliacao e serializacao
 * de representacoes octree de campos de distancia assinados.
 */
export class OctreeSDF {
  /**
   * Constroi octree a partir de uma funcao SDF.
   *
   * Algoritmo adaptativo:
   * 1. Avalia SDF no centro do no
   * 2. Se variacao for pequena, cria folha
   * 3. Caso contrario, subdividir em 8 filhos
   * 4. Para na profundidade maxima
   *
   * @param fn - Funcao SDF: ponto -> distancia
   * @param bounds - Limites do espaco
   * @param maxDepth - Profundidade maxima da arvore
   * @returns Raiz da octree
   */
  public buildFromFunction(
    fn: (p: number[]) => number,
    bounds: AABB,
    maxDepth: number = 6
  ): OctreeNode {
    return this._buildRecursive(fn, bounds, 0, maxDepth);
  }

  private _buildRecursive(
    fn: (p: number[]) => number,
    bounds: AABB,
    depth: number,
    maxDepth: number
  ): OctreeNode {
    const center = aabbCenter(bounds);
    const sdfValue = fn(center);

    // Condicoes de parada: profundidade maxima ou SDF muito uniforme
    if (depth >= maxDepth) {
      return {
        bounds,
        children: null,
        sdfValue,
        isLeaf: true,
        depth,
      };
    }

    // Avalia SDF nos cantos para estimar variacao
    const size = aabbSize(bounds);
    const corners = this._getCorners(bounds);
    const cornerValues = corners.map((c) => fn(c));
    const maxVar = Math.max(...cornerValues) - Math.min(...cornerValues);

    // Se variacao for menor que 10% do tamanho, e uma folha
    if (maxVar < size * 0.1) {
      return {
        bounds,
        children: null,
        sdfValue,
        isLeaf: true,
        depth,
      };
    }

    // Subdividir em 8 filhos
    const subBounds = splitAABB(bounds);
    const children = subBounds.map((sb) =>
      this._buildRecursive(fn, sb, depth + 1, maxDepth)
    );

    return {
      bounds,
      children,
      sdfValue,
      isLeaf: false,
      depth,
    };
  }

  private _getCorners(bounds: AABB): number[][] {
    const corners: number[][] = [];
    const n = bounds.min.length;

    for (let i = 0; i < (1 << n); i++) {
      const corner = new Array(n);
      for (let d = 0; d < n; d++) {
        corner[d] = (i >> d) & 1 ? bounds.max[d] : bounds.min[d];
      }
      corners.push(corner);
    }

    return corners;
  }

  /**
   * Avalia o SDF em um ponto, percorrendo a octree.
   *
   * Se o ponto estiver em um no folha, retorna o valor armazenado.
   * Caso contraria, percorre recursivamente ate encontrar a folha.
   *
   * @param node - No atual
   * @param point - Ponto de avaliacao
   * @returns Valor SDF interpolado
   */
  public evaluate(node: OctreeNode, point: number[]): number {
    // Verifica se o ponto esta dentro deste no
    if (!pointInAABB(point, node.bounds)) {
      // Fora do bounds: retorna distancia ate a borda mais proxima
      return this._distanceToBounds(point, node.bounds);
    }

    // Se e folha, retorna o valor armazenado
    if (node.isLeaf || !node.children) {
      return node.sdfValue;
    }

    // Encontra o filho que contem o ponto
    for (const child of node.children) {
      if (pointInAABB(point, child.bounds)) {
        return this.evaluate(child, point);
      }
    }

    // Fallback: retorna valor do no pai
    return node.sdfValue;
  }

  private _distanceToBounds(point: number[], bounds: AABB): number {
    let distSq = 0;
    for (let i = 0; i < point.length; i++) {
      if (point[i]! < bounds.min[i]!) {
        distSq += (bounds.min[i]! - point[i]!) ** 2;
      } else if (point[i]! > bounds.max[i]!) {
        distSq += (point[i]! - bounds.max[i]!) ** 2;
      }
    }
    return Math.sqrt(distSq);
  }

  /**
   * Insere um ponto com valor SDF na octree.
   *
   * Se o no for uma folha e a profundidade nao for maxima,
   * subdividir e redistribuir os valores.
   *
   * @param node - No a ser modificado (mutavel)
   * @param point - Ponto a inserir
   * @param value - Valor SDF no ponto
   * @param maxDepth - Profundidade maxima
   */
  public insert(
    node: OctreeNode,
    point: number[],
    value: number,
    maxDepth: number
  ): void {
    // Verifica se o ponto esta dentro deste no
    if (!pointInAABB(point, node.bounds)) {
      return;
    }

    // Se e folha e pode subdividir
    if (node.isLeaf && node.depth < maxDepth) {
      const size = aabbSize(node.bounds);
      if (size > 0.001) { // Tamanho minimo
        // Subdivide
        const subBounds = splitAABB(node.bounds);
        node.children = subBounds.map((sb) => ({
          bounds: sb,
          children: null,
          sdfValue: node.sdfValue, // Herda valor do pai
          isLeaf: true,
          depth: node.depth + 1,
        }));
        node.isLeaf = false;
      }
    }

    // Se tem filhos, insere recursivamente
    if (node.children) {
      for (const child of node.children) {
        if (pointInAABB(point, child.bounds)) {
          this.insert(child, point, value, maxDepth);
          return;
        }
      }
    }

    // Atualiza o valor SDF (media ponderada)
    node.sdfValue = (node.sdfValue + value) / 2;
  }

  /**
   * Serializa a octree para Uint8Array.
   *
   * Formato binario:
   * - [0-3]: Magic number (0x5344464F = "SDFO")
   * - [4-7]: Numero de nos
   * - Para cada no:
   *   - [0]: Flags (bit 0: isLeaf, bits 1-3: profundidade)
   *   - [1-24]: Bounds min (3 x float32)
   *   - [25-48]: Bounds max (3 x float32)
   *   - [49-52]: SDF value (float32)
   *
   * @param root - Raiz da octree
   * @returns Buffer serializado
   */
  public serialize(root: OctreeNode): Uint8Array {
    // Conta nos primeiro
    const nodes: OctreeNode[] = [];
    const queue: OctreeNode[] = [root];
    while (queue.length > 0) {
      const node = queue.shift()!;
      nodes.push(node);
      if (node.children) {
        queue.push(...node.children);
      }
    }

    // Tamanho: 8 (header) + nodes.length * 52
    const bufferSize = 8 + nodes.length * 52;
    const buffer = new Uint8Array(bufferSize);
    const view = new DataView(buffer.buffer);

    // Magic number
    view.setUint32(0, 0x5344464f, false); // "SDFO" big-endian
    // Numero de nos
    view.setUint32(4, nodes.length, true);

    let offset = 8;
    for (const node of nodes) {
      // Flags
      const flags = (node.isLeaf ? 1 : 0) | (node.depth << 1);
      buffer[offset] = flags;
      offset += 1;

      // Bounds min (3 x float32)
      for (let d = 0; d < 3; d++) {
        view.setFloat32(offset, node.bounds.min[d] ?? 0, true);
        offset += 4;
      }

      // Bounds max (3 x float32)
      for (let d = 0; d < 3; d++) {
        view.setFloat32(offset, node.bounds.max[d] ?? 0, true);
        offset += 4;
      }

      // SDF value (float32)
      view.setFloat32(offset, node.sdfValue, true);
      offset += 4;
    }

    return buffer.subarray(0, offset);
  }

  /**
   * Deserializa octree de Uint8Array.
   *
   * @param buffer - Buffer serializado
   * @returns Raiz da octree reconstruida
   */
  public deserialize(buffer: Uint8Array): OctreeNode {
    const view = new DataView(buffer.buffer, buffer.byteOffset);

    // Verifica magic number
    const magic = view.getUint32(0, false);
    if (magic !== 0x5344464f) {
      throw new Error("Magic number invalido: esperado 0x5344464F (SDFO)");
    }

    const numNodes = view.getUint32(4, true);
    const nodes: OctreeNode[] = [];
    let offset = 8;

    for (let i = 0; i < numNodes; i++) {
      const flags = buffer[offset]!;
      const isLeaf = (flags & 1) === 1;
      const depth = (flags >> 1) & 7;
      offset += 1;

      // Bounds min
      const min = new Array(3);
      for (let d = 0; d < 3; d++) {
        min[d] = view.getFloat32(offset, true);
        offset += 4;
      }

      // Bounds max
      const max = new Array(3);
      for (let d = 0; d < 3; d++) {
        max[d] = view.getFloat32(offset, true);
        offset += 4;
      }

      // SDF value
      const sdfValue = view.getFloat32(offset, true);
      offset += 4;

      nodes.push({
        bounds: { min, max },
        children: null,
        sdfValue,
        isLeaf,
        depth,
      });
    }

    // Reconstruir hierarquia
    // Para cada no, encontrar filhos cujos bounds estao dentro
    for (const node of nodes) {
      if (node.isLeaf) continue;

      const children: OctreeNode[] = [];
      for (const candidate of nodes) {
        if (candidate.depth !== node.depth + 1) continue;
        if (this._isInside(candidate.bounds, node.bounds)) {
          children.push(candidate);
        }
      }

      if (children.length === 8) {
        node.children = children;
      }
    }

    // Retorna o no com menor profundidade (raiz)
    return nodes.reduce((root, n) =>
      n.depth < root.depth ? n : root
    );
  }

  private _isInside(inner: AABB, outer: AABB): boolean {
    for (let d = 0; d < inner.min.length; d++) {
      if (inner.min[d]! < outer.min[d]! || inner.max[d]! > outer.max[d]!) {
        return false;
      }
    }
    return true;
  }
}
