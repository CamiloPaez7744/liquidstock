import {
  DEFAULT_BRANCH_FEATURE_FLAGS,
  evaluateCreditRequest,
  evaluateLinePromotion,
  evaluateSubAccountPromotion,
  explodePresentationSale,
  generateUuidV7,
  isPromotionEligibleAt,
  type BranchFeatureFlags,
  type Customer,
  type OfflineSyncCommand,
  type PresentationGroup,
  type ProductKind,
  type ProductPresentation,
  type PromotionRule,
} from "@liquistock/domain";
import type { ISyncRepository, SyncCommandReceipt } from "../../domain/ports/sync-repository.port.js";
import { type DbClient, withTransaction } from "./pool.js";

function getBranchClock(clientHlc: string): { isoDay: number; hhmm: string; yyyymmdd: string } {
  const date = new Date(clientHlc);
  const jsDay = date.getDay(); // 0=Sun..6=Sat
  const isoDay = jsDay === 0 ? 7 : jsDay;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return { isoDay, hhmm: `${hh}:${mm}`, yyyymmdd: `${yyyy}-${mo}-${dd}` };
}

async function loadActiveBranchPromotions(client: DbClient, branchId: string): Promise<PromotionRule[]> {
  const promoRows = await client.query<{
    id: string;
    branch_id: string;
    name: string;
    rule_type: PromotionRule["ruleType"];
    scope_type: PromotionRule["scopeType"];
    application_mode: PromotionRule["applicationMode"];
    target_id: string | null;
    days_of_week: number[] | null;
    start_time: string | null;
    end_time: string | null;
    valid_from: string | null;
    valid_until: string | null;
    config: PromotionRule["config"];
    priority: number;
    is_stackable: boolean;
    is_active: boolean;
  }>(
    `SELECT id, branch_id, name, rule_type, scope_type, application_mode, target_id,
            days_of_week, to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time, 'HH24:MI') AS end_time,
            to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
            to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
            config, priority, is_stackable, is_active
     FROM promotion_rules
     WHERE branch_id = $1 AND is_active = true
     ORDER BY priority ASC`,
    [branchId],
  );

  return promoRows.rows.map((r) => ({
    id: r.id,
    branchId: r.branch_id,
    name: r.name,
    ruleType: r.rule_type,
    scopeType: r.scope_type,
    applicationMode: r.application_mode ?? "automatic",
    targetId: r.target_id,
    daysOfWeek: r.days_of_week,
    startTime: r.start_time,
    endTime: r.end_time,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    config: r.config ?? {},
    priority: r.priority,
    isStackable: r.is_stackable,
    isActive: r.is_active,
  }));
}

async function applyPromotionRuleToSubAccount(
  client: DbClient,
  subAccountId: string,
  rule: PromotionRule,
  options?: { skipManualPromoLines?: boolean },
): Promise<void> {
  // Only re-price active items without a manual courtesy/price override
  const linesRes = await client.query<{
    id: string;
    category_id: string;
    menu_product_id: string;
    presentation_id: string;
    presentation_group_snap: string;
    unit_price_snap: string;
    quantity: number;
    discount_amount: string;
  }>(
    options?.skipManualPromoLines
      ? `SELECT oi.id, mp.category_id, oi.menu_product_id, oi.presentation_id,
                oi.presentation_group_snap, oi.unit_price_snap::text, oi.quantity, oi.discount_amount::text
         FROM order_items oi
         JOIN menu_products mp ON mp.id = oi.menu_product_id
         LEFT JOIN promotion_rules pr ON pr.id = oi.promotion_rule_id
         WHERE oi.sub_account_id = $1
           AND oi.status = 'active'
           AND oi.adjustment_reason IS NULL
           AND (pr.id IS NULL OR pr.application_mode <> 'manual_at_checkout')
         ORDER BY oi.created_at ASC`
      : `SELECT oi.id, mp.category_id, oi.menu_product_id, oi.presentation_id,
                oi.presentation_group_snap, oi.unit_price_snap::text, oi.quantity, oi.discount_amount::text
         FROM order_items oi
         JOIN menu_products mp ON mp.id = oi.menu_product_id
         WHERE oi.sub_account_id = $1 AND oi.status = 'active' AND oi.adjustment_reason IS NULL
         ORDER BY oi.created_at ASC`,
    [subAccountId],
  );

  const lines = linesRes.rows.map((r) => ({
    id: r.id,
    categoryId: r.category_id,
    menuProductId: r.menu_product_id,
    presentationId: r.presentation_id,
    presentationGroup: r.presentation_group_snap as PresentationGroup,
    unitPrice: Number(r.unit_price_snap),
    quantity: r.quantity,
  }));

  const preview = evaluateSubAccountPromotion(rule, lines);
  for (const alloc of preview.allocations) {
    // Only improve discount if greater than existing discount on that line
    await client.query(
      `UPDATE order_items
       SET promotion_rule_id = $2,
           discount_amount = $3,
           line_total = $4
       WHERE id = $1 AND $3 >= discount_amount`,
      [alloc.lineId, alloc.promotionRuleId, alloc.discountAmount, alloc.netTotal],
    );
  }
}

async function recalculateSubAccountTotals(client: DbClient, subAccountId: string): Promise<void> {
  const totals = await client.query<{
    subtotal: string;
    discount: string;
    total: string;
  }>(
    `SELECT
       COALESCE(SUM(unit_price_snap * quantity), 0)::text AS subtotal,
       COALESCE(SUM(discount_amount), 0)::text AS discount,
       COALESCE(SUM(line_total), 0)::text AS total
     FROM order_items
     WHERE sub_account_id = $1 AND status = 'active'`,
    [subAccountId],
  );
  const row = totals.rows[0];
  await client.query(
    `UPDATE sub_accounts
     SET subtotal_amount = $2,
         discount_amount = $3,
         total_amount = $4,
         version = version + 1,
         updated_at = now()
     WHERE id = $1`,
    [subAccountId, row?.subtotal ?? "0", row?.discount ?? "0", row?.total ?? "0"],
  );
}

async function closeSessionIfAllSubAccountsClosed(client: DbClient, subAccountId: string): Promise<void> {
  const sessionRes = await client.query<{ table_session_id: string }>(
    `SELECT table_session_id FROM sub_accounts WHERE id = $1`,
    [subAccountId],
  );
  const sessionId = sessionRes.rows[0]?.table_session_id;
  if (!sessionId) return;

  const openLeft = await client.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM sub_accounts WHERE table_session_id = $1 AND status = 'open'`,
    [sessionId],
  );
  if (Number(openLeft.rows[0]?.cnt ?? "0") === 0) {
    await client.query(
      `UPDATE table_sessions SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open'`,
      [sessionId],
    );
  }
}

async function voidOrderItemInTx(
  client: DbClient,
  orderItemId: string,
  reason: string,
  branchId: string,
  userId: string,
): Promise<string | null> {
  const itemRes = await client.query<{ sub_account_id: string; status: string }>(
    `SELECT sub_account_id, status FROM order_items WHERE id = $1`,
    [orderItemId],
  );
  const item = itemRes.rows[0];
  if (!item || item.status === "voided") return null;

  await client.query(
    `UPDATE order_items SET status = 'voided', void_reason = $2, voided_by = $3 WHERE id = $1`,
    [orderItemId, reason, userId],
  );

  // Compensating reversal in immutable inventory_ledger
  const origLedger = await client.query<{
    inventory_item_id: string;
    quantity_delta_base: string;
    nominal_qty_base: string;
    pour_loss_qty_base: string;
    unit_cost_base: string;
  }>(
    `SELECT inventory_item_id, quantity_delta_base::text, nominal_qty_base::text,
            pour_loss_qty_base::text, unit_cost_base::text
     FROM inventory_ledger
     WHERE reference_type = 'order_item' AND reference_id = $1 AND movement_type = 'sale'`,
    [orderItemId],
  );

  for (const row of origLedger.rows) {
    const restoreDelta = Math.abs(Number(row.quantity_delta_base));
    const inv = await client.query<{ current_stock_base: string }>(
      `SELECT current_stock_base::text FROM inventory_items WHERE id = $1 FOR UPDATE`,
      [row.inventory_item_id],
    );
    const nextStock =
      Math.round((Number(inv.rows[0]?.current_stock_base ?? "0") + restoreDelta) * 1000) / 1000;

    await client.query(
      `UPDATE inventory_items SET current_stock_base = $2, updated_at = now() WHERE id = $1`,
      [row.inventory_item_id, nextStock],
    );

    await client.query(
      `INSERT INTO inventory_ledger (
         id, branch_id, inventory_item_id, movement_type,
         quantity_delta_base, nominal_qty_base, pour_loss_qty_base,
         stock_after_base, unit_cost_base, reference_type, reference_id,
         reason, created_by, idempotency_key
       ) VALUES (
         $1, $2, $3, 'sale_void_reversal',
         $4, $5, $6,
         $7, $8, 'order_item', $9,
         $10, $11, $12
       )`,
      [
        generateUuidV7(),
        branchId,
        row.inventory_item_id,
        restoreDelta,
        -Number(row.nominal_qty_base),
        -Number(row.pour_loss_qty_base),
        nextStock,
        Number(row.unit_cost_base),
        orderItemId,
        `Reversión anulación: ${reason}`,
        userId,
        generateUuidV7(),
      ],
    );
  }

  await client.query(
    `UPDATE ally_settlement_entries SET status = 'voided' WHERE order_item_id = $1`,
    [orderItemId],
  );

  return item.sub_account_id;
}

async function getActiveCashShiftId(client: DbClient, branchId: string, fallbackUserId: string): Promise<string> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open' LIMIT 1`,
    [branchId],
  );
  if (res.rows[0]?.id) return res.rows[0].id;

  const newShiftId = generateUuidV7();
  await client.query(
    `INSERT INTO cash_shifts (id, branch_id, opened_by, status, opening_float)
     VALUES ($1, $2, $3, 'open', 0)`,
    [newShiftId, branchId, fallbackUserId],
  );
  return newShiftId;
}

/**
 * Full ACID PostgreSQL adapter for idempotent offline outbox processing.
 * Executes table sessions, split sub-accounts, recipe explosion with foam loss into immutable
 * inventory_ledger, ally settlements, payments, and Lista Blanca/Lista Negra credit guard.
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

      const payload = command.payload as Record<string, unknown>;

      switch (command.commandType) {
        case "OPEN_TABLE_SESSION": {
          const tableSessionId = String(payload.tableSessionId ?? generateUuidV7());
          const diningTableId = payload.diningTableId ? String(payload.diningTableId) : null;
          const initialSubAccountId = String(payload.subAccountId ?? generateUuidV7());
          const label = String(payload.label ?? "Cuenta 1");
          const shiftId = await getActiveCashShiftId(client, command.branchId, command.userId);

          await client.query(
            `INSERT INTO table_sessions (id, branch_id, dining_table_id, cash_shift_id, opened_by, status, device_id)
             VALUES ($1, $2, $3, $4, $5, 'open', $6)
             ON CONFLICT (id) DO NOTHING`,
            [tableSessionId, command.branchId, diningTableId, shiftId, command.userId, command.deviceId],
          );

          await client.query(
            `INSERT INTO sub_accounts (id, branch_id, table_session_id, label, status)
             VALUES ($1, $2, $3, $4, 'open')
             ON CONFLICT (id) DO NOTHING`,
            [initialSubAccountId, command.branchId, tableSessionId, label],
          );
          break;
        }

        case "CREATE_SUB_ACCOUNT": {
          const subAccountId = String(payload.subAccountId ?? generateUuidV7());
          const tableSessionId = String(payload.tableSessionId);
          const label = String(payload.label ?? "Cuenta nueva");

          await client.query(
            `INSERT INTO sub_accounts (id, branch_id, table_session_id, label, status)
             VALUES ($1, $2, $3, $4, 'open')
             ON CONFLICT (id) DO NOTHING`,
            [subAccountId, command.branchId, tableSessionId, label],
          );
          break;
        }

        case "DELETE_SUB_ACCOUNT": {
          const subAccountId = String(payload.subAccountId);
          const mode = (payload.mode as "empty_only" | "move_items" | "void_items" | undefined) ?? "empty_only";
          const targetSubAccountId =
            typeof payload.targetSubAccountId === "string" && payload.targetSubAccountId.trim()
              ? payload.targetSubAccountId.trim()
              : null;
          const reason = String(payload.reason ?? "Cuenta eliminada en POS");

          const subRes = await client.query<{
            status: string;
            table_session_id: string;
            paid_amount: string;
            credit_amount: string;
          }>(
            `SELECT status, table_session_id, paid_amount::text, credit_amount::text
             FROM sub_accounts
             WHERE id = $1 AND branch_id = $2
             FOR UPDATE`,
            [subAccountId, command.branchId],
          );
          const sub = subRes.rows[0];
          if (!sub || sub.status !== "open") break;

          if (Number(sub.paid_amount) > 0 || Number(sub.credit_amount) > 0) {
            await client.query(
              `UPDATE sync_processed_events SET result_status = 'conflict_flagged' WHERE idempotency_key = $1`,
              [command.idempotencyKey],
            );
            return {
              idempotencyKey: command.idempotencyKey,
              status: "conflict_flagged",
              detail: "No se puede eliminar una sub-cuenta que ya tiene abonos o fiado registrados.",
            };
          }

          const activeItemsRes = await client.query<{ id: string }>(
            `SELECT id FROM order_items WHERE sub_account_id = $1 AND status = 'active'`,
            [subAccountId],
          );

          if (activeItemsRes.rows.length > 0) {
            if (mode === "move_items" && targetSubAccountId && targetSubAccountId !== subAccountId) {
              const targetCheck = await client.query<{ id: string }>(
                `SELECT id FROM sub_accounts
                 WHERE id = $1 AND table_session_id = $2 AND status = 'open'`,
                [targetSubAccountId, sub.table_session_id],
              );
              if (targetCheck.rows.length === 0) {
                await client.query(
                  `UPDATE sync_processed_events SET result_status = 'conflict_flagged' WHERE idempotency_key = $1`,
                  [command.idempotencyKey],
                );
                return {
                  idempotencyKey: command.idempotencyKey,
                  status: "conflict_flagged",
                  detail: "La sub-cuenta destino no está abierta en esta mesa.",
                };
              }
              for (const row of activeItemsRes.rows) {
                await client.query(`UPDATE order_items SET sub_account_id = $2 WHERE id = $1`, [
                  row.id,
                  targetSubAccountId,
                ]);
                await client.query(
                  `INSERT INTO order_item_transfers (id, order_item_id, from_sub_account_id, to_sub_account_id, moved_by, idempotency_key)
                   VALUES ($1, $2, $3, $4, $5, $6)`,
                  [generateUuidV7(), row.id, subAccountId, targetSubAccountId, command.userId, generateUuidV7()],
                );
              }
              await recalculateSubAccountTotals(client, targetSubAccountId);
            } else if (mode === "void_items") {
              for (const row of activeItemsRes.rows) {
                await voidOrderItemInTx(client, row.id, reason, command.branchId, command.userId);
              }
            } else {
              await client.query(
                `UPDATE sync_processed_events SET result_status = 'conflict_flagged' WHERE idempotency_key = $1`,
                [command.idempotencyKey],
              );
              return {
                idempotencyKey: command.idempotencyKey,
                status: "conflict_flagged",
                detail: "La sub-cuenta aún tiene productos activos.",
              };
            }
          }

          await client.query(
            `UPDATE sub_accounts
             SET status = 'voided',
                 subtotal_amount = 0,
                 discount_amount = 0,
                 total_amount = 0,
                 version = version + 1,
                 updated_at = now()
             WHERE id = $1`,
            [subAccountId],
          );

          await closeSessionIfAllSubAccountsClosed(client, subAccountId);
          break;
        }

        case "ADD_ORDER_ITEM": {
          const orderItemId = String(payload.orderItemId ?? generateUuidV7());
          let subAccountId = String(payload.subAccountId);
          const presentationId = String(payload.presentationId);
          const quantity = Math.max(1, Math.trunc(Number(payload.quantity ?? 1)));
          const forcedPromotionRuleId =
            typeof payload.forcedPromotionRuleId === "string" && payload.forcedPromotionRuleId.trim()
              ? payload.forcedPromotionRuleId.trim()
              : null;

          // Check sub-account status for multi-tablet offline conflict safety
          const subRes = await client.query<{ status: string; table_session_id: string }>(
            `SELECT status, table_session_id FROM sub_accounts WHERE id = $1`,
            [subAccountId],
          );

          let conflictFlagged = false;
          if (subRes.rows[0] && subRes.rows[0].status !== "open") {
            // Conflict recovery: another tablet already closed this sub-account while offline.
            // Never lose the drink — create a recovery sub-account and flag conflict!
            const recoveryId = generateUuidV7();
            await client.query(
              `INSERT INTO sub_accounts (id, branch_id, table_session_id, label, status)
               VALUES ($1, $2, $3, 'Ajuste Offline (Conflicto)', 'open')`,
              [recoveryId, command.branchId, subRes.rows[0].table_session_id],
            );
            subAccountId = recoveryId;
            conflictFlagged = true;
            await client.query(
              `UPDATE sync_processed_events SET result_status = 'conflict_flagged' WHERE idempotency_key = $1`,
              [command.idempotencyKey],
            );
          }

          // Load presentation + parent product + branch flags + recipes
          const presRes = await client.query<{
            id: string;
            menu_product_id: string;
            name: string;
            presentation_group: string;
            sale_price: string;
            ally_id: string | null;
            ally_payout_amount: string;
            product_name: string;
            product_kind: ProductKind;
            category_id: string;
            feature_flags: BranchFeatureFlags | null;
          }>(
            `SELECT
               pp.id, pp.menu_product_id, pp.name, pp.presentation_group, pp.sale_price::text,
               COALESCE(pp.ally_id, mp.ally_id) AS ally_id, pp.ally_payout_amount::text,
               mp.name AS product_name, mp.product_kind, mp.category_id, b.feature_flags
             FROM product_presentations pp
             JOIN menu_products mp ON mp.id = pp.menu_product_id
             JOIN branches b ON b.id = pp.branch_id
             WHERE pp.id = $1 AND pp.branch_id = $2`,
            [presentationId, command.branchId],
          );

          const pres = presRes.rows[0];
          if (!pres) {
            throw new Error(`Presentation ${presentationId} not found in branch ${command.branchId}`);
          }

          const recipesRes = await client.query<{
            id: string;
            presentation_id: string;
            inventory_item_id: string;
            display_unit: string;
            display_quantity: string;
            quantity_base: string;
            pour_loss_percent: string;
            fixed_loss_base: string;
          }>(
            `SELECT id, presentation_id, inventory_item_id, display_unit,
                    display_quantity::text, quantity_base::text,
                    pour_loss_percent::text, fixed_loss_base::text
             FROM presentation_recipes
             WHERE presentation_id = $1`,
            [presentationId],
          );

          const featureFlags: BranchFeatureFlags = {
            ...DEFAULT_BRANCH_FEATURE_FLAGS,
            ...(pres.feature_flags ?? {}),
          };

          // Evaluate active promotions
          let promotionRuleId: string | null = null;
          let discountAmount = 0;
          const unitPrice = Number(pres.sale_price);
          let lineTotal = unitPrice * quantity;

          let activeRules: PromotionRule[] = [];
          const clock = getBranchClock(command.clientHlc);

          if (featureFlags.enablePromotions) {
            activeRules = await loadActiveBranchPromotions(client, command.branchId);
            const promoRes = evaluateLinePromotion({
              line: {
                categoryId: pres.category_id,
                menuProductId: pres.menu_product_id,
                presentationId: pres.id,
                presentationGroup: pres.presentation_group as PresentationGroup,
                unitPrice,
                quantity,
              },
              rules: activeRules,
              isoDayOfWeek: clock.isoDay,
              currentTimeHHMM: clock.hhmm,
              currentDateYYYYMMDD: clock.yyyymmdd,
              forcedRuleId: forcedPromotionRuleId,
            });
            promotionRuleId = promoRes.promotionRuleId;
            discountAmount = promoRes.discountAmount;
            lineTotal = promoRes.netTotal;
          }

          await client.query(
            `INSERT INTO order_items (
               id, branch_id, sub_account_id, menu_product_id, presentation_id, added_by,
               quantity, product_name_snap, presentation_name_snap, presentation_group_snap,
               product_kind_snap, unit_price_snap, ally_id_snap, ally_payout_snap,
               promotion_rule_id, discount_amount, line_total, status, idempotency_key, device_id
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10,
               $11, $12, $13, $14,
               $15, $16, $17, 'active', $18, $19
             )`,
            [
              orderItemId,
              command.branchId,
              subAccountId,
              pres.menu_product_id,
              pres.id,
              command.userId,
              quantity,
              pres.product_name,
              pres.name,
              pres.presentation_group,
              pres.product_kind,
              unitPrice,
              pres.ally_id,
              Number(pres.ally_payout_amount),
              promotionRuleId,
              discountAmount,
              lineTotal,
              command.idempotencyKey,
              command.deviceId,
            ],
          );

          // Explode recipes & write immutable inventory_ledger (with foam loss breakdown!)
          const domainPresentation: ProductPresentation = {
            id: pres.id,
            branchId: command.branchId,
            menuProductId: pres.menu_product_id,
            name: pres.name,
            presentationGroup: pres.presentation_group as ProductPresentation["presentationGroup"],
            salePrice: unitPrice,
            allyId: pres.ally_id,
            allyPayoutAmount: Number(pres.ally_payout_amount),
            isAvailable: true,
            sortOrder: 0,
            recipes: recipesRes.rows.map((r) => ({
              id: r.id,
              presentationId: r.presentation_id,
              inventoryItemId: r.inventory_item_id,
              displayUnit: r.display_unit as ProductPresentation["recipes"][number]["displayUnit"],
              displayQuantity: Number(r.display_quantity),
              quantityBase: Number(r.quantity_base),
              pourLossPercent: Number(r.pour_loss_percent),
              fixedLossBase: Number(r.fixed_loss_base),
            })),
          };

          const explosion = explodePresentationSale({
            productKind: pres.product_kind,
            presentation: domainPresentation,
            quantity,
            applyFoamLossFormula: featureFlags.enableFoamLossFormula,
          });

          for (const deduction of explosion.deductions) {
            const invRow = await client.query<{ current_stock_base: string; avg_unit_cost_base: string }>(
              `SELECT current_stock_base::text, avg_unit_cost_base::text
               FROM inventory_items
               WHERE id = $1
               FOR UPDATE`,
              [deduction.inventoryItemId],
            );
            const prevStock = Number(invRow.rows[0]?.current_stock_base ?? "0");
            const avgCost = Number(invRow.rows[0]?.avg_unit_cost_base ?? "0");
            const nextStock = Math.round((prevStock - deduction.totalDeductionBase) * 1000) / 1000;

            await client.query(
              `UPDATE inventory_items SET current_stock_base = $2, updated_at = now() WHERE id = $1`,
              [deduction.inventoryItemId, nextStock],
            );

            await client.query(
              `INSERT INTO inventory_ledger (
                 id, branch_id, inventory_item_id, movement_type,
                 quantity_delta_base, nominal_qty_base, pour_loss_qty_base,
                 stock_after_base, unit_cost_base, reference_type, reference_id,
                 reason, created_by, idempotency_key
               ) VALUES (
                 $1, $2, $3, 'sale',
                 $4, $5, $6,
                 $7, $8, 'order_item', $9,
                 $10, $11, $12
               )`,
              [
                generateUuidV7(),
                command.branchId,
                deduction.inventoryItemId,
                -deduction.totalDeductionBase,
                deduction.nominalQuantityBase,
                deduction.pourLossQuantityBase,
                nextStock,
                avgCost,
                orderItemId,
                `Venta ${quantity}x ${pres.product_name} (${pres.name})`,
                command.userId,
                generateUuidV7(),
              ],
            );
          }

          // Record third-party ally settlement entry if applicable
          if (explosion.allyId && explosion.totalAllyPayout > 0) {
            const shiftId = await getActiveCashShiftId(client, command.branchId, command.userId);
            await client.query(
              `INSERT INTO ally_settlement_entries (id, branch_id, ally_id, cash_shift_id, order_item_id, amount_payable, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'pending')
               ON CONFLICT (order_item_id) DO NOTHING`,
              [generateUuidV7(), command.branchId, explosion.allyId, shiftId, orderItemId, explosion.totalAllyPayout],
            );
          }

          // Re-evaluate accumulated automatic sub-account promotions (e.g. "Toma 10, la 11 es gratis" or 3x2 across rounds)
          if (featureFlags.enablePromotions && activeRules.length > 0) {
            const eligibleAuto = activeRules.filter(
              (r) =>
                (r.applicationMode ?? "automatic") === "automatic" &&
                (r.ruleType === "bxgy" || (r.config.minQuantity ?? 1) > 1) &&
                isPromotionEligibleAt(r, {
                  isoDayOfWeek: clock.isoDay,
                  currentTimeHHMM: clock.hhmm,
                  currentDateYYYYMMDD: clock.yyyymmdd,
                }),
            );
            for (const rule of eligibleAuto) {
              await applyPromotionRuleToSubAccount(client, subAccountId, rule, {
                skipManualPromoLines: true,
              });
            }
          }

          await recalculateSubAccountTotals(client, subAccountId);

          if (conflictFlagged) {
            return {
              idempotencyKey: command.idempotencyKey,
              status: "conflict_flagged",
              detail: "Sub-cuenta ya cerrada; ítem guardado en sub-cuenta de recuperación.",
            };
          }
          break;
        }

        case "VOID_ORDER_ITEM": {
          const orderItemId = String(payload.orderItemId);
          const reason = String(payload.reason ?? "Anulación en POS");

          const affectedSubAccountId = await voidOrderItemInTx(
            client,
            orderItemId,
            reason,
            command.branchId,
            command.userId,
          );
          if (affectedSubAccountId) {
            await recalculateSubAccountTotals(client, affectedSubAccountId);
          }
          break;
        }

        case "MOVE_ORDER_ITEM": {
          const orderItemId = String(payload.orderItemId);
          const toSubAccountId = String(payload.toSubAccountId);

          const itemRes = await client.query<{ sub_account_id: string }>(
            `SELECT sub_account_id FROM order_items WHERE id = $1 AND status = 'active'`,
            [orderItemId],
          );
          const fromSubAccountId = itemRes.rows[0]?.sub_account_id;
          if (!fromSubAccountId || fromSubAccountId === toSubAccountId) break;

          await client.query(`UPDATE order_items SET sub_account_id = $2 WHERE id = $1`, [
            orderItemId,
            toSubAccountId,
          ]);
          await client.query(
            `INSERT INTO order_item_transfers (id, order_item_id, from_sub_account_id, to_sub_account_id, moved_by, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [generateUuidV7(), orderItemId, fromSubAccountId, toSubAccountId, command.userId, command.idempotencyKey],
          );

          await recalculateSubAccountTotals(client, fromSubAccountId);
          await recalculateSubAccountTotals(client, toSubAccountId);
          break;
        }

        case "ADJUST_ORDER_ITEM_PRICE": {
          // Courtesy ($0), 50% off, or custom price override — preserves unit_price_snap & inventory ledger!
          const orderItemId = String(payload.orderItemId);
          const newLineTotal = Math.max(0, Number(payload.newLineTotal ?? 0));
          const reason = String(payload.reason ?? "Ajuste de precio / Cortesía");

          const itemRes = await client.query<{
            sub_account_id: string;
            unit_price_snap: string;
            quantity: number;
          }>(
            `SELECT sub_account_id, unit_price_snap::text, quantity
             FROM order_items WHERE id = $1 AND status = 'active'`,
            [orderItemId],
          );
          const item = itemRes.rows[0];
          if (!item) break;

          const gross = Number(item.unit_price_snap) * item.quantity;
          const clampedNet = Math.min(gross, Math.round(newLineTotal * 100) / 100);
          const discount = Math.max(0, Math.round((gross - clampedNet) * 100) / 100);

          await client.query(
            `UPDATE order_items
             SET discount_amount = $2,
                 line_total = $3,
                 adjustment_reason = $4,
                 adjusted_by = $5
             WHERE id = $1`,
            [orderItemId, discount, clampedNet, reason, command.userId],
          );
          await recalculateSubAccountTotals(client, item.sub_account_id);
          break;
        }

        case "APPLY_PROMOTION_TO_SUB_ACCOUNT": {
          // Applies a conditional/manual promotion at checkout (e.g. Women's Month 3x2 for tables with women)
          const subAccountId = String(payload.subAccountId);
          const promotionRuleId = String(payload.promotionRuleId);

          const rules = await loadActiveBranchPromotions(client, command.branchId);
          const rule = rules.find((r) => r.id === promotionRuleId);
          if (!rule) break;

          await applyPromotionRuleToSubAccount(client, subAccountId, rule);
          await recalculateSubAccountTotals(client, subAccountId);
          break;
        }

        case "RECORD_PAYMENT": {
          const paymentId = String(payload.paymentId ?? generateUuidV7());
          const subAccountId = payload.subAccountId ? String(payload.subAccountId) : null;
          const customerId = payload.customerId ? String(payload.customerId) : null;
          const paymentMethodId = String(payload.paymentMethodId);
          const purpose = (payload.paymentPurpose === "credit_repayment"
            ? "credit_repayment"
            : "sale_payment") as "sale_payment" | "credit_repayment";
          const amount = Number(payload.amount);
          const referenceCode = payload.referenceCode ? String(payload.referenceCode) : null;
          const shiftId = await getActiveCashShiftId(client, command.branchId, command.userId);

          if (amount > 0) {
            await client.query(
              `INSERT INTO payments (
                 id, branch_id, cash_shift_id, sub_account_id, customer_id,
                 payment_method_id, payment_purpose, amount, received_by, reference_code, idempotency_key
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                paymentId,
                command.branchId,
                shiftId,
                subAccountId,
                customerId,
                paymentMethodId,
                purpose,
                amount,
                command.userId,
                referenceCode,
                command.idempotencyKey,
              ],
            );
          }

          if (purpose === "sale_payment" && subAccountId) {
            const sub = await client.query<{ total_amount: string; paid_amount: string; credit_amount: string }>(
              `SELECT total_amount::text, paid_amount::text, credit_amount::text
               FROM sub_accounts WHERE id = $1 FOR UPDATE`,
              [subAccountId],
            );
            const total = Number(sub.rows[0]?.total_amount ?? "0");
            const nextPaid = Number(sub.rows[0]?.paid_amount ?? "0") + amount;
            const credit = Number(sub.rows[0]?.credit_amount ?? "0");
            const settled = nextPaid + credit >= total - 0.01;

            await client.query(
              `UPDATE sub_accounts
               SET paid_amount = $2,
                   status = CASE WHEN $3 THEN (CASE WHEN credit_amount > 0 THEN 'partial_credit' ELSE 'paid' END) ELSE status END,
                   closed_at = CASE WHEN $3 THEN now() ELSE closed_at END,
                   closed_in_shift_id = CASE WHEN $3 THEN $4 ELSE closed_in_shift_id END,
                   version = version + 1,
                   updated_at = now()
               WHERE id = $1`,
              [subAccountId, nextPaid, settled, shiftId],
            );

            if (settled) {
              await closeSessionIfAllSubAccountsClosed(client, subAccountId);
            }
          } else if (purpose === "credit_repayment" && customerId) {
            const custRes = await client.query<{ current_debt: string }>(
              `SELECT current_debt::text FROM customers WHERE id = $1 FOR UPDATE`,
              [customerId],
            );
            const prevDebt = Number(custRes.rows[0]?.current_debt ?? "0");
            const nextDebt = Math.max(0, Math.round((prevDebt - amount) * 100) / 100);

            await client.query(`UPDATE customers SET current_debt = $2, updated_at = now() WHERE id = $1`, [
              customerId,
              nextDebt,
            ]);
            await client.query(
              `INSERT INTO customer_credit_ledger (
                 id, branch_id, customer_id, cash_shift_id, payment_id,
                 entry_type, amount_delta, balance_after, notes, created_by, idempotency_key
               ) VALUES ($1, $2, $3, $4, $5, 'repayment', $6, $7, 'Abono a cartera', $8, $9)`,
              [
                generateUuidV7(),
                command.branchId,
                customerId,
                shiftId,
                paymentId,
                -amount,
                nextDebt,
                command.userId,
                generateUuidV7(),
              ],
            );
          }
          break;
        }

        case "CHARGE_SUB_ACCOUNT_CREDIT": {
          const subAccountId = String(payload.subAccountId);
          const customerId = String(payload.customerId);
          const creditAmount = Number(payload.amount);
          const adminOverride = Boolean(payload.adminOverride);
          const shiftId = await getActiveCashShiftId(client, command.branchId, command.userId);

          const custRes = await client.query<{
            id: string;
            branch_id: string;
            full_name: string;
            credit_status: Customer["creditStatus"];
            credit_limit: string | null;
            current_debt: string;
            status_reason: string | null;
          }>(
            `SELECT id, branch_id, full_name, credit_status, credit_limit::text, current_debt::text, status_reason
             FROM customers WHERE id = $1 FOR UPDATE`,
            [customerId],
          );
          const row = custRes.rows[0];
          if (!row) throw new Error(`Customer ${customerId} not found`);

          const customer: Customer = {
            id: row.id,
            branchId: row.branch_id,
            fullName: row.full_name,
            creditStatus: row.credit_status,
            creditLimit: row.credit_limit !== null ? Number(row.credit_limit) : null,
            currentDebt: Number(row.current_debt),
            statusReason: row.status_reason,
          };

          const decision = evaluateCreditRequest(customer, creditAmount);
          if (!decision.allowed && !(adminOverride && decision.requiresAdminOverride)) {
            throw new Error(decision.message);
          }

          const nextDebt = Math.round((customer.currentDebt + creditAmount) * 100) / 100;
          await client.query(`UPDATE customers SET current_debt = $2, updated_at = now() WHERE id = $1`, [
            customerId,
            nextDebt,
          ]);

          await client.query(
            `INSERT INTO customer_credit_ledger (
               id, branch_id, customer_id, cash_shift_id, sub_account_id,
               entry_type, amount_delta, balance_after, notes, created_by, idempotency_key
             ) VALUES ($1, $2, $3, $4, $5, 'charge', $6, $7, $8, $9, $10)`,
            [
              generateUuidV7(),
              command.branchId,
              customerId,
              shiftId,
              subAccountId,
              creditAmount,
              nextDebt,
              String(payload.notes ?? "Fiado desde POS"),
              command.userId,
              command.idempotencyKey,
            ],
          );

          const subRes = await client.query<{ paid_amount: string }>(
            `SELECT paid_amount::text FROM sub_accounts WHERE id = $1 FOR UPDATE`,
            [subAccountId],
          );
          const paidAmt = Number(subRes.rows[0]?.paid_amount ?? "0");
          const nextStatus = paidAmt > 0 ? "partial_credit" : "credit";

          await client.query(
            `UPDATE sub_accounts
             SET customer_id = $2,
                 credit_amount = credit_amount + $3,
                 status = $4,
                 closed_at = now(),
                 closed_in_shift_id = $5,
                 version = version + 1,
                 updated_at = now()
             WHERE id = $1`,
            [subAccountId, customerId, creditAmount, nextStatus, shiftId],
          );

          await closeSessionIfAllSubAccountsClosed(client, subAccountId);
          break;
        }

        case "CLOSE_CASH_SHIFT": {
          // Handled via dedicated /shifts/close endpoint or offline replay
          break;
        }
      }

      return {
        idempotencyKey: command.idempotencyKey,
        status: "applied",
      };
    });
  }
}
