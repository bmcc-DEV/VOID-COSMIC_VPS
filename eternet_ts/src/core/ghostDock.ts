import { secureRandomInt } from "../utils/secureRandom";

export type GhostDockNetworkMode = "deny_all" | "allow_localhost" | "custom";

export interface GhostDockProfile {
  readonly id: string;
  readonly name: string;
  readonly encryptedWorkspace: boolean;
  readonly networkMode: GhostDockNetworkMode;
  readonly allowedHosts: readonly string[];
  readonly maxRuntimeMs: number;
}

export interface GhostDockSession {
  readonly sessionId: string;
  readonly profileId: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly status: "running" | "stopped";
  readonly reason?: string;
}

export interface GhostDockAuditEvent {
  readonly timestamp: number;
  readonly type: "profile_registered" | "session_started" | "session_stopped";
  readonly data: string;
}

function newGhostDockId(prefix: string): string {
  return `${prefix}_${Date.now()}_${secureRandomInt(1_000_000).toString().padStart(6, "0")}`;
}

export class GhostDockOrchestrator {
  private readonly profiles = new Map<string, GhostDockProfile>();
  private readonly sessions = new Map<string, GhostDockSession>();
  private readonly audit: GhostDockAuditEvent[] = [];

  registerProfile(profile: Omit<GhostDockProfile, "id">): GhostDockProfile {
    const normalized: GhostDockProfile = {
      ...profile,
      id: newGhostDockId("gd_profile"),
      allowedHosts: profile.networkMode === "custom" ? profile.allowedHosts : [],
    };
    this.profiles.set(normalized.id, normalized);
    this.audit.push({
      timestamp: Date.now(),
      type: "profile_registered",
      data: `${normalized.id}:${normalized.name}:${normalized.networkMode}`,
    });
    return normalized;
  }

  startSession(profileId: string): GhostDockSession {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`GhostDock profile não encontrado: ${profileId}`);
    const now = Date.now();
    const session: GhostDockSession = {
      sessionId: newGhostDockId("gd_session"),
      profileId: profile.id,
      startedAt: now,
      expiresAt: now + profile.maxRuntimeMs,
      status: "running",
    };
    this.sessions.set(session.sessionId, session);
    this.audit.push({
      timestamp: now,
      type: "session_started",
      data: `${session.sessionId}:${profile.id}`,
    });
    return session;
  }

  stopSession(sessionId: string, reason: string): GhostDockSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`GhostDock session não encontrada: ${sessionId}`);
    if (session.status === "stopped") return session;
    const updated: GhostDockSession = {
      ...session,
      status: "stopped",
      reason,
    };
    this.sessions.set(sessionId, updated);
    this.audit.push({
      timestamp: Date.now(),
      type: "session_stopped",
      data: `${sessionId}:${reason}`,
    });
    return updated;
  }

  enforceRuntimeLimits(now = Date.now()): readonly GhostDockSession[] {
    const stopped: GhostDockSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.status === "running" && session.expiresAt <= now) {
        stopped.push(this.stopSession(session.sessionId, "runtime_limit_exceeded"));
      }
    }
    return stopped;
  }

  listProfiles(): readonly GhostDockProfile[] {
    return Array.from(this.profiles.values());
  }

  listSessions(profileId?: string): readonly GhostDockSession[] {
    const all = Array.from(this.sessions.values()).sort((a, b) => b.startedAt - a.startedAt);
    if (!profileId) return all;
    return all.filter((item) => item.profileId === profileId);
  }

  getAuditTrail(limit = 200): readonly GhostDockAuditEvent[] {
    return this.audit.slice(-limit);
  }
}

