import { useState, useEffect } from "react";
import { voidOrchestrator, type VoidEvent } from "./VoidOrchestrator";
import { type GhostIdentity } from "../crypto/ghostid";

export function useVoid() {
  const [identity, setIdentity] = useState<GhostIdentity | null>(voidOrchestrator.getIdentity());
  const [lastEvent, setLastEvent] = useState<VoidEvent | null>(null);

  useEffect(() => {
    const unsubscribe = voidOrchestrator.subscribe((event) => {
      setLastEvent(event);
      if (event.type === "GHOST_SPAWNED") {
        setIdentity(event.identity);
      } else if (event.type === "GHOST_DESTROYED") {
        setIdentity(null);
      }
    });

    return unsubscribe;
  }, []);

  return {
    identity,
    lastEvent,
    orchestrator: voidOrchestrator,
    spawn: (onProgress?: any) => voidOrchestrator.spawn(onProgress),
    destroy: () => voidOrchestrator.destroy(),
    send: (msg: string) => voidOrchestrator.send(msg),
  };
}
