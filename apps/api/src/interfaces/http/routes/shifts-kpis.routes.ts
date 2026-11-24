import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { calculateCashShiftClosure, generateUuidV7, type ShiftPaymentRecord } from "@liquistock/domain";
import { requireBranchModulePermission } from "../../../infrastructure/auth/auth-guard.js";
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
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "view");
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
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "edit");
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
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "edit");
    if (!auth) return;
    const body = z
      .object({
        userId: z.string().uuid().optional(),
        declaredPhysicalCash: z.number().min(0),
        declaredByMethod: z.record(z.number().min(0)).optional(),
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

      const [live, cashExpRes] = await Promise.all([
        computeShiftLiveReport(client, branchId, shiftId, body.data.declaredPhysicalCash),
        client.query<{ cash_out: string }>(
          `SELECT COALESCE(SUM(ce.amount), 0)::text AS cash_out
           FROM cash_expenses ce
           JOIN payment_methods pm ON pm.id = ce.payment_method_id
           WHERE ce.cash_shift_id = $1 AND pm.counts_as_physical_cash = true`,
          [shiftId],
        ),
      ]);
      if (!live) throw new Error("NO_OPEN_SHIFT");
      const cashExpensesOut = Number(cashExpRes.rows[0]?.cash_out ?? "0");
      const r = {
        ...live.report,
        expectedPhysicalCash: Math.max(
          0,
          Math.round((live.report.expectedPhysicalCash - cashExpensesOut) * 100) / 100,
        ),
      };
      r.cashDiscrepancy =
        Math.round((body.data.declaredPhysicalCash - r.expectedPhysicalCash) * 100) / 100;

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
             declared_by_method = $13::jsonb,
             notes = $14
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
          JSON.stringify(body.data.declaredByMethod ?? {}),
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
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "edit");
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

  // ============================================================================
  // BALANCE DE CAJA (DIARIO PARA MESERO/CAJERO · MENSUAL + FILTRO DÍA PARA ADMIN)
  // Agrupa todos los ingresos y egresos por medio de pago (Efectivo, Nequi, etc.)
  // ============================================================================
  app.get("/api/v1/branches/:branchId/cash-flow", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "view");
    if (!auth) return;

    const isBranchAdmin = auth.memberships.some(
      (m) => m.branchId === branchId && m.role === "admin",
    );
    const query = request.query as { period?: string; date?: string };

    const now = new Date();
    let startAt: Date;
    let endAt: Date = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    );
    let effectivePeriod: "daily" | "weekly" | "monthly" | "all" | "date" = "daily";
    let periodLabel = "Hoy";
    let selectedDate: string | null = null;

    const pad2 = (n: number) => String(n).padStart(2, "0");
    const todayIsoDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

    if (!isBranchAdmin) {
      // Non-admin roles (Waiter / Cashier): strictly today's net sales & daily cash flow
      startAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      effectivePeriod = "daily";
      periodLabel = `Hoy (${todayIsoDate})`;
      selectedDate = todayIsoDate;
    } else if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
      const [yy, mm, dd] = query.date.split("-").map(Number);
      startAt = new Date(yy!, (mm! - 1), dd!, 0, 0, 0, 0);
      endAt = new Date(yy!, (mm! - 1), dd!, 23, 59, 59, 999);
      effectivePeriod = "date";
      selectedDate = query.date;
      periodLabel = query.date === todayIsoDate ? `Hoy (${query.date})` : `Día ${query.date}`;
    } else {
      // Admin defaults to current month, with quick filters to daily / weekly / all / specific date
      const requested = query.period;
      if (requested === "daily") {
        startAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        effectivePeriod = "daily";
        periodLabel = `Hoy (${todayIsoDate})`;
        selectedDate = todayIsoDate;
      } else if (requested === "weekly") {
        startAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
        effectivePeriod = "weekly";
        periodLabel = "Últimos 7 días";
      } else if (requested === "all") {
        startAt = new Date(2000, 0, 1, 0, 0, 0, 0);
        effectivePeriod = "all";
        periodLabel = "Histórico total";
      } else {
        startAt = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        effectivePeriod = "monthly";
        periodLabel = "Este mes";
      }
    }

    const startIso = startAt.toISOString();
    const endIso = endAt.toISOString();

    const [
      salesRes,
      pmRes,
      paymentsRes,
      expensesRes,
      openShiftRes,
      debtsRes,
      alliesPendingRes,
      creditIssuedRes,
    ] = await Promise.all([
      db.query<{ gross: string; discounts: string; net: string; units: string }>(
        `SELECT
           COALESCE(SUM(oi.unit_price_snap * oi.quantity), 0)::text AS gross,
           COALESCE(SUM(oi.discount_amount), 0)::text AS discounts,
           COALESCE(SUM(oi.line_total), 0)::text AS net,
           COALESCE(SUM(oi.quantity), 0)::text AS units
         FROM order_items oi
         JOIN sub_accounts sa ON sa.id = oi.sub_account_id
         WHERE oi.branch_id = $1
           AND oi.status = 'active'
           AND sa.status <> 'voided'
           AND oi.created_at >= $2::timestamptz
           AND oi.created_at <= $3::timestamptz`,
        [branchId, startIso, endIso],
      ),
      db.query<{
        id: string;
        name: string;
        code: string;
        countsAsPhysicalCash: boolean;
      }>(
        `SELECT id, name, code, counts_as_physical_cash AS "countsAsPhysicalCash"
         FROM payment_methods
         WHERE branch_id = $1 AND is_active = true
         ORDER BY sort_order ASC, name ASC`,
        [branchId],
      ),
      db.query<{
        id: string;
        paymentMethodId: string;
        paymentMethodName: string;
        countsAsPhysicalCash: boolean;
        paymentPurpose: "sale_payment" | "credit_repayment";
        amount: number;
        referenceCode: string | null;
        createdAt: string;
        userName: string;
        customerName: string | null;
        subAccountLabel: string | null;
        tableLabel: string | null;
      }>(
        `SELECT p.id,
                p.payment_method_id AS "paymentMethodId",
                pm.name AS "paymentMethodName",
                pm.counts_as_physical_cash AS "countsAsPhysicalCash",
                p.payment_purpose AS "paymentPurpose",
                p.amount::float8 AS amount,
                p.reference_code AS "referenceCode",
                p.created_at AS "createdAt",
                u.full_name AS "userName",
                c.full_name AS "customerName",
                sa.label AS "subAccountLabel",
                dt.label AS "tableLabel"
         FROM payments p
         JOIN payment_methods pm ON pm.id = p.payment_method_id
         JOIN users u ON u.id = p.received_by
         LEFT JOIN customers c ON c.id = p.customer_id
         LEFT JOIN sub_accounts sa ON sa.id = p.sub_account_id
         LEFT JOIN table_sessions ts ON ts.id = sa.table_session_id
         LEFT JOIN dining_tables dt ON dt.id = ts.dining_table_id
         WHERE p.branch_id = $1
           AND p.created_at >= $2::timestamptz
           AND p.created_at <= $3::timestamptz
         ORDER BY p.created_at DESC
         LIMIT 500`,
        [branchId, startIso, endIso],
      ),
      db.query<{
        id: string;
        paymentMethodId: string;
        paymentMethodName: string;
        countsAsPhysicalCash: boolean;
        category: string;
        description: string;
        amount: number;
        createdAt: string;
        userName: string;
      }>(
        `SELECT ce.id,
                ce.payment_method_id AS "paymentMethodId",
                pm.name AS "paymentMethodName",
                pm.counts_as_physical_cash AS "countsAsPhysicalCash",
                ce.category,
                ce.description,
                ce.amount::float8 AS amount,
                ce.created_at AS "createdAt",
                u.full_name AS "userName"
         FROM cash_expenses ce
         JOIN payment_methods pm ON pm.id = ce.payment_method_id
         JOIN users u ON u.id = ce.created_by
         WHERE ce.branch_id = $1
           AND ce.created_at >= $2::timestamptz
           AND ce.created_at <= $3::timestamptz
         ORDER BY ce.created_at DESC
         LIMIT 300`,
        [branchId, startIso, endIso],
      ),
      db.query<{ opening_float: string }>(
        `SELECT opening_float::text FROM cash_shifts WHERE branch_id = $1 AND status = 'open' LIMIT 1`,
        [branchId],
      ),
      db.query<{ total_debt: string; debtors_count: string }>(
        `SELECT COALESCE(SUM(current_debt), 0)::text AS total_debt,
                COUNT(*) FILTER (WHERE current_debt > 0)::text AS debtors_count
         FROM customers WHERE branch_id = $1`,
        [branchId],
      ),
      db.query<{ pending_allies: string }>(
        `SELECT COALESCE(SUM(amount_payable), 0)::text AS pending_allies
         FROM ally_settlement_entries
         WHERE branch_id = $1 AND status = 'pending'`,
        [branchId],
      ),
      db.query<{ credit_issued: string }>(
        `SELECT COALESCE(SUM(amount_delta), 0)::text AS credit_issued
         FROM customer_credit_ledger
         WHERE branch_id = $1
           AND entry_type = 'charge'
           AND created_at >= $2::timestamptz
           AND created_at <= $3::timestamptz`,
        [branchId, startIso, endIso],
      ),
    ]);

    const openingFloat = Number(openShiftRes.rows[0]?.opening_float ?? "0");
    const includeOpeningFloatInCash =
      effectivePeriod === "daily" || (effectivePeriod === "date" && selectedDate === todayIsoDate);

    interface MethodMovement {
      id: string;
      kind: "sale_payment" | "credit_repayment" | "expense";
      amount: number;
      label: string;
      detail: string | null;
      category: string | null;
      userName: string;
      createdAt: string;
    }

    const methodMap = new Map<
      string,
      {
        paymentMethodId: string;
        name: string;
        countsAsPhysicalCash: boolean;
        salesIn: number;
        repaymentsIn: number;
        totalIn: number;
        expensesOut: number;
        netFlow: number;
        expectedBalance: number;
        movements: MethodMovement[];
      }
    >();

    for (const pm of pmRes.rows) {
      methodMap.set(pm.id, {
        paymentMethodId: pm.id,
        name: pm.name,
        countsAsPhysicalCash: pm.countsAsPhysicalCash,
        salesIn: 0,
        repaymentsIn: 0,
        totalIn: 0,
        expensesOut: 0,
        netFlow: 0,
        expectedBalance: 0,
        movements: [],
      });
    }

    const ensureMethod = (id: string, name: string, countsAsPhysicalCash: boolean) => {
      let bucket = methodMap.get(id);
      if (!bucket) {
        bucket = {
          paymentMethodId: id,
          name,
          countsAsPhysicalCash,
          salesIn: 0,
          repaymentsIn: 0,
          totalIn: 0,
          expensesOut: 0,
          netFlow: 0,
          expectedBalance: 0,
          movements: [],
        };
        methodMap.set(id, bucket);
      }
      return bucket;
    };

    let totalSalesInflows = 0;
    let totalCreditRepayments = 0;
    let totalOutflows = 0;

    for (const p of paymentsRes.rows) {
      const bucket = ensureMethod(p.paymentMethodId, p.paymentMethodName, p.countsAsPhysicalCash);
      if (p.paymentPurpose === "credit_repayment") {
        bucket.repaymentsIn += p.amount;
        totalCreditRepayments += p.amount;
      } else {
        bucket.salesIn += p.amount;
        totalSalesInflows += p.amount;
      }
      bucket.totalIn += p.amount;
      const label =
        p.paymentPurpose === "credit_repayment"
          ? `Abono cartera · ${p.customerName ?? "Cliente"}`
          : p.tableLabel
            ? `${p.tableLabel}${p.subAccountLabel ? ` · ${p.subAccountLabel}` : ""}`
            : `Barra Rápida${p.subAccountLabel ? ` · ${p.subAccountLabel}` : ""}`;
      bucket.movements.push({
        id: p.id,
        kind: p.paymentPurpose,
        amount: p.amount,
        label,
        detail: p.referenceCode,
        category: null,
        userName: p.userName,
        createdAt: p.createdAt,
      });
    }

    for (const e of expensesRes.rows) {
      const bucket = ensureMethod(e.paymentMethodId, e.paymentMethodName, e.countsAsPhysicalCash);
      bucket.expensesOut += e.amount;
      totalOutflows += e.amount;
      bucket.movements.push({
        id: e.id,
        kind: "expense",
        amount: -e.amount,
        label: e.description,
        detail: null,
        category: e.category,
        userName: e.userName,
        createdAt: e.createdAt,
      });
    }

    const byPaymentMethod = Array.from(methodMap.values()).map((m) => {
      const netFlow = Math.round((m.totalIn - m.expensesOut) * 100) / 100;
      const expectedBalance =
        m.countsAsPhysicalCash && includeOpeningFloatInCash
          ? Math.round((openingFloat + netFlow) * 100) / 100
          : netFlow;
      m.movements.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return {
        ...m,
        salesIn: Math.round(m.salesIn * 100) / 100,
        repaymentsIn: Math.round(m.repaymentsIn * 100) / 100,
        totalIn: Math.round(m.totalIn * 100) / 100,
        expensesOut: Math.round(m.expensesOut * 100) / 100,
        netFlow,
        expectedBalance,
      };
    });

    const totalInflows = Math.round((totalSalesInflows + totalCreditRepayments) * 100) / 100;
    const netCashFlow = Math.round((totalInflows - totalOutflows) * 100) / 100;
    const physicalMethods = byPaymentMethod.filter((m) => m.countsAsPhysicalCash);
    const expectedPhysicalCash =
      Math.round(physicalMethods.reduce((acc, m) => acc + m.expectedBalance, 0) * 100) / 100;

    return {
      isAdminScope: isBranchAdmin,
      period: effectivePeriod,
      periodLabel,
      selectedDate,
      startAt: startIso,
      endAt: endIso,
      salesSummary: {
        grossSales: Number(salesRes.rows[0]?.gross ?? "0"),
        discounts: Number(salesRes.rows[0]?.discounts ?? "0"),
        netSales: Number(salesRes.rows[0]?.net ?? "0"),
        unitsSold: Number(salesRes.rows[0]?.units ?? "0"),
      },
      balance: {
        openingFloat: includeOpeningFloatInCash ? openingFloat : 0,
        totalSalesInflows: Math.round(totalSalesInflows * 100) / 100,
        totalCreditRepayments: Math.round(totalCreditRepayments * 100) / 100,
        totalInflows,
        totalOutflows: Math.round(totalOutflows * 100) / 100,
        netCashFlow,
        expectedPhysicalCash,
        creditIssuedInPeriod: Number(creditIssuedRes.rows[0]?.credit_issued ?? "0"),
      },
      pendingTotals: {
        customerDebtsTotal: Number(debtsRes.rows[0]?.total_debt ?? "0"),
        debtorsCount: Number(debtsRes.rows[0]?.debtors_count ?? "0"),
        alliesPendingTotal: Number(alliesPendingRes.rows[0]?.pending_allies ?? "0"),
      },
      byPaymentMethod,
      expenses: expensesRes.rows,
    };
  });

  // Register operating expense / payment from cash or bank account (e.g. utilities, ice, supplies, staff)
  app.post("/api/v1/branches/:branchId/cash-expenses", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "edit");
    if (!auth) return;

    const parsed = z
      .object({
        paymentMethodId: z.string().uuid(),
        category: z
          .enum(["servicios", "insumos", "nomina", "mantenimiento", "transporte", "otro"])
          .default("otro"),
        description: z.string().min(2).max(200),
        amount: z.number().positive(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_CASH_EXPENSE",
        message: "Ingresa una descripción, monto positivo y medio de pago válido.",
        issues: parsed.error.issues,
      });
    }

    const pmCheck = await db.query(
      `SELECT 1 FROM payment_methods WHERE id = $1 AND branch_id = $2 AND is_active = true`,
      [parsed.data.paymentMethodId, branchId],
    );
    if (pmCheck.rows.length === 0) {
      return reply.status(400).send({ error: "INVALID_PAYMENT_METHOD", message: "Medio de pago no encontrado." });
    }

    const openShiftRes = await db.query<{ id: string }>(
      `SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open' LIMIT 1`,
      [branchId],
    );
    const shiftId = openShiftRes.rows[0]?.id ?? null;

    const id = generateUuidV7();
    await db.query(
      `INSERT INTO cash_expenses (id, branch_id, cash_shift_id, payment_method_id, category, description, amount, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        branchId,
        shiftId,
        parsed.data.paymentMethodId,
        parsed.data.category,
        parsed.data.description.trim(),
        parsed.data.amount,
        auth.userId,
      ],
    );

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "cash",
      timestamp: new Date().toISOString(),
      payload: { action: "EXPENSE_RECORDED", expenseId: id },
    });

    return reply.status(201).send({ id });
  });

  app.delete("/api/v1/branches/:branchId/cash-expenses/:expenseId", async (request, reply) => {
    const { branchId, expenseId } = request.params as { branchId: string; expenseId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "edit");
    if (!auth) return;

    const res = await db.query(
      `DELETE FROM cash_expenses WHERE id = $1 AND branch_id = $2 RETURNING id`,
      [expenseId, branchId],
    );
    if (res.rows.length === 0) {
      return reply.status(404).send({ error: "EXPENSE_NOT_FOUND" });
    }

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "cash",
      timestamp: new Date().toISOString(),
      payload: { action: "EXPENSE_DELETED", expenseId },
    });

    return { deleted: true, id: expenseId };
  });

  // MVP+ Dashboard KPIs with Daily / Weekly / Monthly / All filters, Previous-Period Comparison & Evolution Time-Series
  app.get("/api/v1/branches/:branchId/kpis", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "kpis", "view");
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

