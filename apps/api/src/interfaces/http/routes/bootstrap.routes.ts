import type { FastifyInstance } from "fastify";
import {
  DEFAULT_BRANCH_FEATURE_FLAGS,
  resolveBranchRolePermissions,
  type BranchRolePermissions,
  type OperatingScheduleSlot,
} from "@liquistock/domain";
import { requireAuth, requireBranchRole } from "../../../infrastructure/auth/auth-guard.js";
import { db } from "../../../infrastructure/db/pool.js";
import {
  ensureBranchVaultAccount,
  getBranchOpenShiftStatus,
} from "../../../infrastructure/db/treasury.js";

export async function registerBootstrapRoutes(app: FastifyInstance) {
  app.get("/api/v1/branches", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const res = await db.query(
      `SELECT b.id, b.organization_id AS "organizationId", b.name, b.code, b.timezone,
              b.feature_flags AS "featureFlags", b.is_active AS "isActive", bm.role
       FROM branches b
       JOIN branch_memberships bm ON bm.branch_id = b.id
       WHERE bm.user_id = $1 AND bm.is_active = true AND b.is_active = true
       ORDER BY b.created_at ASC`,
      [auth.userId],
    );
    return { branches: res.rows };
  });

  /**
   * Single-call offline hydration snapshot for a branch.
   * Tablets hydrate Dexie.js IndexedDB from this endpoint and then work 100% offline.
   */
  app.get("/api/v1/branches/:branchId/bootstrap", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier", "waiter"]);
    if (!auth) return;

    const branchRes = await db.query<{
      id: string;
      organizationId: string;
      name: string;
      code: string;
      timezone: string;
      featureFlags: Record<string, boolean> | null;
      rolePermissions: Partial<BranchRolePermissions> | null;
      operatingSchedules: OperatingScheduleSlot[] | null;
      isActive: boolean;
    }>(
      `SELECT id, organization_id AS "organizationId", name, code, timezone,
              feature_flags AS "featureFlags",
              role_permissions AS "rolePermissions",
              operating_schedules AS "operatingSchedules",
              is_active AS "isActive"
       FROM branches WHERE id = $1`,
      [branchId],
    );

    const branch = branchRes.rows[0];
    if (!branch) {
      return reply.status(404).send({ error: "BRANCH_NOT_FOUND" });
    }

    await ensureBranchVaultAccount(branchId);

    const [
      usersRes,
      tablesRes,
      categoriesRes,
      productsRes,
      presentationsRes,
      recipesRes,
      inventoryRes,
      purchasePresRes,
      alliesRes,
      customersRes,
      paymentMethodsRes,
      promotionsRes,
      comboTemplatesRes,
      shiftStatus,
      sessionsRes,
      subAccountsRes,
      orderItemsRes,
    ] = await Promise.all([
      db.query(
        `SELECT u.id, u.full_name AS "fullName", bm.role, bm.permissions
         FROM branch_memberships bm
         JOIN users u ON u.id = bm.user_id
         WHERE bm.branch_id = $1 AND bm.is_active = true AND u.is_active = true`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", label, zone, sort_order AS "sortOrder"
         FROM dining_tables WHERE branch_id = $1 AND is_active = true ORDER BY sort_order ASC`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", name, color_token AS "colorToken",
                sort_order AS "sortOrder", is_active AS "isActive"
         FROM categories WHERE branch_id = $1 AND is_active = true ORDER BY sort_order ASC`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", category_id AS "categoryId", name,
                short_label AS "shortLabel", image_url AS "imageUrl",
                edition_tag AS "editionTag",
                product_kind AS "productKind", ally_id AS "allyId",
                to_char(available_from, 'HH24:MI') AS "availableFrom",
                to_char(available_until, 'HH24:MI') AS "availableUntil",
                is_available AS "isAvailable", sort_order AS "sortOrder"
         FROM menu_products WHERE branch_id = $1 ORDER BY sort_order ASC, name ASC`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", menu_product_id AS "menuProductId", name,
                short_label AS "shortLabel", presentation_group AS "presentationGroup",
                image_url AS "imageUrl", sale_price::float8 AS "salePrice",
                ally_id AS "allyId", ally_payout_amount::float8 AS "allyPayoutAmount",
                is_available AS "isAvailable", sort_order AS "sortOrder"
         FROM product_presentations WHERE branch_id = $1 ORDER BY sort_order ASC, sale_price ASC`,
        [branchId],
      ),
      db.query(
        `SELECT pr.id, pr.presentation_id AS "presentationId", pr.inventory_item_id AS "inventoryItemId",
                pr.display_unit AS "displayUnit", pr.display_quantity::float8 AS "displayQuantity",
                pr.quantity_base::float8 AS "quantityBase", pr.pour_loss_percent::float8 AS "pourLossPercent",
                pr.fixed_loss_base::float8 AS "fixedLossBase"
         FROM presentation_recipes pr
         JOIN product_presentations pp ON pp.id = pr.presentation_id
         WHERE pp.branch_id = $1`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", sku, name, base_unit AS "baseUnit",
                current_stock_base::float8 AS "currentStockBase",
                min_stock_base::float8 AS "minStockBase",
                avg_unit_cost_base::float8 AS "avgUnitCostBase",
                default_pour_loss_pct::float8 AS "defaultPourLossPercent",
                is_keg AS "isKeg", is_active AS "isActive"
         FROM inventory_items WHERE branch_id = $1 AND is_active = true ORDER BY is_keg DESC, name ASC`,
        [branchId],
      ),
      db.query(
        `SELECT pp.id, pp.inventory_item_id AS "inventoryItemId", pp.name,
                pp.factor_to_base::float8 AS "factorToBase",
                pp.last_purchase_cost::float8 AS "lastPurchaseCost",
                pp.is_default AS "isDefault"
         FROM purchase_presentations pp
         JOIN inventory_items ii ON ii.id = pp.inventory_item_id
         WHERE ii.branch_id = $1`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", name, contact_phone AS "contactPhone",
                operating_days AS "operatingDays",
                to_char(open_time, 'HH24:MI') AS "openTime",
                to_char(close_time, 'HH24:MI') AS "closeTime",
                operating_schedules AS "operatingSchedules",
                is_temporarily_closed AS "isTemporarilyClosed",
                is_active AS "isActive"
         FROM allies WHERE branch_id = $1 AND is_active = true ORDER BY name ASC`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", full_name AS "fullName", nickname, phone,
                credit_status AS "creditStatus",
                credit_limit::float8 AS "creditLimit",
                current_debt::float8 AS "currentDebt",
                status_reason AS "statusReason"
         FROM customers WHERE branch_id = $1 ORDER BY full_name ASC`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", name, code,
                counts_as_physical_cash AS "countsAsPhysicalCash",
                is_internal_vault AS "isInternalVault",
                sort_order AS "sortOrder", is_active AS "isActive"
         FROM payment_methods WHERE branch_id = $1 AND is_active = true ORDER BY sort_order ASC`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", name, rule_type AS "ruleType",
                scope_type AS "scopeType", application_mode AS "applicationMode",
                target_id AS "targetId", days_of_week AS "daysOfWeek",
                to_char(start_time, 'HH24:MI') AS "startTime",
                to_char(end_time, 'HH24:MI') AS "endTime",
                to_char(valid_from, 'YYYY-MM-DD') AS "validFrom",
                to_char(valid_until, 'YYYY-MM-DD') AS "validUntil",
                config, priority, is_stackable AS "isStackable", is_active AS "isActive"
         FROM promotion_rules WHERE branch_id = $1 ORDER BY priority ASC`,
        [branchId],
      ),
      db.query(
        `SELECT id, branch_id AS "branchId", name, short_label AS "shortLabel",
                scope_type AS "scopeType", target_id AS "targetId",
                presentation_group AS "presentationGroup",
                base_quantity AS "baseQuantity",
                companion_type AS "companionType",
                pricing_mode AS "pricingMode",
                price_value::float8 AS "priceValue",
                ally_id AS "allyId",
                ally_payout_amount::float8 AS "allyPayoutAmount",
                COALESCE(fixed_recipes, '[]'::jsonb) AS "fixedRecipes",
                is_active AS "isActive"
         FROM combo_templates WHERE branch_id = $1 ORDER BY created_at ASC`,
        [branchId],
      ),
      getBranchOpenShiftStatus(branchId),
      db.query(
        `SELECT id, branch_id AS "branchId", dining_table_id AS "diningTableId",
                cash_shift_id AS "cashShiftId", status, opened_at AS "openedAt"
         FROM table_sessions WHERE branch_id = $1 AND status = 'open' ORDER BY opened_at ASC`,
        [branchId],
      ),
      db.query(
        `SELECT sa.id, sa.branch_id AS "branchId", sa.table_session_id AS "tableSessionId",
                sa.label, sa.description, sa.customer_id AS "customerId", sa.status,
                sa.subtotal_amount::float8 AS "subtotalAmount",
                sa.discount_amount::float8 AS "discountAmount",
                sa.total_amount::float8 AS "totalAmount",
                sa.paid_amount::float8 AS "paidAmount",
                sa.credit_amount::float8 AS "creditAmount",
                sa.version, sa.updated_at AS "updatedAt"
         FROM sub_accounts sa
         JOIN table_sessions ts ON ts.id = sa.table_session_id
         WHERE sa.branch_id = $1 AND ts.status = 'open'
         ORDER BY sa.created_at ASC`,
        [branchId],
      ),
      db.query(
        `SELECT oi.id, oi.sub_account_id AS "subAccountId", oi.menu_product_id AS "menuProductId",
                oi.presentation_id AS "presentationId", mp.category_id AS "categoryId",
                oi.product_name_snap AS "productNameSnap",
                oi.presentation_name_snap AS "presentationNameSnap",
                oi.presentation_group_snap AS "presentationGroupSnap",
                oi.product_kind_snap AS "productKindSnap",
                oi.quantity, oi.unit_price_snap::float8 AS "unitPriceSnap",
                oi.ally_id_snap AS "allyIdSnap", oi.ally_payout_snap::float8 AS "allyPayoutSnap",
                oi.promotion_rule_id AS "promotionRuleId",
                oi.discount_amount::float8 AS "discountAmount",
                oi.line_total::float8 AS "lineTotal",
                oi.adjustment_reason AS "adjustmentReason",
                oi.status
         FROM order_items oi
         JOIN sub_accounts sa ON sa.id = oi.sub_account_id
         JOIN table_sessions ts ON ts.id = sa.table_session_id
         LEFT JOIN menu_products mp ON mp.id = oi.menu_product_id
         WHERE oi.branch_id = $1 AND ts.status = 'open' AND oi.status = 'active'
         ORDER BY oi.created_at ASC`,
        [branchId],
      ),
    ]);

    const recipesByPres = new Map<string, unknown[]>();
    for (const r of recipesRes.rows) {
      const presId = String(r.presentationId);
      const list = recipesByPres.get(presId) ?? [];
      list.push(r);
      recipesByPres.set(presId, list);
    }

    const presentations = presentationsRes.rows.map((p) => ({
      ...p,
      recipes: recipesByPres.get(String(p.id)) ?? [],
    }));

    const allies = alliesRes.rows.map((a) => ({
      id: a.id,
      branchId: a.branchId,
      name: a.name,
      contactPhone: a.contactPhone,
      operatingSchedule: {
        daysOfWeek: a.operatingDays ?? null,
        openTime: a.openTime ?? null,
        closeTime: a.closeTime ?? null,
      },
      operatingSchedules: Array.isArray(a.operatingSchedules) ? a.operatingSchedules : [],
      isTemporarilyClosed: a.isTemporarilyClosed,
      isActive: a.isActive,
    }));

    const allAccounts = paymentMethodsRes.rows as Array<{ isInternalVault?: boolean }>;
    const posPaymentMethods = allAccounts.filter((pm) => !pm.isInternalVault);

    return {
      serverTime: new Date().toISOString(),
      branch: {
        ...branch,
        featureFlags: {
          ...DEFAULT_BRANCH_FEATURE_FLAGS,
          ...(branch.featureFlags ?? {}),
        },
        rolePermissions: resolveBranchRolePermissions(branch.rolePermissions),
        operatingSchedules: Array.isArray(branch.operatingSchedules) ? branch.operatingSchedules : [],
      },
      users: usersRes.rows,
      diningTables: tablesRes.rows,
      activeShift: shiftStatus.shift
        ? {
            ...shiftStatus.shift,
            hoursOpen: shiftStatus.hoursOpen,
            isExpired24h: shiftStatus.isExpired24h,
          }
        : null,
      lastClosedCashLeft: shiftStatus.lastClosedCashLeft,
      categories: categoriesRes.rows,
      menuProducts: productsRes.rows,
      presentations,
      inventoryItems: inventoryRes.rows,
      purchasePresentations: purchasePresRes.rows,
      allies,
      customers: customersRes.rows,
      paymentMethods: posPaymentMethods,
      treasuryAccounts: allAccounts,
      promotionRules: promotionsRes.rows,
      comboTemplates: comboTemplatesRes.rows,
      openTableSessions: sessionsRes.rows,
      openSubAccounts: subAccountsRes.rows,
      openOrderItems: orderItemsRes.rows,
    };
  });
}

