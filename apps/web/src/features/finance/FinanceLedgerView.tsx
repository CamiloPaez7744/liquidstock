import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownCircle,
  ArrowLeftRight,
  ArrowUpCircle,
  Banknote,
  Calendar,
  Check,
  CreditCard,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Scale,
  Trash2,
  Vault,
  X,
} from "lucide-react";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { useFeedback } from "../../shared/components/FeedbackProvider.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

type StoreType = ReturnType<typeof useLiquiStock>;
type FinancePeriod = "daily" | "weekly" | "monthly" | "all" | "date";
type ManualMode = "none" | "extra" | "expense" | "transfer";

const EXPENSE_CATEGORIES = [
  { id: "servicios", label: "Servicios" },
  { id: "insumos", label: "Insumos / Stock" },
  { id: "nomina", label: "Turnos / Nómina" },
  { id: "mantenimiento", label: "Mantenimiento" },
  { id: "transporte", label: "Transporte" },
  { id: "otro", label: "Otro egreso" },
] as const;

const EXTRA_CATEGORIES = [
  { id: "cover", label: "Cover / Entradas" },
  { id: "danos", label: "Daño / Reposición" },
  { id: "propina", label: "Propinas" },
  { id: "alquiler", label: "Alquiler / Evento" },
  { id: "ajuste", label: "Base / Ajuste" },
  { id: "otro", label: "Otro ingreso" },
] as const;

interface AccountBalance {
  id: string;
  name: string;
  code: string;
  countsAsPhysicalCash: boolean;
  isInternalVault: boolean;
  currentBalance: number;
}

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

interface FinanceLedgerResponse {
  period: FinancePeriod;
  periodLabel: string;
  selectedDate: string | null;
  salesSummary: {
    grossSales: number;
    discounts: number;
    netSales: number;
    unitsSold: number;
  };
  periodBalance: {
    totalInflows: number;
    totalOutflows: number;
    netFlow: number;
  };
  accountBalances: AccountBalance[];
  totalTreasuryBalance: number;
  dualCreditSummary: {
    receivablesFromCustomers: number;
    debtorsCount: number;
    payablesToSuppliers: number;
    openSuppliersCount: number;
    payablesToAllies: number;
  };
  entries: FinanceEntry[];
}

function getTodayDateString(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function FinanceLedgerView({
  store,
  branchId,
  canEdit = true,
}: {
  store: StoreType;
  branchId: string;
  canEdit?: boolean;
}) {
  const { toast } = useFeedback();
  const [period, setPeriod] = useState<FinancePeriod>("daily");
  const [selectedDate, setSelectedDate] = useState<string>(getTodayDateString());
  const [filterAccountId, setFilterAccountId] = useState<string>("");
  const [data, setData] = useState<FinanceLedgerResponse | null>(null);
  const [busy, setBusy] = useState(false);

  // Manual entry form
  const [manualMode, setManualMode] = useState<ManualMode>("none");
  const [formCategory, setFormCategory] = useState("otro");
  const [formAccountId, setFormAccountId] = useState("");
  const [formToAccountId, setFormToAccountId] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formAmount, setFormAmount] = useState("");

  // Inline edit state for any editable entry
  const [editingEntry, setEditingEntry] = useState<FinanceEntry | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editAccountId, setEditAccountId] = useState("");
  const [editToAccountId, setEditToAccountId] = useState("");
  const [editCategory, setEditCategory] = useState("otro");

  const accounts = data?.accountBalances ?? store.treasuryAccounts ?? store.paymentMethods;

  const loadLedger = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (period === "date") {
        params.set("date", selectedDate);
      } else {
        params.set("period", period);
      }
      if (filterAccountId) params.set("accountId", filterAccountId);
      const res = await apiFetch<FinanceLedgerResponse>(
        `/api/v1/branches/${branchId}/finance/ledger?${params.toString()}`,
      );
      setData(res);
    } catch {
      // Offline
    }
  }, [branchId, period, selectedDate, filterAccountId]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger, store.lastHydratedAt]);

  const notify = (kind: "ok" | "err", text: string) => {
    toast({
      kind: kind === "ok" ? "success" : "error",
      title: kind === "ok" ? "Libro financiero actualizado" : "Atención",
      description: text,
    });
  };

  const openManualForm = (mode: ManualMode) => {
    haptics.tap();
    if (manualMode === mode) {
      setManualMode("none");
      return;
    }
    setManualMode(mode);
    setFormDesc("");
    setFormAmount("");
    const firstAcc = accounts[0]?.id ?? "";
    const vaultAcc = accounts.find((a) => a.isInternalVault)?.id ?? accounts[1]?.id ?? firstAcc;
    setFormAccountId(firstAcc);
    setFormToAccountId(vaultAcc);
    setFormCategory(mode === "expense" ? "servicios" : "otro");
  };

  const handleSaveManual = async () => {
    const amt = Number(formAmount);
    if (!amt || amt <= 0) {
      notify("err", "Ingresa un monto mayor a $0.");
      return;
    }
    setBusy(true);
    try {
      if (manualMode === "expense") {
        if (!formDesc.trim() || !formAccountId) {
          notify("err", "Completa el concepto y la cuenta de salida.");
          return;
        }
        await apiFetch(`/api/v1/branches/${branchId}/cash-expenses`, {
          method: "POST",
          body: JSON.stringify({
            paymentMethodId: formAccountId,
            category: formCategory,
            description: formDesc.trim(),
            amount: amt,
          }),
        });
        notify("ok", `Egreso registrado: -${formatCOP(amt)}`);
      } else if (manualMode === "extra") {
        if (!formDesc.trim() || !formAccountId) {
          notify("err", "Completa el concepto y la cuenta de ingreso.");
          return;
        }
        await apiFetch(`/api/v1/branches/${branchId}/cash-extras`, {
          method: "POST",
          body: JSON.stringify({
            paymentMethodId: formAccountId,
            category: formCategory,
            description: formDesc.trim(),
            amount: amt,
          }),
        });
        notify("ok", `Ingreso registrado: +${formatCOP(amt)}`);
      } else if (manualMode === "transfer") {
        if (!formAccountId || !formToAccountId || formAccountId === formToAccountId) {
          notify("err", "Elige dos cuentas diferentes (origen y destino).");
          return;
        }
        await apiFetch(`/api/v1/branches/${branchId}/cash-transfers`, {
          method: "POST",
          body: JSON.stringify({
            fromPaymentMethodId: formAccountId,
            toPaymentMethodId: formToAccountId,
            amount: amt,
            notes: formDesc.trim() || undefined,
          }),
        });
        notify("ok", `Traslado registrado: ${formatCOP(amt)}`);
      }
      haptics.success();
      setManualMode("none");
      await loadLedger();
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo guardar el movimiento");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (entry: FinanceEntry) => {
    haptics.tap();
    setEditingEntry(entry);
    setEditDesc(entry.description);
    setEditAmount(String(entry.amount));
    setEditAccountId(entry.paymentMethodId);
    setEditToAccountId(entry.toPaymentMethodId ?? "");
    setEditCategory(entry.category ?? "otro");
  };

  const handleSaveEdit = async () => {
    if (!editingEntry) return;
    const amt = Number(editAmount);
    if (!amt || amt <= 0) {
      notify("err", "Ingresa un monto positivo.");
      return;
    }
    setBusy(true);
    try {
      if (editingEntry.entryType === "expense") {
        await apiFetch(`/api/v1/branches/${branchId}/cash-expenses/${editingEntry.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            paymentMethodId: editAccountId,
            category: editCategory,
            description: editDesc.trim(),
            amount: amt,
          }),
        });
      } else if (editingEntry.entryType === "extra_income") {
        await apiFetch(`/api/v1/branches/${branchId}/cash-extras/${editingEntry.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            paymentMethodId: editAccountId,
            category: editCategory,
            description: editDesc.trim(),
            amount: amt,
          }),
        });
      } else if (editingEntry.entryType === "transfer") {
        await apiFetch(`/api/v1/branches/${branchId}/cash-transfers/${editingEntry.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            fromPaymentMethodId: editAccountId,
            toPaymentMethodId: editToAccountId,
            amount: amt,
            notes: editDesc.trim(),
          }),
        });
      }
      haptics.success();
      setEditingEntry(null);
      await loadLedger();
      notify("ok", "Movimiento corregido y saldos recalculados");
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo editar el movimiento");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteEntry = async (entry: FinanceEntry) => {
    setBusy(true);
    try {
      const path =
        entry.entryType === "expense"
          ? `cash-expenses/${entry.id}`
          : entry.entryType === "extra_income"
            ? `cash-extras/${entry.id}`
            : `cash-transfers/${entry.id}`;
      await apiFetch(`/api/v1/branches/${branchId}/${path}`, { method: "DELETE" });
      haptics.tap();
      if (editingEntry?.id === entry.id) setEditingEntry(null);
      await loadLedger();
      notify("ok", "Movimiento eliminado");
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo eliminar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 pb-10">
      {/* Cabecera y Filtros de Periodo */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight sm:text-2xl">
            Ingresos, Egresos y Bodega
          </h1>
          <p className="text-xs text-muted-foreground">
            Libro financiero editable · Saldos reales por cuenta (Efectivo, Bodega, Nequi…)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: "daily", label: "Hoy" },
              { id: "weekly", label: "7 días" },
              { id: "monthly", label: "Este mes" },
              { id: "all", label: "Todo" },
            ] as const
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                haptics.tap();
                setPeriod(p.id);
              }}
              className={`press-response rounded-xl px-3 py-1.5 text-xs font-bold ${
                period === p.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
          <div className="flex items-center gap-1 rounded-xl border border-white/15 bg-card px-2 py-1">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                setSelectedDate(e.target.value);
                if (e.target.value) setPeriod("date");
              }}
              className="border-0 bg-transparent text-xs font-semibold text-foreground focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void loadLedger()}
            className="press-response flex h-9 w-9 items-center justify-center rounded-xl bg-secondary text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!canEdit && (
        <div className="flex items-center gap-2 rounded-2xl border border-warning/35 bg-warning/10 px-4 py-2.5 text-xs font-semibold text-warning">
          <Eye className="h-4 w-4 shrink-0" />
          <span>Modo solo vista: puedes consultar saldos y movimientos sin crear ni editar.</span>
        </div>
      )}

      {/* 4 Cards ejecutivos: Ventas del Periodo + Ingresos + Egresos + Cartera Dual */}
      {data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="solid-card rounded-2xl p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Ventas Netas ({data.periodLabel})
            </p>
            <p className="mt-1.5 font-display text-2xl font-bold tabular-nums text-foreground">
              {formatCOP(data.salesSummary.netSales)}
            </p>
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">
              {data.salesSummary.unitsSold} und · Bruto {formatCOP(data.salesSummary.grossSales)}
            </p>
          </div>

          <div className="solid-card rounded-2xl border-success/30 p-4">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-success">
              <ArrowUpCircle className="h-3.5 w-3.5" />
              Ingresos ({data.periodLabel})
            </p>
            <p className="mt-1.5 font-display text-2xl font-bold tabular-nums text-success">
              +{formatCOP(data.periodBalance.totalInflows)}
            </p>
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">
              Flujo neto:{" "}
              <strong
                className={data.periodBalance.netFlow >= 0 ? "text-primary" : "text-destructive"}
              >
                {formatCOP(data.periodBalance.netFlow)}
              </strong>
            </p>
          </div>

          <div className="solid-card rounded-2xl border-destructive/30 p-4">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive">
              <ArrowDownCircle className="h-3.5 w-3.5" />
              Egresos y Compras
            </p>
            <p className="mt-1.5 font-display text-2xl font-bold tabular-nums text-destructive">
              -{formatCOP(data.periodBalance.totalOutflows)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Incluye servicios, insumos y pagos a proveedores
            </p>
          </div>

          <div className="solid-card rounded-2xl border-primary/30 p-4">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
              <Scale className="h-3.5 w-3.5" />
              Tesorería Total (Todas las Cuentas)
            </p>
            <p className="mt-1.5 font-display text-2xl font-bold tabular-nums text-primary">
              {formatCOP(data.totalTreasuryBalance)}
            </p>
            <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
              Nos deben:{" "}
              <strong className="text-success">
                {formatCOP(data.dualCreditSummary.receivablesFromCustomers)}
              </strong>{" "}
              · Debemos:{" "}
              <strong className="text-warning">
                {formatCOP(
                  data.dualCreditSummary.payablesToSuppliers +
                    data.dualCreditSummary.payablesToAllies,
                )}
              </strong>
            </p>
          </div>
        </div>
      )}

      {/* Saldos Reales Acumulados por Cuenta (Efectivo Caja, Bodega, Nequi, Bancolombia...) */}
      {data && (
        <section className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">
              Saldo Disponible por Cuenta / Medio de Pago (clic para filtrar)
            </h2>
            {filterAccountId && (
              <button
                type="button"
                onClick={() => setFilterAccountId("")}
                className="text-xs font-bold text-primary hover:underline"
              >
                Ver todas las cuentas
              </button>
            )}
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {data.accountBalances.map((acc) => {
              const active = filterAccountId === acc.id;
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => {
                    haptics.tap();
                    setFilterAccountId(active ? "" : acc.id);
                  }}
                  className={`press-response solid-card flex items-center justify-between gap-3 rounded-2xl p-3.5 text-left transition ${
                    active
                      ? "border-primary bg-primary/15 ring-1 ring-primary/40"
                      : acc.isInternalVault
                        ? "border-warning/35 bg-warning/5"
                        : ""
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                        acc.isInternalVault
                          ? "bg-warning/20 text-warning"
                          : acc.countsAsPhysicalCash
                            ? "bg-success/15 text-success"
                            : "bg-primary/15 text-primary"
                      }`}
                    >
                      {acc.isInternalVault ? (
                        <Vault className="h-4 w-4" />
                      ) : acc.countsAsPhysicalCash ? (
                        <Banknote className="h-4 w-4" />
                      ) : (
                        <CreditCard className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-foreground">{acc.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {acc.isInternalVault
                          ? "Caja fuerte / Ahorro"
                          : acc.countsAsPhysicalCash
                            ? "Efectivo en caja"
                            : "Cuenta / Banco"}
                      </p>
                    </div>
                  </div>
                  <p
                    className={`shrink-0 font-display text-base font-bold tabular-nums ${
                      acc.currentBalance >= 0 ? "text-foreground" : "text-destructive"
                    }`}
                  >
                    {formatCOP(acc.currentBalance)}
                  </p>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Acciones Rápidas Manuales (Ingreso, Egreso, Traslado a Bodega/Cuentas) */}
      {canEdit && (
        <section className="solid-card space-y-3 rounded-2xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-base font-bold">Registrar Movimiento Manual</h3>
              <p className="text-xs text-muted-foreground">
                Anota ingresos, pagos/egresos o traslados internos (ej. Caja ↔ Bodega ↔ Nequi).
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openManualForm("extra")}
                className={`press-response flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold ${
                  manualMode === "extra"
                    ? "bg-success text-primary-foreground"
                    : "bg-success/15 text-success ring-1 ring-success/35"
                }`}
              >
                <Plus className="h-4 w-4" />
                Ingreso
              </button>
              <button
                type="button"
                onClick={() => openManualForm("expense")}
                className={`press-response flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold ${
                  manualMode === "expense"
                    ? "bg-destructive text-white"
                    : "bg-destructive/15 text-destructive ring-1 ring-destructive/35"
                }`}
              >
                <Plus className="h-4 w-4" />
                Egreso
              </button>
              <button
                type="button"
                onClick={() => openManualForm("transfer")}
                className={`press-response flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold ${
                  manualMode === "transfer"
                    ? "bg-warning text-primary-foreground"
                    : "bg-warning/15 text-warning ring-1 ring-warning/35"
                }`}
              >
                <ArrowLeftRight className="h-4 w-4" />
                Traslado (Bodega / Cuentas)
              </button>
            </div>
          </div>

          {manualMode !== "none" && (
            <div className="space-y-3 rounded-xl border border-white/15 bg-background/70 p-3.5">
              {manualMode !== "transfer" && (
                <div className="flex flex-wrap gap-1.5">
                  {(manualMode === "expense" ? EXPENSE_CATEGORIES : EXTRA_CATEGORIES).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setFormCategory(c.id)}
                      className={`press-response rounded-lg border px-2.5 py-1 text-xs font-bold ${
                        formCategory === c.id
                          ? "border-primary bg-primary/20 text-primary"
                          : "border-white/10 bg-card text-muted-foreground"
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid gap-2.5 sm:grid-cols-12">
                <input
                  type="text"
                  placeholder={
                    manualMode === "transfer"
                      ? "Nota (ej. Retiro de caja a Bodega, consignación a Nequi)"
                      : "Concepto del movimiento *"
                  }
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  className={`rounded-xl border border-white/15 bg-card px-3 py-2.5 text-sm ${
                    manualMode === "transfer" ? "sm:col-span-4" : "sm:col-span-5"
                  }`}
                />
                <select
                  value={formAccountId}
                  onChange={(e) => setFormAccountId(e.target.value)}
                  className={`rounded-xl border border-white/15 bg-card px-3 py-2.5 text-sm ${
                    manualMode === "transfer" ? "sm:col-span-2" : "sm:col-span-3"
                  }`}
                >
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {manualMode === "extra" ? "Entra a: " : "Sale de: "}
                      {acc.name}
                    </option>
                  ))}
                </select>
                {manualMode === "transfer" && (
                  <select
                    value={formToAccountId}
                    onChange={(e) => setFormToAccountId(e.target.value)}
                    className="rounded-xl border border-white/15 bg-card px-3 py-2.5 text-sm sm:col-span-2"
                  >
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        Hacia: {acc.name}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="number"
                  min={1}
                  placeholder="Monto COP"
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                  className="rounded-xl border border-white/15 bg-card px-3 py-2.5 text-sm font-bold tabular-nums sm:col-span-2"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSaveManual()}
                  className="press-response min-h-11 rounded-xl bg-primary px-4 text-xs font-bold text-primary-foreground disabled:opacity-50 sm:col-span-2"
                >
                  Guardar
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Histórico Unificado y Editable de Movimientos */}
      <section className="solid-card space-y-3 rounded-2xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-base font-bold">
              Histórico de Movimientos ({data?.entries.length ?? 0})
            </h3>
            <p className="text-xs text-muted-foreground">
              Los egresos, compras de stock, ingresos adicionales y traslados se pueden editar o
              corregir directamente.
            </p>
          </div>
        </div>

        {!data || data.entries.length === 0 ? (
          <p className="rounded-xl bg-background/50 p-6 text-center text-xs text-muted-foreground">
            Sin movimientos en este periodo o cuenta.
          </p>
        ) : (
          <div className="divide-y divide-white/10 rounded-xl bg-background/50 px-3 text-xs tabular-nums">
            {data.entries.map((entry) => {
              const isEditing = editingEntry?.id === entry.id;
              return (
                <div key={`${entry.entryType}-${entry.id}`} className="py-3">
                  {isEditing ? (
                    <div className="grid gap-2 sm:grid-cols-12">
                      <input
                        type="text"
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        className="rounded-lg border border-primary/50 bg-card px-2.5 py-2 text-xs sm:col-span-4"
                      />
                      <select
                        value={editAccountId}
                        onChange={(e) => setEditAccountId(e.target.value)}
                        className="rounded-lg border border-white/15 bg-card px-2 py-2 text-xs sm:col-span-2"
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      {entry.entryType === "transfer" ? (
                        <select
                          value={editToAccountId}
                          onChange={(e) => setEditToAccountId(e.target.value)}
                          className="rounded-lg border border-white/15 bg-card px-2 py-2 text-xs sm:col-span-2"
                        >
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              → {a.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <select
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value)}
                          className="rounded-lg border border-white/15 bg-card px-2 py-2 text-xs sm:col-span-2"
                        >
                          {(entry.entryType === "expense"
                            ? EXPENSE_CATEGORIES
                            : EXTRA_CATEGORIES
                          ).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      )}
                      <input
                        type="number"
                        min={1}
                        value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)}
                        className="rounded-lg border border-white/15 bg-card px-2.5 py-2 font-bold tabular-nums sm:col-span-2"
                      />
                      <div className="flex items-center justify-end gap-1.5 sm:col-span-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleSaveEdit()}
                          className="press-response flex h-9 flex-1 items-center justify-center rounded-lg bg-success text-primary-foreground"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingEntry(null)}
                          className="press-response flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-muted-foreground"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              entry.direction === "in"
                                ? "bg-success/15 text-success"
                                : entry.direction === "out"
                                  ? "bg-destructive/15 text-destructive"
                                  : "bg-warning/15 text-warning"
                            }`}
                          >
                            {entry.entryType === "sale_payment"
                              ? "Venta POS"
                              : entry.entryType === "credit_repayment"
                                ? "Abono Cartera"
                                : entry.entryType === "extra_income"
                                  ? "Ingreso"
                                  : entry.entryType === "transfer"
                                    ? "Traslado"
                                    : entry.referenceType === "inventory_purchase"
                                      ? "Compra Stock"
                                      : entry.referenceType === "supplier_payment"
                                        ? "Pago Proveedor"
                                        : "Egreso"}
                          </span>
                          <span className="truncate font-semibold text-foreground">
                            {entry.description}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          <strong className="text-foreground/85">{entry.paymentMethodName}</strong>
                          {entry.toPaymentMethodName ? ` → ${entry.toPaymentMethodName}` : ""} ·{" "}
                          {entry.userName} ·{" "}
                          {new Date(entry.createdAt).toLocaleString("es-CO", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-bold ${
                            entry.direction === "in"
                              ? "text-success"
                              : entry.direction === "out"
                                ? "text-destructive"
                                : "text-warning"
                          }`}
                        >
                          {entry.direction === "in"
                            ? `+${formatCOP(entry.amount)}`
                            : entry.direction === "out"
                              ? `-${formatCOP(entry.amount)}`
                              : formatCOP(entry.amount)}
                        </span>

                        {canEdit && entry.editable && (
                          <>
                            <button
                              type="button"
                              title="Editar movimiento"
                              onClick={() => startEdit(entry)}
                              className="press-response flex h-7 w-7 items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-primary"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              title="Eliminar movimiento"
                              onClick={() => void handleDeleteEntry(entry)}
                              className="press-response flex h-7 w-7 items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
