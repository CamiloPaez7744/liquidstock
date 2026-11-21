import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  convertToBaseUnit,
  generateUuidV7,
  type BaseUnit,
  type DisplayUnit,
} from "@liquistock/domain";
import { requireBranchRole } from "../../../infrastructure/auth/auth-guard.js";
import { db, withTransaction } from "../../../infrastructure/db/pool.js";
import { branchHub } from "../../../infrastructure/realtime/branch-hub.js";

const quickMenuPresentationSchema = z.object({
  name: z.string().min(1).max(100),
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
  salePrice: z.number().min(0),
  displayUnit: z.enum(["ml", "oz", "L", "g", "kg", "unit"]),
  displayQuantity: z.number().positive(),
  pourLossPercent: z.number().min(0).max(100).default(0),
  fixedLossBase: z.number().min(0).default(0),
});

const createInventoryItemSchema = z.object({
  name: z.string().min(1).max(120),
  sku: z.string().optional().nullable(),
  baseUnit: z.enum(["ml", "g", "unit"]),
  initialStockBase: z.number().min(0).default(0),
  initialTotalCost: z.number().min(0).default(0),
  minStockBase: z.number().min(0).default(0),
  defaultPourLossPercent: z.number().min(0).max(100).default(0),
  isKeg: z.boolean().default(false),
  userId: z.string().uuid().optional(),
  purchasePresentation: z
    .object({
      name: z.string().min(1),
      factorToBase: z.number().positive(),
      lastPurchaseCost: z.number().min(0).optional().nullable(),
    })
    .optional(),
  /** Optional one-step publish directly to the POS Menu (so adding chips, cigarettes, empanadas or new liquors takes 1 form!) */
  publishToMenu: z
    .object({
      categoryId: z.string().uuid().optional(),
      newCategoryName: z.string().min(1).max(60).optional(),
      productName: z.string().min(1).max(120).optional(),
      imageUrl: z.string().max(500).optional().nullable(),
      presentations: z.array(quickMenuPresentationSchema).min(1),
    })
    .optional(),
});

const movementSchema = z.object({
  inventoryItemId: z.string().uuid(),
  movementType: z.enum(["purchase", "waste", "manual_adjustment"]),
  presentationId: z.string().uuid().optional().nullable(),
  presentationUnits: z.number().positive().optional(),
  quantityBase: z.number().optional(),
  totalCost: z.number().min(0).optional(),
  reason: z.string().min(1).max(200),
  userId: z.string().uuid().optional(),
});

export async function registerInventoryRoutes(app: FastifyInstance) {
  app.post("/api/v1/branches/:branchId/inventory/items", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const parsed = createInventoryItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_INVENTORY_ITEM", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const itemId = generateUuidV7();
    let createdProductId: string | null = null;
    let createdCategoryId: string | null = null;

    await withTransaction(async (client) => {
      const avgUnitCost =
        d.initialStockBase > 0 && d.initialTotalCost > 0
          ? d.initialTotalCost / d.initialStockBase
          : 0;

      await client.query(
        `INSERT INTO inventory_items
           (id, branch_id, sku, name, base_unit, current_stock_base, min_stock_base, avg_unit_cost_base, default_pour_loss_pct, is_keg)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          itemId,
          branchId,
          d.sku ?? null,
          d.name,
          d.baseUnit,
          d.initialStockBase,
          d.minStockBase,
          avgUnitCost,
          d.defaultPourLossPercent,
          d.isKeg,
        ],
      );

      let purchasePresId: string | null = null;
      if (d.purchasePresentation) {
        purchasePresId = generateUuidV7();
        await client.query(
          `INSERT INTO purchase_presentations (id, inventory_item_id, name, factor_to_base, last_purchase_cost, is_default)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [
            purchasePresId,
            itemId,
            d.purchasePresentation.name,
            d.purchasePresentation.factorToBase,
            d.purchasePresentation.lastPurchaseCost ?? null,
          ],
        );
      }

      // Record opening stock in immutable inventory_ledger
      if (d.initialStockBase > 0) {
        const ledgerId = generateUuidV7();
        await client.query(
          `INSERT INTO inventory_ledger (
             id, branch_id, inventory_item_id, movement_type,
             quantity_delta_base, nominal_qty_base, pour_loss_qty_base,
             stock_after_base, unit_cost_base, reference_type,
             presentation_id, reason, created_by, idempotency_key
           ) VALUES (
             $1, $2, $3, 'purchase',
             $4, $4, 0,
             $4, $5, 'item_creation',
             $6, 'Stock inicial al crear insumo', $7, $1
           )`,
          [ledgerId, branchId, itemId, d.initialStockBase, avgUnitCost, purchasePresId, auth.userId],
        );
      }

      // Optional 1-step publish to POS menu (product + sellable presentations + recipes)
      if (d.publishToMenu) {
        let categoryId = d.publishToMenu.categoryId ?? null;
        if (!categoryId && d.publishToMenu.newCategoryName) {
          categoryId = generateUuidV7();
          createdCategoryId = categoryId;
          const maxSort = await client.query<{ next_sort: number }>(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM categories WHERE branch_id = $1`,
            [branchId],
          );
          await client.query(
            `INSERT INTO categories (id, branch_id, name, color_token, sort_order)
             VALUES ($1, $2, $3, 'cyan', $4)`,
            [categoryId, branchId, d.publishToMenu.newCategoryName, maxSort.rows[0]?.next_sort ?? 10],
          );
        }

        if (!categoryId) {
          throw new Error("CATEGORY_REQUIRED_FOR_MENU");
        }

        createdProductId = generateUuidV7();
        const productName = d.publishToMenu.productName ?? d.name;
        await client.query(
          `INSERT INTO menu_products
             (id, branch_id, category_id, name, short_label, image_url, product_kind, is_available)
           VALUES ($1, $2, $3, $4, $5, $6, 'standard', true)`,
          [
            createdProductId,
            branchId,
            categoryId,
            productName,
            productName.slice(0, 14),
            d.publishToMenu.imageUrl ?? null,
          ],
        );

        let sortOrder = 1;
        for (const pres of d.publishToMenu.presentations) {
          const presId = generateUuidV7();
          const qtyBase = convertToBaseUnit(
            pres.displayQuantity,
            pres.displayUnit as DisplayUnit,
            d.baseUnit as BaseUnit,
          );

          await client.query(
            `INSERT INTO product_presentations
               (id, branch_id, menu_product_id, name, short_label, presentation_group, sale_price, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              presId,
              branchId,
              createdProductId,
              pres.name,
              pres.name.slice(0, 14),
              pres.presentationGroup,
              pres.salePrice,
              sortOrder++,
            ],
          );

          await client.query(
            `INSERT INTO presentation_recipes
               (id, presentation_id, inventory_item_id, display_unit, display_quantity, quantity_base, pour_loss_percent, fixed_loss_base)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              generateUuidV7(),
              presId,
              itemId,
              pres.displayUnit,
              pres.displayQuantity,
              qtyBase,
              pres.pourLossPercent,
              pres.fixedLossBase,
            ],
          );
        }
      }
    });

    branchHub.broadcast({
      type: "INVENTORY_UPDATED",
      branchId,
      originDeviceId: "admin",
      timestamp: new Date().toISOString(),
      payload: { itemId, createdProductId },
    });
    if (createdProductId) {
      branchHub.broadcast({
        type: "CATALOG_UPDATED",
        branchId,
        originDeviceId: "admin",
        timestamp: new Date().toISOString(),
        payload: { createdProductId, createdCategoryId },
      });
    }

    return reply.status(201).send({ id: itemId, createdProductId, createdCategoryId });
  });

  // Record purchase (by keg/bottle/pack/tray presentation), waste, or manual stock adjustment
  app.post("/api/v1/branches/:branchId/inventory/movements", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier"]);
    if (!auth) return;
    const parsed = movementSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_MOVEMENT", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const result = await withTransaction(async (client) => {
      const invRes = await client.query<{
        current_stock_base: string;
        avg_unit_cost_base: string;
      }>(
        `SELECT current_stock_base::text, avg_unit_cost_base::text
         FROM inventory_items
         WHERE id = $1 AND branch_id = $2
         FOR UPDATE`,
        [d.inventoryItemId, branchId],
      );
      const inv = invRes.rows[0];
      if (!inv) throw new Error("INVENTORY_ITEM_NOT_FOUND");

      let deltaBase = 0;
      if (d.presentationId && d.presentationUnits) {
        const presRes = await client.query<{ factor_to_base: string }>(
          `SELECT factor_to_base::text FROM purchase_presentations WHERE id = $1`,
          [d.presentationId],
        );
        const factor = Number(presRes.rows[0]?.factor_to_base ?? "0");
        if (factor <= 0) throw new Error("PRESENTATION_NOT_FOUND");
        deltaBase = Math.round(factor * d.presentationUnits * 1000) / 1000;
      } else if (d.quantityBase !== undefined && d.quantityBase !== 0) {
        deltaBase = Math.round(d.quantityBase * 1000) / 1000;
      } else {
        throw new Error("QUANTITY_REQUIRED");
      }

      if (d.movementType === "waste" && deltaBase > 0) {
        deltaBase = -deltaBase;
      }

      const prevStock = Number(inv.current_stock_base);
      const prevAvgCost = Number(inv.avg_unit_cost_base);
      const nextStock = Math.round((prevStock + deltaBase) * 1000) / 1000;

      let nextAvgCost = prevAvgCost;
      let unitCostThisMovement = prevAvgCost;
      if (d.movementType === "purchase" && deltaBase > 0 && d.totalCost !== undefined) {
        unitCostThisMovement = d.totalCost / deltaBase;
        const totalValue = Math.max(0, prevStock) * prevAvgCost + d.totalCost;
        const totalQty = Math.max(0, prevStock) + deltaBase;
        nextAvgCost = totalQty > 0 ? totalValue / totalQty : unitCostThisMovement;
      }

      await client.query(
        `UPDATE inventory_items
         SET current_stock_base = $2,
             avg_unit_cost_base = $3,
             updated_at = now()
         WHERE id = $1`,
        [d.inventoryItemId, nextStock, nextAvgCost],
      );

      const ledgerId = generateUuidV7();
      await client.query(
        `INSERT INTO inventory_ledger (
           id, branch_id, inventory_item_id, movement_type,
           quantity_delta_base, nominal_qty_base, pour_loss_qty_base,
           stock_after_base, unit_cost_base, reference_type,
           presentation_id, reason, created_by, idempotency_key
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, 'manual_movement',
           $10, $11, $12, $1
         )`,
        [
          ledgerId,
          branchId,
          d.inventoryItemId,
          d.movementType,
          deltaBase,
          d.movementType === "waste" ? 0 : deltaBase,
          d.movementType === "waste" ? Math.abs(deltaBase) : 0,
          nextStock,
          unitCostThisMovement,
          d.presentationId ?? null,
          d.reason,
          auth.userId,
        ],
      );

      return { ledgerId, nextStock, deltaBase };
    });

    branchHub.broadcast({
      type: "INVENTORY_UPDATED",
      branchId,
      originDeviceId: "admin",
      timestamp: new Date().toISOString(),
      payload: result,
    });

    return reply.status(201).send(result);
  });

  app.get("/api/v1/branches/:branchId/inventory/ledger", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier", "waiter"]);
    if (!auth) return;
    const res = await db.query(
      `SELECT il.id, il.inventory_item_id AS "inventoryItemId", ii.name AS "itemName",
              ii.base_unit AS "baseUnit", il.movement_type AS "movementType",
              il.quantity_delta_base::float8 AS "quantityDeltaBase",
              il.nominal_qty_base::float8 AS "nominalQtyBase",
              il.pour_loss_qty_base::float8 AS "pourLossQtyBase",
              il.stock_after_base::float8 AS "stockAfterBase",
              il.reason, u.full_name AS "createdByName", il.created_at AS "createdAt"
       FROM inventory_ledger il
       JOIN inventory_items ii ON ii.id = il.inventory_item_id
       JOIN users u ON u.id = il.created_by
       WHERE il.branch_id = $1
       ORDER BY il.created_at DESC
       LIMIT 100`,
      [branchId],
    );
    return { entries: res.rows };
  });
}
