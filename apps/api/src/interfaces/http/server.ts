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
import {
  extractBearerToken,
  loadAuthContextFromToken,
  requireBranchRole,
} from "../../infrastructure/auth/auth-guard.js";
import { db, dbEngineLabel } from "../../infrastructure/db/pool.js";
import { PostgresSyncRepository } from "../../infrastructure/db/postgres-sync.repository.js";
import { branchHub } from "../../infrastructure/realtime/branch-hub.js";
import { registerAdminCatalogRoutes } from "./routes/admin-catalog.routes.js";
import { registerAuthAndUsersRoutes } from "./routes/auth-users.routes.js";
import { registerBootstrapRoutes } from "./routes/bootstrap.routes.js";
import { registerInventoryRoutes } from "./routes/inventory.routes.js";
import { registerShiftsAndKpisRoutes } from "./routes/shifts-kpis.routes.js";

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
        "ADJUST_ORDER_ITEM_PRICE",
        "APPLY_PROMOTION_TO_SUB_ACCOUNT",
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
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 },
  });
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: "/uploads/",
  });
  await app.register(websocket);

  const syncUseCase = new ProcessSyncBatchUseCase(new PostgresSyncRepository());

  app.get("/health", async () => {
    try {
      await db.query("SELECT 1");
      return {
        status: "healthy",
        database: "connected",
        engine: dbEngineLabel,
        service: "liquistock-api",
      };
    } catch {
      return {
        status: "degraded",
        database: "unreachable",
        engine: dbEngineLabel,
        service: "liquistock-api",
      };
    }
  });

  // Authenticated Real-time multi-tablet WebSocket channel scoped by branch
  app.get("/ws/:branchId", { websocket: true }, async (socket, req) => {
    const { branchId } = req.params as { branchId: string };
    const token = extractBearerToken(req);
    const auth = token ? await loadAuthContextFromToken(token) : null;
    if (!auth || !auth.memberships.some((m) => m.branchId === branchId)) {
      socket.close(1008, "Unauthorized");
      return;
    }

    branchHub.subscribe(branchId, socket);
    socket.send(
      JSON.stringify({
        type: "CONNECTED",
        branchId,
        serverTime: new Date().toISOString(),
      }),
    );
  });

  // Authenticated Idempotent Offline Outbox Sync endpoint
  app.post("/api/v1/sync/batch", async (request, reply) => {
    const parsed = syncBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_SYNC_BATCH",
        issues: parsed.error.issues,
      });
    }

    const auth = await requireBranchRole(request, reply, parsed.data.branchId, [
      "admin",
      "cashier",
      "waiter",
    ]);
    if (!auth) return;

    // Enforce server-authenticated actor identity on every command
    const authenticatedCommands: OfflineSyncCommand[] = parsed.data.commands.map((c) => ({
      ...(c as OfflineSyncCommand),
      branchId: parsed.data.branchId,
      userId: auth.userId,
    }));

    const result = await syncUseCase.execute(authenticatedCommands);

    if (result.receipts.some((r) => r.status === "applied" || r.status === "conflict_flagged")) {
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

  await registerAuthAndUsersRoutes(app);
  await registerBootstrapRoutes(app);
  await registerAdminCatalogRoutes(app, uploadDir);
  await registerInventoryRoutes(app);
  await registerShiftsAndKpisRoutes(app);

  return app;
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = await buildServer();
  await server.listen({ port, host });
}
