/**
 * Testes — GhostDockOrchestrator
 *
 * Cobre: registro de perfis, sessões, trilha de auditoria,
 * enforce de runtime limits e edge cases de erro.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { GhostDockOrchestrator } from "./ghostDock";
import type { GhostDockProfile } from "./ghostDock";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ProfileInput = Omit<GhostDockProfile, "id">;

function makeProfile(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name:               "void-node-test",
    encryptedWorkspace: true,
    networkMode:        "deny_all",
    allowedHosts:       [],
    maxRuntimeMs:       5_000,
    ...overrides,
  };
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe("GhostDockOrchestrator", () => {
  let dock: GhostDockOrchestrator;

  beforeEach(() => {
    dock = new GhostDockOrchestrator();
  });

  // ── Perfis ─────────────────────────────────────────────────────────────────

  describe("registerProfile()", () => {
    it("registra perfil e gera id único", () => {
      const p = dock.registerProfile(makeProfile());
      expect(p.id).toMatch(/^gd_profile_/);
      expect(p.name).toBe("void-node-test");
    });

    it("modo deny_all zera allowedHosts", () => {
      const p = dock.registerProfile(makeProfile({
        networkMode:  "deny_all",
        allowedHosts: ["example.com"],
      }));
      expect(p.allowedHosts).toHaveLength(0);
    });

    it("modo allow_localhost zera allowedHosts", () => {
      const p = dock.registerProfile(makeProfile({
        networkMode:  "allow_localhost",
        allowedHosts: ["evil.com"],
      }));
      expect(p.allowedHosts).toHaveLength(0);
    });

    it("modo custom preserva allowedHosts", () => {
      const p = dock.registerProfile(makeProfile({
        networkMode:  "custom",
        allowedHosts: ["relay.etrnet.io", "pool.xmr.org"],
      }));
      expect(p.allowedHosts).toEqual(["relay.etrnet.io", "pool.xmr.org"]);
    });

    it("IDs de perfis distintos são únicos", () => {
      const p1 = dock.registerProfile(makeProfile());
      const p2 = dock.registerProfile(makeProfile());
      expect(p1.id).not.toBe(p2.id);
    });

    it("listProfiles retorna todos os perfis registrados", () => {
      dock.registerProfile(makeProfile({ name: "alpha" }));
      dock.registerProfile(makeProfile({ name: "beta" }));
      const profiles = dock.listProfiles();
      expect(profiles).toHaveLength(2);
    });

    it("registrar perfil emite evento de auditoria", () => {
      const p = dock.registerProfile(makeProfile());
      const audit = dock.getAuditTrail();
      const ev = audit.find((e) => e.type === "profile_registered");
      expect(ev).toBeTruthy();
      expect(ev!.data).toContain(p.id);
    });
  });

  // ── Sessões ────────────────────────────────────────────────────────────────

  describe("startSession()", () => {
    it("inicia sessão com status running", () => {
      const p = dock.registerProfile(makeProfile());
      const s = dock.startSession(p.id);
      expect(s.status).toBe("running");
      expect(s.profileId).toBe(p.id);
      expect(s.sessionId).toMatch(/^gd_session_/);
    });

    it("expiresAt = startedAt + maxRuntimeMs", () => {
      const p = dock.registerProfile(makeProfile({ maxRuntimeMs: 10_000 }));
      const s = dock.startSession(p.id);
      expect(s.expiresAt - s.startedAt).toBe(10_000);
    });

    it("lança erro para profileId inexistente", () => {
      expect(() => dock.startSession("nao_existe")).toThrow("não encontrado");
    });

    it("IDs de sessões distintas são únicos", () => {
      const p = dock.registerProfile(makeProfile());
      const s1 = dock.startSession(p.id);
      const s2 = dock.startSession(p.id);
      expect(s1.sessionId).not.toBe(s2.sessionId);
    });

    it("emite evento session_started na trilha de auditoria", () => {
      const p = dock.registerProfile(makeProfile());
      const s = dock.startSession(p.id);
      const audit = dock.getAuditTrail();
      const ev = audit.find((e) => e.type === "session_started");
      expect(ev).toBeTruthy();
      expect(ev!.data).toContain(s.sessionId);
    });
  });

  describe("stopSession()", () => {
    it("para sessão e registra motivo", () => {
      const p = dock.registerProfile(makeProfile());
      const s = dock.startSession(p.id);
      const stopped = dock.stopSession(s.sessionId, "operador_manual");
      expect(stopped.status).toBe("stopped");
      expect(stopped.reason).toBe("operador_manual");
    });

    it("parar sessão já parada é idempotente", () => {
      const p = dock.registerProfile(makeProfile());
      const s = dock.startSession(p.id);
      dock.stopSession(s.sessionId, "1ª parada");
      const again = dock.stopSession(s.sessionId, "2ª parada");
      // Retorna o estado anterior (já parado)
      expect(again.status).toBe("stopped");
      expect(again.reason).toBe("1ª parada");
    });

    it("lança erro para sessionId inexistente", () => {
      expect(() => dock.stopSession("fantasma", "x")).toThrow("não encontrada");
    });

    it("emite evento session_stopped na trilha de auditoria", () => {
      const p = dock.registerProfile(makeProfile());
      const s = dock.startSession(p.id);
      dock.stopSession(s.sessionId, "fim");
      const audit = dock.getAuditTrail();
      const ev = audit.find((e) => e.type === "session_stopped");
      expect(ev).toBeTruthy();
      expect(ev!.data).toContain(s.sessionId);
    });
  });

  // ── listSessions ───────────────────────────────────────────────────────────

  describe("listSessions()", () => {
    it("lista vazia sem sessões", () => {
      expect(dock.listSessions()).toHaveLength(0);
    });

    it("lista todas as sessões sem filtro", () => {
      const p1 = dock.registerProfile(makeProfile());
      const p2 = dock.registerProfile(makeProfile());
      dock.startSession(p1.id);
      dock.startSession(p2.id);
      expect(dock.listSessions()).toHaveLength(2);
    });

    it("filtra sessões por profileId", () => {
      const p1 = dock.registerProfile(makeProfile());
      const p2 = dock.registerProfile(makeProfile());
      dock.startSession(p1.id);
      dock.startSession(p1.id);
      dock.startSession(p2.id);

      const sessionsP1 = dock.listSessions(p1.id);
      expect(sessionsP1).toHaveLength(2);
      expect(sessionsP1.every((s) => s.profileId === p1.id)).toBe(true);
    });

    it("sessões listadas em ordem decrescente de startedAt", async () => {
      const p = dock.registerProfile(makeProfile());
      const s1 = dock.startSession(p.id);
      await new Promise((r) => setTimeout(r, 5));
      const s2 = dock.startSession(p.id);

      const list = dock.listSessions();
      expect(list[0]!.sessionId).toBe(s2.sessionId);
      expect(list[1]!.sessionId).toBe(s1.sessionId);
    });
  });

  // ── Enforce Runtime Limits ─────────────────────────────────────────────────

  describe("enforceRuntimeLimits()", () => {
    it("para sessões expiradas automaticamente", () => {
      const p = dock.registerProfile(makeProfile({ maxRuntimeMs: 1 }));
      const s = dock.startSession(p.id);

      // Simula passagem de tempo com `now` futuro
      const stopped = dock.enforceRuntimeLimits(s.expiresAt + 1000);
      expect(stopped).toHaveLength(1);
      expect(stopped[0]!.reason).toBe("runtime_limit_exceeded");
      expect(stopped[0]!.status).toBe("stopped");
    });

    it("não afeta sessões ainda dentro do prazo", () => {
      const p = dock.registerProfile(makeProfile({ maxRuntimeMs: 60_000 }));
      dock.startSession(p.id);

      const stopped = dock.enforceRuntimeLimits(Date.now());
      expect(stopped).toHaveLength(0);
    });

    it("não para sessões já paradas", () => {
      const p = dock.registerProfile(makeProfile({ maxRuntimeMs: 1 }));
      const s = dock.startSession(p.id);
      dock.stopSession(s.sessionId, "manual");

      const stopped = dock.enforceRuntimeLimits(Date.now() + 9999);
      expect(stopped).toHaveLength(0);
    });

    it("para múltiplas sessões expiradas ao mesmo tempo", () => {
      const p = dock.registerProfile(makeProfile({ maxRuntimeMs: 1 }));
      dock.startSession(p.id);
      dock.startSession(p.id);
      dock.startSession(p.id);

      const future = Date.now() + 9999;
      const stopped = dock.enforceRuntimeLimits(future);
      expect(stopped).toHaveLength(3);
    });
  });

  // ── Trilha de Auditoria ────────────────────────────────────────────────────

  describe("getAuditTrail()", () => {
    it("retorna trilha vazia antes de qualquer operação", () => {
      expect(dock.getAuditTrail()).toHaveLength(0);
    });

    it("cada evento tem timestamp e data não-vazia", () => {
      const p = dock.registerProfile(makeProfile());
      dock.startSession(p.id);
      const trail = dock.getAuditTrail();

      for (const ev of trail) {
        expect(typeof ev.timestamp).toBe("number");
        expect(ev.timestamp).toBeGreaterThan(0);
        expect(ev.data).toBeTruthy();
      }
    });

    it("respeita o limite de entradas retornadas", () => {
      const p = dock.registerProfile(makeProfile());
      for (let i = 0; i < 10; i++) {
        dock.startSession(p.id);
      }
      // 1 profile_registered + 10 session_started = 11 eventos
      const trail = dock.getAuditTrail(5);
      expect(trail).toHaveLength(5);
    });

    it("tipos de eventos corretos na ordem certa", () => {
      const p = dock.registerProfile(makeProfile());
      const s = dock.startSession(p.id);
      dock.stopSession(s.sessionId, "fim");

      const trail = dock.getAuditTrail();
      const types = trail.map((e) => e.type);
      expect(types).toContain("profile_registered");
      expect(types).toContain("session_started");
      expect(types).toContain("session_stopped");
    });
  });
});
