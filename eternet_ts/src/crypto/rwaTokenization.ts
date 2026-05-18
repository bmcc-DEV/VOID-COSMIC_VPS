/**
 * ETΞRNET — Layer 1: RWA Tokenization (Real World Assets)
 * 
 * Este módulo permite transformar bens físicos (ouro, imóveis, safras) em 
 * ativos digitais soberanos. A confiança não vem de um cartório, mas da
 * 'Prova de Posse Física' (PoPP) via testemunhas locais descentralizadas.
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { voidOrchestrator } from "../core/VoidOrchestrator";
import { GhostIdentity } from "../crypto/ghostid";
import { createUTXO, UTXO } from "./utxo";
import { signWithNodeKey } from "./signingKeys";

export interface AssetMetadata {
  id: string;
  name: string;
  category: "REAL_ESTATE" | "VEHICLE" | "COMMODITY" | "EQUIPMENT";
  description: string;
  location?: { lat: number; lng: number; precision: number };
  valuation: bigint; // Valor estimado em unidades base ($ET)
}

export interface WitnessReport {
  witnessPk: string;
  timestamp: number;
  signature: Uint8Array;
  verdict: "CONFIRMED" | "DISPUTED";
}

export interface TokenizedAsset {
  metadata: AssetMetadata;
  issuerPk: string;
  witnesses: WitnessReport[];
  totalFractions: bigint;
  remainingFractions: bigint;
  isVerified: boolean;
}

export class RwaManager {
  private static instance: RwaManager;
  private assets: Map<string, TokenizedAsset> = new Map();

  public static getInstance(): RwaManager {
    if (!RwaManager.instance) {
      RwaManager.instance = new RwaManager();
    }
    return RwaManager.instance;
  }

  private constructor() {
    this.initMeshListener();
  }

  private initMeshListener() {
    voidOrchestrator.subscribe((event) => {
      if (event.type === "SHARD_RECEIVED") {
        this.processIncomingAttestation(event.shard.payload);
      }
    });
  }

  /**
   * Inicia o processo de tokenização de um bem físico.
   * Gera um 'Fóssil de Ativo' que aguarda testemunhas na rede mesh.
   */
  public async registerAsset(meta: Omit<AssetMetadata, "id">, identity: GhostIdentity): Promise<TokenizedAsset> {
    const assetId = `asset_${Array.from(sha3_256(new TextEncoder().encode(JSON.stringify(meta)))).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)}`;
    
    const asset: TokenizedAsset = {
      metadata: { ...meta, id: assetId },
      issuerPk: Array.from(identity.publicKey).map(b => b.toString(16).padStart(2, '0')).join(''),
      witnesses: [],
      totalFractions: 1000n, // Dividimos o ativo em 1000 frações por padrão
      remainingFractions: 1000n,
      isVerified: false
    };

    this.assets.set(assetId, asset);
    console.log(`[RwaManager] Ativo registrado: ${assetId}. Aguardando testemunhas...`);

    // Propaga o pedido de testemunha pela malha
    await voidOrchestrator.send(`RWA_WITNESS_REQUEST:${JSON.stringify(asset.metadata)}`);
    
    return asset;
  }

  /**
   * Um nó vizinho atua como testemunha, assinando a existência do bem.
   * Em produção, isso exigiria proximidade física (BLE/NFC) ou prova visual ZK.
   */
  public async signAsWitness(assetId: string, identity: GhostIdentity) {
    const timestamp = Date.now();
    const witnessPk = Array.from(identity.publicKey).map(b => b.toString(16).padStart(2, '0')).join('');
    const signature = signWithNodeKey(
      "rwa-witness",
      sha3_256(new TextEncoder().encode(`${assetId}:${timestamp}`))
    );
    const report: WitnessReport = {
      witnessPk,
      timestamp,
      signature,
      verdict: "CONFIRMED"
    };

    await voidOrchestrator.send(`RWA_WITNESS_REPORT:${JSON.stringify({ assetId, report })}`);
  }

  private processIncomingAttestation(rawPayload: string) {
    try {
      const decoded = atob(rawPayload);
      if (decoded.startsWith("RWA_WITNESS_REPORT:")) {
        const { assetId, report } = JSON.parse(decoded.replace("RWA_WITNESS_REPORT:", ""));
        const asset = this.assets.get(assetId);
        
        if (asset && !asset.witnesses.some(w => w.witnessPk === report.witnessPk)) {
          asset.witnesses.push(report);
          
          // Se tiver 3 ou mais testemunhas independentes, o ativo é considerado VERIFICADO
          if (asset.witnesses.length >= 3) {
            asset.isVerified = true;
            console.log(`[RwaManager] ATIVO VERIFICADO: ${assetId}. Pronto para fracionamento.`);
          }
          this.assets.set(assetId, asset);
        }
      }
    } catch (e) { /* Não é um report RWA */ }
  }

  /**
   * Transforma um ativo verificado em UTXOs financeiros (Fractions).
   * Permite que o dono venda partes da casa/carro na DEX.
   */
  public fractionalize(assetId: string, identity: GhostIdentity): UTXO[] {
    const asset = this.assets.get(assetId);
    if (!asset || !asset.isVerified) throw new Error("Asset not verified or not found");

    const fractions: UTXO[] = [];
    const fractionValue = asset.metadata.valuation / asset.totalFractions;

    // Geramos as frações como UTXOs reais do Hydra
    for (let i = 0; i < asset.totalFractions; i++) {
       fractions.push(createUTXO(fractionValue, identity.publicKey));
    }

    return fractions;
  }

  public getAssets(): TokenizedAsset[] {
    return Array.from(this.assets.values());
  }
}

export const rwaManager = RwaManager.getInstance();
