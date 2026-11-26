import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { calculateCashShiftClosure, generateUuidV7, type ShiftPaymentRecord } from "@liquistock/domain";
import {
  requireBranchAnyModulePermission,
  requireBranchModulePermission,
} from "../../../infrastructure/auth/auth-guard.js";
import { type DbClient, db, withTransaction } from "../../../infrastructure/db/pool.js";
import {
  ensureBranchVaultAccount,
  getBranchOpenShiftStatus,
} from "../../../infrastructure/db/treasury.js";
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

    const [shiftStatus, vaultAccount] = await Promise.all([
      getBranchOpenShiftStatus(branchId),
      ensureBranchVaultAccount(branchId),
    ]);

    if (!shiftStatus.shift) {
      return {
        activeShift: null,
        lastClosedCashLeft: shiftStatus.lastClosedCashLeft,
        vaultAccount,
      };
    }

    const shiftId = shiftStatus.shift.id;
    const [data, expRes, extRes, trOutRes, trInRes, emptyOpenRes] = await Promise.all([
      computeShiftLiveReport(db, branchId, shiftId),
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
        `SELECT ce.id, ce.payment_method_id AS "paymentMethodId", pm.name AS "paymentMethodName",
                pm.counts_as_physical_cash AS "countsAsPhysicalCash", ce.category, ce.description,
                ce.amount::float8 AS amount, ce.created_at AS "createdAt", u.full_name AS "userName"
         FROM cash_expenses ce
         JOIN payment_methods pm ON pm.id = ce.payment_method_id
         JOIN users u ON u.id = ce.created_by
         WHERE ce.cash_shift_id = $1
         ORDER BY ce.created_at DESC`,
        [shiftId],
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
        `SELECT cx.id, cx.payment_method_id AS "paymentMethodId", pm.name AS "paymentMethodName",
                pm.counts_as_physical_cash AS "countsAsPhysicalCash", cx.category, cx.description,
                cx.amount::float8 AS amount, cx.created_at AS "createdAt", u.full_name AS "userName"
         FROM cash_extras cx
         JOIN payment_methods pm ON pm.id = cx.payment_method_id
         JOIN users u ON u.id = cx.created_by
         WHERE cx.cash_shift_id = $1
         ORDER BY cx.created_at DESC`,
        [shiftId],
      ),
      db.query<{ cash_out: string }>(
        `SELECT COALESCE(SUM(ct.amount), 0)::text AS cash_out
         FROM cash_transfers ct
         JOIN payment_methods pm ON pm.id = ct.from_payment_method_id
         WHERE ct.cash_shift_id = $1 AND pm.counts_as_physical_cash = true`,
        [shiftId],
      ),
      db.query<{ cash_in: string }>(
        `SELECT COALESCE(SUM(ct.amount), 0)::text AS cash_in
         FROM cash_transfers ct
         JOIN payment_methods pm ON pm.id = ct.to_payment_method_id
         WHERE ct.cash_shift_id = $1 AND pm.counts_as_physical_cash = true`,
        [shiftId],
      ),
      db.query<{ empty_count: string }>(
        `SELECT COUNT(*)::text AS empty_count
         FROM sub_accounts sa
         JOIN table_sessions ts ON ts.id = sa.table_session_id
         WHERE ts.branch_id = $1 AND ts.status = 'open' AND sa.status = 'open'
           AND sa.total_amount = 0 AND sa.paid_amount = 0 AND sa.credit_amount = 0`,
        [branchId],
      ),
    ]);

    if (!data) {
      return {
        activeShift: null,
        lastClosedCashLeft: shiftStatus.lastClosedCashLeft,
        vaultAccount,
      };
    }

    const physicalExpensesOut = expRes.rows
      .filter((e) => e.countsAsPhysicalCash)
      .reduce((acc, e) => acc + e.amount, 0);
    const physicalExtrasIn = extRes.rows
      .filter((e) => e.countsAsPhysicalCash)
      .reduce((acc, e) => acc + e.amount, 0);
    const physicalTransfersOut = Number(trOutRes.rows[0]?.cash_out ?? "0");
    const physicalTransfersIn = Number(trInRes.rows[0]?.cash_in ?? "0");

    const adjustedExpectedPhysicalCash = Math.max(
      0,
      Math.round(
        (data.report.expectedPhysicalCash +
          physicalExtrasIn +
          physicalTransfersIn -
          physicalExpensesOut -
          physicalTransfersOut) *
          100,
      ) / 100,
    );

    return {
      activeShift: {
        ...data,
        hoursOpen: shiftStatus.hoursOpen,
        isExpired24h: shiftStatus.isExpired24h,
        expectedOpeningFloat: shiftStatus.shift.expectedOpeningFloat,
        openingDiscrepancy: shiftStatus.shift.openingDiscrepancy,
        emptyOpenAccountsCount: Number(emptyOpenRes.rows[0]?.empty_count ?? "0"),
        shiftExpenses: expRes.rows,
        shiftExtras: extRes.rows,
        report: {
          ...data.report,
          expectedPhysicalCash: adjustedExpectedPhysicalCash,
        },
      },
      lastClosedCashLeft: shiftStatus.lastClosedCashLeft,
      vaultAccount,
    };
  });

  app.post("/api/v1/branches/:branchId/shifts/open", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "edit");
    if (!auth) return;
    const body = z
      .object({
        userId: z.string().uuid().optional(),
        openingFloat: z.number().min(0).default(0),
        notes: z.string().max(240).optional().nullable(),
      })
      .safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "INVALID_SHIFT_OPEN" });

    const shiftStatus = await getBranchOpenShiftStatus(branchId);
    if (shiftStatus.shift) {
      return reply.status(409).send({
        error: "SHIFT_ALREADY_OPEN",
        message: "Ya existe un turno abierto en esta sucursal.",
      });
    }

    const expectedOpeningFloat = shiftStatus.lastClosedCashLeft;
    const openingDiscrepancy =
      Math.round((body.data.openingFloat - expectedOpeningFloat) * 100) / 100;
    const id = generateUuidV7();

    await withTransaction(async (client) => {
      await ensureBranchVaultAccount(branchId, client);
      await client.query(
        `INSERT INTO cash_shifts
           (id, branch_id, opened_by, status, opening_float, expected_opening_float, opening_discrepancy, notes)
         VALUES ($1, $2, $3, 'open', $4, $5, $6, $7)`,
        [
          id,
          branchId,
          auth.userId,
          body.data.openingFloat,
          expectedOpeningFloat,
          openingDiscrepancy,
          body.data.notes?.trim() || null,
        ],
      );
      // Seamlessly attach any carried-over active tables to this newly opened shift
      await client.query(
        `UPDATE table_sessions SET cash_shift_id = $2 WHERE branch_id = $1 AND status = 'open'`,
        [branchId, id],
      );
    });

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "pos",
      timestamp: new Date().toISOString(),
      payload: { action: "OPENED", shiftId: id, openingDiscrepancy },
    });

    return reply.status(201).send({ id, expectedOpeningFloat, openingDiscrepancy });
  });

  // Partial / With-Debts Cash Shift Closure (+ Auto-clean $0 open tables + Optional Vault transfer)
  app.post("/api/v1/branches/:branchId/shifts/close", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "edit");
    if (!auth) return;
    const body = z
      .object({
        userId: z.string().uuid().optional(),
        declaredPhysicalCash: z.number().min(0),
        declaredByMethod: z.record(z.number().min(0)).optional(),
        transferToVaultAmount: z.number().min(0).default(0),
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

      // 1) Auto-clean any open $0 tables/sub-accounts (no active items, $0 total, $0 paid, $0 credit)
      const cleanedSubs = await client.query<{ id: string; table_session_id: string }>(
        `UPDATE sub_accounts sa
         SET status = 'voided', closed_at = now(), updated_at = now()
         FROM table_sessions ts
         WHERE sa.table_session_id = ts.id
           AND ts.branch_id = $1
           AND ts.status = 'open'
           AND sa.status = 'open'
           AND sa.total_amount = 0
           AND sa.paid_amount = 0
           AND sa.credit_amount = 0
           AND NOT EXISTS (
             SELECT 1 FROM order_items oi
             WHERE oi.sub_account_id = sa.id AND oi.status = 'active'
           )
         RETURNING sa.id, sa.table_session_id`,
        [branchId],
      );
      const cleanedSessions = await client.query<{ id: string }>(
        `UPDATE table_sessions ts
         SET status = 'closed', closed_at = now()
         WHERE ts.branch_id = $1
           AND ts.status = 'open'
           AND NOT EXISTS (
             SELECT 1 FROM sub_accounts sa
             WHERE sa.table_session_id = ts.id AND sa.status = 'open'
           )
         RETURNING ts.id`,
        [branchId],
      );

      // 2) Compute live shift totals including physical cash extras, expenses, and transfers
      const [live, cashExpRes, cashExtraRes, cashTrOutRes, cashTrInRes, physicalPmRes, vaultAccount] =
        await Promise.all([
          computeShiftLiveReport(client, branchId, shiftId, body.data.declaredPhysicalCash),
          client.query<{ cash_out: string }>(
            `SELECT COALESCE(SUM(ce.amount), 0)::text AS cash_out
             FROM cash_expenses ce
             JOIN payment_methods pm ON pm.id = ce.payment_method_id
             WHERE ce.cash_shift_id = $1 AND pm.counts_as_physical_cash = true`,
            [shiftId],
          ),
          client.query<{ cash_in: string }>(
            `SELECT COALESCE(SUM(cx.amount), 0)::text AS cash_in
             FROM cash_extras cx
             JOIN payment_methods pm ON pm.id = cx.payment_method_id
             WHERE cx.cash_shift_id = $1 AND pm.counts_as_physical_cash = true`,
            [shiftId],
          ),
          client.query<{ cash_out: string }>(
            `SELECT COALESCE(SUM(ct.amount), 0)::text AS cash_out
             FROM cash_transfers ct
             JOIN payment_methods pm ON pm.id = ct.from_payment_method_id
             WHERE ct.cash_shift_id = $1 AND pm.counts_as_physical_cash = true`,
            [shiftId],
          ),
          client.query<{ cash_in: string }>(
            `SELECT COALESCE(SUM(ct.amount), 0)::text AS cash_in
             FROM cash_transfers ct
             JOIN payment_methods pm ON pm.id = ct.to_payment_method_id
             WHERE ct.cash_shift_id = $1 AND pm.counts_as_physical_cash = true`,
            [shiftId],
          ),
          client.query<{ id: string }>(
            `SELECT id FROM payment_methods
             WHERE branch_id = $1 AND counts_as_physical_cash = true AND is_active = true
             ORDER BY sort_order ASC LIMIT 1`,
            [branchId],
          ),
          ensureBranchVaultAccount(branchId, client),
        ]);
      if (!live) throw new Error("NO_OPEN_SHIFT");
      const cashExpensesOut = Number(cashExpRes.rows[0]?.cash_out ?? "0");
      const cashExtrasIn = Number(cashExtraRes.rows[0]?.cash_in ?? "0");
      const cashTrOut = Number(cashTrOutRes.rows[0]?.cash_out ?? "0");
      const cashTrIn = Number(cashTrInRes.rows[0]?.cash_in ?? "0");

      const r = {
        ...live.report,
        expectedPhysicalCash: Math.max(
          0,
          Math.round(
            (live.report.expectedPhysicalCash +
              cashExtrasIn +
              cashTrIn -
              cashExpensesOut -
              cashTrOut) *
              100,
          ) / 100,
        ),
      };
      r.cashDiscrepancy =
        Math.round((body.data.declaredPhysicalCash - r.expectedPhysicalCash) * 100) / 100;

      // 3) Optional transfer from cash register drawer to internal "Bodega" vault
      const transferToVault = Math.min(
        body.data.declaredPhysicalCash,
        Math.max(0, Math.round(body.data.transferToVaultAmount * 100) / 100),
      );
      const closingCashLeft =
        Math.round((body.data.declaredPhysicalCash - transferToVault) * 100) / 100;

      if (transferToVault > 0 && physicalPmRes.rows[0]?.id) {
        await client.query(
          `INSERT INTO cash_transfers
             (id, branch_id, cash_shift_id, from_payment_method_id, to_payment_method_id, amount, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            generateUuidV7(),
            branchId,
            shiftId,
            physicalPmRes.rows[0].id,
            vaultAccount.id,
            transferToVault,
            "Traslado a Bodega al cierre de turno",
            auth.userId,
          ],
        );
      }

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
             transfer_to_vault_amount = $14,
             closing_cash_left = $15,
             notes = $16
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
          transferToVault,
          closingCashLeft,
          body.data.notes ?? null,
        ],
      );

      let nextShiftId: string | null = null;
      if (body.data.openNextShiftFloat !== undefined) {
        nextShiftId = generateUuidV7();
        const nextDiscrepancy =
          Math.round((body.data.openNextShiftFloat - closingCashLeft) * 100) / 100;
        await client.query(
          `INSERT INTO cash_shifts
             (id, branch_id, opened_by, status, opening_float, expected_opening_float, opening_discrepancy)
           VALUES ($1, $2, $3, 'open', $4, $5, $6)`,
          [nextShiftId, branchId, auth.userId, body.data.openNextShiftFloat, closingCashLeft, nextDiscrepancy],
        );
        // Transfer any still-open tables with real consumption seamlessly to the newly opened shift
        await client.query(
          `UPDATE table_sessions SET cash_shift_id = $2 WHERE branch_id = $1 AND status = 'open'`,
          [branchId, nextShiftId],
        );
      }

      return {
        closedShiftId: shiftId,
        nextShiftId,
        transferToVaultAmount: transferToVault,
        closingCashLeft,
        cleanedEmptyAccountsCount: cleanedSubs.rowCount ?? 0,
        cleanedEmptyTablesCount: cleanedSessions.rowCount ?? 0,
        report: r,
      };
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
      extrasRes,
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
        `SELECT cx.id,
                cx.payment_method_id AS "paymentMethodId",
                pm.name AS "paymentMethodName",
                pm.counts_as_physical_cash AS "countsAsPhysicalCash",
                cx.category,
                cx.description,
                cx.amount::float8 AS amount,
                cx.created_at AS "createdAt",
                u.full_name AS "userName"
         FROM cash_extras cx
         JOIN payment_methods pm ON pm.id = cx.payment_method_id
         JOIN users u ON u.id = cx.created_by
         WHERE cx.branch_id = $1
           AND cx.created_at >= $2::timestamptz
           AND cx.created_at <= $3::timestamptz
         ORDER BY cx.created_at DESC
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
      kind: "sale_payment" | "credit_repayment" | "extra_income" | "expense";
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
        extrasIn: number;
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
        extrasIn: 0,
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
          extrasIn: 0,
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
    let totalExtraInflows = 0;
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

    for (const x of extrasRes.rows) {
      const bucket = ensureMethod(x.paymentMethodId, x.paymentMethodName, x.countsAsPhysicalCash);
      bucket.extrasIn += x.amount;
      bucket.totalIn += x.amount;
      totalExtraInflows += x.amount;
      bucket.movements.push({
        id: x.id,
        kind: "extra_income",
        amount: x.amount,
        label: x.description,
        detail: null,
        category: x.category,
        userName: x.userName,
        createdAt: x.createdAt,
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
        extrasIn: Math.round(m.extrasIn * 100) / 100,
        totalIn: Math.round(m.totalIn * 100) / 100,
        expensesOut: Math.round(m.expensesOut * 100) / 100,
        netFlow,
        expectedBalance,
      };
    });

    const totalInflows =
      Math.round((totalSalesInflows + totalCreditRepayments + totalExtraInflows) * 100) / 100;
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
        totalExtraInflows: Math.round(totalExtraInflows * 100) / 100,
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
      extras: extrasRes.rows,
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

  // Register misc / additional cash or bank inflow (cover, glass breakage, space rental, tips, adjustments)
  app.post("/api/v1/branches/:branchId/cash-extras", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "edit");
    if (!auth) return;

    const parsed = z
      .object({
        paymentMethodId: z.string().uuid(),
        category: z
          .enum(["cover", "danos", "propina", "alquiler", "ajuste", "otro"])
          .default("otro"),
        description: z.string().min(2).max(200),
        amount: z.number().positive(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_CASH_EXTRA",
        message: "Ingresa un concepto, monto positivo y medio de pago válido.",
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
      `INSERT INTO cash_extras (id, branch_id, cash_shift_id, payment_method_id, category, description, amount, created_by)
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
      payload: { action: "EXTRA_INCOME_RECORDED", extraId: id },
    });

    return reply.status(201).send({ id });
  });

  app.delete("/api/v1/branches/:branchId/cash-extras/:extraId", async (request, reply) => {
    const { branchId, extraId } = request.params as { branchId: string; extraId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "cash", "edit");
    if (!auth) return;

    const res = await db.query(
      `DELETE FROM cash_extras WHERE id = $1 AND branch_id = $2 RETURNING id`,
      [extraId, branchId],
    );
    if (res.rows.length === 0) {
      return reply.status(404).send({ error: "EXTRA_NOT_FOUND" });
    }

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "cash",
      timestamp: new Date().toISOString(),
      payload: { action: "EXTRA_INCOME_DELETED", extraId },
    });

    return { deleted: true, id: extraId };
  });

  // Edit existing cash expense (e.g. fix wrong payment method, amount, or concept from Stock purchase or manual entry)
  app.patch("/api/v1/branches/:branchId/cash-expenses/:expenseId", async (request, reply) => {
    const { branchId, expenseId } = request.params as { branchId: string; expenseId: string };
    const auth = await requireBranchAnyModulePermission(request, reply, branchId, [
      { moduleId: "finance", requiredLevel: "edit" },
      { moduleId: "cash", requiredLevel: "edit" },
    ]);
    if (!auth) return;

    const parsed = z
      .object({
        paymentMethodId: z.string().uuid().optional(),
        category: z
          .enum(["servicios", "insumos", "nomina", "mantenimiento", "transporte", "otro"])
          .optional(),
        description: z.string().trim().min(2).max(200).optional(),
        amount: z.number().positive().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_EXPENSE_PATCH", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const res = await db.query(
      `UPDATE cash_expenses
       SET payment_method_id = COALESCE($3::uuid, payment_method_id),
           category = COALESCE($4, category),
           description = COALESCE($5, description),
           amount = COALESCE($6, amount)
       WHERE id = $1 AND branch_id = $2
       RETURNING id`,
      [expenseId, branchId, d.paymentMethodId ?? null, d.category ?? null, d.description ?? null, d.amount ?? null],
    );
    if (res.rows.length === 0) return reply.status(404).send({ error: "EXPENSE_NOT_FOUND" });

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "finance",
      timestamp: new Date().toISOString(),
      payload: { action: "EXPENSE_UPDATED", expenseId },
    });
    return { id: expenseId };
  });

  // Edit existing cash extra inflow
  app.patch("/api/v1/branches/:branchId/cash-extras/:extraId", async (request, reply) => {
    const { branchId, extraId } = request.params as { branchId: string; extraId: string };
    const auth = await requireBranchAnyModulePermission(request, reply, branchId, [
      { moduleId: "finance", requiredLevel: "edit" },
      { moduleId: "cash", requiredLevel: "edit" },
    ]);
    if (!auth) return;

    const parsed = z
      .object({
        paymentMethodId: z.string().uuid().optional(),
        category: z.enum(["cover", "danos", "propina", "alquiler", "ajuste", "otro"]).optional(),
        description: z.string().trim().min(2).max(200).optional(),
        amount: z.number().positive().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_EXTRA_PATCH", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const res = await db.query(
      `UPDATE cash_extras
       SET payment_method_id = COALESCE($3::uuid, payment_method_id),
           category = COALESCE($4, category),
           description = COALESCE($5, description),
           amount = COALESCE($6, amount)
       WHERE id = $1 AND branch_id = $2
       RETURNING id`,
      [extraId, branchId, d.paymentMethodId ?? null, d.category ?? null, d.description ?? null, d.amount ?? null],
    );
    if (res.rows.length === 0) return reply.status(404).send({ error: "EXTRA_NOT_FOUND" });

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "finance",
      timestamp: new Date().toISOString(),
      payload: { action: "EXTRA_UPDATED", extraId },
    });
    return { id: extraId };
  });

  // Internal Treasury Transfers (e.g. Efectivo Caja <-> Bodega <-> Nequi)
  app.post("/api/v1/branches/:branchId/cash-transfers", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchAnyModulePermission(request, reply, branchId, [
      { moduleId: "finance", requiredLevel: "edit" },
      { moduleId: "cash", requiredLevel: "edit" },
    ]);
    if (!auth) return;

    const parsed = z
      .object({
        fromPaymentMethodId: z.string().uuid(),
        toPaymentMethodId: z.string().uuid(),
        amount: z.number().positive(),
        notes: z.string().trim().max(200).optional().nullable(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_TRANSFER", issues: parsed.error.issues });
    }
    if (parsed.data.fromPaymentMethodId === parsed.data.toPaymentMethodId) {
      return reply.status(400).send({
        error: "SAME_ACCOUNT_TRANSFER",
        message: "La cuenta origen y la cuenta destino deben ser diferentes.",
      });
    }

    const openShiftRes = await db.query<{ id: string }>(
      `SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open' LIMIT 1`,
      [branchId],
    );
    const id = generateUuidV7();
    await db.query(
      `INSERT INTO cash_transfers
         (id, branch_id, cash_shift_id, from_payment_method_id, to_payment_method_id, amount, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        branchId,
        openShiftRes.rows[0]?.id ?? null,
        parsed.data.fromPaymentMethodId,
        parsed.data.toPaymentMethodId,
        parsed.data.amount,
        parsed.data.notes || "Traslado interno entre cuentas",
        auth.userId,
      ],
    );

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "finance",
      timestamp: new Date().toISOString(),
      payload: { action: "TRANSFER_RECORDED", transferId: id },
    });
    return reply.status(201).send({ id });
  });

  app.patch("/api/v1/branches/:branchId/cash-transfers/:transferId", async (request, reply) => {
    const { branchId, transferId } = request.params as { branchId: string; transferId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "finance", "edit");
    if (!auth) return;

    const parsed = z
      .object({
        fromPaymentMethodId: z.string().uuid().optional(),
        toPaymentMethodId: z.string().uuid().optional(),
        amount: z.number().positive().optional(),
        notes: z.string().trim().max(200).optional().nullable(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_TRANSFER_PATCH", issues: parsed.error.issues });
    }
    const d = parsed.data;
    const res = await db.query(
      `UPDATE cash_transfers
       SET from_payment_method_id = COALESCE($3::uuid, from_payment_method_id),
           to_payment_method_id = COALESCE($4::uuid, to_payment_method_id),
           amount = COALESCE($5, amount),
           notes = COALESCE($6, notes)
       WHERE id = $1 AND branch_id = $2
       RETURNING id`,
      [
        transferId,
        branchId,
        d.fromPaymentMethodId ?? null,
        d.toPaymentMethodId ?? null,
        d.amount ?? null,
        d.notes ?? null,
      ],
    );
    if (res.rows.length === 0) return reply.status(404).send({ error: "TRANSFER_NOT_FOUND" });

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "finance",
      timestamp: new Date().toISOString(),
      payload: { action: "TRANSFER_UPDATED", transferId },
    });
    return { id: transferId };
  });

  app.delete("/api/v1/branches/:branchId/cash-transfers/:transferId", async (request, reply) => {
    const { branchId, transferId } = request.params as { branchId: string; transferId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "finance", "edit");
    if (!auth) return;

    const res = await db.query(
      `DELETE FROM cash_transfers WHERE id = $1 AND branch_id = $2 RETURNING id`,
      [transferId, branchId],
    );
    if (res.rows.length === 0) return reply.status(404).send({ error: "TRANSFER_NOT_FOUND" });

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "finance",
      timestamp: new Date().toISOString(),
      payload: { action: "TRANSFER_DELETED", transferId },
    });
    return { deleted: true, id: transferId };
  });

  // ============================================================================
  // LIBRO FINANCIERO DE INGRESOS Y EGRESOS (MÓDULO "FINANCE" — ADMIN / ENCARGADO)
  // Muestra saldos reales acumulados por cuenta (Efectivo, Bodega, Nequi...) +
  // ventas del periodo + histórico unificado y editable.
  // ============================================================================
  app.get("/api/v1/branches/:branchId/finance/ledger", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "finance", "view");
    if (!auth) return;

    await ensureBranchVaultAccount(branchId);

    const query = request.query as { period?: string; date?: string; accountId?: string };
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const todayIso = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

    let startAt: Date;
    let endAt: Date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    let effectivePeriod: "daily" | "weekly" | "monthly" | "all" | "date" = "daily";
    let periodLabel = `Hoy (${todayIso})`;
    let selectedDate: string | null = todayIso;

    if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
      const [yy, mm, dd] = query.date.split("-").map(Number);
      startAt = new Date(yy!, mm! - 1, dd!, 0, 0, 0, 0);
      endAt = new Date(yy!, mm! - 1, dd!, 23, 59, 59, 999);
      effectivePeriod = "date";
      selectedDate = query.date;
      periodLabel = query.date === todayIso ? `Hoy (${query.date})` : `Día ${query.date}`;
    } else if (query.period === "weekly") {
      startAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
      effectivePeriod = "weekly";
      periodLabel = "Últimos 7 días";
      selectedDate = null;
    } else if (query.period === "monthly") {
      startAt = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      effectivePeriod = "monthly";
      periodLabel = "Este mes";
      selectedDate = null;
    } else if (query.period === "all") {
      startAt = new Date(2000, 0, 1, 0, 0, 0, 0);
      effectivePeriod = "all";
      periodLabel = "Histórico total";
      selectedDate = null;
    } else {
      startAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      effectivePeriod = "daily";
      periodLabel = `Hoy (${todayIso})`;
      selectedDate = todayIso;
    }

    const startIso = startAt.toISOString();
    const endIso = endAt.toISOString();

    const [
      accountsRes,
      salesPeriodRes,
      allTimePaymentsRes,
      allTimeExtrasRes,
      allTimeExpensesRes,
      allTimeTransfersOutRes,
      allTimeTransfersInRes,
      firstShiftFloatRes,
      periodPaymentsRes,
      periodExtrasRes,
      periodExpensesRes,
      periodTransfersRes,
      payablesSummaryRes,
      debtsSummaryRes,
      alliesPendingRes,
    ] = await Promise.all([
      db.query<{
        id: string;
        name: string;
        code: string;
        countsAsPhysicalCash: boolean;
        isInternalVault: boolean;
      }>(
        `SELECT id, name, code,
                counts_as_physical_cash AS "countsAsPhysicalCash",
                is_internal_vault AS "isInternalVault"
         FROM payment_methods
         WHERE branch_id = $1 AND is_active = true
         ORDER BY is_internal_vault ASC, sort_order ASC, name ASC`,
        [branchId],
      ),
      db.query<{ gross: string; discounts: string; net: string; units: string }>(
        `SELECT COALESCE(SUM(oi.unit_price_snap * oi.quantity), 0)::text AS gross,
                COALESCE(SUM(oi.discount_amount), 0)::text AS discounts,
                COALESCE(SUM(oi.line_total), 0)::text AS net,
                COALESCE(SUM(oi.quantity), 0)::text AS units
         FROM order_items oi
         JOIN sub_accounts sa ON sa.id = oi.sub_account_id
         WHERE oi.branch_id = $1 AND oi.status = 'active' AND sa.status <> 'voided'
           AND oi.created_at >= $2::timestamptz AND oi.created_at <= $3::timestamptz`,
        [branchId, startIso, endIso],
      ),
      db.query<{ pm_id: string; total: string }>(
        `SELECT payment_method_id AS pm_id, COALESCE(SUM(amount), 0)::text AS total
         FROM payments WHERE branch_id = $1 GROUP BY payment_method_id`,
        [branchId],
      ),
      db.query<{ pm_id: string; total: string }>(
        `SELECT payment_method_id AS pm_id, COALESCE(SUM(amount), 0)::text AS total
         FROM cash_extras WHERE branch_id = $1 GROUP BY payment_method_id`,
        [branchId],
      ),
      db.query<{ pm_id: string; total: string }>(
        `SELECT payment_method_id AS pm_id, COALESCE(SUM(amount), 0)::text AS total
         FROM cash_expenses WHERE branch_id = $1 GROUP BY payment_method_id`,
        [branchId],
      ),
      db.query<{ pm_id: string; total: string }>(
        `SELECT from_payment_method_id AS pm_id, COALESCE(SUM(amount), 0)::text AS total
         FROM cash_transfers WHERE branch_id = $1 GROUP BY from_payment_method_id`,
        [branchId],
      ),
      db.query<{ pm_id: string; total: string }>(
        `SELECT to_payment_method_id AS pm_id, COALESCE(SUM(amount), 0)::text AS total
         FROM cash_transfers WHERE branch_id = $1 GROUP BY to_payment_method_id`,
        [branchId],
      ),
      db.query<{ opening_float: string }>(
        `SELECT opening_float::text FROM cash_shifts
         WHERE branch_id = $1 ORDER BY opened_at ASC LIMIT 1`,
        [branchId],
      ),
      db.query<{
        id: string;
        paymentMethodId: string;
        paymentMethodName: string;
        paymentPurpose: "sale_payment" | "credit_repayment";
        amount: number;
        createdAt: string;
        userName: string;
        customerName: string | null;
        tableLabel: string | null;
      }>(
        `SELECT p.id, p.payment_method_id AS "paymentMethodId", pm.name AS "paymentMethodName",
                p.payment_purpose AS "paymentPurpose", p.amount::float8 AS amount,
                p.created_at AS "createdAt", u.full_name AS "userName",
                c.full_name AS "customerName", dt.label AS "tableLabel"
         FROM payments p
         JOIN payment_methods pm ON pm.id = p.payment_method_id
         JOIN users u ON u.id = p.received_by
         LEFT JOIN customers c ON c.id = p.customer_id
         LEFT JOIN sub_accounts sa ON sa.id = p.sub_account_id
         LEFT JOIN table_sessions ts ON ts.id = sa.table_session_id
         LEFT JOIN dining_tables dt ON dt.id = ts.dining_table_id
         WHERE p.branch_id = $1 AND p.created_at >= $2::timestamptz AND p.created_at <= $3::timestamptz
         ORDER BY p.created_at DESC LIMIT 400`,
        [branchId, startIso, endIso],
      ),
      db.query<{
        id: string;
        paymentMethodId: string;
        paymentMethodName: string;
        category: string;
        description: string;
        amount: number;
        createdAt: string;
        userName: string;
      }>(
        `SELECT cx.id, cx.payment_method_id AS "paymentMethodId", pm.name AS "paymentMethodName",
                cx.category, cx.description, cx.amount::float8 AS amount,
                cx.created_at AS "createdAt", u.full_name AS "userName"
         FROM cash_extras cx
         JOIN payment_methods pm ON pm.id = cx.payment_method_id
         JOIN users u ON u.id = cx.created_by
         WHERE cx.branch_id = $1 AND cx.created_at >= $2::timestamptz AND cx.created_at <= $3::timestamptz
         ORDER BY cx.created_at DESC LIMIT 300`,
        [branchId, startIso, endIso],
      ),
      db.query<{
        id: string;
        paymentMethodId: string;
        paymentMethodName: string;
        category: string;
        description: string;
        amount: number;
        referenceType: string | null;
        createdAt: string;
        userName: string;
      }>(
        `SELECT ce.id, ce.payment_method_id AS "paymentMethodId", pm.name AS "paymentMethodName",
                ce.category, ce.description, ce.amount::float8 AS amount,
                ce.reference_type AS "referenceType",
                ce.created_at AS "createdAt", u.full_name AS "userName"
         FROM cash_expenses ce
         JOIN payment_methods pm ON pm.id = ce.payment_method_id
         JOIN users u ON u.id = ce.created_by
         WHERE ce.branch_id = $1 AND ce.created_at >= $2::timestamptz AND ce.created_at <= $3::timestamptz
         ORDER BY ce.created_at DESC LIMIT 300`,
        [branchId, startIso, endIso],
      ),
      db.query<{
        id: string;
        fromPaymentMethodId: string;
        fromAccountName: string;
        toPaymentMethodId: string;
        toAccountName: string;
        amount: number;
        notes: string | null;
        createdAt: string;
        userName: string;
      }>(
        `SELECT ct.id,
                ct.from_payment_method_id AS "fromPaymentMethodId",
                pmf.name AS "fromAccountName",
                ct.to_payment_method_id AS "toPaymentMethodId",
                pmt.name AS "toAccountName",
                ct.amount::float8 AS amount,
                ct.notes,
                ct.created_at AS "createdAt",
                u.full_name AS "userName"
         FROM cash_transfers ct
         JOIN payment_methods pmf ON pmf.id = ct.from_payment_method_id
         JOIN payment_methods pmt ON pmt.id = ct.to_payment_method_id
         JOIN users u ON u.id = ct.created_by
         WHERE ct.branch_id = $1 AND ct.created_at >= $2::timestamptz AND ct.created_at <= $3::timestamptz
         ORDER BY ct.created_at DESC LIMIT 200`,
        [branchId, startIso, endIso],
      ),
      db.query<{ pending_suppliers: string; open_count: string }>(
        `SELECT COALESCE(SUM(GREATEST(0, total_amount - paid_amount)), 0)::text AS pending_suppliers,
                COUNT(*) FILTER (WHERE status <> 'paid')::text AS open_count
         FROM supplier_payables WHERE branch_id = $1`,
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
         FROM ally_settlement_entries WHERE branch_id = $1 AND status = 'pending'`,
        [branchId],
      ),
    ]);

    const toMap = (rows: Array<{ pm_id: string; total: string }>) =>
      new Map(rows.map((r) => [r.pm_id, Number(r.total)]));
    const payAllMap = toMap(allTimePaymentsRes.rows);
    const extAllMap = toMap(allTimeExtrasRes.rows);
    const expAllMap = toMap(allTimeExpensesRes.rows);
    const trOutAllMap = toMap(allTimeTransfersOutRes.rows);
    const trInAllMap = toMap(allTimeTransfersInRes.rows);
    const initialCashFloat = Number(firstShiftFloatRes.rows[0]?.opening_float ?? "0");
    let assignedInitialFloat = false;

    const accountBalances = accountsRes.rows.map((acc) => {
      const seedFloat = acc.countsAsPhysicalCash && !assignedInitialFloat ? initialCashFloat : 0;
      if (acc.countsAsPhysicalCash && !assignedInitialFloat) assignedInitialFloat = true;
      const totalIn =
        seedFloat + (payAllMap.get(acc.id) ?? 0) + (extAllMap.get(acc.id) ?? 0) + (trInAllMap.get(acc.id) ?? 0);
      const totalOut = (expAllMap.get(acc.id) ?? 0) + (trOutAllMap.get(acc.id) ?? 0);
      const currentBalance = Math.round((totalIn - totalOut) * 100) / 100;
      return {
        ...acc,
        currentBalance,
      };
    });

    interface FinanceEntry {
      id: string;
      entryType: "sale_payment" | "credit_repayment" | "extra_income" | "expense" | "transfer";
      editable: boolean;
      amount: number;
      direction: "in" | "out" | "transfer";
      paymentMethodId: string;
      paymentMethodName: string;
      toPaymentMethodId?: string | null;
      toPaymentMethodName?: string | null;
      category: string | null;
      referenceType?: string | null;
      description: string;
      userName: string;
      createdAt: string;
    }

    const entries: FinanceEntry[] = [];
    let periodInflows = 0;
    let periodOutflows = 0;

    for (const p of periodPaymentsRes.rows) {
      periodInflows += p.amount;
      entries.push({
        id: p.id,
        entryType: p.paymentPurpose,
        editable: false,
        amount: p.amount,
        direction: "in",
        paymentMethodId: p.paymentMethodId,
        paymentMethodName: p.paymentMethodName,
        category: p.paymentPurpose === "credit_repayment" ? "abono" : "venta",
        description:
          p.paymentPurpose === "credit_repayment"
            ? `Abono cartera · ${p.customerName ?? "Cliente"}`
            : `Venta POS · ${p.tableLabel ?? "Barra Rápida"}`,
        userName: p.userName,
        createdAt: p.createdAt,
      });
    }
    for (const x of periodExtrasRes.rows) {
      periodInflows += x.amount;
      entries.push({
        id: x.id,
        entryType: "extra_income",
        editable: true,
        amount: x.amount,
        direction: "in",
        paymentMethodId: x.paymentMethodId,
        paymentMethodName: x.paymentMethodName,
        category: x.category,
        description: x.description,
        userName: x.userName,
        createdAt: x.createdAt,
      });
    }
    for (const e of periodExpensesRes.rows) {
      periodOutflows += e.amount;
      entries.push({
        id: e.id,
        entryType: "expense",
        editable: true,
        amount: e.amount,
        direction: "out",
        paymentMethodId: e.paymentMethodId,
        paymentMethodName: e.paymentMethodName,
        category: e.category,
        referenceType: e.referenceType,
        description: e.description,
        userName: e.userName,
        createdAt: e.createdAt,
      });
    }
    for (const t of periodTransfersRes.rows) {
      entries.push({
        id: t.id,
        entryType: "transfer",
        editable: true,
        amount: t.amount,
        direction: "transfer",
        paymentMethodId: t.fromPaymentMethodId,
        paymentMethodName: t.fromAccountName,
        toPaymentMethodId: t.toPaymentMethodId,
        toPaymentMethodName: t.toAccountName,
        category: "traslado",
        description: t.notes || `${t.fromAccountName} → ${t.toAccountName}`,
        userName: t.userName,
        createdAt: t.createdAt,
      });
    }

    entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const filteredEntries = query.accountId
      ? entries.filter(
          (e) => e.paymentMethodId === query.accountId || e.toPaymentMethodId === query.accountId,
        )
      : entries;

    return {
      period: effectivePeriod,
      periodLabel,
      selectedDate,
      salesSummary: {
        grossSales: Number(salesPeriodRes.rows[0]?.gross ?? "0"),
        discounts: Number(salesPeriodRes.rows[0]?.discounts ?? "0"),
        netSales: Number(salesPeriodRes.rows[0]?.net ?? "0"),
        unitsSold: Number(salesPeriodRes.rows[0]?.units ?? "0"),
      },
      periodBalance: {
        totalInflows: Math.round(periodInflows * 100) / 100,
        totalOutflows: Math.round(periodOutflows * 100) / 100,
        netFlow: Math.round((periodInflows - periodOutflows) * 100) / 100,
      },
      accountBalances,
      totalTreasuryBalance:
        Math.round(accountBalances.reduce((acc, a) => acc + a.currentBalance, 0) * 100) / 100,
      dualCreditSummary: {
        receivablesFromCustomers: Number(debtsSummaryRes.rows[0]?.total_debt ?? "0"),
        debtorsCount: Number(debtsSummaryRes.rows[0]?.debtors_count ?? "0"),
        payablesToSuppliers: Number(payablesSummaryRes.rows[0]?.pending_suppliers ?? "0"),
        openSuppliersCount: Number(payablesSummaryRes.rows[0]?.open_count ?? "0"),
        payablesToAllies: Number(alliesPendingRes.rows[0]?.pending_allies ?? "0"),
      },
      entries: filteredEntries,
    };
  });

  // ============================================================================
  // CUENTAS POR PAGAR A PROVEEDORES ("DEBEMOS" EN CARTERA DUAL)
  // ============================================================================
  app.get("/api/v1/branches/:branchId/supplier-payables", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchAnyModulePermission(request, reply, branchId, [
      { moduleId: "cash", requiredLevel: "view" },
      { moduleId: "finance", requiredLevel: "view" },
    ]);
    if (!auth) return;

    const [payablesRes, paymentsRes] = await Promise.all([
      db.query<{
        id: string;
        supplierName: string;
        description: string;
        inventoryItemId: string | null;
        totalAmount: number;
        paidAmount: number;
        remainingAmount: number;
        status: "pending" | "partial" | "paid";
        createdByName: string;
        createdAt: string;
      }>(
        `SELECT sp.id, sp.supplier_name AS "supplierName", sp.description,
                sp.inventory_item_id AS "inventoryItemId",
                sp.total_amount::float8 AS "totalAmount",
                sp.paid_amount::float8 AS "paidAmount",
                GREATEST(0, sp.total_amount - sp.paid_amount)::float8 AS "remainingAmount",
                sp.status,
                u.full_name AS "createdByName",
                sp.created_at AS "createdAt"
         FROM supplier_payables sp
         JOIN users u ON u.id = sp.created_by
         WHERE sp.branch_id = $1
         ORDER BY CASE sp.status WHEN 'paid' THEN 1 ELSE 0 END ASC, sp.created_at DESC
         LIMIT 200`,
        [branchId],
      ),
      db.query<{
        id: string;
        supplierPayableId: string;
        paymentMethodName: string;
        amount: number;
        notes: string | null;
        createdByName: string;
        createdAt: string;
      }>(
        `SELECT spm.id, spm.supplier_payable_id AS "supplierPayableId",
                pm.name AS "paymentMethodName",
                spm.amount::float8 AS amount,
                spm.notes,
                u.full_name AS "createdByName",
                spm.created_at AS "createdAt"
         FROM supplier_payments spm
         JOIN payment_methods pm ON pm.id = spm.payment_method_id
         JOIN users u ON u.id = spm.created_by
         WHERE spm.branch_id = $1
         ORDER BY spm.created_at DESC
         LIMIT 300`,
        [branchId],
      ),
    ]);

    const byPayable = new Map<string, typeof paymentsRes.rows>();
    for (const p of paymentsRes.rows) {
      const list = byPayable.get(p.supplierPayableId) ?? [];
      list.push(p);
      byPayable.set(p.supplierPayableId, list);
    }

    return {
      payables: payablesRes.rows.map((row) => ({
        ...row,
        payments: byPayable.get(row.id) ?? [],
      })),
    };
  });

  app.post("/api/v1/branches/:branchId/supplier-payables", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchAnyModulePermission(request, reply, branchId, [
      { moduleId: "finance", requiredLevel: "edit" },
      { moduleId: "cash", requiredLevel: "edit" },
    ]);
    if (!auth) return;

    const parsed = z
      .object({
        supplierName: z.string().trim().min(2).max(120),
        description: z.string().trim().min(2).max(200),
        totalAmount: z.number().positive(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_PAYABLE", issues: parsed.error.issues });
    }

    const id = generateUuidV7();
    await db.query(
      `INSERT INTO supplier_payables
         (id, branch_id, supplier_name, description, total_amount, paid_amount, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 0, 'pending', $6)`,
      [id, branchId, parsed.data.supplierName, parsed.data.description, parsed.data.totalAmount, auth.userId],
    );
    return reply.status(201).send({ id });
  });

  app.post("/api/v1/branches/:branchId/supplier-payables/:payableId/payments", async (request, reply) => {
    const { branchId, payableId } = request.params as { branchId: string; payableId: string };
    const auth = await requireBranchAnyModulePermission(request, reply, branchId, [
      { moduleId: "finance", requiredLevel: "edit" },
      { moduleId: "cash", requiredLevel: "edit" },
    ]);
    if (!auth) return;

    const parsed = z
      .object({
        paymentMethodId: z.string().uuid(),
        amount: z.number().positive(),
        notes: z.string().trim().max(200).optional().nullable(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_SUPPLIER_PAYMENT", issues: parsed.error.issues });
    }

    const result = await withTransaction(async (client) => {
      const pRes = await client.query<{
        id: string;
        supplier_name: string;
        description: string;
        total_amount: string;
        paid_amount: string;
      }>(
        `SELECT id, supplier_name, description, total_amount::text, paid_amount::text
         FROM supplier_payables WHERE id = $1 AND branch_id = $2 FOR UPDATE`,
        [payableId, branchId],
      );
      const payable = pRes.rows[0];
      if (!payable) throw new Error("PAYABLE_NOT_FOUND");

      const total = Number(payable.total_amount);
      const alreadyPaid = Number(payable.paid_amount);
      const remainingBefore = Math.max(0, total - alreadyPaid);
      if (remainingBefore <= 0.01) throw new Error("PAYABLE_ALREADY_SETTLED");

      const actualPay = Math.min(remainingBefore, Math.round(parsed.data.amount * 100) / 100);
      const nextPaid = Math.round((alreadyPaid + actualPay) * 100) / 100;
      const nextRemaining = Math.max(0, Math.round((total - nextPaid) * 100) / 100);
      const nextStatus = nextRemaining <= 0.01 ? "paid" : "partial";

      const openShiftRes = await client.query<{ id: string }>(
        `SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open' LIMIT 1`,
        [branchId],
      );

      const expenseId = generateUuidV7();
      await client.query(
        `INSERT INTO cash_expenses
           (id, branch_id, cash_shift_id, payment_method_id, category, description, amount, reference_type, reference_id, created_by)
         VALUES ($1, $2, $3, $4, 'insumos', $5, $6, 'supplier_payment', $7, $8)`,
        [
          expenseId,
          branchId,
          openShiftRes.rows[0]?.id ?? null,
          parsed.data.paymentMethodId,
          `Pago proveedor (${payable.supplier_name}): ${payable.description}`.slice(0, 200),
          actualPay,
          payableId,
          auth.userId,
        ],
      );

      const spId = generateUuidV7();
      await client.query(
        `INSERT INTO supplier_payments
           (id, branch_id, supplier_payable_id, payment_method_id, cash_expense_id, amount, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          spId,
          branchId,
          payableId,
          parsed.data.paymentMethodId,
          expenseId,
          actualPay,
          parsed.data.notes || null,
          auth.userId,
        ],
      );

      await client.query(
        `UPDATE supplier_payables
         SET paid_amount = $2, status = $3, updated_at = now()
         WHERE id = $1`,
        [payableId, nextPaid, nextStatus],
      );

      return { id: spId, cashExpenseId: expenseId, amountPaid: actualPay, remainingAmount: nextRemaining, status: nextStatus };
    });

    branchHub.broadcast({
      type: "SHIFT_UPDATED",
      branchId,
      originDeviceId: "finance",
      timestamp: new Date().toISOString(),
      payload: { action: "SUPPLIER_PAYMENT_RECORDED", ...result },
    });
    return reply.status(201).send(result);
  });

  app.delete("/api/v1/branches/:branchId/supplier-payables/:payableId", async (request, reply) => {
    const { branchId, payableId } = request.params as { branchId: string; payableId: string };
    const auth = await requireBranchModulePermission(request, reply, branchId, "finance", "edit");
    if (!auth) return;

    const res = await db.query(
      `DELETE FROM supplier_payables WHERE id = $1 AND branch_id = $2 RETURNING id`,
      [payableId, branchId],
    );
    if (res.rows.length === 0) return reply.status(404).send({ error: "PAYABLE_NOT_FOUND" });
    return { deleted: true, id: payableId };
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
           COALESCE(c.id::text, 'custom-extras') AS "categoryId",
           COALESCE(c.name, 'Cargos adicionales') AS "categoryName",
           SUM(oi.quantity)::int AS "unitsSold",
           SUM(oi.line_total)::float8 AS "revenue"
         FROM order_items oi
         LEFT JOIN menu_products mp ON mp.id = oi.menu_product_id
         LEFT JOIN categories c ON c.id = mp.category_id
         WHERE oi.branch_id = $1 AND oi.status = 'active' AND oi.created_at >= $2::timestamptz
         GROUP BY COALESCE(c.id::text, 'custom-extras'), COALESCE(c.name, 'Cargos adicionales')
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

