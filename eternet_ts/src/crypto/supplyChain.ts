/**
 * VØID Core — Supply Chain Security & Parasitic Architecture Layer
 *
 * Resolve o dilema: como o ANIMUS se propaga sem ser classificado como malware?
 *
 * Solução: "Parasitismo Benigno Autenticado"
 * 1. SUPPLY CHAIN INTEGRITY: Cada dependência é assinada e verificada.
 * 2. PARASITIC ARCHITECTURE: O ANIMUS se "hospeda" em processos legítimos existentes.
 * 3. WHITELIST PROVENANCE: Cada nó publica seu "pedigree" em um registro público.
 * 4. KILL SWITCH POR CONSENSO: Voto da comunidade revoga credenciais do parasita.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SupplyChainNode {
  packageName: string;
  version: string;
  maintainer: string;
  hash: string;
  signature: string;
  parentPackage: string;
  provenanceUrl: string;
  trustScore: number;
  lastVerified: number;
  isWhitelisted: boolean;
}

export interface ParasiticHost {
  hostName: string;
  hostVersion: string;
  parasiteName: string;
  parasiteHash: string;
  hostIntegrity: string;
  resourceUsage: number;
  isDetected: boolean;
  killSwitch: boolean;
  symbiosisScore: number;
}

export interface CommunityVote {
  voterId: string;
  vote: 1 | -1;
  reason: string;
  timestamp: number;
}

export interface ProvenanceEntry {
  packageName: string;
  version: string;
  origin: string;
  maintainerPubKey: string;
  binaryHash: string;
  signature: string;
  timestamp: number;
  communityVotes: CommunityVote[];
  revoked: boolean;
}

export interface SecurityAudit {
  totalPackages: number;
  verifiedPackages: number;
  suspiciousPackages: number;
  revokedPackages: number;
  parasiticNodes: number;
  standaloneNodes: number;
  avgTrustScore: number;
  killSwitchActive: boolean;
}

// ─── 1. Supply Chain Integrity Verifier ───────────────────────────────────────

export function verifyPackageIntegrity(
  binaryHash: string,
  registeredHash: string,
): { valid: boolean; reason?: string } {
  if (binaryHash !== registeredHash) {
    return {
      valid: false,
      reason: `HASH MISMATCH: baixado≠registrado`,
    };
  }
  return { valid: true };
}

// ─── 2. Parasitic Architecture Manager ────────────────────────────────────────

export class ParasiticArchitecture {
  private hosts: Map<string, ParasiticHost> = new Map();

  registerHost(host: ParasiticHost): void {
    this.hosts.set(`${host.hostName}@${host.hostVersion}`, host);
  }

  calculateSymbiosisScore(hostKey: string): number {
    const host = this.hosts.get(hostKey);
    if (!host) return 0;

    let score = 70;
    score -= host.resourceUsage * 0.5;
    if (host.isDetected) score -= 40;
    if (!host.killSwitch) score += 10;
    if (host.hostIntegrity === "VERIFIED") score += 10;

    return Math.max(0, Math.min(100, score));
  }

  activateKillSwitch(parasiteName: string): void {
    for (const [, host] of this.hosts) {
      if (host.parasiteName === parasiteName) {
        host.killSwitch = true;
      }
    }
  }

  getHosts(): ParasiticHost[] {
    return Array.from(this.hosts.values());
  }

  getStats(): {
    totalHosts: number;
    parasiticNodes: number;
    avgSymbiosis: number;
    killSwitchActive: boolean;
  } {
    const hosts = this.getHosts();
    const parasitic = hosts.filter(h => h.parasiteName.startsWith("v0id"));
    const avgSymbiosis = parasitic.length > 0
      ? parasitic.reduce((s, h) => s + this.calculateSymbiosisScore(`${h.hostName}@${h.hostVersion}`), 0) / parasitic.length
      : 0;

    return {
      totalHosts: hosts.length,
      parasiticNodes: parasitic.length,
      avgSymbiosis: Math.round(avgSymbiosis),
      killSwitchActive: parasitic.some(h => h.killSwitch),
    };
  }
}

// ─── 3. Provenance Registry (Public Ledger) ──────────────────────────────────

export class ProvenanceRegistry {
  private entries: Map<string, ProvenanceEntry> = new Map();

  register(entry: ProvenanceEntry): void {
    const key = `${entry.packageName}@${entry.version}`;
    this.entries.set(key, entry);
  }

  isWhitelisted(packageName: string, version: string): boolean {
    const key = `${packageName}@${version}`;
    const entry = this.entries.get(key);
    if (!entry || entry.revoked) return false;

    const positiveVotes = entry.communityVotes.filter(v => v.vote === 1).length;
    const totalVotes = entry.communityVotes.length;
    return totalVotes > 0 && positiveVotes / totalVotes > 0.6;
  }

  castVote(packageName: string, version: string, vote: CommunityVote): void {
    const key = `${packageName}@${version}`;
    const entry = this.entries.get(key);
    if (entry) {
      entry.communityVotes.push(vote);
    }
  }

  revoke(packageName: string, version: string): void {
    const key = `${packageName}@${version}`;
    const entry = this.entries.get(key);
    if (entry) {
      entry.revoked = true;
    }
  }

  getAudit(): SecurityAudit {
    const entries = Array.from(this.entries.values());
    return {
      totalPackages: entries.length,
      verifiedPackages: entries.filter(e => !e.revoked && e.communityVotes.length > 0).length,
      suspiciousPackages: entries.filter(e => !e.revoked && e.communityVotes.some(v => v.vote === -1)).length,
      revokedPackages: entries.filter(e => e.revoked).length,
      parasiticNodes: entries.filter(e => e.origin.startsWith("parasitic")).length,
      standaloneNodes: entries.filter(e => e.origin === "standalone").length,
      avgTrustScore: entries.length > 0
        ? entries.reduce((s, e) => {
            const vs = e.communityVotes.reduce((acc, v) => acc + v.vote, 0);
            return s + (vs / Math.max(1, e.communityVotes.length)) * 50 + 50;
          }, 0) / entries.length
        : 50,
      killSwitchActive: entries.some(e => e.revoked),
    };
  }
}

// ─── 4. Security Audit Engine ──────────────────────────────────────────────────

export class SecurityAuditEngine {
  private registry = new ProvenanceRegistry();
  private parasiticArch = new ParasiticArchitecture();

  constructor() {
    this.seedRegistry();
  }

  private seedRegistry(): void {
    const packages: Array<{
      name: string; version: string; origin: string; hash: string;
    }> = [
      { name: "v0id-crypto", version: "2.1.0", origin: "standalone", hash: "a1b2c3d4" },
      { name: "v0id-runtime", version: "1.5.0", origin: "parasitic:node", hash: "f6e5d4c3" },
      { name: "v0id-mesh", version: "3.0.0", origin: "standalone", hash: "12345678" },
      { name: "v0id-qel", version: "1.2.0", origin: "parasitic:python", hash: "def01234" },
      { name: "v0id-hcn", version: "2.0.0", origin: "standalone", hash: "abcdef01" },
    ];

    for (const pkg of packages) {
      this.registry.register({
        packageName: pkg.name,
        version: pkg.version,
        origin: pkg.origin,
        maintainerPubKey: "v0id-labs-pubkey",
        binaryHash: pkg.hash,
        signature: `sig_${pkg.name}`,
        timestamp: Date.now() - 86400000 * 30,
        communityVotes: [
          { voterId: "auditor-1", vote: 1, reason: "Verificado", timestamp: Date.now() - 86400000 * 20 },
          { voterId: "auditor-2", vote: 1, reason: "Hash confere", timestamp: Date.now() - 86400000 * 15 },
        ],
        revoked: false,
      });
    }

    // Seed parasitic hosts
    const hosts: ParasiticHost[] = [
      {
        hostName: "node", hostVersion: "18.0.0",
        parasiteName: "v0id-runtime", parasiteHash: "f6e5d4c3",
        hostIntegrity: "VERIFIED", resourceUsage: 2.3,
        isDetected: false, killSwitch: false, symbiosisScore: 87,
      },
      {
        hostName: "python", hostVersion: "3.11.0",
        parasiteName: "v0id-qel", parasiteHash: "def01234",
        hostIntegrity: "VERIFIED", resourceUsage: 1.8,
        isDetected: false, killSwitch: false, symbiosisScore: 92,
      },
    ];

    for (const h of hosts) {
      this.parasiticArch.registerHost(h);
    }
  }

  runAudit(): SecurityAudit {
    return this.registry.getAudit();
  }

  isPackageSafe(packageName: string, version: string): { safe: boolean; details: string } {
    if (this.registry.isWhitelisted(packageName, version)) {
      return { safe: true, details: "Pacote whitelisted pela comunidade VØID" };
    }
    return { safe: false, details: "Pacote não encontrado no registry de proveniência" };
  }

  emergencyKillSwitch(parasiteName: string): void {
    this.parasiticArch.activateKillSwitch(parasiteName);
    this.registry.revoke("v0id-runtime", "1.5.0");
    this.registry.revoke("v0id-qel", "1.2.0");
  }

  addCommunityVote(packageName: string, version: string, voterId: string, vote: 1 | -1, reason: string): void {
    this.registry.castVote(packageName, version, {
      voterId, vote, reason, timestamp: Date.now(),
    });
  }
}
