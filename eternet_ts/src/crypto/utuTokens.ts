/**
 * ETΞRNET — Tokenização Universal (Capítulo 11.3)
 *
 * UTU (Universal Tokenization Unit): sistema de tokenização que aceita
 * qualquer tipo de ativo — sites, software, objetos físicos — e gera
 * tokens verificáveis via SHA3-256.
 *
 * Categorias:
 * - SITE_SAAS: sites e aplicações SaaS (hash de URL + receita)
 * - SOFTWARE: repositórios e projetos open-source (hash de repo + estrelas)
 * - PHYSICAL_OBJECT: bens físicos (hash de descrição + testemunhas)
 *
 * Referência: "O Livro do ETRNET", Cap. 11.3
 */

import { sha3_256 } from "@noble/hashes/sha3.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Categoria do token UTU */
export type UTUCategory = "SITE_SAAS" | "SOFTWARE" | "PHYSICAL_OBJECT";

/** Token de Tokenização Universal */
export interface UTUToken {
  /** Identificador único do token */
  id: string;
  /** Categoria do ativo tokenizado */
  category: UTUCategory;
  /** Nome/descrição do ativo */
  name: string;
  /** Valor estimado do ativo */
  valuation: number;
  /** Hash SHA3-256 da prova de existência */
  proofHash: string;
  /** Timestamp de criação */
  createdAt: number;
}

// ─── Funções de Tokenização ──────────────────────────────────────────────────

/**
 * Tokeniza um site/SaaS em token UTU.
 *
 * Gera hash SHA3-256 de (URL + receita mensal) como prova
 * de existência e valor.
 *
 * @param url - URL do site/SaaS
 * @param revenue - Receita mensal estimada em USD
 * @returns Token UTU da categoria SITE_SAAS
 */
export function tokenizeSite(url: string, revenue: number): UTUToken {
  const data = `${url}:${revenue}`;
  const hash = sha3_256(new TextEncoder().encode(data));
  const proofHash = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const id = `utu_site_${proofHash.substring(0, 12)}`;

  console.log(`[UTU] Site tokenizado: ${url} (receita: $${revenue})`);

  return {
    id,
    category: "SITE_SAAS",
    name: url,
    valuation: revenue * 12, // Valor anualizado
    proofHash,
    createdAt: Date.now(),
  };
}

/**
 * Tokeniza um repositório/software em token UTU.
 *
 * Gera hash SHA3-256 de (hash do repositório + estrelas)
 * como prova de existência e popularidade.
 *
 * @param repoHash - Hash do repositório (commit hash ou blob hash)
 * @param stars - Número de estrelas/forks
 * @returns Token UTU da categoria SOFTWARE
 */
export function tokenizeSoftware(
  repoHash: string,
  stars: number
): UTUToken {
  const data = `${repoHash}:${stars}`;
  const hash = sha3_256(new TextEncoder().encode(data));
  const proofHash = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const id = `utu_sw_${proofHash.substring(0, 12)}`;

  console.log(`[UTU] Software tokenizado: ${repoHash.substring(0, 8)}... (estrelas: ${stars})`);

  return {
    id,
    category: "SOFTWARE",
    name: repoHash.substring(0, 16),
    valuation: stars * 10, // Valor estimado baseado em popularidade
    proofHash,
    createdAt: Date.now(),
  };
}

/**
 * Tokeniza um objeto físico em token UTU.
 *
 * Requer pelo menos 3 testemunhas independentes para validação.
 * Gera hash SHA3-256 de (descrição + lista de testemunhas).
 *
 * @param description - Descrição detalhada do objeto
 * @param witnesses - Lista de IDs de testemunhas (mínimo 3)
 * @returns Token UTU da categoria PHYSICAL_OBJECT
 * @throws Error se menos de 3 testemunhas fornecidas
 */
export function tokenizePhysicalObject(
  description: string,
  witnesses: string[]
): UTUToken {
  if (witnesses.length < 3) {
    throw new Error(
      `Tokenização física requer pelo menos 3 testemunhas. Recebido: ${witnesses.length}`
    );
  }

  // Ordenar testemunhas para garantir consistência
  const sortedWitnesses = [...witnesses].sort();
  const data = `${description}:${sortedWitnesses.join(",")}`;
  const hash = sha3_256(new TextEncoder().encode(data));
  const proofHash = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const id = `utu_obj_${proofHash.substring(0, 12)}`;

  console.log(
    `[UTU] Objeto físico tokenizado: "${description.substring(0, 30)}..." (${witnesses.length} testemunhas)`
  );

  return {
    id,
    category: "PHYSICAL_OBJECT",
    name: description.substring(0, 64),
    valuation: witnesses.length * 100, // Valor baseado em consenso de testemunhas
    proofHash,
    createdAt: Date.now(),
  };
}

// ─── Gerenciador UTU (Singleton) ─────────────────────────────────────────────

/**
 * Gerenciador de Tokenização Universal (singleton).
 *
 * Mantém registro de todos os tokens UTU criados
 * e fornece métodos de verificação e yield.
 */
export class UTUManager {
  private static instance: UTUManager;
  private tokens: Map<string, UTUToken> = new Map();

  public static getInstance(): UTUManager {
    if (!UTUManager.instance) {
      UTUManager.instance = new UTUManager();
    }
    return UTUManager.instance;
  }

  private constructor() {}

  /**
   * Cria um novo token UTU e o registra no sistema.
   *
   * @param token - Token a ser registrado (gerado por tokenizeXxx)
   * @returns O token registrado com ID único
   */
  createToken(token: UTUToken): UTUToken {
    if (this.tokens.has(token.id)) {
      throw new Error(`Token ${token.id} já existe`);
    }

    this.tokens.set(token.id, token);
    console.log(
      `[UTUManager] Token criado: ${token.id} (${token.category})`
    );
    return token;
  }

  /**
   * Verifica a integridade de um token UTU.
   *
   * Recalcula o hash da prova e compara com o armazenado.
   *
   * @param token - Token a verificar
   * @param sourceData - Dados originais para recálculo
   * @returns true se o hash confere
   */
  verifyToken(token: UTUToken, sourceData: string): boolean {
    const hash = sha3_256(new TextEncoder().encode(sourceData));
    const calculatedHash = Array.from(hash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const valid = calculatedHash === token.proofHash;

    console.log(
      `[UTUManager] Verificação ${token.id}: ${valid ? "VÁLIDO" : "INVÁLIDO"}`
    );
    return valid;
  }

  /**
   * Calcula o yield (retorno) de um token.
   *
   * Yield baseado na valorização do ativo e idade.
   *
   * @param tokenId - ID do token
   * @param currentValuation - Valorização atual
   * @returns Yield percentual
   */
  getYield(tokenId: string, currentValuation: number): number {
    const token = this.tokens.get(tokenId);
    if (!token) throw new Error(`Token ${tokenId} não encontrado`);

    const ageInDays = (Date.now() - token.createdAt) / (1000 * 60 * 60 * 24);
    if (ageInDays <= 0) return 0;

    const appreciation = (currentValuation - token.valuation) / token.valuation;
    const annualizedYield = (appreciation / ageInDays) * 365;

    return Math.round(annualizedYield * 10000) / 100;
  }

  /**
   * Retorna um token pelo ID.
   */
  getToken(tokenId: string): UTUToken | undefined {
    return this.tokens.get(tokenId);
  }

  /**
   * Retorna todos os tokens de uma categoria.
   */
  getTokensByCategory(category: UTUCategory): UTUToken[] {
    return Array.from(this.tokens.values()).filter(
      (t) => t.category === category
    );
  }

  /**
   * Retorna todos os tokens registrados.
   */
  getAllTokens(): UTUToken[] {
    return Array.from(this.tokens.values());
  }
}

export const utuManager = UTUManager.getInstance();
