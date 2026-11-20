import type { OfflineSyncCommand } from "@liquistock/domain";
import type { ISyncRepository, SyncCommandReceipt } from "../../domain/ports/sync-repository.port.js";

export interface SyncBatchOutput {
  receipts: SyncCommandReceipt[];
  serverTime: string;
}

/**
 * Application Use Case: processes an offline tablet's outbox batch in chronological order
 * (guaranteed by UUIDv7 keys) with strict idempotency so network retries never duplicate sales or stock deductions.
 */
export class ProcessSyncBatchUseCase {
  constructor(private readonly syncRepo: ISyncRepository) {}

  async execute(commands: readonly OfflineSyncCommand[]): Promise<SyncBatchOutput> {
    const ordered = [...commands].sort((a, b) =>
      a.idempotencyKey.localeCompare(b.idempotencyKey),
    );

    const receipts: SyncCommandReceipt[] = [];
    for (const cmd of ordered) {
      const receipt = await this.syncRepo.processCommandIdempotently(cmd);
      receipts.push(receipt);
    }

    return {
      receipts,
      serverTime: new Date().toISOString(),
    };
  }
}

