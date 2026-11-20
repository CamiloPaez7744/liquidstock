import type { OfflineSyncCommand } from "@liquistock/domain";

export interface SyncCommandReceipt {
  idempotencyKey: string;
  status: "applied" | "already_processed" | "conflict_flagged";
  detail?: string;
}

export interface ISyncRepository {
  processCommandIdempotently(command: OfflineSyncCommand): Promise<SyncCommandReceipt>;
}

