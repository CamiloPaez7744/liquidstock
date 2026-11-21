import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { calculateCashShiftClosure, generateUuidV7, type ShiftPaymentRecord } from "@liquistock/domain";
import { requireBranchRole } from "../../../infrastructure/auth/auth-guard.js";
import { type DbClient, db, withTransaction } from "../../../infrastructure/db/pool.js";
import { branchHub } from "../../../infrastructure/realtime/branch-hub.js";

async function computeShiftLiveReport(client: DbClient, branchId: string, shiftId: string, declaredPhysicalCash?: number | null) {
  const shiftRes = await client.query<{
    id: string;
    opening_float: string;
    opened_at: string;
    status: string;
  }>(
    `SELECT id, opening_float::text, opened_at, status FROM cash_shifts WHERE id = $1 AND branch_id = $2`,
    [shiftId, branchId],
  );
  const shift = shiftRes.rows[0];
  if (!shift) return null;

  const [salesRes, creditRes, paymentsRes, alliesRes, openTablesRes] = await Promise.all([
    client.query<{ gross: string; discounts: string }>(
      `SELECT
         COALESCE(SUM(oi.unit_price_snap * oi.quantity), 0)::text AS gross,
         COALESCE(SUM(oi.discount_amount), 0)::text AS discounts
       FROM order_items oi
       JOIN sub_accounts sa ON sa.id = oi.sub_account_id
       JOIN table_sessions ts ON ts.id = sa.table_session_id
       WHERE ts.cash_shift_id = $1 AND oi.status = 'active' AND sa.status <> 'voided'`,
      [shiftId],
    ),
    client.query<{ credit_issued: string }>(
      `SELECT COALESCE(SUM(amount_delta), 0)::text AS credit_issued
       FROM customer_credit_ledger
       WHERE cash_shift_id = $1 AND entry_type = 'charge'`,
      [shiftId],
    ),
    client.query<{
      payment_method_id: string;
      payment_method_name: string;
      counts_as_physical_cash: boolean;
      payment_purpose: "sale_payment" | "credit_repayment";
      amount: string;
    }>(
      `SELECT p.payment_method_id, pm.name AS payment_method_name,
              pm.counts_as_physical_cash, p.payment_purpose, p.amount::text
       FROM payments p
       JOIN payment_methods pm ON pm.id = p.payment_method_id
       WHERE p.cash_shift_id = $1`,
      [shiftId],
    ),
    client.query<{ ally_id: string; ally_name: string; amount: string }>(
      `SELECT ase.ally_id, a.name AS ally_name, COALESCE(SUM(ase.amount_payable), 0)::text AS amount
       FROM ally_settlement_entries ase
       JOIN allies a ON a.id = ase.ally_id
       WHERE ase.cash_shift_id = $1 AND ase.status = 'pending'
       GROUP BY ase.ally_id, a.name`,
      [shiftId],
    ),
    client.query<{ open_count: string; open_amount: string }>(
      `SELECT COUNT(DISTINCT ts.id)::text AS open_count,
              COALESCE(SUM(sa.total_amount - sa.paid_amount - sa.credit_amount), 0)::text AS open_amount
       FROM table_sessions ts
       JOIN sub_accounts sa ON sa.table_session_id = ts.id
       WHERE ts.branch_id = $1 AND ts.status = 'open' AND sa.status = 'open'`,
      [branchId],
    ),
  ]);

  const paymentRecords: ShiftPaymentRecord[] = paymentsRes.rows.map((p) => ({
    paymentMethodId: p.payment_method_id,
    paymentMethodName: p.payment_method_name,
    countsAsPhysicalCash: p.counts_as_physical_cash,
    purpose: p.payment_purpose,
    amount: Number(p.amount),
  }));

  const closure = calculateCashShiftClosure({
    openingFloat: Number(shift.opening_float),
    grossSales: Number(salesRes.rows[0]?.gross ?? "0"),
    discounts: Number(salesRes.rows[0]?.discounts ?? "0"),
    creditIssued: Number(creditRes.rows[0]?.credit_issued ?? "0"),
    allyPayablesByAlly: alliesRes.rows.map((a) => ({
      allyId: a.ally_id,
      allyName: a.ally_name,
      amount: Number(a.amount),
    })),
    payments: paymentRecords,
    declaredPhysicalCash,
  });

  return {
    shiftId: shift.id,
    status: shift.status,
    openedAt: shift.opened_at,
    openTablesCount: Number(openTablesRes.rows[0]?.open_count ?? "0"),
    openTablesPendingAmount: Number(openTablesRes.rows[0]?.open_amount ?? "0"),
    report: closure,
  };
}

export async function registerShiftsAndKpisRoutes(app: FastifyInstance) {
  app.get("/api/v1/branches/:branchId/shifts/current", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier", "waiter"]);
    if (!auth) return;
    const open = await db.query<{ id: string }>(
      `SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open' LIMIT 1`,
      [branchId],
    );
    const shiftId = open.rows[0]?.id;
    if (!shiftId) return { activeShift: null };

    const data = await computeShiftLiveReport(db, branchId, shiftId);
    return { activeShift: data };
  });

  app.post("/api/v1/branches/:branchId/shifts/open", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier"]);
    if (!auth) return;
    const body = z
      .object({
        userId: z.string().uuid().optional(),
        openingFloat: z.number().min(0).default(0),
      })
      .safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "INVALID_SHIFT_OPEN" });

    const existing = await db.query(
      `SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open'`,
      [branchId],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return reply.status(409).send({ error: "SHIFT_ALREADY_OPEN" });
    }

    const id = generateUuidV7();
    await db.query(
      `INSERT INTO cash_shifts (id, branch_id, opened_by, status, opening_float)
       VALUES ($1, $2, $3, 'open', $4)`,
      [id, branchId, auth.userId, body.data.openingFloat],
    );

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "pos",
      timestamp: new Date().toISOString(),
      payload: { action: "OPENED", shiftId: id },
    });

    return reply.status(201).send({ id });
  });

  // Partial / With-Debts Cash Shift Closure
  app.post("/api/v1/branches/:branchId/shifts/close", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier"]);
    if (!auth) return;
    const body = z
      .object({
        userId: z.string().uuid().optional(),
        declaredPhysicalCash: z.number().min(0),
        notes: z.string().optional().nullable(),
        openNextShiftFloat: z.number().min(0).optional(),
      })
      .safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "INVALID_SHIFT_CLOSE" });

    const closed = await withTransaction(async (client) => {
      const openRes = await client.query<{ id: string }>(
        `SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open' FOR UPDATE`,
        [branchId],
      );
      const shiftId = openRes.rows[0]?.id;
      if (!shiftId) throw new Error("NO_OPEN_SHIFT");

      const live = await computeShiftLiveReport(
        client,
        branchId,
        shiftId,
        body.data.declaredPhysicalCash,
      );
      if (!live) throw new Error("NO_OPEN_SHIFT");
      const r = live.report;

      await client.query(
        `UPDATE cash_shifts
         SET status = 'closed',
             closed_by = $2,
             closed_at = now(),
             total_gross_sales = $3,
             total_discounts = $4,
             total_net_sales = $5,
             total_collected = $6,
             total_credit_issued = $7,
             total_credit_recovered = $8,
             total_ally_payable = $9,
             expected_physical_cash = $10,
             declared_physical_cash = $11,
             cash_discrepancy = $12,
             notes = $13
         WHERE id = $1`,
        [
          shiftId,
          auth.userId,
          r.totalGrossSales,
          r.totalDiscounts,
          r.totalNetSales,
          r.totalCollectedOverall,
          r.totalCreditIssued,
          r.totalCreditRecovered,
          r.totalAllyPayable,
          r.expectedPhysicalCash,
          r.declaredPhysicalCash,
          r.cashDiscrepancy,
          body.data.notes ?? null,
        ],
      );

      let nextShiftId: string | null = null;
      if (body.data.openNextShiftFloat !== undefined) {
        nextShiftId = generateUuidV7();
        await client.query(
          `INSERT INTO cash_shifts (id, branch_id, opened_by, status, opening_float)
           VALUES ($1, $2, $3, 'open', $4)`,
          [nextShiftId, branchId, auth.userId, body.data.openNextShiftFloat],
        );
        // Transfer any still-open tables seamlessly to the newly opened shift
        await client.query(
          `UPDATE table_sessions SET cash_shift_id = $2 WHERE branch_id = $1 AND status = 'open'`,
          [branchId, nextShiftId],
        );
      }

      return { closedShiftId: shiftId, nextShiftId, report: r };
    });

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "pos",
      timestamp: new Date().toISOString(),
      payload: { action: "CLOSED", ...closed },
    });

    return closed;
  });

  // Mark pending ally settlements as paid
  app.post("/api/v1/branches/:branchId/allies/:allyId/settle", async (request, reply) => {
    const { branchId, allyId } = request.params as { branchId: string; allyId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier"]);
    if (!auth) return;

    const res = await db.query(
      `UPDATE ally_settlement_entries
       SET status = 'settled', settled_at = now(), settled_by = $3
       WHERE branch_id = $1 AND ally_id = $2 AND status = 'pending'
       RETURNING id, amount_payable::float8 AS "amountPayable"`,
      [branchId, allyId, auth.userId],
    );
    return { settledCount: res.rowCount ?? 0 };
  });

  // MVP+ Dashboard KPIs with Daily / Weekly / Monthly / All filters, Previous-Period Comparison & Evolution Time-Series
  app.get("/api/v1/branches/:branchId/kpis", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;
    const query = request.query as { period?: string };
    const period = (
      query.period === "daily" ||
      query.period === "weekly" ||
      query.period === "monthly" ||
      query.period === "all"
        ? query.period
        : "monthly"
    ) as "daily" | "weekly" | "monthly" | "all";

    const now = new Date();
    let currentStart: Date;
    let prevStart: Date;
    let prevEnd: Date;
    let periodLabel: string;
    let comparisonLabel: string;

    if (period === "daily") {
      currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      prevEnd = new Date(currentStart.getTime());
      prevStart = new Date(currentStart.getTime() - 24 * 60 * 60 * 1000);
      periodLabel = "Hoy";
      comparisonLabel = "vs ayer";
    } else if (period === "weekly") {
      currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
      prevEnd = new Date(currentStart.getTime());
      prevStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
      periodLabel = "Últimos 7 días";
      comparisonLabel = "vs 7 días previos";
    } else if (period === "monthly") {
      currentStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      prevEnd = new Date(currentStart.getTime());
      prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
      periodLabel = "Este mes";
      comparisonLabel = "vs mes anterior";
    } else {
      currentStart = new Date(2000, 0, 1);
      prevStart = new Date(1999, 0, 1);
      prevEnd = new Date(2000, 0, 1);
      periodLabel = "Histórico total";
      comparisonLabel = "acumulado";
    }

    const currentStartIso = currentStart.toISOString();
    const prevStartIso = prevStart.toISOString();
    const prevEndIso = prevEnd.toISOString();

    // Evolution window: daily -> 24h today; weekly -> last 7 days; monthly/all -> last 6 months
    const evolutionStart =
      period === "daily"
        ? currentStart
        : period === "weekly"
          ? currentStart
          : new Date(now.getFullYear(), now.getMonth() - 5, 1, 0, 0, 0, 0);
    const evolutionBucketFormat =
      period === "daily" ? "HH24:00" : period === "weekly" ? "YYYY-MM-DD" : "YYYY-MM";

    const [
      summaryRes,
      prevSummaryRes,
      topProductsRes,
      topPresentationsRes,
      byCategoryRes,
      kegHealthRes,
      foamRes,
      prevFoamRes,
      portfolioRes,
      debtorsRes,
      salesEvolutionRes,
      foamEvolutionRes,
    ] = await Promise.all([
      db.query<{
        totalNetSales: number;
        totalDiscounts: number;
        totalUnitsSold: number;
        totalTickets: number;
      }>(
        `SELECT
           COALESCE(SUM(oi.line_total), 0)::float8 AS "totalNetSales",
           COALESCE(SUM(oi.discount_amount), 0)::float8 AS "totalDiscounts",
           COALESCE(SUM(oi.quantity), 0)::int AS "totalUnitsSold",
           COUNT(DISTINCT oi.sub_account_id)::int AS "totalTickets"
         FROM order_items oi
         WHERE oi.branch_id = $1 AND oi.status = 'active' AND oi.created_at >= $2::timestamptz`,
        [branchId, currentStartIso],
      ),
      db.query<{
        totalNetSales: number;
        totalDiscounts: number;
        totalUnitsSold: number;
        totalTickets: number;
      }>(
        `SELECT
           COALESCE(SUM(oi.line_total), 0)::float8 AS "totalNetSales",
           COALESCE(SUM(oi.discount_amount), 0)::float8 AS "totalDiscounts",
           COALESCE(SUM(oi.quantity), 0)::int AS "totalUnitsSold",
           COUNT(DISTINCT oi.sub_account_id)::int AS "totalTickets"
         FROM order_items oi
         WHERE oi.branch_id = $1 AND oi.status = 'active'
           AND oi.created_at >= $2::timestamptz AND oi.created_at < $3::timestamptz`,
        [branchId, prevStartIso, prevEndIso],
      ),
      db.query(
        `SELECT
           oi.menu_product_id AS "productId",
           oi.product_name_snap AS "productName",
           SUM(oi.quantity)::int AS "unitsSold",
           SUM(oi.line_total)::float8 AS "revenue"
         FROM order_items oi
         WHERE oi.branch_id = $1 AND oi.status = 'active' AND oi.created_at >= $2::timestamptz
         GROUP BY oi.menu_product_id, oi.product_name_snap
         ORDER BY "revenue" DESC
         LIMIT 15`,
        [branchId, currentStartIso],
      ),
      db.query(
        `SELECT
           oi.presentation_id AS "presentationId",
           oi.product_name_snap AS "productName",
           oi.presentation_name_snap AS "presentationName",
           oi.presentation_group_snap AS "presentationGroup",
           SUM(oi.quantity)::int AS "unitsSold",
           SUM(oi.line_total)::float8 AS "revenue"
         FROM order_items oi
         WHERE oi.branch_id = $1 AND oi.status = 'active' AND oi.created_at >= $2::timestamptz
         GROUP BY oi.presentation_id, oi.product_name_snap, oi.presentation_name_snap, oi.presentation_group_snap
         ORDER BY "unitsSold" DESC, "revenue" DESC
         LIMIT 15`,
        [branchId, currentStartIso],
      ),
      db.query(
        `SELECT
           c.id AS "categoryId",
           c.name AS "categoryName",
           SUM(oi.quantity)::int AS "unitsSold",
           SUM(oi.line_total)::float8 AS "revenue"
         FROM order_items oi
         JOIN menu_products mp ON mp.id = oi.menu_product_id
         JOIN categories c ON c.id = mp.category_id
         WHERE oi.branch_id = $1 AND oi.status = 'active' AND oi.created_at >= $2::timestamptz
         GROUP BY c.id, c.name
         ORDER BY "revenue" DESC`,
        [branchId, currentStartIso],
      ),
      db.query(
        `SELECT
           id, name, base_unit AS "baseUnit", is_keg AS "isKeg",
           current_stock_base::float8 AS "currentStockBase",
           min_stock_base::float8 AS "minStockBase",
           default_pour_loss_pct::float8 AS "defaultPourLossPercent"
         FROM inventory_items
         WHERE branch_id = $1 AND is_active = true
         ORDER BY is_keg DESC, (current_stock_base - min_stock_base) ASC`,
        [branchId],
      ),
      db.query<{ totalNominalSoldBase: number; totalFoamLossBase: number }>(
        `SELECT
           COALESCE(SUM(nominal_qty_base), 0)::float8 AS "totalNominalSoldBase",
           COALESCE(SUM(pour_loss_qty_base), 0)::float8 AS "totalFoamLossBase"
         FROM inventory_ledger
         WHERE branch_id = $1 AND movement_type = 'sale' AND created_at >= $2::timestamptz`,
        [branchId, currentStartIso],
      ),
      db.query<{ totalNominalSoldBase: number; totalFoamLossBase: number }>(
        `SELECT
           COALESCE(SUM(nominal_qty_base), 0)::float8 AS "totalNominalSoldBase",
           COALESCE(SUM(pour_loss_qty_base), 0)::float8 AS "totalFoamLossBase"
         FROM inventory_ledger
         WHERE branch_id = $1 AND movement_type = 'sale'
           AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
        [branchId, prevStartIso, prevEndIso],
      ),
      db.query(
        `SELECT
           COALESCE(SUM(current_debt), 0)::float8 AS "totalPendingCredit",
           COUNT(*) FILTER (WHERE current_debt > 0)::int AS "debtorCount",
           COUNT(*) FILTER (WHERE credit_status = 'blacklist_blocked')::int AS "blacklistedCount"
         FROM customers
         WHERE branch_id = $1`,
        [branchId],
      ),
      db.query(
        `SELECT
           id, full_name AS "fullName", nickname,
           credit_status AS "creditStatus",
           credit_limit::float8 AS "creditLimit",
           current_debt::float8 AS "currentDebt"
         FROM customers
         WHERE branch_id = $1 AND current_debt > 0
         ORDER BY current_debt DESC
         LIMIT 20`,
        [branchId],
      ),
      db.query<{
        bucket: string;
        netSales: number;
        discounts: number;
        unitsSold: number;
        tickets: number;
      }>(
        `SELECT
           to_char(oi.created_at, $3) AS bucket,
           COALESCE(SUM(oi.line_total), 0)::float8 AS "netSales",
           COALESCE(SUM(oi.discount_amount), 0)::float8 AS "discounts",
           COALESCE(SUM(oi.quantity), 0)::int AS "unitsSold",
           COUNT(DISTINCT oi.sub_account_id)::int AS "tickets"
         FROM order_items oi
         WHERE oi.branch_id = $1 AND oi.status = 'active' AND oi.created_at >= $2::timestamptz
         GROUP BY bucket
         ORDER BY bucket ASC`,
        [branchId, evolutionStart.toISOString(), evolutionBucketFormat],
      ),
      db.query<{ bucket: string; foamLossBase: number }>(
        `SELECT
           to_char(il.created_at, $3) AS bucket,
           COALESCE(SUM(il.pour_loss_qty_base), 0)::float8 AS "foamLossBase"
         FROM inventory_ledger il
         WHERE il.branch_id = $1 AND il.movement_type = 'sale' AND il.created_at >= $2::timestamptz
         GROUP BY bucket
         ORDER BY bucket ASC`,
        [branchId, evolutionStart.toISOString(), evolutionBucketFormat],
      ),
    ]);

    const summary = summaryRes.rows[0] ?? {
      totalNetSales: 0,
      totalDiscounts: 0,
      totalUnitsSold: 0,
      totalTickets: 0,
    };
    const prevSummary = prevSummaryRes.rows[0] ?? {
      totalNetSales: 0,
      totalDiscounts: 0,
      totalUnitsSold: 0,
      totalTickets: 0,
    };

    const calcDeltaPct = (curr: number, prev: number): number | null => {
      if (period === "all" || prev <= 0) return null;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    };

    const nominal = foamRes.rows[0]?.totalNominalSoldBase ?? 0;
    const foam = foamRes.rows[0]?.totalFoamLossBase ?? 0;
    const prevFoam = prevFoamRes.rows[0]?.totalFoamLossBase ?? 0;
    const foamRatioPct = nominal > 0 ? Math.round((foam / nominal) * 1000) / 10 : 0;

    // Build complete zero-filled evolution series so monthly/weekly/daily charts always look clean
    const salesByBucket = new Map(salesEvolutionRes.rows.map((r) => [r.bucket, r]));
    const foamByBucket = new Map(foamEvolutionRes.rows.map((r) => [r.bucket, r.foamLossBase]));
    const evolution: Array<{
      bucket: string;
      label: string;
      netSales: number;
      discounts: number;
      unitsSold: number;
      tickets: number;
      foamLossBase: number;
    }> = [];

    if (period === "daily") {
      // Show active bar hours + all hours with data (or last 12h up to current hour)
      const currentHour = now.getHours();
      const startHour = Math.max(0, currentHour - 11);
      for (let h = startHour; h <= currentHour; h += 1) {
        const key = `${String(h).padStart(2, "0")}:00`;
        const row = salesByBucket.get(key);
        evolution.push({
          bucket: key,
          label: `${String(h).padStart(2, "0")}h`,
          netSales: row?.netSales ?? 0,
          discounts: row?.discounts ?? 0,
          unitsSold: row?.unitsSold ?? 0,
          tickets: row?.tickets ?? 0,
          foamLossBase: foamByBucket.get(key) ?? 0,
        });
      }
    } else if (period === "weekly") {
      const dayNames = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const row = salesByBucket.get(key);
        evolution.push({
          bucket: key,
          label: `${dayNames[d.getDay()]} ${d.getDate()}`,
          netSales: row?.netSales ?? 0,
          discounts: row?.discounts ?? 0,
          unitsSold: row?.unitsSold ?? 0,
          tickets: row?.tickets ?? 0,
          foamLossBase: foamByBucket.get(key) ?? 0,
        });
      }
    } else {
      const monthNames = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
      for (let i = 5; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const row = salesByBucket.get(key);
        evolution.push({
          bucket: key,
          label: `${monthNames[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`,
          netSales: row?.netSales ?? 0,
          discounts: row?.discounts ?? 0,
          unitsSold: row?.unitsSold ?? 0,
          tickets: row?.tickets ?? 0,
          foamLossBase: foamByBucket.get(key) ?? 0,
        });
      }
    }

    return {
      period,
      periodLabel,
      comparisonLabel,
      summary,
      previousSummary: {
        ...prevSummary,
        totalFoamLossBase: prevFoam,
      },
      deltas: {
        salesPct: calcDeltaPct(summary.totalNetSales, prevSummary.totalNetSales),
        discountsPct: calcDeltaPct(summary.totalDiscounts, prevSummary.totalDiscounts),
        unitsPct: calcDeltaPct(summary.totalUnitsSold, prevSummary.totalUnitsSold),
        ticketsPct: calcDeltaPct(summary.totalTickets, prevSummary.totalTickets),
        foamPct: calcDeltaPct(foam, prevFoam),
      },
      evolution,
      salesByCategory: byCategoryRes.rows,
      topProducts: topProductsRes.rows,
      topPresentations: topPresentationsRes.rows,
      inventoryHealth: kegHealthRes.rows,
      foamAnalytics: {
        totalNominalSoldBase: nominal,
        totalFoamLossBase: foam,
        foamRatioPercent: foamRatioPct,
      },
      creditPortfolio: portfolioRes.rows[0],
      debtors: debtorsRes.rows,
    };
  });
}

