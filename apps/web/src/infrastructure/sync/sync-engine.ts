import { API_BASE_URL, getAuthToken, WS_BASE_URL } from "../api/api-client.js";
import { getOrCreateDeviceId, localDb } from "../storage/dexie/db.js";

export type ConnectivityState = "online" | "syncing" | "offline";

export interface SyncStatusSnapshot {
  connectivity: ConnectivityState;
  pendingCount: number;
  lastSyncedAt: string | null;
  wsConnected: boolean;
}

type StatusListener = (snapshot: SyncStatusSnapshot) => void;
type RemoteEventListener = (eventType: string) => void;

export class SyncEngine {
  private readonly statusListeners = new Set<StatusListener>();
  private readonly remoteListeners = new Set<RemoteEventListener>();
  private socket: WebSocket | null = null;
  private flushTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private activeBranchId: string | null = null;
  private state: SyncStatusSnapshot = {
    connectivity: typeof navigator !== "undefined" && navigator.onLine ? "online" : "offline",
    pendingCount: 0,
    lastSyncedAt: null,
    wsConnected: false,
  };

  subscribe(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.state);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onRemoteChange(listener: RemoteEventListener): () => void {
    this.remoteListeners.add(listener);
    return () => {
      this.remoteListeners.delete(listener);
    };
  }

  private emit(patch: Partial<SyncStatusSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.statusListeners) {
      listener(this.state);
    }
  }

  start(branchId: string): () => void {
    this.activeBranchId = branchId;

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
    }, 5_000);

    return () => {
      this.activeBranchId = null;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (this.flushTimer !== null) window.clearInterval(this.flushTimer);
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      this.socket?.close();
    };
  }

  private connectWebSocket(branchId: string): void {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const token = getAuthToken();
    if (!token) return;
    try {
      this.socket?.close();
      const ws = new WebSocket(`${WS_BASE_URL}/ws/${branchId}?token=${encodeURIComponent(token)}`);
      this.socket = ws;

      ws.onopen = () => this.emit({ wsConnected: true, connectivity: "online" });
      ws.onclose = () => {
        this.emit({ wsConnected: false });
        if (this.activeBranchId === branchId && navigator.onLine) {
          this.reconnectTimer = window.setTimeout(() => this.connectWebSocket(branchId), 4_000);
        }
      };
      ws.onerror = () => this.emit({ wsConnected: false });
      ws.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(String(evt.data)) as { type?: string };
          if (parsed.type && parsed.type !== "CONNECTED") {
            for (const cb of this.remoteListeners) {
              cb(parsed.type);
            }
          }
        } catch {
          // Ignore malformed ws messages
        }
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

  async flushOutbox(branchId: string): Promise<boolean> {
    const pending = await localDb.syncOutbox
      .where("syncStatus")
      .equals("pending")
      .sortBy("idempotencyKey");

    this.emit({ pendingCount: pending.length });
    if (pending.length === 0 || (typeof navigator !== "undefined" && !navigator.onLine)) {
      return false;
    }

    this.emit({ connectivity: "syncing" });
    try {
      const token = getAuthToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const response = await fetch(`${API_BASE_URL}/api/v1/sync/batch`, {
        method: "POST",
        headers,
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
      return true;
    } catch {
      this.emit({ connectivity: "offline" });
      return false;
    }
  }
}

export const syncEngine = new SyncEngine();
