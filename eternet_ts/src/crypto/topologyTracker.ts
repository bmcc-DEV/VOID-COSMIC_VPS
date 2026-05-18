/**
 * V0ID vHGPU -- Topology Tracker (Capitulo 4.2.4)
 *
 * Rastreamento topologico via grafos de Reeb e persistencia:
 * 1. GRAFO DE REEB   -- Mudancas na topologia dos niveis de nivel-set
 * 2. DIAGRAMA PERSISTENCIA -- Pares nascimento-morte de componentes
 * 3. CARACTERISTICA EULER   -- Invariante topologico chi = Sigma(-1)^dim * count
 * 4. DETECCAO MUDANCA      -- Comparacao entre diagramas de persistencia
 *
 * Aplicacoes:
 * - Deteccao de mudancas de genero em superficies evoluintes
 * - Compressao adaptativa baseada em topologia
 * - Validacao de invariantes topologicos em tempo real
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * No do grafo de Reeb.
 *
 * Cada no representa uma componente conexa do nivel de nivel.
 */
export interface ReebNode {
  /** Identificador unico do no */
  id: number;
  /** Valor do nivel (funcao de escalada) */
  value: number;
  /** Persistencia (vida util do componente) */
  persistence: number;
}

/**
 * Aresta do grafo de Reeb.
 *
 * Conecta dois nos quando componentes se unem ou dividem.
 */
export interface ReebEdge {
  /** No de origem */
  from: number;
  /** No de destino */
  to: number;
  /** Peso da aresta (mudanca de nivel) */
  weight: number;
}

/**
 * Grafo de Reeb completo.
 *
 * Representa a evolucao topologica de uma funcao sobre uma variedade.
 */
export interface ReebGraph {
  /** Nos do grafo */
  nodes: ReebNode[];
  /** Arestas do grafo */
  edges: ReebEdge[];
}

/**
 * Par nascimento-morte de uma feature topologica.
 */
export interface PersistencePair {
  /** Nivel de nascimento */
  birth: number;
  /** Nivel de morte */
  death: number;
  /** Dimensao da feature (0=ponto, 1=buraco, 2=vazio) */
  dimension: number;
}

/**
 * Diagrama de persistencia.
 *
 * Armazena todos os pares nascimento-morte, organizados por dimensao.
 */
export interface PersistenceDiagram {
  /** Pares de persistencia */
  pairs: PersistencePair[];
}

// ─── 1. Grafo de Reeb ───────────────────────────────────────────────────────

/**
 * Constroi o grafo de Reeb a partir de uma funcao escalar.
 *
 * O grafo de Reeb rastrea como as componentes conexos
 * dos conjuntos de nivel {f <= c} mudam conforme c varia.
 *
 * Algoritmo:
 * 1. Discretiza o range da funcao em numLevels niveis
 * 2. Para cada nivel, identifica componentes conexos
 * 3. Conecta componentes que se unem entre niveis adjacentes
 * 4. Registra persistencia de cada componente
 *
 * @param values - Valores da funcao de escalada (amostrados)
 * @param numLevels - Numero de niveis de discretizacao
 * @returns Grafo de Reeb
 */
export function computeReebGraph(
  values: number[],
  numLevels: number
): ReebGraph {
  const nodes: ReebNode[] = [];
  const edges: ReebEdge[] = [];

  if (values.length === 0 || numLevels === 0) {
    return { nodes, edges };
  }

  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal;
  if (range === 0) {
    nodes.push({ id: 0, value: minVal, persistence: 0 });
    return { nodes, edges };
  }

  const step = range / numLevels;
  let nextId = 0;

  // Para cada nivel, encontra os pontos acima/abaixo
  const levelComponents: Map<number, number[]> = new Map();

  for (let level = 0; level <= numLevels; level++) {
    const threshold = minVal + level * step;

    // Encontra pontos neste nivel (dentro da faixa)
    const component: number[] = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i]! >= threshold - step / 2 && values[i]! < threshold + step / 2) {
        component.push(i);
      }
    }

    if (component.length > 0) {
      levelComponents.set(level, component);

      // Cria no para cada componente
      const node: ReebNode = {
        id: nextId++,
        value: threshold,
        persistence: 0,
      };
      nodes.push(node);
    }
  }

  // Conecta nos adjacentes
  let prevLevelNodes: number[] = [];
  for (let level = 0; level <= numLevels; level++) {
    const currentLevelNodes: number[] = [];
    for (const node of nodes) {
      if (Math.abs(node.value - (minVal + level * step)) < step / 2) {
        currentLevelNodes.push(node.id);
      }
    }

    // Conecta nos do nivel anterior ao atual
    if (prevLevelNodes.length > 0 && currentLevelNodes.length > 0) {
      const fromId = prevLevelNodes[0]!;
      const toId = currentLevelNodes[0]!;
      edges.push({
        from: fromId,
        to: toId,
        weight: step,
      });

      // Atualiza persistencia
      const fromNode = nodes.find((n) => n.id === fromId);
      if (fromNode) {
        fromNode.persistence += step;
      }
    }

    prevLevelNodes = currentLevelNodes;
  }

  return { nodes, edges };
}

// ─── 2. Diagrama de Persistencia ─────────────────────────────────────────────

/**
 * Extrai o diagrama de persistencia de um grafo de Reeb.
 *
 * Cada componente (no) gera um par nascimento-morte:
 * - Nascimento: valor minimo onde o componente aparece
 * - Morte: valor maximo onde o componente existe
 * - Dimensao: estimada pelo numero de vizinhos
 *
 * @param reebGraph - Grafo de Reeb
 * @returns Diagrama de persistencia
 */
export function persistenceDiagram(
  reebGraph: ReebGraph
): PersistenceDiagram {
  const pairs: PersistencePair[] = [];

  for (const node of reebGraph.nodes) {
    // Estima dimensao baseada na conexao
    const degree = reebGraph.edges.filter(
      (e) => e.from === node.id || e.to === node.id
    ).length;

    // Dimensao 0: componentes isolados (pontos)
    // Dimensao 1: componentes com ciclos (buracos)
    // Dimensao 2: componentes com cavidades
    const dimension = degree === 0 ? 0 : degree <= 2 ? 0 : 1;

    pairs.push({
      birth: node.value,
      death: node.value + node.persistence,
      dimension,
    });
  }

  // Ordena por nascimento
  pairs.sort((a, b) => a.birth - b.birth);

  return { pairs };
}

// ─── 3. Caracteristica de Euler ──────────────────────────────────────────────

/**
 * Calcula a caracteristica de Euler do diagrama de persistencia.
 *
 * chi = Sigma_{d=0}^{inf} (-1)^d * n_d
 *
 * Onde n_d e o numero de features de dimensao d.
 *
 * Propriedade topologica fundamental:
 * - Para superficie genus g: chi = 2 - 2g
 * - Para esfera: chi = 2
 * - Para toro: chi = 0
 *
 * @param diagram - Diagrama de persistencia
 * @returns Caracteristica de Euler
 */
export function eulerCharacteristic(
  diagram: PersistenceDiagram
): number {
  let chi = 0;

  for (const pair of diagram.pairs) {
    // (-1)^dim * 1
    const sign = pair.dimension % 2 === 0 ? 1 : -1;
    chi += sign;
  }

  return chi;
}

// ─── 4. Deteccao de Mudanca Topologica ───────────────────────────────────────

/**
 * Detecta se houve mudanca topologica entre dois diagramas.
 *
 * Compara:
 * 1. Numero total de features por dimensao
 * 2. Mudanca na caracteristica de Euler
 * 3. Presenca de features novas ou desaparecidas
 *
 * @param oldDiag - Diagrama anterior
 * @param newDiag - Diagrama atual
 * @returns true se houve mudanca topologica significativa
 */
export function detectTopologicalChange(
  oldDiag: PersistenceDiagram,
  newDiag: PersistenceDiagram
): boolean {
  // Compara numero de features por dimensao
  const countByDim = (diag: PersistenceDiagram): Map<number, number> => {
    const counts = new Map<number, number>();
    for (const pair of diag.pairs) {
      counts.set(pair.dimension, (counts.get(pair.dimension) || 0) + 1);
    }
    return counts;
  };

  const oldCounts = countByDim(oldDiag);
  const newCounts = countByDim(newDiag);

  // Verifica se o numero de features mudou
  for (const [dim, oldCount] of oldCounts) {
    const newCount = newCounts.get(dim) || 0;
    if (oldCount !== newCount) return true;
  }
  for (const [dim, newCount] of newCounts) {
    const oldCount = oldCounts.get(dim) || 0;
    if (oldCount !== newCount) return true;
  }

  // Compara caracteristica de Euler
  const oldChi = eulerCharacteristic(oldDiag);
  const newChi = eulerCharacteristic(newDiag);
  if (oldChi !== newChi) return true;

  // Compara persistencia media
  const avgPersistence = (diag: PersistenceDiagram): number => {
    if (diag.pairs.length === 0) return 0;
    return diag.pairs.reduce(
      (sum, p) => sum + (p.death - p.birth), 0
    ) / diag.pairs.length;
  };

  const oldAvg = avgPersistence(oldDiag);
  const newAvg = avgPersistence(newDiag);

  // Tolerancia de 10% para persistencia media
  if (Math.abs(oldAvg - newAvg) > Math.max(oldAvg, newAvg) * 0.1) {
    return true;
  }

  return false;
}

// ─── Funcoes Auxiliares ──────────────────────────────────────────────────────

/**
 * Estima a dimensao topologica minima de uma variedade
 * a partir de um diagrama de persistencia.
 *
 * @param diagram - Diagrama de persistencia
 * @returns Dimensao estimada (maior dimensao com features significativas)
 */
export function estimateTopologyDimension(
  diagram: PersistenceDiagram
): number {
  let maxDim = 0;
  for (const pair of diagram.pairs) {
    if (pair.dimension > maxDim && (pair.death - pair.birth) > 0) {
      maxDim = pair.dimension;
    }
  }
  return maxDim;
}

/**
 * Calcula o numero de buracos (genero) estimado a partir do diagrama.
 *
 * Para superficies: g = (2 - chi) / 2
 *
 * @param diagram - Diagrama de persistencia
 * @returns Genero estimado
 */
export function estimateGenus(
  diagram: PersistenceDiagram
): number {
  const chi = eulerCharacteristic(diagram);
  return Math.max(0, Math.round((2 - chi) / 2));
}

/**
 * Filtra o diagrama de persistencia removendo features com
 * persistencia abaixo de um limiar (noise filtering).
 *
 * @param diagram - Diagrama original
 * @param threshold - Limiar de persistencia minima
 * @returns Diagrama filtrado
 */
export function filterPersistence(
  diagram: PersistenceDiagram,
  threshold: number
): PersistenceDiagram {
  return {
    pairs: diagram.pairs.filter(
      (p) => (p.death - p.birth) >= threshold
    ),
  };
}
