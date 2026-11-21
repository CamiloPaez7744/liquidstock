import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Handshake,
  History,
  Lock,
  RefreshCw,
  Users,
  Wallet,
} from "lucide-react";
import type { CashShiftClosureReport } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

type StoreType = ReturnType<typeof useLiquiStock>;
type CashTab = "current" | "credit" | "allies" | "history";

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

export function CashShiftView({ store, branchId }: { store: StoreType; branchId: string }) {
  const [tab, setTab] = useState<CashTab>("current");
  const [shiftData, setShiftData] = useState<CurrentShiftResponse["activeShift"]>(null);
  const [declaredCash, setDeclaredCash] = useState("");
  const [nextShiftFloat, setNextShiftFloat] = useState("200000");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [closedSummary, setClosedSummary] = useState<CashShiftClosureReport | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 4000);
  };

  const loadShift = useCallback(async () => {
    try {
      const res = await apiFetch<CurrentShiftResponse>(
        `/api/v1/branches/${branchId}/shifts/current`,
      );
      setShiftData(res.activeShift);
      if (res.activeShift && declaredCash === "") {
        setDeclaredCash(String(Math.round(res.activeShift.report.expectedPhysicalCash)));
      }
    } catch {
      // Offline
    }
  }, [branchId, declaredCash]);

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
    void loadShift();
  }, [loadShift, store.lastHydratedAt]);

  useEffect(() => {
    if (tab === "allies") void loadAlliesSettlements();
    if (tab === "history") void loadHistory();
  }, [tab, loadAlliesSettlements, loadHistory, store.lastHydratedAt]);

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
      await Promise.all([store.refresh(), loadShift()]);
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
      const res = await apiFetch<{ report: CashShiftClosureReport }>(
        `/api/v1/branches/${branchId}/shifts/close`,
        {
          method: "POST",
          body: JSON.stringify({
            userId: store.activeUserId,
            declaredPhysicalCash: Number(declaredCash) || 0,
            notes,
            openNextShiftFloat: Number(nextShiftFloat) || 0,
          }),
        },
      );
      haptics.success();
      setClosedSummary(res.report);
      setDeclaredCash("");
      await Promise.all([store.refresh(), loadShift(), loadHistory()]);
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
      await Promise.all([loadShift(), loadAlliesSettlements()]);
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
      await loadShift();
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
            void loadShift();
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

      {notice && (
        <div
          className={`flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold ${
            notice.kind === "ok"
              ? "border-success/40 bg-success/15 text-success"
              : "border-destructive/40 bg-destructive/15 text-destructive"
          }`}
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{notice.text}</span>
        </div>
      )}

      {/* === TAB 1: TURNO ACTUAL Y CIERRE === */}
      {tab === "current" &&
        (!shiftData ? (
          <div className="solid-card mx-auto max-w-lg space-y-4 rounded-2xl p-6 text-center">
            <Wallet className="mx-auto h-10 w-10 text-primary" />
            <h2 className="font-display text-xl font-bold">No hay turno abierto</h2>
            <p className="text-sm text-muted-foreground">
              Define la base de efectivo inicial para abrir la caja de esta sucursal.
            </p>
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
          </div>
        ) : (
          (() => {
            const r = shiftData.report;
            const declaredNum = Number(declaredCash) || 0;
            const liveDiscrepancy = declaredNum - r.expectedPhysicalCash;
            return (
              <div className="space-y-5">
                <div>
                  <h2 className="font-display text-xl font-bold">
                    Cierre de Caja (Parcial / Con Deudas)
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Turno abierto desde {new Date(shiftData.openedAt).toLocaleString("es-CO")} ·
                    Base inicial: {formatCOP(r.openingFloat)}
                  </p>
                </div>

                {closedSummary && (
                  <div className="flex items-center gap-3 rounded-2xl border border-success/40 bg-success/10 p-4 text-sm text-success">
                    <CheckCircle2 className="h-6 w-6 shrink-0" />
                    <div>
                      <p className="font-bold">
                        Turno cerrado correctamente y nuevo turno abierto.
                      </p>
                      <p className="text-xs">
                        Vendido: {formatCOP(closedSummary.totalNetSales)} · Recaudado:{" "}
                        {formatCOP(closedSummary.totalCollectedOverall)} · Aliados:{" "}
                        {formatCOP(closedSummary.totalAllyPayable)} · Fiado:{" "}
                        {formatCOP(closedSummary.totalCreditIssued)}
                      </p>
                    </div>
                  </div>
                )}

                {/* LOS 4 PILARES FINANCIEROS */}
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <div className="solid-card rounded-2xl p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      1. Total Vendido (Neto)
                    </p>
                    <p className="mt-2 font-display text-2xl font-bold tabular-nums text-foreground">
                      {formatCOP(r.totalNetSales)}
                    </p>
                    <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                      Bruto {formatCOP(r.totalGrossSales)} · Promos -{formatCOP(r.totalDiscounts)}
                    </p>
                  </div>

                  <div className="solid-card rounded-2xl border-success/30 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-success">
                      2. Recaudado Real
                    </p>
                    <p className="mt-2 font-display text-2xl font-bold tabular-nums text-success">
                      {formatCOP(r.totalCollectedOverall)}
                    </p>
                    <div className="mt-2 space-y-1 text-xs tabular-nums">
                      {r.paymentBreakdown.length === 0 ? (
                        <p className="text-muted-foreground">Sin pagos aún en este turno</p>
                      ) : (
                        r.paymentBreakdown.map((pm) => (
                          <div key={pm.paymentMethodId} className="flex justify-between">
                            <span className="text-muted-foreground">{pm.paymentMethodName}</span>
                            <span className="font-semibold">{formatCOP(pm.totalCollected)}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="solid-card rounded-2xl border-warning/30 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-warning">
                      3. Saldo a Pagar a Aliados
                    </p>
                    <p className="mt-2 font-display text-2xl font-bold tabular-nums text-warning">
                      {formatCOP(r.totalAllyPayable)}
                    </p>
                    <div className="mt-2 space-y-1.5 text-xs">
                      {r.allyPayablesByAlly.length === 0 ? (
                        <p className="text-muted-foreground">Sin saldo pendiente en este turno</p>
                      ) : (
                        r.allyPayablesByAlly.map((ally) => (
                          <div key={ally.allyId} className="flex items-center justify-between gap-2">
                            <span className="truncate text-foreground">
                              {ally.allyName}:{" "}
                              <strong className="tabular-nums">{formatCOP(ally.amount)}</strong>
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleSettleAlly(ally.allyId, ally.allyName)}
                              className="press-response shrink-0 rounded-lg bg-warning/20 px-2 py-1 text-[10px] font-bold text-warning"
                            >
                              Liquidar
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="solid-card rounded-2xl border-accent/30 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                      4. Saldo Pendiente (Fiado)
                    </p>
                    <p className="mt-2 font-display text-2xl font-bold tabular-nums text-accent">
                      {formatCOP(r.totalCreditIssued)}
                    </p>
                    <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                      Abonos recuperados: +{formatCOP(r.totalCreditRecovered)}
                    </p>
                  </div>
                </div>

                {/* Arqueo de Efectivo y Confirmación de Cierre */}
                <div className="solid-card space-y-4 rounded-2xl p-5">
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="rounded-xl bg-background/60 p-3.5 tabular-nums">
                      <p className="text-xs text-muted-foreground">Efectivo esperado en cajón</p>
                      <p className="mt-1 text-xl font-bold text-primary">
                        {formatCOP(r.expectedPhysicalCash)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Base ({formatCOP(r.openingFloat)}) + Ventas/Abonos en Efectivo
                      </p>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                        Efectivo contado físicamente (COP)
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={declaredCash}
                        onChange={(e) => setDeclaredCash(e.target.value)}
                        className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-3 text-lg font-bold tabular-nums text-foreground focus:border-primary focus:outline-none"
                      />
                      <p
                        className={`mt-1 text-xs font-bold tabular-nums ${
                          Math.abs(liveDiscrepancy) < 1
                            ? "text-success"
                            : liveDiscrepancy < 0
                              ? "text-destructive"
                              : "text-warning"
                        }`}
                      >
                        {Math.abs(liveDiscrepancy) < 1
                          ? "Cuadre exacto (+$0)"
                          : liveDiscrepancy < 0
                            ? `Faltante: ${formatCOP(liveDiscrepancy)}`
                            : `Sobrante: +${formatCOP(liveDiscrepancy)}`}
                      </p>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                        Base para siguiente turno (COP)
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={nextShiftFloat}
                        onChange={(e) => setNextShiftFloat(e.target.value)}
                        className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-3 text-lg font-bold tabular-nums text-foreground focus:border-primary focus:outline-none"
                      />
                    </div>
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

                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      type="text"
                      placeholder="Notas del cierre (ej. cambio de turno sin novedades)..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      className="min-w-60 flex-1 rounded-xl border border-white/15 bg-background px-3.5 py-3 text-sm"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleCloseShift}
                      className="press-response flex min-h-13 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-bold text-primary-foreground disabled:opacity-50"
                    >
                      <Lock className="h-4 w-4" />
                      Confirmar Cierre de Turno
                    </button>
                  </div>
                </div>
              </div>
            );
          })()
        ))}

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
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleSettleAlly(group.allyId, group.allyName)}
                          className="press-response flex items-center gap-1 rounded-xl bg-warning px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
                        >
                          <Handshake className="h-3.5 w-3.5" />
                          Marcar Pagado
                        </button>
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
