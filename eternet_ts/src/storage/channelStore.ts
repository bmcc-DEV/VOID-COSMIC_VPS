/**
 * VØID-LN — Channel Store (IndexedDB via Dexie)
 *
 * Persists Lightning channel state (channel monitors, HTLCs)
 * to IndexedDB. Used by the LDK-WASM persister callback.
 *
 * The WASM layer serializes channel monitors as bytes.
 * This store handles the IndexedDB operations.
 */

import Dexie from "dexie";

export interface ChannelMonitor {
  id: string;              // funding_txo as hex
  data: Uint8Array;        // Serialized ChannelMonitor bytes
  updatedAt: number;       // timestamp
  channelId?: string;      // Human-readable channel ID
}

export interface ChannelHTLC {
  id: string;              // unique ID
  channelId: string;       // Channel this HTLC belongs to
  direction: "inbound" | "outbound";
  amountMsats: number;
  paymentHash: string;     // hex
  cltvExpiry: number;      // block height
  state: "pending" | "claimed" | "refunded" | "failed";
  createdAt: number;
}

class ChannelDatabase extends Dexie {
  channelMonitors!: Dexie.Table<ChannelMonitor, string>;
  channelHTLCs!: Dexie.Table<ChannelHTLC, string>;

  constructor() {
    super("VoidLightningDB");

    this.version(1).stores({
      channelMonitors: "id, updatedAt, channelId",
      channelHTLCs: "id, channelId, paymentHash, state, createdAt",
    });
  }
}

const db = new ChannelDatabase();

export const channelStore = {
  // ─── Channel Monitors ──────────────────────────────────────────────────

  async saveMonitor(monitor: ChannelMonitor): Promise<void> {
    await db.channelMonitors.put(monitor);
  },

  async getMonitor(id: string): Promise<ChannelMonitor | undefined> {
    return db.channelMonitors.get(id);
  },

  async getAllMonitors(): Promise<ChannelMonitor[]> {
    return db.channelMonitors.toArray();
  },

  async deleteMonitor(id: string): Promise<void> {
    await db.channelMonitors.delete(id);
  },

  // ─── Channel HTLCs ────────────────────────────────────────────────────

  async saveHTLC(htlc: ChannelHTLC): Promise<void> {
    await db.channelHTLCs.put(htlc);
  },

  async getHTLC(id: string): Promise<ChannelHTLC | undefined> {
    return db.channelHTLCs.get(id);
  },

  async getHTLCsForChannel(channelId: string): Promise<ChannelHTLC[]> {
    return db.channelHTLCs.where("channelId").equals(channelId).toArray();
  },

  async getPendingHTLCs(): Promise<ChannelHTLC[]> {
    return db.channelHTLCs.where("state").equals("pending").toArray();
  },

  async updateHTLCState(id: string, state: ChannelHTLC["state"]): Promise<void> {
    await db.channelHTLCs.update(id, { state });
  },

  async getHTLCByPaymentHash(paymentHash: string): Promise<ChannelHTLC | undefined> {
    return db.channelHTLCs.where("paymentHash").equals(paymentHash).first();
  },

  // ─── Cleanup ──────────────────────────────────────────────────────────

  async getStorageStats(): Promise<{ monitors: number; htlcs: number; pendingHTLCs: number }> {
    const monitors = await db.channelMonitors.count();
    const htlcs = await db.channelHTLCs.count();
    const pendingHTLCs = await db.channelHTLCs.where("state").equals("pending").count();
    return { monitors, htlcs, pendingHTLCs };
  },
};
