/**
 * ETΞRNET — Layer 4: Stablecoin Local & Credit Vaults
 * 
 * Permite a criação de moedas estáveis locais ($ETBRL, $ETARS) lastreadas
 * em ativos reais (RWA) ou HYDRA UTXOs. O sistema usa cofres de crédito
 * sobrecolateralizados (Credit Vaults).
 */

import { TokenizedAsset } from "./rwaTokenization";
import { secureRandomId } from "../utils/secureRandom";
import { UTXO } from "./utxo";
import { GhostIdentity } from "./ghostid";
import { karmaSystem } from "./karmaSystem";

export interface CreditVault {
  id: string;
  ownerPk: string;
  collateralAssetId?: string;
  collateralUtxos: UTXO[];
  collateralValue: bigint;
  mintedAmount: bigint;
  currency: string; // e.g., "ETBRL", "ETARS"
  healthFactor: number;
  isLiquidated: boolean;
}

export interface FiatOffer {
  id: string;
  traderPk: string;
  type: "BUY" | "SELL";
  amount: bigint;
  currency: string;
  price: number; // Taxa de conversão
  karmaRequired: number;
  location?: string;
}

export class StablecoinManager {
  private static instance: StablecoinManager;
  private vaults: Map<string, CreditVault> = new Map();
  private fiatOffers: Map<string, FiatOffer[]> = new Map();

  public static getInstance(): StablecoinManager {
    if (!StablecoinManager.instance) {
      StablecoinManager.instance = new StablecoinManager();
    }
    return StablecoinManager.instance;
  }

  private constructor() {}

  /**
   * Abre um cofre de crédito usando RWA como colateral.
   */
  public openVaultWithRwa(
    asset: TokenizedAsset,
    mintAmount: bigint,
    currency: string,
    identity: GhostIdentity
  ): CreditVault {
    if (!asset.isVerified) throw new Error("Ativo RWA não verificado");

    const vaultId = `vault_${Date.now()}_${secureRandomId(4)}`;
    const collateralValue = asset.metadata.valuation;
    
    // Regra de colateral: Mínimo 150% (LTV 66%)
    const maxMint = (collateralValue * 100n) / 150n;
    if (mintAmount > maxMint) throw new Error("Valor de mint excede o limite de colateral (150%)");

    const vault: CreditVault = {
      id: vaultId,
      ownerPk: Array.from(identity.publicKey).map(b => b.toString(16).padStart(2, '0')).join(''),
      collateralAssetId: asset.metadata.id,
      collateralUtxos: [],
      collateralValue,
      mintedAmount: mintAmount,
      currency,
      healthFactor: Number(collateralValue * 100n / mintAmount) / 100,
      isLiquidated: false,
    };

    this.vaults.set(vaultId, vault);
    return vault;
  }

  /**
   * Cria uma oferta de rampa fiat P2P.
   */
  public createFiatOffer(
    type: "BUY" | "SELL",
    amount: bigint,
    currency: string,
    price: number,
    identity: GhostIdentity
  ): FiatOffer {
    const userKarma = karmaSystem.getSpendableBalance();
    
    const offer: FiatOffer = {
      id: `offer_${Date.now()}_${secureRandomId(4)}`,
      traderPk: Array.from(identity.publicKey).map(b => b.toString(16).padStart(2, '0')).join(''),
      type,
      amount,
      currency,
      price,
      karmaRequired: Math.floor(userKarma * 0.8), // Exige reputação baseada no histórico
    };

    const offers = this.fiatOffers.get(currency) || [];
    offers.push(offer);
    this.fiatOffers.set(currency, offers);
    
    return offer;
  }

  public getVaults(): CreditVault[] {
    return Array.from(this.vaults.values());
  }

  public getOffers(currency: string): FiatOffer[] {
    return this.fiatOffers.get(currency) || [];
  }
}

export const stablecoinManager = StablecoinManager.getInstance();
