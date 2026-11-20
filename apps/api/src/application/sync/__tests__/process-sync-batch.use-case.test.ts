import { describe, expect, it } from "vitest";
import { generateUuidV7, type OfflineSyncCommand } from "@liquistock/domain";
import type { ISyncRepository, SyncCommandReceipt } from "../../../domain/ports/sync-repository.port.js";
import { ProcessSyncBatchUseCase } from "../process-sync-batch.use-case.js";

class InMemorySyncRepository implements ISyncRepository {
  private readonly processed = new Set<string>();
  public readonly executionOrder: string[] = [];

  async processCommandIdempotently(command: OfflineSyncCommand): Promise<SyncCommandReceipt> {
    if (this.processed.has(command.idempotencyKey)) {
      return {
        idempotencyKey: command.idempotencyKey,
        status: "already_processed",
      };
    }
    this.processed.add(command.idempotencyKey);
    this.executionOrder.push(command.idempotencyKey);
    return {
      idempotencyKey: command.idempotencyKey,
      status: "applied",
    };
  }
}

describe("ProcessSyncBatchUseCase", () => {
  it("orders commands chronologically by UUIDv7 and deduplicates offline retries idempotently", async () => {
    const repo = new InMemorySyncRepository();
    const useCase = new ProcessSyncBatchUseCase(repo);

    const k1 = generateUuidV7(1700000001000);
    const k2 = generateUuidV7(1700000002000);

    const cmd2: OfflineSyncCommand = {
      idempotencyKey: k2,
      branchId: "01950000-0000-7000-8000-000000000001",
      deviceId: "tablet-1",
      userId: "01950000-0000-7000-8000-000000000010",
      commandType: "ADD_ORDER_ITEM",
      clientHlc: "2026-11-20T20:00:02.000Z",
      payload: { qty: 1 },
    };

    const cmd1: OfflineSyncCommand = {
      idempotencyKey: k1,
      branchId: "01950000-0000-7000-8000-000000000001",
      deviceId: "tablet-1",
      userId: "01950000-0000-7000-8000-000000000010",
      commandType: "OPEN_TABLE_SESSION",
      clientHlc: "2026-11-20T20:00:01.000Z",
      payload: { table: "Mesa 4" },
    };

    // Send out-of-order + duplicate retry
    const first = await useCase.execute([cmd2, cmd1]);
    expect(repo.executionOrder).toEqual([k1, k2]);
    expect(first.receipts.map((r) => r.status)).toEqual(["applied", "applied"]);

    // Retry same batch after flaky Wi-Fi
    const retry = await useCase.execute([cmd1, cmd2]);
    expect(retry.receipts.map((r) => r.status)).toEqual([
      "already_processed",
      "already_processed",
    ]);
    expect(repo.executionOrder).toEqual([k1, k2]);
  });
});

