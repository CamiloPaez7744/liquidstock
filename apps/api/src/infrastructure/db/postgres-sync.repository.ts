import type { OfflineSyncCommand } from "@liquistock/domain";
import type { ISyncRepository, SyncCommandReceipt } from "../../domain/ports/sync-repository.port.js";
import { withTransaction } from "./pool.js";

/**
 * PostgreSQL adapter for idempotent offline outbox processing.
 * Uses `sync_processed_events` PK (idempotency_key) to guarantee exactly-once application.
 */
export class PostgresSyncRepository implements ISyncRepository {
  async processCommandIdempotently(command: OfflineSyncCommand): Promise<SyncCommandReceipt> {
    return withTransaction(async (client) => {
      const insertCheck = await client.query(
        `INSERT INTO sync_processed_events (idempotency_key, branch_id, device_id, command_type, client_hlc, result_status)
         VALUES ($1, $2, $3, $4, $5, 'applied')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [
          command.idempotencyKey,
          command.branchId,
          command.deviceId,
          command.commandType,
          command.clientHlc,
        ],
      );

      if (insertCheck.rowCount === 0) {
        return {
          idempotencyKey: command.idempotencyKey,
          status: "already_processed",
        };
      }

      // Phase 1 command handlers will plug directly here inside the same ACID transaction.
      return {
        idempotencyKey: command.idempotencyKey,
        status: "applied",
      };
    });
  }
}

