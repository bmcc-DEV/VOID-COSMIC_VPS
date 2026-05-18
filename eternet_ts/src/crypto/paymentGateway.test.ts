import { describe, expect, it } from "vitest";
import { executeWithNwcRetry, mapNwcError } from "./paymentGateway";

describe("paymentGateway", () => {
  describe("mapNwcError", () => {
    it("mapeia erro NWC conhecido para mensagem amigável", () => {
      const mapped = mapNwcError({ code: "INSUFFICIENT_BALANCE", message: "not enough balance" });
      expect(mapped.code).toBe("INSUFFICIENT_BALANCE");
      expect(mapped.message).toContain("Saldo insuficiente");
      expect(mapped.hint).toContain("wallet");
    });

    it("preserva mensagem para erro desconhecido", () => {
      const mapped = mapNwcError(new Error("falha específica"));
      expect(mapped.code).toBe("UNKNOWN");
      expect(mapped.message).toBe("falha específica");
    });

    it("retorna fallback padrão para erro não tipado", () => {
      const mapped = mapNwcError(null);
      expect(mapped.code).toBe("UNKNOWN");
      expect(mapped.message).toContain("Erro inesperado");
    });
  });

  describe("executeWithNwcRetry", () => {
    it("retenta para erros transitórios e recupera no sucesso", async () => {
      let calls = 0;
      const outcome = await executeWithNwcRetry(async () => {
        calls++;
        if (calls < 3) throw { code: "TIMEOUT", message: "relay lento" };
        return "ok";
      }, { baseDelayMs: 0, maxRetries: 3 });

      expect(outcome.result).toBe("ok");
      expect(outcome.attempts).toBe(3);
    });

    it("não retenta para erro não transitório", async () => {
      const outcome = await executeWithNwcRetry(async () => {
        throw { code: "INSUFFICIENT_BALANCE", message: "sem saldo" };
      }, { baseDelayMs: 0, maxRetries: 3 });

      expect(outcome.result).toBeUndefined();
      expect(outcome.attempts).toBe(1);
      expect(mapNwcError(outcome.lastError).code).toBe("INSUFFICIENT_BALANCE");
    });

    it("encerra após atingir limite de retentativas", async () => {
      const outcome = await executeWithNwcRetry(async () => {
        throw { code: "RATE_LIMITED", message: "limite" };
      }, { baseDelayMs: 0, maxRetries: 2 });

      expect(outcome.result).toBeUndefined();
      expect(outcome.attempts).toBe(3);
      expect(mapNwcError(outcome.lastError).code).toBe("RATE_LIMITED");
    });

    it("emite callback de retry com metadados de backoff", async () => {
      const events: Array<{ attempt: number; maxAttempts: number; code: string; nextDelayMs: number }> = [];
      const outcome = await executeWithNwcRetry(
        async () => {
          throw { code: "TIMEOUT", message: "timeout relay" };
        },
        { baseDelayMs: 0, maxRetries: 1 },
        (event) => events.push(event),
      );

      expect(outcome.result).toBeUndefined();
      expect(outcome.attempts).toBe(2);
      expect(events).toHaveLength(1);
      expect(events[0]?.code).toBe("TIMEOUT");
      expect(events[0]?.attempt).toBe(1);
      expect(events[0]?.maxAttempts).toBe(2);
    });
  });
});
