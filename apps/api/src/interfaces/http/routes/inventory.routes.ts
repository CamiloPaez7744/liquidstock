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

const presentationGroupEnum = z.enum([
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
]);

const purchasePresentationInputSchema = z.object({
  name: z.string().min(1).max(80),
  factorToBase: z.number().positive(),
  lastPurchaseCost: z.number().min(0).optional().nullable(),
  isDefault: z.boolean().optional(),
});

const quickMenuPresentationSchema = z.object({
  name: z.string().min(1).max(100),
  presentationGroup: presentationGroupEnum,
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
  purchasePresentation: purchasePresentationInputSchema.optional(),
  purchasePresentations: z.array(purchasePresentationInputSchema).optional(),
  /** Optional one-step publish directly to the POS Menu */
  publishToMenu: z
    .object({
      categoryId: z.string().uuid().optional(),
      newCategoryName: z.string().min(1).max(60).optional(),
      productName: z.string().min(1).max(120).optional(),
      imageUrl: z.string().max(500).optional().nullable(),
      editionTag: z.string().max(32).optional().nullable(),
      isAvailable: z.boolean().optional(),
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

const composedIngredientSchema = z.object({
  inventoryItemId: z.string().uuid().optional(),
  createIngredient: z
    .object({
      name: z.string().min(1).max(120),
      baseUnit: z.enum(["ml", "g", "unit"]),
      initialStockBase: z.number().min(0).default(0),
      initialTotalCost: z.number().min(0).default(0),
      minStockBase: z.number().min(0).default(0),
      defaultPourLossPercent: z.number().min(0).max(100).default(0),
      purchasePresentations: z.array(purchasePresentationInputSchema).optional(),
    })
    .optional(),
  displayUnit: z.enum(["ml", "oz", "L", "g", "kg", "unit"]),
  displayQuantity: z.number().positive(),
  pourLossPercent: z.number().min(0).max(100).default(0),
  fixedLossBase: z.number().min(0).default(0),
});

const createComposedRecipeSchema = z.object({
  name: z.string().min(1).max(120),
  presentationName: z.string().min(1).max(80).default("Estándar"),
  presentationGroup: presentationGroupEnum.default("coctel"),
  salePrice: z.number().min(0),
  categoryId: z.string().uuid().optional(),
  newCategoryName: z.string().min(1).max(60).optional(),
  imageUrl: z.string().max(500).optional().nullable(),
  ingredients: z.array(composedIngredientSchema).min(1),
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

      // Support multiple purchase formats (e.g. Unidad x1, Six-pack x6, Canasta x30)
      const purchaseList =
        d.purchasePresentations && d.purchasePresentations.length > 0
          ? d.purchasePresentations
          : d.purchasePresentation
            ? [d.purchasePresentation]
            : [];

      let defaultPurchasePresId: string | null = null;
      for (let idx = 0; idx < purchaseList.length; idx += 1) {
        const pp = purchaseList[idx]!;
        const ppId = generateUuidV7();
        const isDef = pp.isDefault ?? idx === 0;
        if (isDef || !defaultPurchasePresId) {
          defaultPurchasePresId = ppId;
        }
        await client.query(
          `INSERT INTO purchase_presentations (id, inventory_item_id, name, factor_to_base, last_purchase_cost, is_default)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ppId,
            itemId,
            pp.name.trim(),
            pp.factorToBase,
            pp.lastPurchaseCost ?? null,
            isDef,
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
          [ledgerId, branchId, itemId, d.initialStockBase, avgUnitCost, defaultPurchasePresId, auth.userId],
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
        const cleanEditionTag = d.publishToMenu.editionTag?.trim() || null;
        await client.query(
          `INSERT INTO menu_products
             (id, branch_id, category_id, name, short_label, image_url, edition_tag, product_kind, is_available)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'standard', $8)`,
          [
            createdProductId,
            branchId,
            categoryId,
            productName,
            productName.slice(0, 14),
            d.publishToMenu.imageUrl ?? null,
            cleanEditionTag,
            d.publishToMenu.isAvailable ?? true,
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

  // Add an additional purchase format (e.g. Unidad x1, Six-pack x6, Canasta x30, Libra 500g) to an existing inventory item
  app.post(
    "/api/v1/branches/:branchId/inventory/items/:itemId/purchase-presentations",
    async (request, reply) => {
      const { branchId, itemId } = request.params as { branchId: string; itemId: string };
      const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
      if (!auth) return;

      const parsed = purchasePresentationInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "INVALID_PURCHASE_PRESENTATION", issues: parsed.error.issues });
      }

      const itemCheck = await db.query(
        `SELECT 1 FROM inventory_items WHERE id = $1 AND branch_id = $2`,
        [itemId, branchId],
      );
      if (itemCheck.rows.length === 0) {
        return reply.status(404).send({ error: "INVENTORY_ITEM_NOT_FOUND" });
      }

      const id = generateUuidV7();
      const d = parsed.data;
      await db.query(
        `INSERT INTO purchase_presentations (id, inventory_item_id, name, factor_to_base, last_purchase_cost, is_default)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, itemId, d.name.trim(), d.factorToBase, d.lastPurchaseCost ?? null, d.isDefault ?? false],
      );

      branchHub.broadcast({
        type: "INVENTORY_UPDATED",
        branchId,
        originDeviceId: "admin",
        timestamp: new Date().toISOString(),
        payload: { itemId, purchasePresentationId: id },
      });

      return reply.status(201).send({ id });
    },
  );

  // Create a composed multi-ingredient product (Cocktails like Margarita/Mojito, Special Coffees like Latte/Carajillo)
  // Supports linking existing inventory items OR creating missing ingredients inline in the same ACID transaction!
  app.post("/api/v1/branches/:branchId/recipes/composed", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const parsed = createComposedRecipeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "INVALID_COMPOSED_RECIPE", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const productId = generateUuidV7();
    const presentationId = generateUuidV7();
    const createdIngredientIds: string[] = [];

    try {
      await withTransaction(async (client) => {
        let categoryId = d.categoryId ?? null;
        if (!categoryId && d.newCategoryName) {
          // Reuse existing category with same name if present
          const existingCat = await client.query<{ id: string }>(
            `SELECT id FROM categories WHERE branch_id = $1 AND lower(name) = lower($2) LIMIT 1`,
            [branchId, d.newCategoryName.trim()],
          );
          if (existingCat.rows[0]?.id) {
            categoryId = existingCat.rows[0].id;
          } else {
            categoryId = generateUuidV7();
            const maxSort = await client.query<{ next_sort: number }>(
              `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort FROM categories WHERE branch_id = $1`,
              [branchId],
            );
            await client.query(
              `INSERT INTO categories (id, branch_id, name, color_token, sort_order)
               VALUES ($1, $2, $3, 'cyan', $4)`,
              [categoryId, branchId, d.newCategoryName.trim(), maxSort.rows[0]?.next_sort ?? 10],
            );
          }
        }
        if (!categoryId) throw new Error("CATEGORY_REQUIRED");

        await client.query(
          `INSERT INTO menu_products
             (id, branch_id, category_id, name, short_label, image_url, product_kind, is_available)
           VALUES ($1, $2, $3, $4, $5, $6, 'standard', true)`,
          [
            productId,
            branchId,
            categoryId,
            d.name.trim(),
            d.name.trim().slice(0, 16),
            d.imageUrl ?? null,
          ],
        );

        await client.query(
          `INSERT INTO product_presentations
             (id, branch_id, menu_product_id, name, short_label, presentation_group, sale_price, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
          [
            presentationId,
            branchId,
            productId,
            d.presentationName.trim(),
            d.presentationName.trim().slice(0, 14),
            d.presentationGroup,
            d.salePrice,
          ],
        );

        for (const ing of d.ingredients) {
          let targetInvId = ing.inventoryItemId ?? null;
          let targetBaseUnit: BaseUnit | null = null;

          if (targetInvId) {
            const invRes = await client.query<{ base_unit: BaseUnit }>(
              `SELECT base_unit FROM inventory_items WHERE id = $1 AND branch_id = $2`,
              [targetInvId, branchId],
            );
            targetBaseUnit = invRes.rows[0]?.base_unit ?? null;
            if (!targetBaseUnit) throw new Error("INGREDIENT_NOT_FOUND");
          } else if (ing.createIngredient) {
            const ci = ing.createIngredient;
            targetInvId = generateUuidV7();
            targetBaseUnit = ci.baseUnit;
            createdIngredientIds.push(targetInvId);

            const avgCost =
              ci.initialStockBase > 0 && ci.initialTotalCost > 0
                ? ci.initialTotalCost / ci.initialStockBase
                : 0;

            await client.query(
              `INSERT INTO inventory_items
                 (id, branch_id, name, base_unit, current_stock_base, min_stock_base, avg_unit_cost_base, default_pour_loss_pct, is_keg)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
              [
                targetInvId,
                branchId,
                ci.name.trim(),
                ci.baseUnit,
                ci.initialStockBase,
                ci.minStockBase,
                avgCost,
                ci.defaultPourLossPercent,
              ],
            );

            const ppList = ci.purchasePresentations ?? [];
            let firstPpId: string | null = null;
            for (let i = 0; i < ppList.length; i += 1) {
              const pp = ppList[i]!;
              const ppId = generateUuidV7();
              if (i === 0) firstPpId = ppId;
              await client.query(
                `INSERT INTO purchase_presentations (id, inventory_item_id, name, factor_to_base, last_purchase_cost, is_default)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [ppId, targetInvId, pp.name.trim(), pp.factorToBase, pp.lastPurchaseCost ?? null, i === 0],
              );
            }

            if (ci.initialStockBase > 0) {
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
                   $6, 'Stock inicial al crear receta compuesta', $7, $1
                 )`,
                [ledgerId, branchId, targetInvId, ci.initialStockBase, avgCost, firstPpId, auth.userId],
              );
            }
          } else {
            throw new Error("INGREDIENT_REQUIRED");
          }

          const qtyBase = convertToBaseUnit(
            ing.displayQuantity,
            ing.displayUnit as DisplayUnit,
            targetBaseUnit,
          );

          await client.query(
            `INSERT INTO presentation_recipes
               (id, presentation_id, inventory_item_id, display_unit, display_quantity, quantity_base, pour_loss_percent, fixed_loss_base)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              generateUuidV7(),
              presentationId,
              targetInvId,
              ing.displayUnit,
              ing.displayQuantity,
              qtyBase,
              ing.pourLossPercent,
              ing.fixedLossBase,
            ],
          );
        }
      });
    } catch (err) {
      return reply.status(400).send({
        error: "COMPOSED_RECIPE_FAILED",
        message: err instanceof Error ? err.message : "No se pudo crear la receta compuesta",
      });
    }

    branchHub.broadcast({
      type: "INVENTORY_UPDATED",
      branchId,
      originDeviceId: "admin",
      timestamp: new Date().toISOString(),
      payload: { createdIngredientIds },
    });
    branchHub.broadcast({
      type: "CATALOG_UPDATED",
      branchId,
      originDeviceId: "admin",
      timestamp: new Date().toISOString(),
      payload: { productId, presentationId },
    });

    return reply.status(201).send({ productId, presentationId, createdIngredientIds });
  });

  // Record purchase (by keg/bottle/pack/tray presentation OR free base quantity), waste, or manual stock adjustment
  app.post("/api/v1/branches/:branchId/inventory/movements", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
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
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const query = request.query as { limit?: string; offset?: string; itemId?: string };
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));
    const offset = Math.max(0, Number(query.offset) || 0);
    const itemId = query.itemId || null;

    const [res, countRes] = await Promise.all([
      db.query(
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
           AND ($4::uuid IS NULL OR il.inventory_item_id = $4::uuid)
         ORDER BY il.created_at DESC
         LIMIT $2 OFFSET $3`,
        [branchId, limit, offset, itemId],
      ),
      db.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM inventory_ledger il
         WHERE il.branch_id = $1
           AND ($2::uuid IS NULL OR il.inventory_item_id = $2::uuid)`,
        [branchId, itemId],
      ),
    ]);

    const total = Number(countRes.rows[0]?.cnt ?? "0");
    return {
      entries: res.rows,
      total,
      offset,
      limit,
      hasMore: offset + res.rows.length < total,
    };
  });
}
