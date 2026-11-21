import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { convertToBaseUnit, generateUuidV7, type BaseUnit, type DisplayUnit } from "@liquistock/domain";
import { requireAuth, requireBranchRole } from "../../../infrastructure/auth/auth-guard.js";
import { db, withTransaction } from "../../../infrastructure/db/pool.js";
import { branchHub } from "../../../infrastructure/realtime/branch-hub.js";

const settingsSchema = z.object({
  enableTables: z.boolean().optional(),
  enableSplitAccounts: z.boolean().optional(),
  enableCreditAccounts: z.boolean().optional(),
  enableAllies: z.boolean().optional(),
  enablePromotions: z.boolean().optional(),
  enableFoamLossFormula: z.boolean().optional(),
  hideOutOfStockInPos: z.boolean().optional(),
  autoHideClosedAllies: z.boolean().optional(),
  allowCloseShiftWithOpenTables: z.boolean().optional(),
});

const productCreateSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1).max(120),
  shortLabel: z.string().max(30).optional().nullable(),
  imageUrl: z.string().max(500).optional().nullable(),
  editionTag: z.string().max(32).optional().nullable(),
  productKind: z.enum(["standard", "combo", "third_party_ally"]).default("standard"),
  allyId: z.string().uuid().optional().nullable(),
  availableFrom: z.string().optional().nullable(),
  availableUntil: z.string().optional().nullable(),
  isAvailable: z.boolean().default(true),
});

const recipeInputSchema = z.object({
  inventoryItemId: z.string().uuid(),
  displayUnit: z.enum(["ml", "oz", "L", "g", "kg", "unit"]),
  displayQuantity: z.number().positive(),
  pourLossPercent: z.number().min(0).max(100).default(0),
  fixedLossBase: z.number().min(0).default(0),
});

const presentationCreateSchema = z.object({
  menuProductId: z.string().uuid(),
  name: z.string().min(1).max(100),
  shortLabel: z.string().max(24).optional().nullable(),
  presentationGroup: z.enum([
    "vaso",
    "pinta",
    "jarra",
    "jirafa",
    "shot",
    "trago",
    "coctel",
    "botella",
    "lata",
    "combo",
    "comida",
    "otro",
  ]),
  imageUrl: z.string().max(500).optional().nullable(),
  salePrice: z.number().min(0),
  allyId: z.string().uuid().optional().nullable(),
  allyPayoutAmount: z.number().min(0).default(0),
  isAvailable: z.boolean().default(true),
  recipes: z.array(recipeInputSchema).default([]),
});

const allyPatchSchema = z.object({
  name: z.string().min(1).optional(),
  contactPhone: z.string().optional().nullable(),
  openTime: z.string().optional().nullable(),
  closeTime: z.string().optional().nullable(),
  operatingDays: z.array(z.number().int().min(1).max(7)).optional().nullable(),
  isTemporarilyClosed: z.boolean().optional(),
});

const promoCreateSchema = z.object({
  name: z.string().min(1),
  ruleType: z.enum(["bxgy", "percentage_discount", "fixed_discount", "fixed_price"]),
  scopeType: z.enum(["category", "product", "presentation", "order"]),
  applicationMode: z.enum(["automatic", "manual_at_checkout"]).default("automatic"),
  targetId: z.string().uuid().optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).optional().nullable(),
  startTime: z.string().optional().nullable(),
  endTime: z.string().optional().nullable(),
  validFrom: z.string().optional().nullable(),
  validUntil: z.string().optional().nullable(),
  config: z.record(z.unknown()).default({}),
  priority: z.number().int().default(50),
  isActive: z.boolean().default(true),
});

const customerSchema = z.object({
  fullName: z.string().min(1),
  nickname: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  creditStatus: z.enum(["standard", "whitelist_credit", "blacklist_blocked"]).default("standard"),
  creditLimit: z.number().min(0).optional().nullable(),
  statusReason: z.string().optional().nullable(),
});

const categoryCreateSchema = z.object({
  name: z.string().min(1).max(60),
  colorToken: z.enum(["cyan", "amber", "magenta", "emerald"]).default("cyan"),
});

const allyCreateSchema = z.object({
  name: z.string().min(1).max(120),
  contactPhone: z.string().optional().nullable(),
  openTime: z.string().default("12:00"),
  closeTime: z.string().default("23:00"),
  operatingDays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5, 6, 7]),
});

const comboCreateSchema = z.object({
  name: z.string().min(1).max(120),
  presentationLabel: z.string().min(1).max(100).optional(),
  categoryId: z.string().uuid().optional(),
  newCategoryName: z.string().min(1).max(60).optional(),
  imageUrl: z.string().max(500).optional().nullable(),
  salePrice: z.number().min(0),
  allyId: z.string().uuid().optional().nullable(),
  allyPayoutAmount: z.number().min(0).default(0),
  recipes: z.array(recipeInputSchema).default([]),
});

function broadcastCatalogChange(branchId: string, action: string) {
  branchHub.broadcast({
    type: "CATALOG_UPDATED",
    branchId,
    originDeviceId: "admin",
    timestamp: new Date().toISOString(),
    payload: { action },
  });
}

export async function registerAdminCatalogRoutes(app: FastifyInstance, uploadDir: string) {
  // Upload product image (authenticated users only; cached offline by PWA Service Worker)
  app.post("/api/v1/uploads/image", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: "NO_FILE_UPLOADED" });
    }
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
    if (!allowed.has(file.mimetype)) {
      return reply.status(400).send({ error: "UNSUPPORTED_IMAGE_TYPE" });
    }

    const ext = file.mimetype.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    const filename = `${generateUuidV7()}.${ext}`;
    const destPath = path.join(uploadDir, filename);

    await pipeline(file.file, fs.createWriteStream(destPath));
    return { imageUrl: `/uploads/${filename}` };
  });

  // Add dining table to branch (Admin only)
  app.post("/api/v1/branches/:branchId/tables", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const parsed = z
      .object({ label: z.string().min(1).max(40), zone: z.string().min(1).max(40).default("Salón") })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_TABLE" });

    const id = generateUuidV7();
    const maxSort = await db.query<{ next_sort: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM dining_tables WHERE branch_id = $1`,
      [branchId],
    );
    await db.query(
      `INSERT INTO dining_tables (id, branch_id, label, zone, sort_order) VALUES ($1, $2, $3, $4, $5)`,
      [id, branchId, parsed.data.label.trim(), parsed.data.zone.trim(), maxSort.rows[0]?.next_sort ?? 1],
    );
    broadcastCatalogChange(branchId, "TABLE_CREATED");
    return reply.status(201).send({ id });
  });

  app.patch("/api/v1/branches/:branchId/tables/:tableId", async (request, reply) => {
    const { branchId, tableId } = request.params as { branchId: string; tableId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const parsed = z
      .object({
        label: z.string().min(1).max(40).optional(),
        zone: z.string().min(1).max(40).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_TABLE_PATCH" });

    const res = await db.query(
      `UPDATE dining_tables
       SET label = COALESCE($3, label),
           zone = COALESCE($4, zone)
       WHERE id = $1 AND branch_id = $2 AND is_active = true
       RETURNING id`,
      [tableId, branchId, parsed.data.label?.trim() ?? null, parsed.data.zone?.trim() ?? null],
    );
    if (res.rows.length === 0) return reply.status(404).send({ error: "TABLE_NOT_FOUND" });

    broadcastCatalogChange(branchId, "TABLE_UPDATED");
    return { id: tableId };
  });

  app.delete("/api/v1/branches/:branchId/tables/:tableId", async (request, reply) => {
    const { branchId, tableId } = request.params as { branchId: string; tableId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const openCheck = await db.query(
      `SELECT 1 FROM table_sessions WHERE dining_table_id = $1 AND branch_id = $2 AND status = 'open' LIMIT 1`,
      [tableId, branchId],
    );
    if (openCheck.rows.length > 0) {
      return reply.status(409).send({
        error: "TABLE_HAS_OPEN_SESSION",
        message: "Esta mesa tiene una cuenta abierta. Cóbrala o ciérrala antes de eliminarla.",
      });
    }

    const usedBefore = await db.query(
      `SELECT 1 FROM table_sessions WHERE dining_table_id = $1 AND branch_id = $2 LIMIT 1`,
      [tableId, branchId],
    );
    const res =
      usedBefore.rows.length > 0
        ? await db.query(
            `UPDATE dining_tables SET is_active = false WHERE id = $1 AND branch_id = $2 RETURNING id`,
            [tableId, branchId],
          )
        : await db.query(
            `DELETE FROM dining_tables WHERE id = $1 AND branch_id = $2 RETURNING id`,
            [tableId, branchId],
          );

    if (res.rows.length === 0) return reply.status(404).send({ error: "TABLE_NOT_FOUND" });

    broadcastCatalogChange(branchId, "TABLE_DELETED");
    return { deleted: true, id: tableId };
  });

  // Add payment method label to branch (Admin only)
  app.post("/api/v1/branches/:branchId/payment-methods", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const parsed = z
      .object({
        name: z.string().min(1).max(40),
        countsAsPhysicalCash: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_PAYMENT_METHOD" });

    const id = generateUuidV7();
    const code = parsed.data.name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .slice(0, 18);
    const maxSort = await db.query<{ next_sort: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM payment_methods WHERE branch_id = $1`,
      [branchId],
    );
    await db.query(
      `INSERT INTO payment_methods (id, branch_id, name, code, counts_as_physical_cash, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        branchId,
        parsed.data.name.trim(),
        `${code}_${id.slice(-4).toUpperCase()}`,
        parsed.data.countsAsPhysicalCash,
        maxSort.rows[0]?.next_sort ?? 10,
      ],
    );
    broadcastCatalogChange(branchId, "PAYMENT_METHOD_CREATED");
    return reply.status(201).send({ id });
  });

  app.patch("/api/v1/branches/:branchId/payment-methods/:paymentMethodId", async (request, reply) => {
    const { branchId, paymentMethodId } = request.params as {
      branchId: string;
      paymentMethodId: string;
    };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const parsed = z
      .object({
        name: z.string().min(1).max(40).optional(),
        countsAsPhysicalCash: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_PAYMENT_METHOD_PATCH" });

    const res = await db.query(
      `UPDATE payment_methods
       SET name = COALESCE($3, name),
           counts_as_physical_cash = COALESCE($4, counts_as_physical_cash)
       WHERE id = $1 AND branch_id = $2 AND is_active = true
       RETURNING id`,
      [
        paymentMethodId,
        branchId,
        parsed.data.name?.trim() ?? null,
        parsed.data.countsAsPhysicalCash ?? null,
      ],
    );
    if (res.rows.length === 0) return reply.status(404).send({ error: "PAYMENT_METHOD_NOT_FOUND" });

    broadcastCatalogChange(branchId, "PAYMENT_METHOD_UPDATED");
    return { id: paymentMethodId };
  });

  app.delete("/api/v1/branches/:branchId/payment-methods/:paymentMethodId", async (request, reply) => {
    const { branchId, paymentMethodId } = request.params as {
      branchId: string;
      paymentMethodId: string;
    };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const activeCountRes = await db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM payment_methods WHERE branch_id = $1 AND is_active = true`,
      [branchId],
    );
    if (Number(activeCountRes.rows[0]?.cnt ?? "0") <= 1) {
      return reply.status(400).send({
        error: "LAST_PAYMENT_METHOD",
        message: "Debe quedar al menos un medio de pago activo en la sucursal.",
      });
    }

    const usedInPayments = await db.query(
      `SELECT 1 FROM payments WHERE payment_method_id = $1 AND branch_id = $2 LIMIT 1`,
      [paymentMethodId, branchId],
    );
    const res =
      usedInPayments.rows.length > 0
        ? await db.query(
            `UPDATE payment_methods SET is_active = false WHERE id = $1 AND branch_id = $2 RETURNING id`,
            [paymentMethodId, branchId],
          )
        : await db.query(
            `DELETE FROM payment_methods WHERE id = $1 AND branch_id = $2 RETURNING id`,
            [paymentMethodId, branchId],
          );

    if (res.rows.length === 0) return reply.status(404).send({ error: "PAYMENT_METHOD_NOT_FOUND" });

    broadcastCatalogChange(branchId, "PAYMENT_METHOD_DELETED");
    return { deleted: true, id: paymentMethodId };
  });

  // Toggle modular branch feature flags
  app.patch("/api/v1/branches/:branchId/settings", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_SETTINGS", issues: parsed.error.issues });
    }

    // Guard: prevent disabling split accounts while any table has >1 open sub-account!
    if (parsed.data.enableSplitAccounts === false) {
      const openSplitRows = await db.query<{
        table_session_id: string;
        table_label: string;
        sub_account_id: string;
        sub_label: string;
        total_amount: string;
        paid_amount: string;
        credit_amount: string;
        item_count: string;
      }>(
        `SELECT ts.id AS table_session_id,
                COALESCE(dt.label, 'Barra Rápida') AS table_label,
                sa.id AS sub_account_id,
                sa.label AS sub_label,
                sa.total_amount::text,
                sa.paid_amount::text,
                sa.credit_amount::text,
                COALESCE((
                  SELECT COUNT(*)::text FROM order_items oi
                  WHERE oi.sub_account_id = sa.id AND oi.status = 'active'
                ), '0') AS item_count
         FROM table_sessions ts
         LEFT JOIN dining_tables dt ON dt.id = ts.dining_table_id
         JOIN sub_accounts sa ON sa.table_session_id = ts.id AND sa.status = 'open'
         WHERE ts.branch_id = $1 AND ts.status = 'open'
         ORDER BY ts.opened_at ASC, sa.created_at ASC`,
        [branchId],
      );

      const bySession = new Map<
        string,
        {
          tableSessionId: string;
          tableLabel: string;
          subAccounts: Array<{
            id: string;
            label: string;
            itemCount: number;
            totalAmount: number;
            paidAmount: number;
            creditAmount: number;
          }>;
        }
      >();

      for (const row of openSplitRows.rows) {
        const entry = bySession.get(row.table_session_id) ?? {
          tableSessionId: row.table_session_id,
          tableLabel: row.table_label,
          subAccounts: [],
        };
        entry.subAccounts.push({
          id: row.sub_account_id,
          label: row.sub_label,
          itemCount: Number(row.item_count),
          totalAmount: Number(row.total_amount),
          paidAmount: Number(row.paid_amount),
          creditAmount: Number(row.credit_amount),
        });
        bySession.set(row.table_session_id, entry);
      }

      const affectedTables = Array.from(bySession.values())
        .filter((s) => s.subAccounts.length > 1)
        .map((s) => {
          const secondaryHavePayments = s.subAccounts
            .slice(1)
            .some((sa) => sa.paidAmount > 0 || sa.creditAmount > 0);
          return {
            tableSessionId: s.tableSessionId,
            tableLabel: s.tableLabel,
            openSubAccountsCount: s.subAccounts.length,
            pendingTotal: s.subAccounts.reduce(
              (acc, sa) => acc + Math.max(0, sa.totalAmount - sa.paidAmount - sa.creditAmount),
              0,
            ),
            secondaryHavePayments,
            subAccounts: s.subAccounts,
          };
        });

      if (affectedTables.length > 0) {
        const canAutoConsolidate = affectedTables.every((t) => !t.secondaryHavePayments);
        return reply.status(409).send({
          error: "SPLIT_ACCOUNTS_OPEN",
          message:
            "Hay mesas con cuentas divididas abiertas. Ciérralas o unifícalas en la cuenta principal antes de activar el modo solo mesa.",
          canAutoConsolidate,
          affectedTables,
        });
      }
    }

    const res = await db.query(
      `UPDATE branches
       SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || $2::jsonb
       WHERE id = $1
       RETURNING feature_flags AS "featureFlags"`,
      [branchId, JSON.stringify(parsed.data)],
    );
    if (!res.rows[0]) return reply.status(404).send({ error: "BRANCH_NOT_FOUND" });

    broadcastCatalogChange(branchId, "SETTINGS_UPDATED");
    return res.rows[0];
  });

  // Atomically consolidate split sub-accounts into each table's primary account and disable split mode
  app.post("/api/v1/branches/:branchId/settings/consolidate-and-disable-splits", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const result = await withTransaction(async (client) => {
      const openSubsRes = await client.query<{
        table_session_id: string;
        sub_account_id: string;
        paid_amount: string;
        credit_amount: string;
      }>(
        `SELECT ts.id AS table_session_id, sa.id AS sub_account_id,
                sa.paid_amount::text, sa.credit_amount::text
         FROM table_sessions ts
         JOIN sub_accounts sa ON sa.table_session_id = ts.id AND sa.status = 'open'
         WHERE ts.branch_id = $1 AND ts.status = 'open'
         ORDER BY ts.opened_at ASC, sa.created_at ASC`,
        [branchId],
      );

      const bySession = new Map<
        string,
        Array<{ id: string; paidAmount: number; creditAmount: number }>
      >();
      for (const r of openSubsRes.rows) {
        const list = bySession.get(r.table_session_id) ?? [];
        list.push({
          id: r.sub_account_id,
          paidAmount: Number(r.paid_amount),
          creditAmount: Number(r.credit_amount),
        });
        bySession.set(r.table_session_id, list);
      }

      let consolidatedSubAccounts = 0;
      for (const [, subs] of bySession) {
        if (subs.length <= 1) continue;
        const primary = subs[0]!;
        const secondaries = subs.slice(1);

        if (secondaries.some((s) => s.paidAmount > 0 || s.creditAmount > 0)) {
          return { blocked: true as const };
        }

        for (const sec of secondaries) {
          const itemsRes = await client.query<{ id: string }>(
            `SELECT id FROM order_items WHERE sub_account_id = $1 AND status = 'active'`,
            [sec.id],
          );
          for (const item of itemsRes.rows) {
            await client.query(`UPDATE order_items SET sub_account_id = $2 WHERE id = $1`, [
              item.id,
              primary.id,
            ]);
            await client.query(
              `INSERT INTO order_item_transfers (id, order_item_id, from_sub_account_id, to_sub_account_id, moved_by, idempotency_key)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [generateUuidV7(), item.id, sec.id, primary.id, auth.userId, generateUuidV7()],
            );
          }

          await client.query(
            `UPDATE sub_accounts
             SET status = 'voided', subtotal_amount = 0, discount_amount = 0, total_amount = 0,
                 version = version + 1, updated_at = now()
             WHERE id = $1`,
            [sec.id],
          );
          consolidatedSubAccounts += 1;
        }

        const totals = await client.query<{ subtotal: string; discount: string; total: string }>(
          `SELECT COALESCE(SUM(unit_price_snap * quantity), 0)::text AS subtotal,
                  COALESCE(SUM(discount_amount), 0)::text AS discount,
                  COALESCE(SUM(line_total), 0)::text AS total
           FROM order_items WHERE sub_account_id = $1 AND status = 'active'`,
          [primary.id],
        );
        const row = totals.rows[0];
        await client.query(
          `UPDATE sub_accounts
           SET subtotal_amount = $2, discount_amount = $3, total_amount = $4,
               version = version + 1, updated_at = now()
           WHERE id = $1`,
          [primary.id, row?.subtotal ?? "0", row?.discount ?? "0", row?.total ?? "0"],
        );
      }

      const updated = await client.query(
        `UPDATE branches
         SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"enableSplitAccounts": false}'::jsonb
         WHERE id = $1
         RETURNING feature_flags AS "featureFlags"`,
        [branchId],
      );

      return {
        blocked: false as const,
        consolidatedSubAccounts,
        featureFlags: updated.rows[0]?.featureFlags ?? {},
      };
    });

    if (result.blocked) {
      return reply.status(409).send({
        error: "SPLIT_ACCOUNTS_HAVE_PAYMENTS",
        message:
          "Alguna sub-cuenta secundaria ya tiene abonos o fiado registrados. Cóbrala desde Mesas & POS antes de desactivar cuentas divididas.",
      });
    }

    broadcastCatalogChange(branchId, "SETTINGS_UPDATED");
    return result;
  });

  // Create Category (e.g. "Snacks & Papas", "Cigarrillos", "Empanadas de la Casa")
  app.post("/api/v1/branches/:branchId/categories", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = categoryCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_CATEGORY", issues: parsed.error.issues });
    }

    const id = generateUuidV7();
    const maxSort = await db.query<{ next_sort: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM categories WHERE branch_id = $1`,
      [branchId],
    );
    await db.query(
      `INSERT INTO categories (id, branch_id, name, color_token, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, branchId, parsed.data.name, parsed.data.colorToken, maxSort.rows[0]?.next_sort ?? 10],
    );
    broadcastCatalogChange(branchId, "CATEGORY_CREATED");
    return reply.status(201).send({ id, name: parsed.data.name });
  });

  // Create Product (with optional image & ally)
  app.post("/api/v1/branches/:branchId/products", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = productCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_PRODUCT", issues: parsed.error.issues });
    }

    const id = generateUuidV7();
    const d = parsed.data;
    await db.query(
      `INSERT INTO menu_products
         (id, branch_id, category_id, name, short_label, image_url, edition_tag, product_kind, ally_id, available_from, available_until, is_available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        branchId,
        d.categoryId,
        d.name,
        d.shortLabel ?? d.name.slice(0, 14),
        d.imageUrl ?? null,
        d.editionTag?.trim() || null,
        d.productKind,
        d.allyId ?? null,
        d.availableFrom || null,
        d.availableUntil || null,
        d.isAvailable,
      ],
    );

    broadcastCatalogChange(branchId, "PRODUCT_CREATED");
    return reply.status(201).send({ id });
  });

  app.patch("/api/v1/branches/:branchId/products/:productId", async (request, reply) => {
    const { branchId, productId } = request.params as { branchId: string; productId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = productCreateSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_PRODUCT_PATCH", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const hasEditionTag = Object.prototype.hasOwnProperty.call(d, "editionTag");
    await db.query(
      `UPDATE menu_products
       SET name = COALESCE($3, name),
           short_label = COALESCE($4, short_label),
           image_url = COALESCE($5, image_url),
           product_kind = COALESCE($6, product_kind),
           is_available = COALESCE($7, is_available),
           edition_tag = CASE WHEN $8::boolean THEN $9 ELSE edition_tag END,
           updated_at = now()
       WHERE id = $1 AND branch_id = $2`,
      [
        productId,
        branchId,
        d.name ?? null,
        d.shortLabel ?? null,
        d.imageUrl ?? null,
        d.productKind ?? null,
        d.isAvailable ?? null,
        hasEditionTag,
        hasEditionTag ? d.editionTag?.trim() || null : null,
      ],
    );

    broadcastCatalogChange(branchId, "PRODUCT_UPDATED");
    return { id: productId };
  });

  // Create Presentation (with recipes & foam loss formula)
  app.post("/api/v1/branches/:branchId/presentations", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = presentationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_PRESENTATION", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const id = generateUuidV7();

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO product_presentations
           (id, branch_id, menu_product_id, name, short_label, presentation_group, image_url, sale_price, ally_id, ally_payout_amount, is_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          branchId,
          d.menuProductId,
          d.name,
          d.shortLabel ?? d.name.slice(0, 14),
          d.presentationGroup,
          d.imageUrl ?? null,
          d.salePrice,
          d.allyId ?? null,
          d.allyPayoutAmount,
          d.isAvailable,
        ],
      );

      for (const rec of d.recipes) {
        const invRes = await client.query<{ base_unit: BaseUnit }>(
          `SELECT base_unit FROM inventory_items WHERE id = $1 AND branch_id = $2`,
          [rec.inventoryItemId, branchId],
        );
        const baseUnit = invRes.rows[0]?.base_unit;
        if (!baseUnit) throw new Error(`Inventory item ${rec.inventoryItemId} not found`);

        const qtyBase = convertToBaseUnit(rec.displayQuantity, rec.displayUnit as DisplayUnit, baseUnit);
        await client.query(
          `INSERT INTO presentation_recipes
             (id, presentation_id, inventory_item_id, display_unit, display_quantity, quantity_base, pour_loss_percent, fixed_loss_base)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            generateUuidV7(),
            id,
            rec.inventoryItemId,
            rec.displayUnit,
            rec.displayQuantity,
            qtyBase,
            rec.pourLossPercent,
            rec.fixedLossBase,
          ],
        );
      }
    });

    broadcastCatalogChange(branchId, "PRESENTATION_CREATED");
    return reply.status(201).send({ id });
  });

  app.patch("/api/v1/branches/:branchId/presentations/:presentationId", async (request, reply) => {
    const { branchId, presentationId } = request.params as { branchId: string; presentationId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = presentationCreateSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_PRESENTATION_PATCH", issues: parsed.error.issues });
    }

    const d = parsed.data;
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE product_presentations
         SET name = COALESCE($3, name),
             sale_price = COALESCE($4, sale_price),
             ally_payout_amount = COALESCE($5, ally_payout_amount),
             is_available = COALESCE($6, is_available),
             updated_at = now()
         WHERE id = $1 AND branch_id = $2`,
        [
          presentationId,
          branchId,
          d.name ?? null,
          d.salePrice ?? null,
          d.allyPayoutAmount ?? null,
          d.isAvailable ?? null,
        ],
      );

      if (d.recipes) {
        await client.query(`DELETE FROM presentation_recipes WHERE presentation_id = $1`, [presentationId]);
        for (const rec of d.recipes) {
          const invRes = await client.query<{ base_unit: BaseUnit }>(
            `SELECT base_unit FROM inventory_items WHERE id = $1 AND branch_id = $2`,
            [rec.inventoryItemId, branchId],
          );
          const baseUnit = invRes.rows[0]?.base_unit;
          if (!baseUnit) throw new Error(`Inventory item ${rec.inventoryItemId} not found`);

          const qtyBase = convertToBaseUnit(rec.displayQuantity, rec.displayUnit as DisplayUnit, baseUnit);
          await client.query(
            `INSERT INTO presentation_recipes
               (id, presentation_id, inventory_item_id, display_unit, display_quantity, quantity_base, pour_loss_percent, fixed_loss_base)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              generateUuidV7(),
              presentationId,
              rec.inventoryItemId,
              rec.displayUnit,
              rec.displayQuantity,
              qtyBase,
              rec.pourLossPercent,
              rec.fixedLossBase,
            ],
          );
        }
      }
    });

    broadcastCatalogChange(branchId, "PRESENTATION_UPDATED");
    return { id: presentationId };
  });

  // Create Ally with operating hours
  app.post("/api/v1/branches/:branchId/allies", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = allyCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_ALLY", issues: parsed.error.issues });
    }

    const id = generateUuidV7();
    const d = parsed.data;
    await db.query(
      `INSERT INTO allies (id, branch_id, name, contact_phone, operating_days, open_time, close_time, is_temporarily_closed)
       VALUES ($1, $2, $3, $4, $5::smallint[], $6::time, $7::time, false)`,
      [id, branchId, d.name, d.contactPhone ?? null, d.operatingDays, d.openTime, d.closeTime],
    );

    broadcastCatalogChange(branchId, "ALLY_CREATED");
    return reply.status(201).send({ id });
  });

  // One-step Combo Builder (supports Bar-only combos, Mixed Bar + Ally combos like "Pinta + Salchipapa", or Pure Ally combos)
  app.post("/api/v1/branches/:branchId/combos", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = comboCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_COMBO", issues: parsed.error.issues });
    }

    const d = parsed.data;
    if (d.recipes.length === 0 && !d.allyId) {
      return reply.status(400).send({
        error: "COMBO_EMPTY",
        message: "El combo debe incluir al menos un insumo del bar o un producto de aliado.",
      });
    }

    const productId = generateUuidV7();
    const presentationId = generateUuidV7();
    const productKind = d.recipes.length === 0 && d.allyId ? "third_party_ally" : "combo";

    await withTransaction(async (client) => {
      let categoryId = d.categoryId ?? null;
      if (!categoryId && d.newCategoryName) {
        categoryId = generateUuidV7();
        const maxSort = await client.query<{ next_sort: number }>(
          `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM categories WHERE branch_id = $1`,
          [branchId],
        );
        await client.query(
          `INSERT INTO categories (id, branch_id, name, color_token, sort_order)
           VALUES ($1, $2, $3, 'emerald', $4)`,
          [categoryId, branchId, d.newCategoryName, maxSort.rows[0]?.next_sort ?? 10],
        );
      }

      if (!categoryId) {
        const firstCat = await client.query<{ id: string }>(
          `SELECT id FROM categories WHERE branch_id = $1 ORDER BY sort_order ASC LIMIT 1`,
          [branchId],
        );
        categoryId = firstCat.rows[0]?.id ?? null;
      }
      if (!categoryId) throw new Error("CATEGORY_REQUIRED");

      await client.query(
        `INSERT INTO menu_products
           (id, branch_id, category_id, name, short_label, image_url, product_kind, ally_id, is_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [
          productId,
          branchId,
          categoryId,
          d.name,
          d.name.slice(0, 14),
          d.imageUrl ?? null,
          productKind,
          d.allyId ?? null,
        ],
      );

      await client.query(
        `INSERT INTO product_presentations
           (id, branch_id, menu_product_id, name, short_label, presentation_group, image_url, sale_price, ally_id, ally_payout_amount, is_available)
         VALUES ($1, $2, $3, $4, $5, 'combo', $6, $7, $8, $9, true)`,
        [
          presentationId,
          branchId,
          productId,
          d.presentationLabel ?? "Combo",
          (d.presentationLabel ?? "Combo").slice(0, 14),
          d.imageUrl ?? null,
          d.salePrice,
          d.allyId ?? null,
          d.allyId ? d.allyPayoutAmount : 0,
        ],
      );

      for (const rec of d.recipes) {
        const invRes = await client.query<{ base_unit: BaseUnit }>(
          `SELECT base_unit FROM inventory_items WHERE id = $1 AND branch_id = $2`,
          [rec.inventoryItemId, branchId],
        );
        const baseUnit = invRes.rows[0]?.base_unit;
        if (!baseUnit) throw new Error(`Inventory item ${rec.inventoryItemId} not found`);

        const qtyBase = convertToBaseUnit(rec.displayQuantity, rec.displayUnit as DisplayUnit, baseUnit);
        await client.query(
          `INSERT INTO presentation_recipes
             (id, presentation_id, inventory_item_id, display_unit, display_quantity, quantity_base, pour_loss_percent, fixed_loss_base)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            generateUuidV7(),
            presentationId,
            rec.inventoryItemId,
            rec.displayUnit,
            rec.displayQuantity,
            qtyBase,
            rec.pourLossPercent,
            rec.fixedLossBase,
          ],
        );
      }
    });

    broadcastCatalogChange(branchId, "COMBO_CREATED");
    return reply.status(201).send({ productId, presentationId, productKind });
  });

  // Update Ally schedule or toggle temporarily closed (immediately hides combos across all tablets!)
  app.patch("/api/v1/branches/:branchId/allies/:allyId", async (request, reply) => {
    const { branchId, allyId } = request.params as { branchId: string; allyId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = allyPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_ALLY", issues: parsed.error.issues });
    }

    const d = parsed.data;
    await db.query(
      `UPDATE allies
       SET name = COALESCE($3, name),
           contact_phone = COALESCE($4, contact_phone),
           open_time = COALESCE($5::time, open_time),
           close_time = COALESCE($6::time, close_time),
           operating_days = COALESCE($7::smallint[], operating_days),
           is_temporarily_closed = COALESCE($8, is_temporarily_closed)
       WHERE id = $1 AND branch_id = $2`,
      [
        allyId,
        branchId,
        d.name ?? null,
        d.contactPhone ?? null,
        d.openTime ?? null,
        d.closeTime ?? null,
        d.operatingDays ?? null,
        d.isTemporarilyClosed ?? null,
      ],
    );

    broadcastCatalogChange(branchId, "ALLY_UPDATED");
    return { id: allyId };
  });

  // Create & toggle Promotions
  app.post("/api/v1/branches/:branchId/promotions", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = promoCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_PROMOTION", issues: parsed.error.issues });
    }

    const id = generateUuidV7();
    const d = parsed.data;
    await db.query(
      `INSERT INTO promotion_rules
         (id, branch_id, name, rule_type, scope_type, application_mode, target_id, days_of_week, start_time, end_time, valid_from, valid_until, config, priority, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::smallint[], $9::time, $10::time, $11::date, $12::date, $13::jsonb, $14, $15)`,
      [
        id,
        branchId,
        d.name,
        d.ruleType,
        d.scopeType,
        d.applicationMode,
        d.targetId ?? null,
        d.daysOfWeek && d.daysOfWeek.length > 0 ? d.daysOfWeek : null,
        d.startTime || null,
        d.endTime || null,
        d.validFrom || null,
        d.validUntil || null,
        JSON.stringify(d.config),
        d.priority,
        d.isActive,
      ],
    );

    broadcastCatalogChange(branchId, "PROMOTION_CREATED");
    return reply.status(201).send({ id });
  });

  app.patch("/api/v1/branches/:branchId/promotions/:promoId", async (request, reply) => {
    const { branchId, promoId } = request.params as { branchId: string; promoId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = promoCreateSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_PROMOTION_PATCH", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const setClauses: string[] = [];
    const params: unknown[] = [promoId, branchId];
    let idx = 3;

    const push = (col: string, val: unknown, cast = "") => {
      setClauses.push(`${col} = $${idx}${cast}`);
      params.push(val);
      idx += 1;
    };

    if (d.name !== undefined) push("name", d.name);
    if (d.ruleType !== undefined) push("rule_type", d.ruleType);
    if (d.scopeType !== undefined) push("scope_type", d.scopeType);
    if (d.applicationMode !== undefined) push("application_mode", d.applicationMode);
    if (d.targetId !== undefined) push("target_id", d.targetId);
    if (d.daysOfWeek !== undefined) {
      push("days_of_week", d.daysOfWeek && d.daysOfWeek.length > 0 ? d.daysOfWeek : null, "::smallint[]");
    }
    if (d.startTime !== undefined) push("start_time", d.startTime || null, "::time");
    if (d.endTime !== undefined) push("end_time", d.endTime || null, "::time");
    if (d.validFrom !== undefined) push("valid_from", d.validFrom || null, "::date");
    if (d.validUntil !== undefined) push("valid_until", d.validUntil || null, "::date");
    if (d.config !== undefined) push("config", JSON.stringify(d.config), "::jsonb");
    if (d.priority !== undefined) push("priority", d.priority);
    if (d.isActive !== undefined) push("is_active", d.isActive);

    if (setClauses.length === 0) {
      return { id: promoId };
    }

    const res = await db.query(
      `UPDATE promotion_rules SET ${setClauses.join(", ")} WHERE id = $1 AND branch_id = $2 RETURNING id`,
      params,
    );
    if (res.rows.length === 0) {
      return reply.status(404).send({ error: "PROMOTION_NOT_FOUND" });
    }

    broadcastCatalogChange(branchId, "PROMOTION_UPDATED");
    return { id: promoId };
  });

  app.delete("/api/v1/branches/:branchId/promotions/:promoId", async (request, reply) => {
    const { branchId, promoId } = request.params as { branchId: string; promoId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const deleted = await withTransaction(async (client) => {
      // Preserve historical sales totals/discounts while safely removing FK reference
      await client.query(
        `UPDATE order_items SET promotion_rule_id = NULL WHERE promotion_rule_id = $1 AND branch_id = $2`,
        [promoId, branchId],
      );
      const res = await client.query(
        `DELETE FROM promotion_rules WHERE id = $1 AND branch_id = $2 RETURNING id`,
        [promoId, branchId],
      );
      return res.rows.length > 0;
    });

    if (!deleted) {
      return reply.status(404).send({ error: "PROMOTION_NOT_FOUND" });
    }

    broadcastCatalogChange(branchId, "PROMOTION_DELETED");
    return { deleted: true, id: promoId };
  });

  // Manage Customers (Lista Blanca / Lista Negra — Admin only)
  app.post("/api/v1/branches/:branchId/customers", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = customerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_CUSTOMER", issues: parsed.error.issues });
    }

    const id = generateUuidV7();
    const d = parsed.data;
    await db.query(
      `INSERT INTO customers (id, branch_id, full_name, nickname, phone, credit_status, credit_limit, status_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, branchId, d.fullName, d.nickname ?? null, d.phone ?? null, d.creditStatus, d.creditLimit ?? null, d.statusReason ?? null],
    );
    broadcastCatalogChange(branchId, "CUSTOMER_CREATED");
    return reply.status(201).send({ id });
  });

  app.patch("/api/v1/branches/:branchId/customers/:customerId", async (request, reply) => {
    const { branchId, customerId } = request.params as { branchId: string; customerId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = customerSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_CUSTOMER_PATCH" });

    const d = parsed.data;
    await db.query(
      `UPDATE customers
       SET credit_status = COALESCE($3, credit_status),
           credit_limit = COALESCE($4, credit_limit),
           status_reason = COALESCE($5, status_reason),
           updated_at = now()
       WHERE id = $1 AND branch_id = $2`,
      [customerId, branchId, d.creditStatus ?? null, d.creditLimit ?? null, d.statusReason ?? null],
    );
    broadcastCatalogChange(branchId, "CUSTOMER_UPDATED");
    return { id: customerId };
  });
}

