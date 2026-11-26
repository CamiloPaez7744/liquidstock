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
  requireBranchModulePermission,
} from "../../infrastructure/auth/auth-guard.js";
import { closeDb, db, dbEngineLabel } from "../../infrastructure/db/pool.js";
import { getBranchOpenShiftStatus } from "../../infrastructure/db/treasury.js";
import { isCloudinaryConfigured } from "../../infrastructure/media/cloudinary.js";
import { PostgresSyncRepository } from "../../infrastructure/db/postgres-sync.repository.js";
import { branchHub } from "../../infrastructure/realtime/branch-hub.js";
import { registerAdminCatalogRoutes } from "./routes/admin-catalog.routes.js";
import { registerAuthAndUsersRoutes } from "./routes/auth-users.routes.js";
import { registerBootstrapRoutes } from "./routes/bootstrap.routes.js";
import { registerInventoryRoutes } from "./routes/inventory.routes.js";
import { registerPhase3OperationsRoutes } from "./routes/phase3-operations.routes.js";
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
        "UPDATE_SUB_ACCOUNT",
        "DELETE_SUB_ACCOUNT",
        "ADD_ORDER_ITEM",
        "ADD_CUSTOM_CHARGE",
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

  // Safe idempotent schema evolution for live embedded PGlite / PostgreSQL instances
  try {
    await db.query(`ALTER TABLE menu_products ADD COLUMN IF NOT EXISTS edition_tag TEXT`);
    await db.query(
      `ALTER TABLE branches ADD COLUMN IF NOT EXISTS role_permissions jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    await db.query(`
      CREATE TABLE IF NOT EXISTS cash_expenses (
        id uuid PRIMARY KEY,
        branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        cash_shift_id uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
        payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
        category text NOT NULL DEFAULT 'otro',
        description text NOT NULL,
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_cash_expenses_branch_created ON cash_expenses (branch_id, created_at DESC)`,
    );
    await db.query(
      `ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS declared_by_method jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    await db.query(`ALTER TABLE order_items ALTER COLUMN menu_product_id DROP NOT NULL`);
    await db.query(`ALTER TABLE order_items ALTER COLUMN presentation_id DROP NOT NULL`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS cash_extras (
        id uuid PRIMARY KEY,
        branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        cash_shift_id uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
        payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
        category text NOT NULL DEFAULT 'otro',
        description text NOT NULL,
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_cash_extras_branch_created ON cash_extras (branch_id, created_at DESC)`,
    );
    await db.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS operational_go_live_at timestamptz`);
    await db.query(`
      CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
          IF TG_OP = 'DELETE' AND current_setting('liquistock.allow_superadmin_purge', true) = 'true' THEN
              RETURN OLD;
          END IF;
          RAISE EXCEPTION 'Ledger table % is append-only; use a compensating entry instead.', TG_TABLE_NAME
              USING ERRCODE = '42501';
      END;
      $$
    `);
    // Migration 009 idempotent evolution for live PGlite / PostgreSQL instances
    await db.query(`ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS is_internal_vault boolean NOT NULL DEFAULT false`);
    await db.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS operating_schedules jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await db.query(`ALTER TABLE allies ADD COLUMN IF NOT EXISTS operating_schedules jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await db.query(`ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS expected_opening_float numeric(12,2) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS opening_discrepancy numeric(12,2) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS transfer_to_vault_amount numeric(12,2) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS closing_cash_left numeric(12,2)`);
    await db.query(`ALTER TABLE cash_expenses ADD COLUMN IF NOT EXISTS reference_type text`);
    await db.query(`ALTER TABLE cash_expenses ADD COLUMN IF NOT EXISTS reference_id uuid`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS cash_transfers (
        id uuid PRIMARY KEY,
        branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        cash_shift_id uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
        from_payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
        to_payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        notes text,
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS supplier_payables (
        id uuid PRIMARY KEY,
        branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        supplier_name text NOT NULL,
        description text NOT NULL,
        inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
        total_amount numeric(14,2) NOT NULL CHECK (total_amount > 0),
        paid_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid')),
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS supplier_payments (
        id uuid PRIMARY KEY,
        branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        supplier_payable_id uuid NOT NULL REFERENCES supplier_payables(id) ON DELETE CASCADE,
        payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
        cash_expense_id uuid REFERENCES cash_expenses(id) ON DELETE SET NULL,
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        notes text,
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS combo_templates (
        id uuid PRIMARY KEY,
        branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        name text NOT NULL,
        short_label text,
        scope_type text NOT NULL CHECK (scope_type IN ('category', 'product')),
        target_id uuid NOT NULL,
        presentation_group text NOT NULL,
        pricing_mode text NOT NULL DEFAULT 'fixed_price' CHECK (pricing_mode IN ('fixed_price', 'add_on_price')),
        price_value numeric(12,2) NOT NULL CHECK (price_value >= 0),
        ally_id uuid REFERENCES allies(id) ON DELETE SET NULL,
        ally_payout_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (ally_payout_amount >= 0),
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS description text`);
    await db.query(
      `ALTER TABLE combo_templates ADD COLUMN IF NOT EXISTS base_quantity integer NOT NULL DEFAULT 1`,
    );
    await db.query(
      `ALTER TABLE combo_templates ADD COLUMN IF NOT EXISTS companion_type text NOT NULL DEFAULT 'ally'`,
    );
    await db.query(
      `ALTER TABLE combo_templates ADD COLUMN IF NOT EXISTS fixed_recipes jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  } catch {
    // Table may not exist yet before migrations run in test harness
  }

  const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
  fs.mkdirSync(uploadDir, { recursive: true });

  const rawCorsOrigins = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const corsOrigin: boolean | string[] =
    rawCorsOrigins.length === 0 || rawCorsOrigins.includes("*") ? true : rawCorsOrigins;

  await app.register(cors, {
    origin: corsOrigin,
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
    const mediaStorage = isCloudinaryConfigured() ? "cloudinary" : "local-disk";
    try {
      await db.query("SELECT 1");
      return {
        status: "healthy",
        database: "connected",
        engine: dbEngineLabel,
        mediaStorage,
        service: "liquistock-api",
      };
    } catch {
      return {
        status: "degraded",
        database: "unreachable",
        engine: dbEngineLabel,
        mediaStorage,
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

    const auth = await requireBranchModulePermission(
      request,
      reply,
      parsed.data.branchId,
      "pos",
      "edit",
    );
    if (!auth) return;

    // Enforce active cash shift (< 24h) before accepting new POS sales/orders
    const saleCommands = new Set([
      "OPEN_TABLE_SESSION",
      "ADD_ORDER_ITEM",
      "ADD_CUSTOM_CHARGE",
      "RECORD_PAYMENT",
      "CHARGE_SUB_ACCOUNT_CREDIT",
    ]);
    if (parsed.data.commands.some((c) => saleCommands.has(c.commandType))) {
      const shiftStatus = await getBranchOpenShiftStatus(parsed.data.branchId);
      if (!shiftStatus.shift) {
        return reply.status(409).send({
          error: "SHIFT_REQUIRED",
          message: "Debes hacer la apertura de caja antes de iniciar ventas en el POS.",
        });
      }
      if (shiftStatus.isExpired24h) {
        return reply.status(409).send({
          error: "SHIFT_EXPIRED_24H",
          message:
            "El turno abierto lleva más de 24 horas. Ciérralo y abre una nueva caja para continuar vendiendo.",
        });
      }
    }

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
  await registerPhase3OperationsRoutes(app);

  return app;
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = await buildServer();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, "Shutting down LiquiStock API gracefully...");
    try {
      await server.close();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await server.listen({ port, host });
}
