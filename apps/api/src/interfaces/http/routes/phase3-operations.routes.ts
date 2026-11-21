import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateUuidV7 } from "@liquistock/domain";
import { requireBranchRole, requireOrgAdmin } from "../../../infrastructure/auth/auth-guard.js";
import { db, withTransaction } from "../../../infrastructure/db/pool.js";
import { branchHub } from "../../../infrastructure/realtime/branch-hub.js";

const repaymentSchema = z.object({
  paymentMethodId: z.string().uuid(),
  amount: z.number().positive(),
  notes: z.string().max(240).optional().nullable(),
});

function resolvePeriodStart(period: "daily" | "weekly" | "monthly" | "all"): Date {
  const now = new Date();
  if (period === "daily") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  }
  if (period === "weekly") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
  }
  if (period === "monthly") {
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  }
  return new Date(2000, 0, 1);
}

export async function registerPhase3OperationsRoutes(app: FastifyInstance) {
  // ============================================================================
  // 1. CARTERA DE FIADOS: REGISTRAR ABONO + HISTORIAL INMUTABLE DEL CLIENTE
  // ============================================================================
  app.post("/api/v1/branches/:branchId/customers/:customerId/repayments", async (request, reply) => {
    const { branchId, customerId } = request.params as { branchId: string; customerId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier"]);
    if (!auth) return;

    const parsed = repaymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_REPAYMENT",
        message: "Ingresa un monto positivo y un medio de pago válido.",
        issues: parsed.error.issues,
      });
    }

    const d = parsed.data;

    try {
      const result = await withTransaction(async (client) => {
        const custRes = await client.query<{
          id: string;
          full_name: string;
          current_debt: string;
        }>(
          `SELECT id, full_name, current_debt::text
           FROM customers
           WHERE id = $1 AND branch_id = $2
           FOR UPDATE`,
          [customerId, branchId],
        );
        const cust = custRes.rows[0];
        if (!cust) throw new Error("CUSTOMER_NOT_FOUND");

        const currentDebt = Number(cust.current_debt);
        if (currentDebt <= 0) {
          throw new Error("NO_PENDING_DEBT");
        }
        if (d.amount > currentDebt + 0.01) {
          throw new Error("AMOUNT_EXCEEDS_DEBT");
        }

        const shiftRes = await client.query<{ id: string }>(
          `SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open' LIMIT 1`,
          [branchId],
        );
        const shiftId = shiftRes.rows[0]?.id;
        if (!shiftId) throw new Error("NO_OPEN_SHIFT");

        const pmRes = await client.query(
          `SELECT 1 FROM payment_methods WHERE id = $1 AND branch_id = $2 AND is_active = true`,
          [d.paymentMethodId, branchId],
        );
        if (pmRes.rows.length === 0) throw new Error("INVALID_PAYMENT_METHOD");

        const paymentId = generateUuidV7();
        const ledgerId = generateUuidV7();
        const appliedAmount = Math.min(d.amount, currentDebt);
        const nextDebt = Math.max(0, Math.round((currentDebt - appliedAmount) * 100) / 100);

        await client.query(
          `INSERT INTO payments (
             id, branch_id, cash_shift_id, sub_account_id, customer_id,
             payment_method_id, payment_purpose, amount, received_by,
             reference_code, idempotency_key
           ) VALUES (
             $1, $2, $3, NULL, $4,
             $5, 'credit_repayment', $6, $7,
             $8, $1
           )`,
          [
            paymentId,
            branchId,
            shiftId,
            customerId,
            d.paymentMethodId,
            appliedAmount,
            auth.userId,
            d.notes?.trim() || "Abono a cartera",
          ],
        );

        await client.query(`UPDATE customers SET current_debt = $2, updated_at = now() WHERE id = $1`, [
          customerId,
          nextDebt,
        ]);

        await client.query(
          `INSERT INTO customer_credit_ledger (
             id, branch_id, customer_id, cash_shift_id, sub_account_id,
             payment_id, entry_type, amount_delta, balance_after,
             notes, created_by, idempotency_key
           ) VALUES (
             $1, $2, $3, $4, NULL,
             $5, 'repayment', $6, $7,
             $8, $9, $1
           )`,
          [
            ledgerId,
            branchId,
            customerId,
            shiftId,
            paymentId,
            -appliedAmount,
            nextDebt,
            d.notes?.trim() || "Abono recibido en caja",
            auth.userId,
          ],
        );

        return {
          paymentId,
          ledgerId,
          customerId,
          customerName: cust.full_name,
          amountPaid: appliedAmount,
          remainingDebt: nextDebt,
        };
      });

      branchHub.broadcast({
        type: "SHIFT_UPDATED",
        branchId,
        originDeviceId: "cash",
        timestamp: new Date().toISOString(),
        payload: { action: "CREDIT_REPAYMENT", ...result },
      });
      branchHub.broadcast({
        type: "CATALOG_UPDATED",
        branchId,
        originDeviceId: "cash",
        timestamp: new Date().toISOString(),
        payload: { customerId },
      });

      return reply.status(201).send(result);
    } catch (err) {
      const code = err instanceof Error ? err.message : "REPAYMENT_FAILED";
      const map: Record<string, { status: number; message: string }> = {
        CUSTOMER_NOT_FOUND: { status: 404, message: "Cliente no encontrado." },
        NO_PENDING_DEBT: { status: 400, message: "Este cliente no tiene deuda pendiente." },
        AMOUNT_EXCEEDS_DEBT: { status: 400, message: "El abono supera el saldo pendiente del cliente." },
        NO_OPEN_SHIFT: { status: 400, message: "Debes abrir un turno de caja para registrar abonos." },
        INVALID_PAYMENT_METHOD: { status: 400, message: "Medio de pago inválido." },
      };
      const mapped = map[code];
      if (mapped) {
        return reply.status(mapped.status).send({ error: code, message: mapped.message });
      }
      throw err;
    }
  });

  app.get("/api/v1/branches/:branchId/customers/:customerId/ledger", async (request, reply) => {
    const { branchId, customerId } = request.params as { branchId: string; customerId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier"]);
    if (!auth) return;

    const res = await db.query(
      `SELECT ccl.id, ccl.entry_type AS "entryType",
              ccl.amount_delta::float8 AS "amountDelta",
              ccl.balance_after::float8 AS "balanceAfter",
              ccl.notes, ccl.created_at AS "createdAt",
              u.full_name AS "createdByName",
              pm.name AS "paymentMethodName"
       FROM customer_credit_ledger ccl
       JOIN users u ON u.id = ccl.created_by
       LEFT JOIN payments p ON p.id = ccl.payment_id
       LEFT JOIN payment_methods pm ON pm.id = p.payment_method_id
       WHERE ccl.branch_id = $1 AND ccl.customer_id = $2
       ORDER BY ccl.created_at DESC
       LIMIT 50`,
      [branchId, customerId],
    );
    return { entries: res.rows };
  });

  // ============================================================================
  // 2. LIQUIDACIÓN DETALLADA DE ALIADOS (PENDIENTES ACUMULADOS + HISTORIAL)
  // ============================================================================
  app.get("/api/v1/branches/:branchId/allies/settlements", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier"]);
    if (!auth) return;

    const [pendingItemsRes, historyRes] = await Promise.all([
      db.query<{
        id: string;
        allyId: string;
        allyName: string;
        contactPhone: string | null;
        amountPayable: number;
        createdAt: string;
        productName: string;
        presentationName: string;
        quantity: number;
      }>(
        `SELECT ase.id, ase.ally_id AS "allyId", a.name AS "allyName",
                a.contact_phone AS "contactPhone",
                ase.amount_payable::float8 AS "amountPayable",
                ase.created_at AS "createdAt",
                oi.product_name_snap AS "productName",
                oi.presentation_name_snap AS "presentationName",
                oi.quantity
         FROM ally_settlement_entries ase
         JOIN allies a ON a.id = ase.ally_id
         JOIN order_items oi ON oi.id = ase.order_item_id
         WHERE ase.branch_id = $1 AND ase.status = 'pending'
         ORDER BY a.name ASC, ase.created_at DESC`,
        [branchId],
      ),
      db.query<{
        allyId: string;
        allyName: string;
        settledDay: string;
        settledByName: string | null;
        entriesCount: number;
        totalSettled: number;
      }>(
        `SELECT ase.ally_id AS "allyId", a.name AS "allyName",
                to_char(ase.settled_at, 'YYYY-MM-DD HH24:MI') AS "settledDay",
                u.full_name AS "settledByName",
                COUNT(*)::int AS "entriesCount",
                COALESCE(SUM(ase.amount_payable), 0)::float8 AS "totalSettled"
         FROM ally_settlement_entries ase
         JOIN allies a ON a.id = ase.ally_id
         LEFT JOIN users u ON u.id = ase.settled_by
         WHERE ase.branch_id = $1 AND ase.status = 'settled'
         GROUP BY ase.ally_id, a.name, to_char(ase.settled_at, 'YYYY-MM-DD HH24:MI'), u.full_name
         ORDER BY "settledDay" DESC
         LIMIT 30`,
        [branchId],
      ),
    ]);

    const grouped = new Map<
      string,
      {
        allyId: string;
        allyName: string;
        contactPhone: string | null;
        totalPending: number;
        itemsCount: number;
        items: Array<{
          id: string;
          productName: string;
          presentationName: string;
          quantity: number;
          amountPayable: number;
          createdAt: string;
        }>;
      }
    >();

    for (const row of pendingItemsRes.rows) {
      const curr = grouped.get(row.allyId) ?? {
        allyId: row.allyId,
        allyName: row.allyName,
        contactPhone: row.contactPhone,
        totalPending: 0,
        itemsCount: 0,
        items: [],
      };
      curr.totalPending = Math.round((curr.totalPending + row.amountPayable) * 100) / 100;
      curr.itemsCount += row.quantity;
      curr.items.push({
        id: row.id,
        productName: row.productName,
        presentationName: row.presentationName,
        quantity: row.quantity,
        amountPayable: row.amountPayable,
        createdAt: row.createdAt,
      });
      grouped.set(row.allyId, curr);
    }

    return {
      pendingByAlly: Array.from(grouped.values()),
      history: historyRes.rows,
    };
  });

  // ============================================================================
  // 3. HISTORIAL DE CIERRES DE CAJA
  // ============================================================================
  app.get("/api/v1/branches/:branchId/shifts/history", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin", "cashier"]);
    if (!auth) return;

    const res = await db.query(
      `SELECT cs.id, cs.opened_at AS "openedAt", cs.closed_at AS "closedAt",
              uo.full_name AS "openedByName", uc.full_name AS "closedByName",
              cs.opening_float::float8 AS "openingFloat",
              cs.total_gross_sales::float8 AS "totalGrossSales",
              cs.total_discounts::float8 AS "totalDiscounts",
              cs.total_net_sales::float8 AS "totalNetSales",
              cs.total_collected::float8 AS "totalCollected",
              cs.total_credit_issued::float8 AS "totalCreditIssued",
              cs.total_credit_recovered::float8 AS "totalCreditRecovered",
              cs.total_ally_payable::float8 AS "totalAllyPayable",
              cs.expected_physical_cash::float8 AS "expectedPhysicalCash",
              cs.declared_physical_cash::float8 AS "declaredPhysicalCash",
              cs.cash_discrepancy::float8 AS "cashDiscrepancy",
              cs.notes
       FROM cash_shifts cs
       JOIN users uo ON uo.id = cs.opened_by
       LEFT JOIN users uc ON uc.id = cs.closed_by
       WHERE cs.branch_id = $1 AND cs.status = 'closed'
       ORDER BY cs.closed_at DESC
       LIMIT 30`,
      [branchId],
    );

    return { shifts: res.rows };
  });

  // ============================================================================
  // 4. CENTRO DE ALERTAS INTELIGENTES + AUDITORÍA DE CORTESÍAS Y ANULACIONES
  // ============================================================================
  app.get("/api/v1/branches/:branchId/alerts-audit", async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const auth = await requireBranchRole(request, reply, branchId, ["admin"]);
    if (!auth) return;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [lowStockRes, creditAlertsRes, foamRes, cashDiscRes, auditRes] = await Promise.all([
      db.query<{
        id: string;
        name: string;
        baseUnit: string;
        currentStockBase: number;
        minStockBase: number;
        isKeg: boolean;
      }>(
        `SELECT id, name, base_unit AS "baseUnit",
                current_stock_base::float8 AS "currentStockBase",
                min_stock_base::float8 AS "minStockBase",
                is_keg AS "isKeg"
         FROM inventory_items
         WHERE branch_id = $1 AND is_active = true AND current_stock_base <= min_stock_base
         ORDER BY (current_stock_base - min_stock_base) ASC`,
        [branchId],
      ),
      db.query<{
        id: string;
        fullName: string;
        creditStatus: string;
        creditLimit: number | null;
        currentDebt: number;
      }>(
        `SELECT id, full_name AS "fullName", credit_status AS "creditStatus",
                credit_limit::float8 AS "creditLimit", current_debt::float8 AS "currentDebt"
         FROM customers
         WHERE branch_id = $1 AND current_debt > 0
           AND (
             credit_status = 'blacklist_blocked'
             OR (credit_limit IS NOT NULL AND credit_limit > 0 AND current_debt >= credit_limit * 0.8)
           )
         ORDER BY current_debt DESC`,
        [branchId],
      ),
      db.query<{
        id: string;
        name: string;
        nominalBase: number;
        foamLossBase: number;
      }>(
        `SELECT ii.id, ii.name,
                COALESCE(SUM(il.nominal_qty_base), 0)::float8 AS "nominalBase",
                COALESCE(SUM(il.pour_loss_qty_base), 0)::float8 AS "foamLossBase"
         FROM inventory_ledger il
         JOIN inventory_items ii ON ii.id = il.inventory_item_id
         WHERE il.branch_id = $1 AND il.movement_type = 'sale' AND il.created_at >= $2::timestamptz
         GROUP BY ii.id, ii.name
         HAVING SUM(il.nominal_qty_base) > 0 AND (SUM(il.pour_loss_qty_base) / SUM(il.nominal_qty_base)) >= 0.15`,
        [branchId, sevenDaysAgo],
      ),
      db.query<{
        id: string;
        closedAt: string;
        cashDiscrepancy: number;
        closedByName: string | null;
      }>(
        `SELECT cs.id, cs.closed_at AS "closedAt",
                cs.cash_discrepancy::float8 AS "cashDiscrepancy",
                u.full_name AS "closedByName"
         FROM cash_shifts cs
         LEFT JOIN users u ON u.id = cs.closed_by
         WHERE cs.branch_id = $1 AND cs.status = 'closed'
           AND cs.closed_at >= $2::timestamptz
           AND ABS(COALESCE(cs.cash_discrepancy, 0)) >= 5000
         ORDER BY cs.closed_at DESC`,
        [branchId, sevenDaysAgo],
      ),
      db.query<{
        id: string;
        eventType: string;
        productName: string;
        presentationName: string;
        quantity: number;
        originalTotal: number;
        discountAmount: number;
        finalTotal: number;
        reason: string | null;
        actorName: string | null;
        createdAt: string;
      }>(
        `SELECT oi.id,
                CASE
                  WHEN oi.status = 'voided' THEN 'void'
                  WHEN oi.adjustment_reason IS NOT NULL AND oi.line_total = 0 THEN 'courtesy'
                  WHEN oi.adjustment_reason IS NOT NULL THEN 'price_adjustment'
                  ELSE 'promotion_discount'
                END AS "eventType",
                oi.product_name_snap AS "productName",
                oi.presentation_name_snap AS "presentationName",
                oi.quantity,
                (oi.unit_price_snap * oi.quantity)::float8 AS "originalTotal",
                oi.discount_amount::float8 AS "discountAmount",
                oi.line_total::float8 AS "finalTotal",
                COALESCE(oi.void_reason, oi.adjustment_reason, pr.name) AS reason,
                COALESCE(uv.full_name, ua.full_name, uadd.full_name) AS "actorName",
                oi.created_at AS "createdAt"
         FROM order_items oi
         LEFT JOIN promotion_rules pr ON pr.id = oi.promotion_rule_id
         LEFT JOIN users uv ON uv.id = oi.voided_by
         LEFT JOIN users ua ON ua.id = oi.adjusted_by
         LEFT JOIN users uadd ON uadd.id = oi.added_by
         WHERE oi.branch_id = $1
           AND (oi.status = 'voided' OR oi.adjustment_reason IS NOT NULL OR oi.discount_amount > 0)
         ORDER BY oi.created_at DESC
         LIMIT 40`,
        [branchId],
      ),
    ]);

    const alerts: Array<{
      id: string;
      type: "low_stock" | "credit_limit" | "foam_high" | "cash_discrepancy";
      severity: "critical" | "warning" | "info";
      title: string;
      detail: string;
    }> = [];

    for (const item of lowStockRes.rows) {
      const depleted = item.currentStockBase <= 0;
      alerts.push({
        id: `stock-${item.id}`,
        type: "low_stock",
        severity: depleted ? "critical" : "warning",
        title: depleted ? `Agotado: ${item.name}` : `Stock bajo: ${item.name}`,
        detail: `Disponible: ${item.currentStockBase} ${item.baseUnit} (mínimo configurado: ${item.minStockBase} ${item.baseUnit})`,
      });
    }

    for (const c of creditAlertsRes.rows) {
      const isBlack = c.creditStatus === "blacklist_blocked";
      const pct = c.creditLimit ? Math.round((c.currentDebt / c.creditLimit) * 100) : 100;
      alerts.push({
        id: `credit-${c.id}`,
        type: "credit_limit",
        severity: isBlack || pct >= 100 ? "critical" : "warning",
        title: isBlack ? `Deuda en Lista Negra: ${c.fullName}` : `Cupo casi lleno (${pct}%): ${c.fullName}`,
        detail: c.creditLimit
          ? `Deuda actual: $${c.currentDebt.toLocaleString("es-CO")} / Cupo: $${c.creditLimit.toLocaleString("es-CO")}`
          : `Deuda pendiente: $${c.currentDebt.toLocaleString("es-CO")}`,
      });
    }

    for (const f of foamRes.rows) {
      const ratio = Math.round((f.foamLossBase / f.nominalBase) * 1000) / 10;
      alerts.push({
        id: `foam-${f.id}`,
        type: "foam_high",
        severity: ratio >= 22 ? "critical" : "warning",
        title: `Merma de espuma elevada (${ratio}%): ${f.name}`,
        detail: `Últimos 7 días: ${Math.round(f.foamLossBase)} ml perdidos sobre ${Math.round(f.nominalBase)} ml vendidos.`,
      });
    }

    for (const d of cashDiscRes.rows) {
      alerts.push({
        id: `cash-${d.id}`,
        type: "cash_discrepancy",
        severity: Math.abs(d.cashDiscrepancy) >= 20000 ? "critical" : "warning",
        title:
          d.cashDiscrepancy < 0
            ? `Faltante en cierre: -$${Math.abs(d.cashDiscrepancy).toLocaleString("es-CO")}`
            : `Sobrante en cierre: +$${d.cashDiscrepancy.toLocaleString("es-CO")}`,
        detail: `Cerrado por ${d.closedByName ?? "Caja"} el ${new Date(d.closedAt).toLocaleString("es-CO")}`,
      });
    }

    alerts.sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 };
      return rank[a.severity] - rank[b.severity];
    });

    return {
      alerts,
      auditLog: auditRes.rows,
    };
  });

  // ============================================================================
  // 5. COMPARATIVA MULTI-SUCURSAL CONSOLIDADA (ADMIN CON >= 1 SEDE)
  // ============================================================================
  app.get("/api/v1/kpis/multi-branch", async (request, reply) => {
    const auth = await requireOrgAdmin(request, reply);
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

    const startIso = resolvePeriodStart(period).toISOString();
    const adminBranches = auth.memberships.filter((m) => m.role === "admin");
    const branchIds = adminBranches.map((m) => m.branchId);
    if (branchIds.length === 0) {
      return { period, consolidated: null, branches: [] };
    }

    const [salesRes, foamRes, creditRes, lowStockRes] = await Promise.all([
      db.query<{
        branchId: string;
        netSales: number;
        discounts: number;
        unitsSold: number;
        tickets: number;
      }>(
        `SELECT branch_id AS "branchId",
                COALESCE(SUM(line_total), 0)::float8 AS "netSales",
                COALESCE(SUM(discount_amount), 0)::float8 AS "discounts",
                COALESCE(SUM(quantity), 0)::int AS "unitsSold",
                COUNT(DISTINCT sub_account_id)::int AS "tickets"
         FROM order_items
         WHERE branch_id = ANY($1::uuid[]) AND status = 'active' AND created_at >= $2::timestamptz
         GROUP BY branch_id`,
        [branchIds, startIso],
      ),
      db.query<{ branchId: string; foamLossBase: number }>(
        `SELECT branch_id AS "branchId",
                COALESCE(SUM(pour_loss_qty_base), 0)::float8 AS "foamLossBase"
         FROM inventory_ledger
         WHERE branch_id = ANY($1::uuid[]) AND movement_type = 'sale' AND created_at >= $2::timestamptz
         GROUP BY branch_id`,
        [branchIds, startIso],
      ),
      db.query<{ branchId: string; pendingCredit: number }>(
        `SELECT branch_id AS "branchId",
                COALESCE(SUM(current_debt), 0)::float8 AS "pendingCredit"
         FROM customers
         WHERE branch_id = ANY($1::uuid[])
         GROUP BY branch_id`,
        [branchIds],
      ),
      db.query<{ branchId: string; lowStockCount: number }>(
        `SELECT branch_id AS "branchId",
                COUNT(*)::int AS "lowStockCount"
         FROM inventory_items
         WHERE branch_id = ANY($1::uuid[]) AND is_active = true AND current_stock_base <= min_stock_base
         GROUP BY branch_id`,
        [branchIds],
      ),
    ]);

    const salesMap = new Map(salesRes.rows.map((r) => [r.branchId, r]));
    const foamMap = new Map(foamRes.rows.map((r) => [r.branchId, r.foamLossBase]));
    const creditMap = new Map(creditRes.rows.map((r) => [r.branchId, r.pendingCredit]));
    const lowStockMap = new Map(lowStockRes.rows.map((r) => [r.branchId, r.lowStockCount]));

    const rawBranches = adminBranches.map((m) => {
      const s = salesMap.get(m.branchId);
      return {
        branchId: m.branchId,
        branchName: m.branchName,
        organizationName: m.organizationName,
        netSales: s?.netSales ?? 0,
        discounts: s?.discounts ?? 0,
        unitsSold: s?.unitsSold ?? 0,
        tickets: s?.tickets ?? 0,
        foamLossBase: foamMap.get(m.branchId) ?? 0,
        pendingCredit: creditMap.get(m.branchId) ?? 0,
        lowStockCount: lowStockMap.get(m.branchId) ?? 0,
      };
    });

    const totalNetSales = rawBranches.reduce((a, b) => a + b.netSales, 0);
    const consolidated = {
      totalNetSales,
      totalDiscounts: rawBranches.reduce((a, b) => a + b.discounts, 0),
      totalUnitsSold: rawBranches.reduce((a, b) => a + b.unitsSold, 0),
      totalTickets: rawBranches.reduce((a, b) => a + b.tickets, 0),
      totalFoamLossBase: rawBranches.reduce((a, b) => a + b.foamLossBase, 0),
      totalPendingCredit: rawBranches.reduce((a, b) => a + b.pendingCredit, 0),
      totalLowStockCount: rawBranches.reduce((a, b) => a + b.lowStockCount, 0),
    };

    const branches = rawBranches
      .map((b) => ({
        ...b,
        salesSharePct: totalNetSales > 0 ? Math.round((b.netSales / totalNetSales) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.netSales - a.netSales);

    return { period, consolidated, branches };
  });
}

