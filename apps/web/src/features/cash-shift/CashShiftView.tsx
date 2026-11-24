import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  Banknote,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  CreditCard,
  Eye,
  Handshake,
  History,
  Lock,
  Plus,
  RefreshCw,
  Scale,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import type { CashShiftClosureReport } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { useFeedback } from "../../shared/components/FeedbackProvider.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

type StoreType = ReturnType<typeof useLiquiStock>;
type CashTab = "current" | "credit" | "allies" | "history";
type AdminCashPeriod = "monthly" | "daily" | "weekly" | "all" | "date";
type ExpenseCategory = "servicios" | "insumos" | "nomina" | "mantenimiento" | "transporte" | "otro";

const EXPENSE_CATEGORIES: Array<{ id: ExpenseCategory; label: string }> = [
  { id: "servicios", label: "Servicios (luz/agua/internet)" },
  { id: "insumos", label: "Insumos / Hielo / Limones" },
  { id: "nomina", label: "Turnos / Nómina / DJ" },
  { id: "mantenimiento", label: "Aseo / Mantenimiento" },
  { id: "transporte", label: "Domicilio / Transporte" },
  { id: "otro", label: "Otro pago" },
];

const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  servicios: "Servicios",
  insumos: "Insumos",
  nomina: "Turnos / Nómina",
  mantenimiento: "Mantenimiento",
  transporte: "Transporte",
  otro: "Otro pago",
};

interface CashFlowMethodMovement {
  id: string;
  kind: "sale_payment" | "credit_repayment" | "expense";
  amount: number;
  label: string;
  detail: string | null;
  category: string | null;
  userName: string;
  createdAt: string;
}

interface CashFlowMethodBucket {
  paymentMethodId: string;
  name: string;
  countsAsPhysicalCash: boolean;
  salesIn: number;
  repaymentsIn: number;
  totalIn: number;
  expensesOut: number;
  netFlow: number;
  expectedBalance: number;
  movements: CashFlowMethodMovement[];
}

interface CashFlowExpenseRow {
  id: string;
  paymentMethodId: string;
  paymentMethodName: string;
  category: string;
  description: string;
  amount: number;
  createdAt: string;
  userName: string;
}

interface CashFlowResponse {
  isAdminScope: boolean;
  period: "daily" | "weekly" | "monthly" | "all" | "date";
  periodLabel: string;
  selectedDate: string | null;
  salesSummary: {
    grossSales: number;
    discounts: number;
    netSales: number;
    unitsSold: number;
  };
  balance: {
    openingFloat: number;
    totalSalesInflows: number;
    totalCreditRepayments: number;
    totalInflows: number;
    totalOutflows: number;
    netCashFlow: number;
    expectedPhysicalCash: number;
    creditIssuedInPeriod: number;
  };
  pendingTotals: {
    customerDebtsTotal: number;
    debtorsCount: number;
    alliesPendingTotal: number;
  };
  byPaymentMethod: CashFlowMethodBucket[];
  expenses: CashFlowExpenseRow[];
}

interface CurrentShiftResponse {
  activeShift: {
    shiftId: string;
    status: string;
    openedAt: string;
    openTablesCount: number;
    openTablesPendingAmount: number;
    report: CashShiftClosureReport;
  } | null;
}

interface CustomerLedgerRow {
  id: string;
  entryType: "charge" | "repayment" | "adjustment";
  amountDelta: number;
  balanceAfter: number;
  notes: string | null;
  createdAt: string;
  createdByName: string;
  paymentMethodName: string | null;
}

interface AllyPendingGroup {
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

interface AllySettlementHistoryRow {
  allyId: string;
  allyName: string;
  settledDay: string;
  settledByName: string | null;
  entriesCount: number;
  totalSettled: number;
}

interface ClosedShiftRow {
  id: string;
  openedAt: string;
  closedAt: string;
  openedByName: string;
  closedByName: string | null;
  openingFloat: number;
  totalNetSales: number;
  totalCollected: number;
  totalCreditIssued: number;
  totalCreditRecovered: number;
  totalAllyPayable: number;
  expectedPhysicalCash: number;
  declaredPhysicalCash: number;
  cashDiscrepancy: number;
  notes: string | null;
}

function getTodayDateString(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function CashShiftView({
  store,
  branchId,
  canEdit = true,
  isAdmin = false,
}: {
  store: StoreType;
  branchId: string;
  canEdit?: boolean;
  isAdmin?: boolean;
}) {
  const { toast } = useFeedback();
  const [tab, setTab] = useState<CashTab>("current");
  const [adminPeriod, setAdminPeriod] = useState<AdminCashPeriod>(isAdmin ? "monthly" : "daily");
  const [adminDate, setAdminDate] = useState<string>(getTodayDateString());
  const [cashFlow, setCashFlow] = useState<CashFlowResponse | null>(null);
  const [shiftData, setShiftData] = useState<CurrentShiftResponse["activeShift"]>(null);
  const [declaredByMethod, setDeclaredByMethod] = useState<Record<string, string>>({});
  const [expandedMethods, setExpandedMethods] = useState<Record<string, boolean>>({});
  const [nextShiftFloat, setNextShiftFloat] = useState("200000");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [closedSummary, setClosedSummary] = useState<CashShiftClosureReport | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Registro de pagos / egresos de caja (servicios, hielo, turnos, etc.)
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expenseCategory, setExpenseCategory] = useState<ExpenseCategory>("servicios");
  const [expenseMethodId, setExpenseMethodId] = useState("");
  const [expenseDesc, setExpenseDesc] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");

  // Cartera & Abonos state
  const [repayCustomerId, setRepayCustomerId] = useState<string | null>(null);
  const [repayAmount, setRepayAmount] = useState("");
  const [repayMethodId, setRepayMethodId] = useState("");
  const [repayNotes, setRepayNotes] = useState("");
  const [ledgerCustomerId, setLedgerCustomerId] = useState<string | null>(null);
  const [ledgerRows, setLedgerRows] = useState<CustomerLedgerRow[]>([]);

  // Aliados & Historial state
  const [allyPending, setAllyPending] = useState<AllyPendingGroup[]>([]);
  const [allyHistory, setAllyHistory] = useState<AllySettlementHistoryRow[]>([]);
  const [shiftHistory, setShiftHistory] = useState<ClosedShiftRow[]>([]);

  const notify = (kind: "ok" | "err", text: string) => {
    toast({
      kind: kind === "ok" ? "success" : "error",
      title: kind === "ok" ? "Caja actualizada" : "Atención",
      description: text,
    });
  };

  const loadCashFlow = useCallback(async () => {
    try {
      const qs = !isAdmin
        ? "period=daily"
        : adminPeriod === "date"
          ? `date=${encodeURIComponent(adminDate)}`
          : `period=${adminPeriod}`;
      const res = await apiFetch<CashFlowResponse>(
        `/api/v1/branches/${branchId}/cash-flow?${qs}`,
      );
      setCashFlow(res);
      setDeclaredByMethod((prev) => {
        const next = { ...prev };
        for (const m of res.byPaymentMethod) {
          if (next[m.paymentMethodId] === undefined) {
            next[m.paymentMethodId] = String(Math.round(m.expectedBalance));
          }
        }
        return next;
      });
    } catch {
      // Offline
    }
  }, [branchId, isAdmin, adminPeriod, adminDate]);

  const loadShift = useCallback(async () => {
    try {
      const res = await apiFetch<CurrentShiftResponse>(
        `/api/v1/branches/${branchId}/shifts/current`,
      );
      setShiftData(res.activeShift);
    } catch {
      // Offline
    }
  }, [branchId]);

  const loadAlliesSettlements = useCallback(async () => {
    try {
      const res = await apiFetch<{
        pendingByAlly: AllyPendingGroup[];
        history: AllySettlementHistoryRow[];
      }>(`/api/v1/branches/${branchId}/allies/settlements`);
      setAllyPending(res.pendingByAlly ?? []);
      setAllyHistory(res.history ?? []);
    } catch {
      // Offline
    }
  }, [branchId]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiFetch<{ shifts: ClosedShiftRow[] }>(
        `/api/v1/branches/${branchId}/shifts/history`,
      );
      setShiftHistory(res.shifts ?? []);
    } catch {
      // Offline
    }
  }, [branchId]);

  useEffect(() => {
    void Promise.all([loadShift(), loadCashFlow()]);
  }, [loadShift, loadCashFlow, store.lastHydratedAt]);

  useEffect(() => {
    if (tab === "allies") void loadAlliesSettlements();
    if (tab === "history") void loadHistory();
  }, [tab, loadAlliesSettlements, loadHistory, store.lastHydratedAt]);

  const handleRecordExpense = async () => {
    const pmId = expenseMethodId || store.paymentMethods[0]?.id;
    const amt = Number(expenseAmount);
    if (!pmId || !expenseDesc.trim() || !amt || amt <= 0) {
      notify("err", "Escribe el concepto, un monto positivo y el medio de pago.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/cash-expenses`, {
        method: "POST",
        body: JSON.stringify({
          paymentMethodId: pmId,
          category: expenseCategory,
          description: expenseDesc.trim(),
          amount: amt,
        }),
      });
      haptics.success();
      setExpenseDesc("");
      setExpenseAmount("");
      setShowExpenseForm(false);
      await Promise.all([loadCashFlow(), loadShift()]);
      notify("ok", `Pago registrado: ${formatCOP(amt)}`);
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo registrar el pago");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteExpense = async (expenseId: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/cash-expenses/${expenseId}`, {
        method: "DELETE",
      });
      haptics.tap();
      await Promise.all([loadCashFlow(), loadShift()]);
      notify("ok", "Pago / egreso eliminado");
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo eliminar el egreso");
    } finally {
      setBusy(false);
    }
  };

  const loadCustomerLedger = async (customerId: string) => {
    if (ledgerCustomerId === customerId) {
      setLedgerCustomerId(null);
      return;
    }
    setLedgerCustomerId(customerId);
    try {
      const res = await apiFetch<{ entries: CustomerLedgerRow[] }>(
        `/api/v1/branches/${branchId}/customers/${customerId}/ledger`,
      );
      setLedgerRows(res.entries ?? []);
    } catch {
      setLedgerRows([]);
    }
  };

  const handleRegisterRepayment = async (customerId: string) => {
    const pmId = repayMethodId || store.paymentMethods[0]?.id;
    const amt = Number(repayAmount);
    if (!pmId || !amt || amt <= 0) {
      notify("err", "Ingresa un monto válido y elige el medio de pago.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{
        customerName: string;
        amountPaid: number;
        remainingDebt: number;
      }>(`/api/v1/branches/${branchId}/customers/${customerId}/repayments`, {
        method: "POST",
        body: JSON.stringify({
          paymentMethodId: pmId,
          amount: amt,
          notes: repayNotes.trim() || undefined,
        }),
      });
      haptics.success();
      setRepayCustomerId(null);
      setRepayAmount("");
      setRepayNotes("");
      await Promise.all([store.refresh(), loadShift(), loadCashFlow()]);
      if (ledgerCustomerId === customerId) {
        const led = await apiFetch<{ entries: CustomerLedgerRow[] }>(
          `/api/v1/branches/${branchId}/customers/${customerId}/ledger`,
        );
        setLedgerRows(led.entries ?? []);
      }
      notify(
        "ok",
        `Abono de ${formatCOP(res.amountPaid)} registrado a ${res.customerName} · Saldo: ${formatCOP(res.remainingDebt)} ✓`,
      );
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo registrar el abono");
    } finally {
      setBusy(false);
    }
  };

  const handleCloseShift = async () => {
    if (!shiftData || busy) return;
    setBusy(true);
    try {
      const methods = cashFlow?.byPaymentMethod ?? [];
      const numericByMethod: Record<string, number> = {};
      let physicalTotal = 0;
      for (const m of methods) {
        const val =
          declaredByMethod[m.paymentMethodId] !== undefined
            ? Math.max(0, Number(declaredByMethod[m.paymentMethodId]) || 0)
            : Math.max(0, m.expectedBalance);
        numericByMethod[m.paymentMethodId] = val;
        if (m.countsAsPhysicalCash) {
          physicalTotal += val;
        }
      }

      const res = await apiFetch<{ report: CashShiftClosureReport }>(
        `/api/v1/branches/${branchId}/shifts/close`,
        {
          method: "POST",
          body: JSON.stringify({
            userId: store.activeUserId,
            declaredPhysicalCash: physicalTotal,
            declaredByMethod: numericByMethod,
            notes,
            openNextShiftFloat: Number(nextShiftFloat) || 0,
          }),
        },
      );
      haptics.success();
      setClosedSummary(res.report);
      setDeclaredByMethod({});
      setNotes("");
      await Promise.all([store.refresh(), loadShift(), loadCashFlow(), loadHistory()]);
      notify("ok", "Cierre de turno guardado y nuevo turno abierto.");
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo cerrar el turno");
    } finally {
      setBusy(false);
    }
  };

  const handleSettleAlly = async (allyId: string, allyName?: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/allies/${allyId}/settle`, {
        method: "POST",
        body: JSON.stringify({ userId: store.activeUserId }),
      });
      haptics.success();
      await Promise.all([loadShift(), loadCashFlow(), loadAlliesSettlements()]);
      notify("ok", `Liquidación a ${allyName ?? "aliado"} marcada como pagada ✓`);
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "No se pudo liquidar");
    } finally {
      setBusy(false);
    }
  };

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      haptics.tap();
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleOpenShift = async () => {
    setBusy(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/shifts/open`, {
        method: "POST",
        body: JSON.stringify({
          userId: store.activeUserId,
          openingFloat: Number(nextShiftFloat) || 200000,
        }),
      });
      await Promise.all([loadShift(), loadCashFlow()]);
    } finally {
      setBusy(false);
    }
  };

  const debtors = store.customers
    .filter((c) => c.currentDebt > 0)
    .sort((a, b) => b.currentDebt - a.currentDebt);
  const totalPortfolioDebt = debtors.reduce((acc, c) => acc + c.currentDebt, 0);
  const totalAlliesPending = allyPending.reduce((acc, a) => acc + a.totalPending, 0);

  return (
    <div className="space-y-5">
      {/* Navegación interna de Caja */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5 rounded-2xl bg-secondary/70 p-1">
          {(
            [
              { id: "current", label: "Turno Actual", icon: Wallet },
              {
                id: "credit",
                label: `Cartera & Abonos${debtors.length > 0 ? ` (${debtors.length})` : ""}`,
                icon: Users,
              },
              {
                id: "allies",
                label: `Aliados${allyPending.length > 0 ? ` (${allyPending.length})` : ""}`,
                icon: Handshake,
              },
              { id: "history", label: "Historial Cierres", icon: History },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                haptics.tap();
                setTab(id);
              }}
              className={`press-response flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold ${
                tab === id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            void Promise.all([loadShift(), loadCashFlow()]);
            if (tab === "allies") void loadAlliesSettlements();
            if (tab === "history") void loadHistory();
            void store.refresh();
          }}
          className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-secondary px-3 text-xs font-semibold"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Recalcular
        </button>
      </div>

      {/* Selector de periodo (Admin: Este mes por defecto + filtro por día · Mesero/Cajero: solo Hoy) */}
      {tab === "current" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/10 bg-card/70 px-3.5 py-2.5">
          <div className="flex items-center gap-2 text-xs">
            <Calendar className="h-4 w-4 text-primary" />
            <span className="font-bold text-foreground">
              {cashFlow?.periodLabel ?? (isAdmin ? "Este mes" : "Hoy")}
            </span>
            {!isAdmin && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold text-primary">
                Balance neto del día
              </span>
            )}
          </div>

          {isAdmin && (
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: "monthly", label: "Este mes" },
                  { id: "daily", label: "Hoy" },
                  { id: "weekly", label: "7 días" },
                  { id: "all", label: "Todo" },
                ] as const
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    haptics.tap();
                    setAdminPeriod(p.id);
                    setDeclaredByMethod({});
                  }}
                  className={`press-response rounded-lg px-2.5 py-1.5 text-xs font-bold ${
                    adminPeriod === p.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary/70 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <input
                type="date"
                value={adminDate}
                onChange={(e) => {
                  const val = e.target.value;
                  setAdminDate(val);
                  if (val) {
                    setAdminPeriod("date");
                    setDeclaredByMethod({});
                  }
                }}
                className={`rounded-lg border px-2 py-1 text-xs font-semibold ${
                  adminPeriod === "date"
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-white/15 bg-background text-foreground"
                }`}
              />
            </div>
          )}
        </div>
      )}

      {!canEdit && (
        <div className="flex items-center gap-2 rounded-2xl border border-warning/35 bg-warning/10 px-4 py-3 text-xs font-semibold text-warning">
          <Eye className="h-4 w-4 shrink-0" />
          <span>
            Modo solo vista: puedes consultar balance, cartera, aliados e historial sin cerrar caja
            ni registrar pagos.
          </span>
        </div>
      )}

      {/* === TAB 1: BALANCE DIARIO / MENSUAL, PAGOS Y CIERRE === */}
      {tab === "current" && (
        <div className="space-y-5">
          {closedSummary && (
            <div className="flex items-center gap-3 rounded-2xl border border-success/40 bg-success/10 p-4 text-sm text-success">
              <CheckCircle2 className="h-6 w-6 shrink-0" />
              <div>
                <p className="font-bold">Turno cerrado correctamente y nuevo turno abierto.</p>
                <p className="text-xs">
                  Vendido: {formatCOP(closedSummary.totalNetSales)} · Recaudado:{" "}
                  {formatCOP(closedSummary.totalCollectedOverall)} · Aliados:{" "}
                  {formatCOP(closedSummary.totalAllyPayable)} · Fiado:{" "}
                  {formatCOP(closedSummary.totalCreditIssued)}
                </p>
              </div>
            </div>
          )}

          {/* 4 PILARES DEL BALANCE (NETO DEL DÍA PARA MESERO / PERIODO PARA ADMIN + INGRESOS VS EGRESOS) */}
          {cashFlow && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="solid-card rounded-2xl p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Vendido Neto (
                  {cashFlow.period === "daily" || cashFlow.period === "date"
                    ? "Día"
                    : cashFlow.periodLabel}
                  )
                </p>
                <p className="mt-2 font-display text-2xl font-bold tabular-nums text-foreground">
                  {formatCOP(cashFlow.salesSummary.netSales)}
                </p>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {cashFlow.salesSummary.unitsSold} und · Bruto{" "}
                  {formatCOP(cashFlow.salesSummary.grossSales)}
                  {cashFlow.salesSummary.discounts > 0
                    ? ` · Promos -${formatCOP(cashFlow.salesSummary.discounts)}`
                    : ""}
                </p>
              </div>

              <div className="solid-card rounded-2xl border-success/30 p-4">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-success">
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  Ingresos Recaudados
                </p>
                <p className="mt-2 font-display text-2xl font-bold tabular-nums text-success">
                  {formatCOP(cashFlow.balance.totalInflows)}
                </p>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  Ventas {formatCOP(cashFlow.balance.totalSalesInflows)} · Abonos{" "}
                  {formatCOP(cashFlow.balance.totalCreditRepayments)}
                </p>
              </div>

              <div className="solid-card rounded-2xl border-destructive/30 p-4">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-destructive">
                  <ArrowDownCircle className="h-3.5 w-3.5" />
                  Pagos / Egresos
                </p>
                <p className="mt-2 font-display text-2xl font-bold tabular-nums text-destructive">
                  -{formatCOP(cashFlow.balance.totalOutflows)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {cashFlow.expenses.length} gasto(s) registrado(s)
                </p>
              </div>

              <div className="solid-card rounded-2xl border-primary/35 p-4">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                  <Scale className="h-3.5 w-3.5" />
                  Balance (Ingresos − Egresos)
                </p>
                <p
                  className={`mt-2 font-display text-2xl font-bold tabular-nums ${
                    cashFlow.balance.netCashFlow >= 0 ? "text-primary" : "text-destructive"
                  }`}
                >
                  {formatCOP(cashFlow.balance.netCashFlow)}
                </p>
                <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                  Deudas cartera:{" "}
                  <strong className="text-accent">
                    {formatCOP(cashFlow.pendingTotals.customerDebtsTotal)}
                  </strong>{" "}
                  · Aliados:{" "}
                  <strong className="text-warning">
                    {formatCOP(cashFlow.pendingTotals.alliesPendingTotal)}
                  </strong>
                </p>
              </div>
            </div>
          )}

          {/* REGISTRO DE PAGOS / EGRESOS (SERVICIOS, HIELO, INSUMOS, TURNOS) */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-display text-base font-bold">
                  Pagos y Egresos del Periodo (Servicios, Insumos, Turnos)
                </h3>
                <p className="text-xs text-muted-foreground">
                  Registra salidas de Efectivo, Nequi o cualquier cuenta para cuadrar el balance
                  real.
                </p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    haptics.tap();
                    setShowExpenseForm((v) => !v);
                    if (!expenseMethodId && store.paymentMethods[0]) {
                      setExpenseMethodId(store.paymentMethods[0].id);
                    }
                  }}
                  className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-destructive/15 px-3.5 text-xs font-bold text-destructive ring-1 ring-destructive/30"
                >
                  <Plus className="h-4 w-4" />
                  {showExpenseForm ? "Ocultar formulario" : "Registrar Pago / Egreso"}
                </button>
              )}
            </div>

            {canEdit && showExpenseForm && (
              <div className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
                <div className="flex flex-wrap gap-1.5">
                  {EXPENSE_CATEGORIES.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => {
                        haptics.tap();
                        setExpenseCategory(cat.id);
                      }}
                      className={`press-response rounded-lg border px-2.5 py-1.5 text-xs font-bold ${
                        expenseCategory === cat.id
                          ? "border-destructive bg-destructive/20 text-destructive"
                          : "border-white/10 bg-background/70 text-muted-foreground"
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>

                <div className="grid gap-2.5 sm:grid-cols-12">
                  <input
                    type="text"
                    placeholder="Concepto (ej. Recibo de energía, 4 bolsas de hielo, domicilio)"
                    value={expenseDesc}
                    onChange={(e) => setExpenseDesc(e.target.value)}
                    className="rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm sm:col-span-5"
                  />
                  <select
                    value={expenseMethodId || store.paymentMethods[0]?.id || ""}
                    onChange={(e) => setExpenseMethodId(e.target.value)}
                    className="rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm sm:col-span-3"
                  >
                    {store.paymentMethods.map((pm) => (
                      <option key={pm.id} value={pm.id}>
                        Sale de: {pm.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    placeholder="Monto COP"
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    className="rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm font-bold tabular-nums sm:col-span-2"
                  />
                  <button
                    type="button"
                    disabled={busy || !expenseDesc.trim() || !Number(expenseAmount)}
                    onClick={() => void handleRecordExpense()}
                    className="press-response min-h-11 rounded-xl bg-destructive px-4 text-xs font-bold text-white disabled:opacity-50 sm:col-span-2"
                  >
                    Guardar Pago
                  </button>
                </div>
              </div>
            )}

            {cashFlow && cashFlow.expenses.length > 0 && (
              <div className="divide-y divide-white/10 rounded-xl bg-background/50 px-3 text-xs tabular-nums">
                {cashFlow.expenses.map((exp) => (
                  <div
                    key={exp.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-bold text-destructive">
                          {EXPENSE_CATEGORY_LABEL[exp.category] ?? exp.category}
                        </span>
                        <span className="font-semibold text-foreground">{exp.description}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {exp.paymentMethodName} · {exp.userName} ·{" "}
                        {new Date(exp.createdAt).toLocaleTimeString("es-CO", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-destructive">-{formatCOP(exp.amount)}</span>
                      {canEdit && (
                        <button
                          type="button"
                          disabled={busy}
                          title="Eliminar pago"
                          onClick={() => void handleDeleteExpense(exp.id)}
                          className="press-response flex h-7 w-7 items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* VALIDACIÓN POR CUENTA / EFECTIVO + TODOS LOS MOVIMIENTOS AGRUPADOS POR MEDIO DE PAGO */}
          {cashFlow && (
            <div className="space-y-3">
              <div>
                <h3 className="font-display text-base font-bold">
                  Validación de Efectivo y Cuentas · Movimientos Agrupados
                </h3>
                <p className="text-xs text-muted-foreground">
                  Revisa cada medio de pago (Efectivo, Nequi, Daviplata, Datáfono…) y valida el
                  saldo real frente a los movimientos.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                {cashFlow.byPaymentMethod.map((method) => {
                  const declaredStr =
                    declaredByMethod[method.paymentMethodId] ??
                    String(Math.round(method.expectedBalance));
                  const declaredVal = Number(declaredStr) || 0;
                  const diff = Math.round((declaredVal - method.expectedBalance) * 100) / 100;
                  const isExpanded =
                    expandedMethods[method.paymentMethodId] ??
                    (method.movements.length > 0 && method.movements.length <= 6);

                  return (
                    <div
                      key={method.paymentMethodId}
                      className="solid-card flex flex-col gap-3 rounded-2xl p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <div
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                              method.countsAsPhysicalCash
                                ? "bg-success/15 text-success"
                                : "bg-primary/15 text-primary"
                            }`}
                          >
                            {method.countsAsPhysicalCash ? (
                              <Banknote className="h-5 w-5" />
                            ) : (
                              <CreditCard className="h-5 w-5" />
                            )}
                          </div>
                          <div>
                            <h4 className="font-display text-sm font-bold text-foreground">
                              {method.name}
                            </h4>
                            <p className="text-[11px] text-muted-foreground">
                              {method.countsAsPhysicalCash
                                ? "Dinero físico en cajón"
                                : "Cuenta digital / banco"}{" "}
                              · {method.movements.length} mov.
                            </p>
                          </div>
                        </div>

                        <div className="text-right tabular-nums">
                          <p className="text-[10px] uppercase text-muted-foreground">Esperado</p>
                          <p className="font-display text-lg font-bold text-primary">
                            {formatCOP(method.expectedBalance)}
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 rounded-xl bg-background/60 p-2.5 text-center text-[11px] tabular-nums">
                        <div>
                          <p className="text-muted-foreground">Ingresos</p>
                          <p className="font-bold text-success">+{formatCOP(method.totalIn)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Egresos</p>
                          <p className="font-bold text-destructive">
                            -{formatCOP(method.expensesOut)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">
                            {method.countsAsPhysicalCash && cashFlow.balance.openingFloat > 0
                              ? "Base"
                              : "Flujo neto"}
                          </p>
                          <p className="font-bold text-foreground">
                            {method.countsAsPhysicalCash && cashFlow.balance.openingFloat > 0
                              ? formatCOP(cashFlow.balance.openingFloat)
                              : formatCOP(method.netFlow)}
                          </p>
                        </div>
                      </div>

                      {canEdit && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-background/50 p-2.5">
                          <label className="text-[11px] font-semibold text-muted-foreground">
                            {method.countsAsPhysicalCash
                              ? "Contado físico:"
                              : "Validado en cuenta:"}
                          </label>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              min={0}
                              value={declaredStr}
                              onChange={(e) =>
                                setDeclaredByMethod((prev) => ({
                                  ...prev,
                                  [method.paymentMethodId]: e.target.value,
                                }))
                              }
                              className="w-32 rounded-lg border border-white/15 bg-card px-2.5 py-1.5 text-right text-sm font-bold tabular-nums text-foreground focus:border-primary focus:outline-none"
                            />
                            <span
                              className={`min-w-24 text-right text-[11px] font-bold tabular-nums ${
                                Math.abs(diff) < 1
                                  ? "text-success"
                                  : diff < 0
                                    ? "text-destructive"
                                    : "text-warning"
                              }`}
                            >
                              {Math.abs(diff) < 1
                                ? "Cuadre OK"
                                : diff < 0
                                  ? formatCOP(diff)
                                  : `+${formatCOP(diff)}`}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Lista de movimientos agrupados en este medio de pago */}
                      <div>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedMethods((prev) => ({
                              ...prev,
                              [method.paymentMethodId]: !isExpanded,
                            }))
                          }
                          className="flex w-full items-center justify-between rounded-lg bg-secondary/50 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
                        >
                          <span>
                            Movimientos de {method.name} ({method.movements.length})
                          </span>
                          {isExpanded ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                        </button>

                        {isExpanded && (
                          <div className="mt-2 max-h-56 divide-y divide-white/10 overflow-y-auto rounded-xl bg-background/50 px-3 text-xs tabular-nums">
                            {method.movements.length === 0 ? (
                              <p className="py-3 text-center text-[11px] text-muted-foreground">
                                Sin movimientos en este periodo.
                              </p>
                            ) : (
                              method.movements.map((mv) => (
                                <div
                                  key={mv.id}
                                  className="flex items-center justify-between gap-2 py-2"
                                >
                                  <div className="min-w-0">
                                    <p className="truncate font-semibold text-foreground">
                                      {mv.label}
                                    </p>
                                    <p className="truncate text-[10px] text-muted-foreground">
                                      {mv.kind === "expense"
                                        ? `Egreso (${EXPENSE_CATEGORY_LABEL[mv.category ?? "otro"] ?? mv.category})`
                                        : mv.kind === "credit_repayment"
                                          ? "Abono cartera"
                                          : "Venta POS"}{" "}
                                      · {mv.userName} ·{" "}
                                      {new Date(mv.createdAt).toLocaleTimeString("es-CO", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </p>
                                  </div>
                                  <span
                                    className={`shrink-0 font-bold ${
                                      mv.amount >= 0 ? "text-success" : "text-destructive"
                                    }`}
                                  >
                                    {mv.amount >= 0 ? "+" : ""}
                                    {formatCOP(mv.amount)}
                                  </span>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* APERTURA O CIERRE DE TURNO DE CAJA */}
          {!shiftData ? (
            <div className="solid-card mx-auto max-w-lg space-y-4 rounded-2xl p-6 text-center">
              <Wallet className="mx-auto h-10 w-10 text-primary" />
              <h2 className="font-display text-xl font-bold">No hay turno abierto</h2>
              <p className="text-sm text-muted-foreground">
                Define la base de efectivo inicial para abrir la caja de esta sucursal.
              </p>
              {canEdit && (
                <>
                  <input
                    type="number"
                    value={nextShiftFloat}
                    onChange={(e) => setNextShiftFloat(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-4 py-3 text-center text-lg font-bold tabular-nums"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleOpenShift}
                    className="press-response min-h-13 w-full rounded-2xl bg-primary font-bold text-primary-foreground"
                  >
                    Abrir Turno de Caja
                  </button>
                </>
              )}
            </div>
          ) : (
            canEdit && (
              <div className="solid-card space-y-4 rounded-2xl border-primary/25 p-5">
                <div>
                  <h3 className="font-display text-base font-bold">
                    Confirmar Cierre de Turno Nocturno
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Turno abierto desde {new Date(shiftData.openedAt).toLocaleString("es-CO")} ·
                    Base inicial: {formatCOP(shiftData.report.openingFloat)}
                  </p>
                </div>

                {shiftData.openTablesCount > 0 && (
                  <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>
                      Hay <strong>{shiftData.openTablesCount} mesa(s) abierta(s)</strong> (
                      {formatCOP(shiftData.openTablesPendingAmount)}). Al cerrar turno, se
                      transferirán automáticamente al siguiente turno sin perder ningún pedido.
                    </span>
                  </div>
                )}

                <div className="grid gap-3 md:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                      Base para siguiente turno (COP)
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={nextShiftFloat}
                      onChange={(e) => setNextShiftFloat(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-3 text-base font-bold tabular-nums text-foreground focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                      Notas del cierre
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="text"
                        placeholder="Ej. Cierre nocturno cuadrado sin novedades..."
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        className="min-w-52 flex-1 rounded-xl border border-white/15 bg-background px-3.5 py-3 text-sm"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleCloseShift}
                        className="press-response flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-bold text-primary-foreground disabled:opacity-50"
                      >
                        <Lock className="h-4 w-4" />
                        Confirmar Cierre
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {/* === TAB 2: CARTERA DE FIADOS Y ABONOS === */}
      {tab === "credit" && (
        <div className="space-y-4">
          <div className="solid-card flex flex-wrap items-center justify-between gap-3 rounded-2xl border-accent/30 p-4">
            <div>
              <h2 className="font-display text-lg font-bold">Cartera Pendiente & Abonos</h2>
              <p className="text-xs text-muted-foreground">
                Cada abono entra al recaudo del turno actual y queda en el libro mayor inmutable
              </p>
            </div>
            <div className="text-right tabular-nums">
              <p className="text-xs text-muted-foreground">Total por cobrar</p>
              <p className="font-display text-2xl font-bold text-accent">
                {formatCOP(totalPortfolioDebt)}
              </p>
            </div>
          </div>

          {debtors.length === 0 ? (
            <div className="solid-card rounded-2xl p-8 text-center text-sm text-muted-foreground">
              ¡Al día! No hay clientes con saldo pendiente de fiado en esta sucursal.
            </div>
          ) : (
            <div className="space-y-3">
              {debtors.map((c) => {
                const isRepaying = repayCustomerId === c.id;
                const isViewingLedger = ledgerCustomerId === c.id;
                const pct =
                  c.creditLimit && c.creditLimit > 0
                    ? Math.min(100, Math.round((c.currentDebt / c.creditLimit) * 100))
                    : null;
                return (
                  <div key={c.id} className="solid-card space-y-3 rounded-2xl p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-display text-base font-bold">{c.fullName}</p>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              c.creditStatus === "blacklist_blocked"
                                ? "bg-destructive/20 text-destructive"
                                : "bg-success/15 text-success"
                            }`}
                          >
                            {c.creditStatus === "blacklist_blocked"
                              ? "Lista Negra"
                              : "Lista Blanca"}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                          Saldo actual:{" "}
                          <strong className="text-accent">{formatCOP(c.currentDebt)}</strong>
                          {c.creditLimit ? ` · Cupo: ${formatCOP(c.creditLimit)} (${pct}%)` : ""}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void loadCustomerLedger(c.id)}
                          className="press-response rounded-xl bg-secondary px-3 py-2 text-xs font-semibold"
                        >
                          {isViewingLedger ? "Ocultar historial" : "Movimientos"}
                        </button>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => {
                              setRepayCustomerId(isRepaying ? null : c.id);
                              setRepayAmount(String(Math.round(c.currentDebt)));
                              setRepayMethodId(store.paymentMethods[0]?.id ?? "");
                              setRepayNotes("");
                            }}
                            className="press-response rounded-xl bg-success px-4 py-2 text-xs font-bold text-primary-foreground"
                          >
                            Registrar Abono
                          </button>
                        )}
                      </div>
                    </div>

                    {isRepaying && (
                      <div className="space-y-2.5 rounded-xl border border-success/30 bg-success/5 p-3">
                        <div className="grid gap-2 sm:grid-cols-3">
                          <div>
                            <label className="mb-1 block text-[11px] text-muted-foreground">
                              Monto del abono (máx. {formatCOP(c.currentDebt)})
                            </label>
                            <input
                              type="number"
                              min={1}
                              max={c.currentDebt}
                              value={repayAmount}
                              onChange={(e) => setRepayAmount(e.target.value)}
                              className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm font-bold tabular-nums"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[11px] text-muted-foreground">
                              Medio de pago recibido
                            </label>
                            <select
                              value={repayMethodId || store.paymentMethods[0]?.id || ""}
                              onChange={(e) => setRepayMethodId(e.target.value)}
                              className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                            >
                              {store.paymentMethods.map((pm) => (
                                <option key={pm.id} value={pm.id}>
                                  {pm.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="mb-1 block text-[11px] text-muted-foreground">
                              Nota / referencia (opcional)
                            </label>
                            <input
                              type="text"
                              placeholder="Ej. Nequi comprobante 4821"
                              value={repayNotes}
                              onChange={(e) => setRepayNotes(e.target.value)}
                              className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                            />
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => setRepayAmount(String(Math.round(c.currentDebt / 2)))}
                              className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-semibold"
                            >
                              50%
                            </button>
                            <button
                              type="button"
                              onClick={() => setRepayAmount(String(Math.round(c.currentDebt)))}
                              className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-semibold"
                            >
                              Saldar 100%
                            </button>
                          </div>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRegisterRepayment(c.id)}
                            className="press-response rounded-xl bg-success px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
                          >
                            Confirmar Abono
                          </button>
                        </div>
                      </div>
                    )}

                    {isViewingLedger && (
                      <div className="divide-y divide-white/10 rounded-xl bg-background/60 p-3 text-xs tabular-nums">
                        {ledgerRows.length === 0 ? (
                          <p className="text-muted-foreground">Sin movimientos registrados.</p>
                        ) : (
                          ledgerRows.map((row) => (
                            <div
                              key={row.id}
                              className="flex flex-wrap items-center justify-between gap-2 py-2"
                            >
                              <div>
                                <span
                                  className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                                    row.entryType === "repayment"
                                      ? "bg-success/20 text-success"
                                      : "bg-accent/20 text-accent"
                                  }`}
                                >
                                  {row.entryType === "repayment" ? "Abono" : "Fiado"}
                                </span>
                                <span className="text-muted-foreground">
                                  {new Date(row.createdAt).toLocaleString("es-CO")} ·{" "}
                                  {row.createdByName}
                                  {row.paymentMethodName ? ` · ${row.paymentMethodName}` : ""}
                                </span>
                                {row.notes && (
                                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                                    {row.notes}
                                  </p>
                                )}
                              </div>
                              <div className="text-right">
                                <p
                                  className={`font-bold ${
                                    row.amountDelta < 0 ? "text-success" : "text-accent"
                                  }`}
                                >
                                  {row.amountDelta > 0 ? "+" : ""}
                                  {formatCOP(row.amountDelta)}
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                  Saldo: {formatCOP(row.balanceAfter)}
                                </p>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* === TAB 3: ALIADOS Y LIQUIDACIONES === */}
      {tab === "allies" && (
        <div className="space-y-5">
          <div className="solid-card flex flex-wrap items-center justify-between gap-3 rounded-2xl border-warning/30 p-4">
            <div>
              <h2 className="font-display text-lg font-bold">Liquidación de Locales Aliados</h2>
              <p className="text-xs text-muted-foreground">
                Acumulado pendiente por pagar a aliados (todos los turnos sin liquidar)
              </p>
            </div>
            <div className="text-right tabular-nums">
              <p className="text-xs text-muted-foreground">Total por liquidar</p>
              <p className="font-display text-2xl font-bold text-warning">
                {formatCOP(totalAlliesPending)}
              </p>
            </div>
          </div>

          {allyPending.length === 0 ? (
            <div className="solid-card rounded-2xl p-8 text-center text-sm text-muted-foreground">
              Sin saldos pendientes por pagar a aliados.
            </div>
          ) : (
            <div className="space-y-3">
              {allyPending.map((group) => {
                const whatsappSummary = [
                  `*Liquidación Aliado: ${group.allyName}*`,
                  `Fecha: ${new Date().toLocaleString("es-CO")}`,
                  "------------------------",
                  ...group.items.map(
                    (it) =>
                      `${it.quantity}x ${it.productName} (${it.presentationName}) - ${formatCOP(it.amountPayable)}`,
                  ),
                  "------------------------",
                  `*TOTAL A LIQUIDAR: ${formatCOP(group.totalPending)}*`,
                ].join("\n");

                return (
                  <div key={group.allyId} className="solid-card space-y-3 rounded-2xl p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="font-display text-base font-bold">{group.allyName}</h3>
                        <p className="text-xs text-muted-foreground">
                          {group.itemsCount} ítem(s) vendidos sin liquidar
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-display text-xl font-bold tabular-nums text-warning">
                          {formatCOP(group.totalPending)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void copyText(`ally-${group.allyId}`, whatsappSummary)}
                          className="press-response flex items-center gap-1 rounded-xl bg-secondary px-3 py-2 text-xs font-semibold"
                        >
                          {copiedId === `ally-${group.allyId}` ? (
                            <Check className="h-3.5 w-3.5 text-success" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                          WhatsApp
                        </button>
                        {canEdit && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleSettleAlly(group.allyId, group.allyName)}
                            className="press-response flex items-center gap-1 rounded-xl bg-warning px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
                          >
                            <Handshake className="h-3.5 w-3.5" />
                            Marcar Pagado
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="divide-y divide-white/10 rounded-xl bg-background/60 p-3 text-xs tabular-nums">
                      {group.items.slice(0, 12).map((it) => (
                        <div key={it.id} className="flex justify-between gap-2 py-1.5">
                          <span>
                            {it.quantity}x {it.productName}{" "}
                            <span className="text-muted-foreground">({it.presentationName})</span>
                          </span>
                          <span className="font-semibold text-warning">
                            {formatCOP(it.amountPayable)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {allyHistory.length > 0 && (
            <section className="solid-card space-y-3 rounded-2xl p-4">
              <h3 className="font-display text-sm font-bold text-muted-foreground">
                Historial de Liquidaciones Pagadas
              </h3>
              <div className="divide-y divide-white/10 text-xs tabular-nums">
                {allyHistory.map((h, i) => (
                  <div
                    key={`${h.allyId}-${h.settledDay}-${i}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <div>
                      <span className="font-bold text-foreground">{h.allyName}</span>
                      <span className="ml-2 text-muted-foreground">
                        {h.settledDay} · {h.entriesCount} reg. · por {h.settledByName ?? "Caja"}
                      </span>
                    </div>
                    <span className="font-bold text-success">{formatCOP(h.totalSettled)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* === TAB 4: HISTORIAL DE CIERRES === */}
      {tab === "history" && (
        <div className="space-y-3">
          {shiftHistory.length === 0 ? (
            <div className="solid-card rounded-2xl p-8 text-center text-sm text-muted-foreground">
              Aún no hay turnos cerrados en esta sucursal.
            </div>
          ) : (
            shiftHistory.map((s) => {
              const summaryText = [
                `*Cierre de Caja*`,
                `Cerrado: ${new Date(s.closedAt).toLocaleString("es-CO")}`,
                `Vendido neto: ${formatCOP(s.totalNetSales)}`,
                `Recaudado: ${formatCOP(s.totalCollected)}`,
                `Aliados: ${formatCOP(s.totalAllyPayable)}`,
                `Fiado: ${formatCOP(s.totalCreditIssued)} (Abonos: ${formatCOP(s.totalCreditRecovered)})`,
                `Efectivo esperado: ${formatCOP(s.expectedPhysicalCash)} | Contado: ${formatCOP(s.declaredPhysicalCash)}`,
                `Diferencia: ${formatCOP(s.cashDiscrepancy)}`,
              ].join("\n");
              return (
                <div key={s.id} className="solid-card space-y-2.5 rounded-2xl p-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-display text-sm font-bold">
                        Cierre {new Date(s.closedAt).toLocaleString("es-CO")}
                      </p>
                      <p className="text-muted-foreground">
                        Abrió: {s.openedByName} · Cerró: {s.closedByName ?? "—"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyText(`shift-${s.id}`, summaryText)}
                      className="press-response flex items-center gap-1 rounded-xl bg-secondary px-3 py-1.5 text-xs font-semibold"
                    >
                      {copiedId === `shift-${s.id}` ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      Copiar
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2 tabular-nums sm:grid-cols-5">
                    <div className="rounded-xl bg-background/60 p-2.5">
                      <p className="text-[10px] text-muted-foreground">Vendido Neto</p>
                      <p className="font-bold">{formatCOP(s.totalNetSales)}</p>
                    </div>
                    <div className="rounded-xl bg-background/60 p-2.5">
                      <p className="text-[10px] text-muted-foreground">Recaudado</p>
                      <p className="font-bold text-success">{formatCOP(s.totalCollected)}</p>
                    </div>
                    <div className="rounded-xl bg-background/60 p-2.5">
                      <p className="text-[10px] text-muted-foreground">Aliados</p>
                      <p className="font-bold text-warning">{formatCOP(s.totalAllyPayable)}</p>
                    </div>
                    <div className="rounded-xl bg-background/60 p-2.5">
                      <p className="text-[10px] text-muted-foreground">Fiado</p>
                      <p className="font-bold text-accent">{formatCOP(s.totalCreditIssued)}</p>
                    </div>
                    <div className="rounded-xl bg-background/60 p-2.5">
                      <p className="text-[10px] text-muted-foreground">Descuadre</p>
                      <p
                        className={`font-bold ${
                          Math.abs(s.cashDiscrepancy) < 1
                            ? "text-success"
                            : s.cashDiscrepancy < 0
                              ? "text-destructive"
                              : "text-warning"
                        }`}
                      >
                        {s.cashDiscrepancy > 0 ? "+" : ""}
                        {formatCOP(s.cashDiscrepancy)}
                      </p>
                    </div>
                  </div>
                  {s.notes && <p className="italic text-muted-foreground">Nota: {s.notes}</p>}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
