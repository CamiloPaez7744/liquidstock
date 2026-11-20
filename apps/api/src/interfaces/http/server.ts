import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";
import type { OfflineSyncCommand } from "@liquistock/domain";
import { ProcessSyncBatchUseCase } from "../../application/sync/process-sync-batch.use-case.js";
import { pool } from "../../infrastructure/db/pool.js";
import { PostgresSyncRepository } from "../../infrastructure/db/postgres-sync.repository.js";
import { branchHub } from "../../infrastructure/realtime/branch-hub.js";

const syncBatchSchema = z.object({
  branchId: z.string().uuid(),
  deviceId: z.string().min(1),
  commands: z.array(
    z.object({
      idempotencyKey: z.string().uuid(),
      branchId: z.string().uuid(),
      deviceId: z.string().min(1),
      userId: z.string().uuid(),
      commandType: z.enum([
        "OPEN_TABLE_SESSION",
        "CREATE_SUB_ACCOUNT",
        "ADD_ORDER_ITEM",
        "VOID_ORDER_ITEM",
        "MOVE_ORDER_ITEM",
        "RECORD_PAYMENT",
        "CHARGE_SUB_ACCOUNT_CREDIT",
        "CLOSE_CASH_SHIFT",
      ]),
      clientHlc: z.string().datetime(),
      payload: z.record(z.unknown()),
    }),
  ),
});

export async function buildServer() {
  const app = Fastify({ logger: true });

  const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
  fs.mkdirSync(uploadDir, { recursive: true });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(",") ?? true,
    credentials: true,
  });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max product image
  });
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: "/uploads/",
  });
  await app.register(websocket);

  const syncUseCase = new ProcessSyncBatchUseCase(new PostgresSyncRepository());

  app.get("/health", async () => {
    try {
      await pool.query("SELECT 1");
      return { status: "healthy", database: "connected", service: "liquistock-api" };
    } catch {
      return { status: "degraded", database: "unreachable", service: "liquistock-api" };
    }
  });

  // Real-time multi-tablet WebSocket channel scoped by branch
  app.get("/ws/:branchId", { websocket: true }, (socket, req) => {
    const { branchId } = req.params as { branchId: string };
    branchHub.subscribe(branchId, socket);
    socket.send(
      JSON.stringify({
        type: "CONNECTED",
        branchId,
        serverTime: new Date().toISOString(),
      }),
    );
  });

  // Idempotent Offline Outbox Sync endpoint
  app.post("/api/v1/sync/batch", async (request, reply) => {
    const parsed = syncBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_SYNC_BATCH",
        issues: parsed.error.issues,
      });
    }

    const result = await syncUseCase.execute(parsed.data.commands as OfflineSyncCommand[]);

    if (result.receipts.some((r) => r.status === "applied")) {
      branchHub.broadcast({
        type: "SYNC_BATCH_APPLIED",
        branchId: parsed.data.branchId,
        originDeviceId: parsed.data.deviceId,
        timestamp: result.serverTime,
        payload: { count: result.receipts.length },
      });
    }

    return reply.send(result);
  });

  return app;
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = await buildServer();
  await server.listen({ port, host });
}

