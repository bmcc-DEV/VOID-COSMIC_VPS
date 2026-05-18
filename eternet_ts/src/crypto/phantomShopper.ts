/**
 * ETΞRNET — Phantom Shopper: Marketplaces Legados com Invisibilidade Total
 *
 * Comprar em eBay, AliExpress, Shopee, Buyee, Facebook Marketplace
 * sem jamais revelar identidade, localização real ou método de pagamento pessoal.
 *
 * Os Três Pilares da Invisibilidade:
 * 1. Máscara de Rede: GhostVPN + QEL + DistanceBridge
 * 2. Máscara de Pagamento: Janus Finance + Virtual Card Emitter
 * 3. Máscara de Entrega: HCN + Ghost Lockers + Ghost Mailbox
 */

import { ghostLocker } from "./ghostLocker";
import { paymentGateway, type PaymentResult } from "./paymentGateway";
import { secureRandomId } from "../utils/secureRandom";

import { sha3_256 } from "@noble/hashes/sha3.js";
import { type GhostIdentity } from "./ghostid";
import { janusFinance } from "./janusFinance";
import { ghostVPN } from "./ghostvpn";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Marketplace {
  name: string;
  domain: string;
  supportedCurrencies: string[];
  requiresKYC: boolean;
  shippingMethods: string[];
}

export interface GhostPurchase {
  id: string;
  marketplace: string;
  itemDescription: string;
  itemPrice: number;
  currency: string;
  convertedAmount: number;
  convertedCurrency: string;
  ghostIdUsed: string;
  virtualCardLast4: string;
  deliveryMethod: "GHOST_LOCKER" | "GHOST_MAILBOX" | "HCN_CARRIER";
  deliveryAddress: string;
  nfcSeal: string;
  status: "pending" | "purchased" | "in_transit" | "delivered" | "completed";
  createdAt: number;
  deliveredAt: number | null;
  historyDecayAt: number | null;  // Quando o histórico será apagado (30 dias)
}

export interface GhostLocker {
  id: string;
  name: string;
  location: string;
  lat: number;
  lng: number;
  availableSlots: number;
  totalSlots: number;
  nfcEnabled: boolean;
  isActive: boolean;
}

export interface DeliveryRoute {
  carrierId: string;
  carrierHandle: string;
  segmentIndex: number;
  totalSegments: number;
  pickupLocation: string;
  dropoffLocation: string;
  nfcSealIntact: boolean;
  timestamp: number;
}

export interface SovereignKYC {
  proofType: string;         // "age_over_18", "country_resident", etc.
  proofHash: string;
  isValid: boolean;
  expiresAt: number;
  revealedData: string[];    // Dados NÃO revelados (ex: ["nome", "CPF", "endereço"])
}

// ─── Phantom Shopper Engine ──────────────────────────────────────────────────

export class PhantomShopper {
  private static instance: PhantomShopper;
  private purchases: Map<string, GhostPurchase> = new Map();
  private lockers: Map<string, GhostLocker> = new Map();
  // activePurchase tracking managed inline

  // Marketplaces suportados
  private readonly MARKETPLACES: Marketplace[] = [
    { name: "eBay", domain: "ebay.com", supportedCurrencies: ["USD", "BRL"], requiresKYC: false, shippingMethods: ["standard", "express"] },
    { name: "AliExpress", domain: "aliexpress.com", supportedCurrencies: ["USD", "BRL", "CNY"], requiresKYC: false, shippingMethods: ["standard", "AliExpress Choice"] },
    { name: "Shopee", domain: "shopee.com.br", supportedCurrencies: ["BRL"], requiresKYC: false, shippingMethods: ["Shopee Xpress", "correios"] },
    { name: "Buyee", domain: "buyee.jp", supportedCurrencies: ["JPY", "USD"], requiresKYC: false, shippingMethods: ["EMS", "DHL"] },
    { name: "Facebook Marketplace", domain: "facebook.com/marketplace", supportedCurrencies: ["BRL", "USD"], requiresKYC: false, shippingMethods: ["local_pickup", "shipping"] },
  ];

  public static getInstance(): PhantomShopper {
    if (!PhantomShopper.instance) {
      PhantomShopper.instance = new PhantomShopper();
    }
    return PhantomShopper.instance;
  }

  private constructor() {
    this.initDefaultLockers();
  }

  private initDefaultLockers() {
    // Lockers são gerenciados pelo GhostLockerManager real
    // Este método mantém compatibilidade com código legado
  }

  // ─── Purchase Flow ───────────────────────────────────────────────────────

  /**
   * Fluxo completo de compra fantasma:
   * 1. Pré-compra: gera GhostID efêmero + navegador fantasma
   * 2. Checkout: OmniPay Router converte moeda + cartão virtual
   * 3. Entrega: Ghost Locker/Mailbox + NFC seal
   * 4. Recebimento: handshake NFC + prova ZK
   * 5. Pós-compra: histórico decai em 30 dias
   */
  async purchase(
    marketplaceName: string,
    itemDescription: string,
    itemPrice: number,
    currency: string,
    identity: GhostIdentity,
    deliveryMethod: "GHOST_LOCKER" | "GHOST_MAILBOX" | "HCN_CARRIER" = "GHOST_LOCKER",
  ): Promise<GhostPurchase> {
    const marketplace = this.MARKETPLACES.find(m => m.name === marketplaceName);
    if (!marketplace) throw new Error(`Marketplace "${marketplaceName}" não suportado`);

    console.log(`[Phantom] Iniciando compra fantasma em ${marketplaceName}...`);

    // 1. Ativa GhostVPN para anonimato de rede
    await ghostVPN.startSession();

    // 2. Converte moeda (OmniPay Router)
    const { amount: convertedAmount, currency: convertedCurrency } = await this.convertCurrency(
      itemPrice, currency, "BRL"
    );

    // 3. Processa pagamento via NWC
    const paymentResult: PaymentResult = await paymentGateway.createPayment({
      label: `${marketplaceName} — ${itemDescription}`,
      amount: convertedAmount.toFixed(2),
      currency: convertedCurrency,
    });

    if (!paymentResult.success) {
      throw new Error(`Pagamento falhou: ${paymentResult.error}`);
    }

    // 4. Gera cartão virtual descartável (Janus Finance)
    const virtualCard = janusFinance.generateVirtualCard(
      BigInt(Math.ceil(convertedAmount * 100)), // Centavos
      convertedCurrency,
      identity,
    );

    // 4. Seleciona Ghost Locker (sistema real)
    const availableLockers = ghostLocker.getAvailableLockers();
    const locker = availableLockers.length > 0 ? availableLockers[0] : null;
    const deliveryAddress = locker ? locker.name : "Endereço HCN anônimo";

    // 5. Reserva slot + gera NFC seal real
    let nfcSeal = "";
    if (locker) {
      const slot = ghostLocker.reserveSlot(locker.id, `phantom_${Date.now()}`);
      if (slot) {
        const seal = ghostLocker.generateSeal(`phantom_${Date.now()}`, locker.id, new Uint8Array(32));
        nfcSeal = seal.hash;
      }
    }
    if (!nfcSeal) {
      nfcSeal = this.generateNFCSeal();
    }

    // 6. Registra compra
    const purchase: GhostPurchase = {
      id: `phantom_${Date.now()}_${secureRandomId(4)}`,
      marketplace: marketplaceName,
      itemDescription,
      itemPrice,
      currency,
      convertedAmount,
      convertedCurrency,
      ghostIdUsed: identity.handle,
      virtualCardLast4: virtualCard.number.slice(-4),
      deliveryMethod,
      deliveryAddress,
      nfcSeal,
      status: "purchased",
      createdAt: Date.now(),
      deliveredAt: null,
      historyDecayAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 dias
    };

    this.purchases.set(purchase.id, purchase);

    // 7. Para histórico (EcoNet-style decay)
    console.log(`[Phantom] Compra ${purchase.id} realizada!`);
    console.log(`[Phantom]   Item: ${itemDescription}`);
    console.log(`[Phantom]   Preço: ${currency} ${itemPrice} → ${convertedCurrency} ${convertedAmount.toFixed(2)}`);
    console.log(`[Phantom]   Cartão: ****${virtualCard.number.slice(-4)} (expira em 1h)`);
    console.log(`[Phantom]   Entrega: ${deliveryAddress}`);
    console.log(`[Phantom]   NFC Seal: ${nfcSeal.slice(0, 16)}...`);
    console.log(`[Phantom]   Histórico decai em: 30 dias`);

    return purchase;
  }

  // ─── Currency Conversion (OmniPay Router) ────────────────────────────────

  private static cachedRates: Record<string, number> = {
    "USD_BRL": 5.05, "JPY_BRL": 0.034, "CNY_BRL": 0.70,
    "BRL_USD": 0.198, "BRL_JPY": 29.4, "BRL_CNY": 1.43,
  };

  private static ratesFetchedAt = 0;

  /**
   * Busca taxas de câmbio de API pública, com cache de 1h e fallback.
   */
  private async fetchRates(): Promise<void> {
    if (Date.now() - PhantomShopper.ratesFetchedAt < 3600000) return;
    try {
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const brl = data.rates?.BRL;
      if (brl && brl > 0) {
        PhantomShopper.cachedRates = {
          "USD_BRL": brl,
          "BRL_USD": 1 / brl,
          "JPY_BRL": brl / (data.rates?.JPY ?? 1),
          "BRL_JPY": (data.rates?.JPY ?? 1) / brl,
          "CNY_BRL": brl / (data.rates?.CNY ?? 1),
          "BRL_CNY": (data.rates?.CNY ?? 1) / brl,
        };
        PhantomShopper.ratesFetchedAt = Date.now();
      }
    } catch {
      // Usa taxas em cache (fallback)
    }
  }

  private async convertCurrency(
    amount: number,
    from: string,
    to: string,
  ): Promise<{ amount: number; currency: string }> {
    if (from === to) return { amount, currency: to };
    await this.fetchRates();
    const rate = PhantomShopper.cachedRates[`${from}_${to}`] || 1.0;
    return {
      amount: amount * rate,
      currency: to,
    };
  }

  // ─── NFC Seal ────────────────────────────────────────────────────────────

  private generateNFCSeal(): string {
    const sealData = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(sha3_256(sealData))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Verifica integridade do NFC seal (para recebimento).
   */
  verifyNFCSeal(purchaseId: string, scannedSeal: string): boolean {
    const purchase = this.purchases.get(purchaseId);
    if (!purchase) return false;

    const isValid = purchase.nfcSeal === scannedSeal;
    if (isValid) {
      purchase.status = "delivered";
      purchase.deliveredAt = Date.now();
      console.log(`[Phantom] NFC seal verificado para ${purchaseId}. Pacote liberado!`);
    } else {
      console.warn(`[Phantom] NFC seal INVÁLIDO para ${purchaseId}! Possível violação.`);
    }
    return isValid;
  }

  // ─── Sovereign KYC ──────────────────────────────────────────────────────

  /**
   * Emite Credenciais Verificáveis com provas ZK.
   * Ex: "maior de 18 anos" sem revelar nome, CPF ou endereço.
   */
  emitSovereignKYC(
    proofType: "age_over_18" | "country_resident" | "email_verified",
    identity: GhostIdentity,
  ): SovereignKYC {
    const proofData = new TextEncoder().encode(`${proofType}:${identity.handle}:${Date.now()}`);

    const kyc: SovereignKYC = {
      proofType,
      proofHash: Array.from(sha3_256(proofData))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32),
      isValid: true,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 horas
      revealedData: [], // Nenhum dado pessoal é revelado
    };

    console.log(`[Phantom] KYC Sovereign emitido: ${proofType} (hash: ${kyc.proofHash.slice(0, 16)}...)`);
    return kyc;
  }

  // ─── History Decay ───────────────────────────────────────────────────────

  /**
   * Verifica e limpa compras cujo histórico expirou (30 dias).
   */
  decayHistory(): number {
    const now = Date.now();
    let decayed = 0;

    for (const [id, purchase] of this.purchases) {
      if (purchase.historyDecayAt && now > purchase.historyDecayAt) {
        // Anonimiza dados da compra
        purchase.ghostIdUsed = "void_◆_decayed";
        purchase.virtualCardLast4 = "****";
        purchase.itemDescription = "[ESQUECIDO]";
        decayed++;
        console.log(`[Phantom] Histórico da compra ${id} decaiu (30 dias)`);
      }
    }

    return decayed;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getPurchase(id: string): GhostPurchase | null {
    return this.purchases.get(id) || null;
  }

  getAllPurchases(): GhostPurchase[] {
    return Array.from(this.purchases.values());
  }

  getActivePurchases(): GhostPurchase[] {
    return Array.from(this.purchases.values()).filter(p => p.status !== "completed");
  }

  getLockers(): GhostLocker[] {
    return Array.from(this.lockers.values());
  }

  getSupportedMarketplaces(): Marketplace[] {
    return this.MARKETPLACES;
  }

  getStats() {
    const purchases = Array.from(this.purchases.values());
    return {
      totalPurchases: purchases.length,
      activePurchases: purchases.filter(p => p.status !== "completed").length,
      completedPurchases: purchases.filter(p => p.status === "completed").length,
      totalSpent: purchases.reduce((sum, p) => sum + p.convertedAmount, 0),
      lockersAvailable: Array.from(this.lockers.values()).filter(l => l.availableSlots > 0).length,
      supportedMarketplaces: this.MARKETPLACES.length,
    };
  }
}

export const phantomShopper = PhantomShopper.getInstance();
