/**
 * VØID·Ω∞ — Power Governor (Energy Hierarchy)
 *
 * Resolve o Paradoxo de Energia. Define o estado operacional do nó baseado
 * na energia disponível no hardware hospedeiro, calibrando o backscatter e o rádio ativo.
 */

import { secureRandom } from "../utils/secureRandom";

export enum PowerLevel {
  LEVEL_0_LATENT = 0,     // Zero Energia (Apenas OPFS)
  LEVEL_1_PASSIVE = 1,    // Beacon Passivo (Luz/Solar)
  LEVEL_2_BACKSCATTER = 2,// RF Harvesting (Parasitagem Wi-Fi/5G)
  LEVEL_3_INTERMITTENT = 3,// TENG/Seebeck Buffer (Pulsos BLE)
  LEVEL_4_ACTIVE = 4      // Fonte Externa/Bateria Cheia (Nó Completo)
}

export type PowerStatus = {
  level: PowerLevel;
  batteryPercent: number;
  isCharging: boolean;
  capabilities: string[];
};

export class PowerGovernor {
  private static instance: PowerGovernor;
  private currentLevel: PowerLevel = PowerLevel.LEVEL_4_ACTIVE;
  private listeners: Set<(status: PowerStatus) => void> = new Set();
  
  // Mocks físicos para a PWA (Em ambiente real, isso leria APIs Nativas)
  private batteryPercent = 100;
  private isCharging = true;
  
  // Novo estado para o hardware Eternal Node real
  private eternalNodeConnected = false;
  private realMetrics = { rfVoltage: 0.0, thermalCurrent: 0.0 };

  public static getInstance(): PowerGovernor {
    if (!PowerGovernor.instance) {
      PowerGovernor.instance = new PowerGovernor();
    }
    return PowerGovernor.instance;
  }

  private constructor() {
    this.initHardwareListeners();
  }

  private async initHardwareListeners() {
    if ('getBattery' in navigator) {
      try {
        const battery: any = await (navigator as any).getBattery();
        this.updateBatteryState(battery);

        battery.addEventListener('chargingchange', () => this.updateBatteryState(battery));
        battery.addEventListener('levelchange', () => this.updateBatteryState(battery));
      } catch (e) {
        console.warn("[PowerGovernor] Battery API not supported.");
      }
    }
  }

  // Novo método para a Ponte Web Bluetooth com o hardware aberto
  public async connectEternalNode() {
    if (typeof navigator === "undefined" || !("bluetooth" in navigator)) {
      console.warn("Web Bluetooth não suportado neste navegador.");
      return;
    }
    
    console.log("[PowerGovernor] Buscando Eternal Node (Hardware Aberto) via BLE...");
    await new Promise(r => setTimeout(r, 1500)); // Simula handshake
    
    this.eternalNodeConnected = true;
    
    // Simulação da leitura contínua dos sensores do microcontrolador
    setInterval(() => {
       if (this.eternalNodeConnected) {
         this.realMetrics.rfVoltage = 1.2 + secureRandom() * 0.5; // Volts (RF Wi-Fi/LoRa)
         this.realMetrics.thermalCurrent = 15 + secureRandom() * 10; // uA (Seebeck TEG)
         this.recalculateHierarchy();
       }
    }, 2000);
    
    this.recalculateHierarchy();
  }

  private updateBatteryState(battery: any) {
    this.batteryPercent = battery.level * 100;
    this.isCharging = battery.charging;
    this.recalculateHierarchy();
  }

  private recalculateHierarchy() {
    let newLevel = PowerLevel.LEVEL_4_ACTIVE;

    if (this.isCharging || this.batteryPercent > 50 || this.eternalNodeConnected) {
      newLevel = PowerLevel.LEVEL_4_ACTIVE;
    } else if (this.batteryPercent > 20) {
      newLevel = PowerLevel.LEVEL_3_INTERMITTENT;
    } else if (this.batteryPercent > 5) {
      newLevel = PowerLevel.LEVEL_2_BACKSCATTER;
    } else if (this.batteryPercent > 1) {
      newLevel = PowerLevel.LEVEL_1_PASSIVE;
    } else {
      newLevel = PowerLevel.LEVEL_0_LATENT;
    }

    if (newLevel !== this.currentLevel) {
      this.currentLevel = newLevel;
      console.log(`[VØID·Ω∞] Power Level Transition: NÍVEL ${this.currentLevel}`);
      this.notifyListeners();
    }
  }

  public getCapabilities(): string[] {
    const caps: string[] = [];
    if (this.eternalNodeConnected) {
      caps.push(
        `RF_VOLTAGE: ${this.realMetrics.rfVoltage.toFixed(2)}V`, 
        `THERMAL_CUR: ${this.realMetrics.thermalCurrent.toFixed(1)}µA`
      );
    }

    switch (this.currentLevel) {
      case PowerLevel.LEVEL_4_ACTIVE:
        caps.push("WebRTC", "BLE_MESH_ACTIVE", "eBPF_FULL", "ZK_COMPUTE");
        break;
      case PowerLevel.LEVEL_3_INTERMITTENT:
        caps.push("BLE_PULSE_30S", "ZK_COMPUTE_DELAYED", "DTN_STORE");
        break;
      case PowerLevel.LEVEL_2_BACKSCATTER:
        caps.push("RF_BACKSCATTER_REFLECT", "DTN_STORE");
        break;
      case PowerLevel.LEVEL_1_PASSIVE:
        caps.push("BLE_BEACON_ONLY");
        break;
      case PowerLevel.LEVEL_0_LATENT:
        caps.push("OFFLINE_STORAGE_ONLY");
        break;
    }
    return caps;
  }

  public subscribe(listener: (status: PowerStatus) => void): () => void {
    this.listeners.add(listener);
    // Dispara estado inicial
    listener({
      level: this.currentLevel,
      batteryPercent: this.batteryPercent,
      isCharging: this.isCharging,
      capabilities: this.getCapabilities()
    });
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    const status = {
      level: this.currentLevel,
      batteryPercent: this.batteryPercent,
      isCharging: this.isCharging,
      capabilities: this.getCapabilities()
    };
    this.listeners.forEach(l => l(status));
  }
}

export const powerGovernor = PowerGovernor.getInstance();
