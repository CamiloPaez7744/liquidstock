import { getOrCreateDeviceId, localDb } from "../storage/dexie/db.js";

export type ConnectivityState = "online" | "syncing" | "offline";

export interface SyncStatusSnapshot {
  connectivity: ConnectivityState;
  pendingCount: number;
  lastSyncedAt: string | null;
  wsConnected: boolean;
}

type Listener = (snapshot: SyncStatusSnapshot) => void;

/**
 * Coordinates Local-First Outbox flushing (HTTP idempotent batch) +
 * Multi-tablet Real-Time WebSocket notifications.
 */
export class SyncEngine {
  private readonly apiBaseUrl: string;
  private readonly wsBaseUrl: string;
  private readonly listeners = new Set<Listener>();
  private socket: WebSocket | null = null;
  private flushTimer: number | null = null;
  private state: SyncStatusSnapshot = {
    connectivity: typeof navigator !== "undefined" && navigator.onLine ? "online" : "offline",
    pendingCount: 0,
    lastSyncedAt: null,
    wsConnected: false,
  };

  constructor() {
    this.apiBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
    this.wsBaseUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001";
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(patch: Partial<SyncStatusSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  start(branchId: string): () => void {
    const onOnline = () => {
      this.emit({ connectivity: "online" });
      void this.flushOutbox(branchId);
      this.connectWebSocket(branchId);
    };
    const onOffline = () => {
      this.emit({ connectivity: "offline", wsConnected: false });
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    void this.refreshPendingCount();
    this.connectWebSocket(branchId);
    this.flushTimer = window.setInterval(() => {
      void this.flushOutbox(branchId);
    }, 8_000);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (this.flushTimer !== null) window.clearInterval(this.flushTimer);
      this.socket?.close();
    };
  }

  private connectWebSocket(branchId: string): void {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    try {
      this.socket?.close();
      const ws = new WebSocket(`${this.wsBaseUrl}/ws/${branchId}`);
      this.socket = ws;

      ws.onopen = () => this.emit({ wsConnected: true, connectivity: "online" });
      ws.onclose = () => this.emit({ wsConnected: false });
      ws.onerror = () => this.emit({ wsConnected: false });
      ws.onmessage = () => {
        // Phase 1 will pull incremental delta & update IndexedDB tables live
        void this.refreshPendingCount();
      };
    } catch {
      this.emit({ wsConnected: false });
    }
  }

  async refreshPendingCount(): Promise<number> {
    const pendingCount = await localDb.syncOutbox
      .where("syncStatus")
      .equals("pending")
      .count();
    this.emit({ pendingCount });
    return pendingCount;
  }

  async flushOutbox(branchId: string): Promise<void> {
    const pending = await localDb.syncOutbox
      .where("syncStatus")
      .equals("pending")
      .sortBy("idempotencyKey");

    this.emit({ pendingCount: pending.length });
    if (pending.length === 0 || (typeof navigator !== "undefined" && !navigator.onLine)) {
      return;
    }

    this.emit({ connectivity: "syncing" });
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/v1/sync/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId,
          deviceId: getOrCreateDeviceId(),
          commands: pending.map((p) => ({
            idempotencyKey: p.idempotencyKey,
            branchId: p.branchId,
            deviceId: p.deviceId,
            userId: p.userId,
            commandType: p.commandType,
            clientHlc: p.clientHlc,
            payload: p.payload,
          })),
        }),
      });

      if (!response.ok) {
        throw new Error(`Sync HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        receipts: Array<{ idempotencyKey: string; status: string }>;
        serverTime: string;
      };

      await localDb.transaction("rw", localDb.syncOutbox, async () => {
        for (const receipt of data.receipts) {
          await localDb.syncOutbox.update(receipt.idempotencyKey, {
            syncStatus: receipt.status === "conflict_flagged" ? "conflict" : "synced",
          });
        }
      });

      const remaining = await this.refreshPendingCount();
      this.emit({
        connectivity: "online",
        pendingCount: remaining,
        lastSyncedAt: data.serverTime,
      });
    } catch {
      this.emit({ connectivity: "offline" });
    }
  }
}

export const syncEngine = new SyncEngine();

