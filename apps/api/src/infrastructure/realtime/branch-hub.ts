import type { WebSocket } from "ws";

export interface BranchRealtimeEvent {
  type:
    | "SYNC_BATCH_APPLIED"
    | "ORDER_UPDATED"
    | "INVENTORY_UPDATED"
    | "CATALOG_UPDATED"
    | "SHIFT_UPDATED"
    | "OPERATIONS_PURGED";
  branchId: string;
  originDeviceId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

/**
 * Real-time WebSocket hub scoped per branchId so all tablets & POS cashiers
 * in the same bar see table changes, stock depletion, and closed allies instantly.
 */
export class BranchRealtimeHub {
  private readonly clientsByBranch = new Map<string, Set<WebSocket>>();

  subscribe(branchId: string, socket: WebSocket): void {
    let set = this.clientsByBranch.get(branchId);
    if (!set) {
      set = new Set();
      this.clientsByBranch.set(branchId, set);
    }
    set.add(socket);

    socket.on("close", () => {
      set?.delete(socket);
      if (set && set.size === 0) {
        this.clientsByBranch.delete(branchId);
      }
    });
  }

  broadcast(event: BranchRealtimeEvent): void {
    const clients = this.clientsByBranch.get(event.branchId);
    if (!clients || clients.size === 0) return;

    const message = JSON.stringify(event);
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  }

  connectedCount(branchId: string): number {
    return this.clientsByBranch.get(branchId)?.size ?? 0;
  }
}

export const branchHub = new BranchRealtimeHub();

