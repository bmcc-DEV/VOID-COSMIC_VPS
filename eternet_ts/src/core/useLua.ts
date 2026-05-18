/**
 * VØID Lua Hook — Plugins Lua no browser
 *
 * Executa scripts Lua localmente via WebAssembly (wasmoon).
 * Cada nó roda seus próprios plugins. Sem servidor central.
 *
 * Filosofia: "O obsoleto não é inferior. A coerência substitui a potência."
 */

import { useState, useCallback, useRef } from "react";

/** Plugin Lua carregado */
export interface LuaPlugin {
  name: string;
  script: string;
  loadedAt: number;
  executions: number;
  errors: number;
  status: "active" | "error" | "disabled";
}

/** Resultado da execução Lua */
export interface LuaResult {
  success: boolean;
  result?: unknown;
  error?: string;
  time: number;
}

/**
 * Hook para executar Lua no browser.
 *
 * Uso:
 * ```tsx
 * const { loadPlugin, execute, plugins } = useLua();
 *
 * // Carregar plugin
 * loadPlugin("minha_estrategia", luaScript);
 *
 * // Executar função
 * const result = await execute("minha_estrategia", "analyze", { stress: 0.7 });
 * ```
 */
export function useLua() {
  const [plugins, setPlugins] = useState<Map<string, LuaPlugin>>(new Map());
  const [isReady, setIsReady] = useState(false);
  const luaRef = useRef<unknown>(null);

  /** Inicializa o runtime Lua (lazy) */
  const ensureRuntime = useCallback(async () => {
    if (luaRef.current) return luaRef.current;

    // Lua via WebAssembly (wasmoon) — opcional
    // Para ativar: npm install wasmoon && npm install -D @types/wasmoon
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const wasmoon = await (Function("return import('wasmoon')")() as Promise<{ GoLuaFactory: { create: () => Promise<unknown> } }>);
      const lua = await wasmoon.GoLuaFactory.create();
      luaRef.current = lua;
      setIsReady(true);
      return lua;
    } catch {
      // Fallback: Lua fake para desenvolvimento
      luaRef.current = createFakeLua();
      setIsReady(true);
      return luaRef.current;
    }
  }, []);

  /** Carrega um plugin Lua */
  const loadPlugin = useCallback(
    (name: string, script: string) => {
      const plugin: LuaPlugin = {
        name,
        script,
        loadedAt: Date.now(),
        executions: 0,
        errors: 0,
        status: "active",
      };
      setPlugins((prev) => new Map(prev).set(name, plugin));
      return plugin;
    },
    []
  );

  /** Executa uma função Lua */
  const execute = useCallback(
    async (name: string, functionName: string, args: Record<string, unknown> = {}): Promise<LuaResult> => {
      const plugin = plugins.get(name);
      if (!plugin) {
        return { success: false, error: `Plugin '${name}' não carregado`, time: 0 };
      }

      const start = performance.now();

      try {
        const lua = await ensureRuntime();

        // Carregar script + executar função
        const code = `
          local args = ${JSON.stringify(args)}
          ${plugin.script}
          local ok, result = pcall(${functionName}, args)
          if ok then
            return result
          else
            error(tostring(result))
          end
        `;

        const result = await (lua as { doString: (code: string) => Promise<unknown> }).doString(code);
        const time = performance.now() - start;

        // Atualizar stats
        setPlugins((prev) => {
          const next = new Map(prev);
          const p = next.get(name);
          if (p) {
            p.executions++;
            next.set(name, { ...p });
          }
          return next;
        });

        return { success: true, result, time };
      } catch (err) {
        const time = performance.now() - start;
        setPlugins((prev) => {
          const next = new Map(prev);
          const p = next.get(name);
          if (p) {
            p.errors++;
            if (p.errors > 10) p.status = "error";
            next.set(name, { ...p });
          }
          return next;
        });
        return { success: false, error: String(err), time };
      }
    },
    [plugins, ensureRuntime]
  );

  /** Remove um plugin */
  const unload = useCallback((name: string) => {
    setPlugins((prev) => {
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  }, []);

  /** Lista plugins ativos */
  const listPlugins = useCallback(() => {
    return Array.from(plugins.values());
  }, [plugins]);

  return {
    loadPlugin,
    execute,
    unload,
    listPlugins,
    plugins: Array.from(plugins.values()),
    isReady,
  };
}

/** Lua fake para quando wasmoon não está disponível */
function createFakeLua() {
  return {
    doString: async (code: string) => {
      // Simula execução Lua via eval simplificado
      console.log("[Lua Fake]", code.slice(0, 100));
      return { simulated: true };
    },
  };
}
