import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Banknote,
  CheckCircle2,
  CreditCard,
  Eye,
  Handshake,
  History,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  Unlock,
  Users,
  Vault,
  Wallet,
} from "lucide-react";
import type { CashShiftClosureReport } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { useFeedback } from "../../shared/components/FeedbackProvider.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

type StoreType = ReturnType<typeof useLiquiStock>;
type CashTab = "shift" | "accounts" | "history";
type ExpenseCategory = "servicios" | "insumos" | "nomina" | "mantenimiento" | "transporte" | "otro";
type ExtraCategory = "cover" | "danos" | "propina" | "alquiler" | "ajuste" | "otro";

const EXPENSE_CATEGORIES: Array<{ id: ExpenseCategory; label: string }> = [
  { id: "servicios", label: "Servicios" },
  { id: "insumos", label: "Insumos / Hielo" },
  { id: "nomina", label: "Turnos / DJ" },
  { id: "mantenimiento", label: "Aseo / Mant." },
  { id: "transporte", label: "Domicilio / Transp." },
  { id: "otro", label: "Otro egreso" },
];

const EXTRA_CATEGORIES: Array<{ id: ExtraCategory; label: string }> = [
  { id: "cover", label: "Cover / Entradas" },
  { id: "danos", label: "Vaso roto / Daño" },
  { id: "propina", label: "Propinas" },
  { id: "alquiler", label: "Alquiler / Evento" },
  { id: "ajuste", label: "Base / Ajuste" },
  { id: "otro", label: "Otro ingreso" },
];

interface ShiftQuickMovement {
  id: string;
  paymentMethodId: string;
  paymentMethodName: string;
  countsAsPhysicalCash: boolean;
  category: string;
  description: string;
  amount: number;
  createdAt: string;
  userName: string;
}

interface CurrentShiftResponse {
  activeShift: {
    shiftId: string;
    status: string;
    openedAt: string;
    hoursOpen: number;
    isExpired24h: boolean;
    expectedOpeningFloat: number;
    openingDiscrepancy: number;
    openTablesCount: number;
    openTablesPendingAmount: number;
    emptyOpenAccountsCount: number;
    shiftExpenses: ShiftQuickMovement[];
    shiftExtras: ShiftQuickMovement[];
    report: CashShiftClosureReport;
  } | null;
  lastClosedCashLeft: number;
  vaultAccount: { id: string; name: string } | null;
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

interface SupplierPayableRow {
  id: string;
  supplierName: string;
  description: string;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  status: "pending" | "partial" | "paid";
  createdByName: string;
  createdAt: string;
  payments: Array<{
    id: string;
    paymentMethodName: string;
    amount: number;
    notes: string | null;
    createdByName: string;
    createdAt: string;
  }>;
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

interface ClosedShiftRow {
  id: string;
  openedAt: string;
  closedAt: string;
  openedByName: string;
  closedByName: string | null;
  openingFloat: number;
  expectedOpeningFloat: number;
  openingDiscrepancy: number;
  transferToVaultAmount: number;
  closingCashLeft: number | null;
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

export function CashShiftView({
  store,
  branchId,
  canEdit = true,
  canEditFinance = false,
  isAdmin = false,
}: {
  store: StoreType;
  branchId: string;
  canEdit?: boolean;
  canEditFinance?: boolean;
  isAdmin?: boolean;
}) {
  const { toast } = useFeedback();
  const [tab, setTab] = useState<CashTab>("shift");
  const [shiftState, setShiftState] = useState<CurrentShiftResponse | null>(null);
  const [busy, setBusy] = useState(false);

  // Apertura de caja
  const [openFloatInput, setOpenFloatInput] = useState("");
  const [openNotes, setOpenNotes] = useState("");

  // Cierre de caja minimalista + Bodega
  const [declaredCash, setDeclaredCash] = useState("");
  const [transferToVault, setTransferToVault] = useState("0");
  const [openNextShift, setOpenNextShift] = useState(false);
  const [closeNotes, setCloseNotes] = useState("");
  const [closedBanner, setClosedBanner] = useState<{
    report: CashShiftClosureReport;
    transferToVaultAmount: number;
    closingCashLeft: number;
    cleanedEmptyTablesCount: number;
  } | null>(null);

  // Registro rápido de gasto / ingreso adicional del turno
  const [quickForm, setQuickForm] = useState<"none" | "expense" | "extra">("none");
  const [quickCategory, setQuickCategory] = useState("servicios");
  const [quickMethodId, setQuickMethodId] = useState("");
  const [quickDesc, setQuickDesc] = useState("");
  const [quickAmount, setQuickAmount] = useState("");

  // Cartera Dual (Nos deben + Debemos Proveedores + Aliados)
  const [repayCustomerId, setRepayCustomerId] = useState<string | null>(null);
  const [repayAmount, setRepayAmount] = useState("");
  const [repayMethodId, setRepayMethodId] = useState("");
  const [repayNotes, setRepayNotes] = useState("");
  const [ledgerCustomerId, setLedgerCustomerId] = useState<string | null>(null);
  const [ledgerRows, setLedgerRows] = useState<CustomerLedgerRow[]>([]);

  const [payables, setPayables] = useState<SupplierPayableRow[]>([]);
  const [paySupplierId, setPaySupplierId] = useState<string | null>(null);
  const [paySupplierAmount, setPaySupplierAmount] = useState("");
  const [paySupplierMethodId, setPaySupplierMethodId] = useState("");
  const [paySupplierNotes, setPaySupplierNotes] = useState("");

  const [allyPending, setAllyPending] = useState<AllyPendingGroup[]>([]);
  const [shiftHistory, setShiftHistory] = useState<ClosedShiftRow[]>([]);

  const treasuryAccounts =
    store.treasuryAccounts.length > 0 ? store.treasuryAccounts : store.paymentMethods;

  const notify = (kind: "ok" | "err", text: string) => {
    toast({
      kind: kind === "ok" ? "success" : "error",
      title: kind === "ok" ? "Caja actualizada" : "Atención",
      description: text,
    });
  };

  const loadShift = useCallback(async () => {
    try {
      const res = await apiFetch<CurrentShiftResponse>(
        `/api/v1/branches/${branchId}/shifts/current`,
      );
      setShiftState(res);
      if (res.activeShift) {
        setDeclaredCash((prev) =>
          prev === "" ? String(Math.round(res.activeShift!.report.expectedPhysicalCash)) : prev,
        );
      } else {
        setOpenFloatInput((prev) =>
          prev === "" ? String(Math.round(res.lastClosedCashLeft ?? 0)) : prev,
        );
      }
    } catch {
      // Offline
    }
  }, [branchId]);

  const loadDualAccounts = useCallback(async () => {
    try {
      const [supRes, allyRes] = await Promise.all([
        apiFetch<{ payables: SupplierPayableRow[] }>(
          `/api/v1/branches/${branchId}/supplier-payables`,
        ),
        apiFetch<{ pendingByAlly: AllyPendingGroup[] }>(
          `/api/v1/branches/${branchId}/allies/settlements`,
        ),
      ]);
      setPayables(supRes.payables ?? []);
      setAllyPending(allyRes.pendingByAlly ?? []);
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
    if (tab === "accounts") void loadDualAccounts();
    if (tab === "history") void loadHistory();
  }, [tab, loadDualAccounts, loadHistory, store.lastHydratedAt]);

  const activeShift = shiftState?.activeShift ?? null;
  const expectedCarryover = shiftState?.lastClosedCashLeft ?? 0;
  const openFloatNum = Number(openFloatInput) || 0;
  const previewOpenDiff = Math.round((openFloatNum - expectedCarryover) * 100) / 100;

  const declaredCashNum = Number(declaredCash) || 0;
  const transferVaultNum = Math.min(declaredCashNum, Math.max(0, Number(transferToVault) || 0));
  const cashLeftAfterClose = Math.max(0, Math.round((declaredCashNum - transferVaultNum) * 100) / 100);
  const closeDiff = activeShift
    ? Math.round((declaredCashNum - activeShift.report.expectedPhysicalCash) * 100) / 100
    : 0;

  const handleOpenShift = async () => {
    if (!canEdit || busy) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ id: string; openingDiscrepancy: number }>(
        `/api/v1/branches/${branchId}/shifts/open`,
        {
          method: "POST",
          body: JSON.stringify({
            openingFloat: Math.max(0, openFloatNum),
            notes: openNotes.trim() || undefined,
          }),
        },
      );
      haptics.success();
      setOpenNotes("");
      setDeclaredCash("");
      setTransferToVault("0");
      setClosedBanner(null);
      await Promise.all([loadShift(), store.refresh()]);
      notify(
        "ok",
        Math.abs(res.openingDiscrepancy) > 0.5
          ? `Caja abierta con diferencia de apertura de ${formatCOP(res.openingDiscrepancy)}`
          : "Caja abierta correctamente · Ya puedes vender en el POS.",
      );
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo abrir la caja");
    } finally {
      setBusy(false);
    }
  };

  const handleCloseShift = async () => {
    if (!canEdit || !activeShift || busy) return;
    setBusy(true);
    try {
      const res = await apiFetch<{
        report: CashShiftClosureReport;
        transferToVaultAmount: number;
        closingCashLeft: number;
        cleanedEmptyTablesCount: number;
      }>(`/api/v1/branches/${branchId}/shifts/close`, {
        method: "POST",
        body: JSON.stringify({
          declaredPhysicalCash: Math.max(0, declaredCashNum),
          transferToVaultAmount: transferVaultNum,
          notes: closeNotes.trim() || undefined,
          ...(openNextShift ? { openNextShiftFloat: cashLeftAfterClose } : {}),
        }),
      });
      haptics.success();
      setClosedBanner(res);
      setCloseNotes("");
      setDeclaredCash("");
      setTransferToVault("0");
      setOpenFloatInput(String(Math.round(res.closingCashLeft)));
      await Promise.all([loadShift(), loadHistory(), store.refresh()]);
      notify(
        "ok",
        res.transferToVaultAmount > 0
          ? `Turno cerrado · ${formatCOP(res.transferToVaultAmount)} trasladado a Bodega`
          : "Turno cerrado correctamente.",
      );
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo cerrar el turno");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveQuickMovement = async () => {
    const pmId = quickMethodId || store.paymentMethods[0]?.id;
    const amt = Number(quickAmount);
    if (!pmId || !quickDesc.trim() || !amt || amt <= 0) {
      notify("err", "Escribe concepto, monto mayor a $0 y medio de pago.");
      return;
    }
    setBusy(true);
    try {
      const endpoint = quickForm === "expense" ? "cash-expenses" : "cash-extras";
      await apiFetch(`/api/v1/branches/${branchId}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify({
          paymentMethodId: pmId,
          category: quickCategory,
          description: quickDesc.trim(),
          amount: amt,
        }),
      });
      haptics.success();
      setQuickDesc("");
      setQuickAmount("");
      setQuickForm("none");
      await loadShift();
      notify(
        "ok",
        quickForm === "expense"
          ? `Egreso registrado: -${formatCOP(amt)}`
          : `Ingreso adicional registrado: +${formatCOP(amt)}`,
      );
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo guardar el movimiento");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteQuick = async (kind: "expense" | "extra", id: string) => {
    setBusy(true);
    try {
      await apiFetch(
        `/api/v1/branches/${branchId}/${kind === "expense" ? "cash-expenses" : "cash-extras"}/${id}`,
        { method: "DELETE" },
      );
      haptics.tap();
      await loadShift();
      notify("ok", "Movimiento eliminado");
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo eliminar");
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
      notify("err", "Ingresa un monto válido y medio de pago.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{ customerName: string; remainingDebt: number }>(
        `/api/v1/branches/${branchId}/customers/${customerId}/repayments`,
        {
          method: "POST",
          body: JSON.stringify({
            paymentMethodId: pmId,
            amount: amt,
            notes: repayNotes.trim() || undefined,
          }),
        },
      );
      haptics.success();
      setRepayCustomerId(null);
      setRepayAmount("");
      setRepayNotes("");
      await Promise.all([store.refresh(), loadShift()]);
      notify("ok", `Abono de ${res.customerName} registrado · Saldo: ${formatCOP(res.remainingDebt)}`);
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo registrar el abono");
    } finally {
      setBusy(false);
    }
  };

  const handlePaySupplier = async (payableId: string) => {
    const pmId = paySupplierMethodId || treasuryAccounts[0]?.id;
    const amt = Number(paySupplierAmount);
    if (!pmId || !amt || amt <= 0) {
      notify("err", "Ingresa monto y cuenta de salida.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/supplier-payables/${payableId}/payments`, {
        method: "POST",
        body: JSON.stringify({
          paymentMethodId: pmId,
          amount: amt,
          notes: paySupplierNotes.trim() || undefined,
        }),
      });
      haptics.success();
      setPaySupplierId(null);
      setPaySupplierAmount("");
      setPaySupplierNotes("");
      await Promise.all([loadDualAccounts(), loadShift()]);
      notify("ok", `Pago a proveedor registrado: ${formatCOP(amt)}`);
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo registrar el pago");
    } finally {
      setBusy(false);
    }
  };

  const handleSettleAlly = async (allyId: string, allyName: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/allies/${allyId}/settle`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      haptics.success();
      await Promise.all([loadDualAccounts(), loadShift()]);
      notify("ok", `Liquidación de ${allyName} marcada como pagada`);
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo liquidar el aliado");
    } finally {
      setBusy(false);
    }
  };

  const debtors = store.customers.filter((c) => c.currentDebt > 0);
  const totalCustomerDebt = debtors.reduce((acc, c) => acc + c.currentDebt, 0);
  const openPayables = payables.filter((p) => p.status !== "paid");
  const totalSupplierDebt = openPayables.reduce((acc, p) => acc + p.remainingAmount, 0);
  const totalAllyDebt = allyPending.reduce((acc, a) => acc + a.totalPending, 0);

  return (
    <div className="space-y-5 pb-10">
      {/* Cabecera minimalista + 3 pestañas limpias */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight sm:text-2xl">
            Caja & Turno
          </h1>
          <p className="text-xs text-muted-foreground">
            Apertura obligatoria, movimientos del turno, traslado a Bodega y cartera dual
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: "shift", label: "Mi Turno", icon: Wallet },
              {
                id: "accounts",
                label: `Cuentas (${debtors.length + openPayables.length + allyPending.length})`,
                icon: Users,
              },
              { id: "history", label: "Historial", icon: History },
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  haptics.tap();
                  setTab(t.id);
                }}
                className={`press-response flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold ${
                  tab === t.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => void Promise.all([loadShift(), loadDualAccounts(), loadHistory()])}
            className="press-response flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!canEdit && (
        <div className="flex items-center gap-2 rounded-2xl border border-warning/35 bg-warning/10 px-4 py-2.5 text-xs font-semibold text-warning">
          <Eye className="h-4 w-4 shrink-0" />
          <span>Modo solo vista: puedes consultar turno, cartera e historial sin abrir ni cerrar caja.</span>
        </div>
      )}

      {/* === TAB 1: MI TURNO (MINIMALISTA: APERTURA O TURNO ACTIVO + CIERRE CON BODEGA) === */}
      {tab === "shift" && (
        <div className="space-y-4">
          {closedBanner && (
            <div className="flex items-start gap-3 rounded-2xl border border-success/40 bg-success/10 p-4 text-sm text-success">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="space-y-0.5">
                <p className="font-bold">Turno cerrado correctamente.</p>
                <p className="text-xs tabular-nums">
                  Vendido: {formatCOP(closedBanner.report.totalNetSales)} · En Bodega:{" "}
                  {formatCOP(closedBanner.transferToVaultAmount)} · Quedó en caja:{" "}
                  {formatCOP(closedBanner.closingCashLeft)}
                  {closedBanner.cleanedEmptyTablesCount > 0
                    ? ` · ${closedBanner.cleanedEmptyTablesCount} mesa(s) en $0 limpiadas`
                    : ""}
                </p>
              </div>
            </div>
          )}

          {!activeShift ? (
            /* ESTADO 1: CAJA CERRADA -> APERTURA OBLIGATORIA */
            <div className="solid-card mx-auto max-w-xl space-y-4 rounded-3xl border-primary/35 p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                  <Unlock className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold">Apertura de Caja</h2>
                  <p className="text-xs text-muted-foreground">
                    Cuenta el efectivo inicial en caja para habilitar ventas en el POS.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-2xl bg-background/70 px-4 py-3 text-xs">
                <span className="text-muted-foreground">Efectivo dejado en el cierre anterior:</span>
                <strong className="font-display text-base tabular-nums text-primary">
                  {formatCOP(expectedCarryover)}
                </strong>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                    Efectivo contado al abrir caja (Base inicial COP) *
                  </label>
                  <input
                    type="number"
                    min={0}
                    disabled={!canEdit}
                    value={openFloatInput}
                    onChange={(e) => setOpenFloatInput(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-4 py-3 text-lg font-bold tabular-nums text-foreground focus:border-primary focus:outline-none"
                  />
                </div>

                {Math.abs(previewOpenDiff) >= 1 && (
                  <div
                    className={`flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-xs font-bold tabular-nums ${
                      previewOpenDiff < 0
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-warning/40 bg-warning/10 text-warning"
                    }`}
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>
                      Diferencia frente al cierre anterior:{" "}
                      {previewOpenDiff > 0 ? `+${formatCOP(previewOpenDiff)}` : formatCOP(previewOpenDiff)}
                      {" "}(quedará registrada en auditoría)
                    </span>
                  </div>
                )}

                <div>
                  <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                    Observación de apertura (opcional)
                  </label>
                  <input
                    type="text"
                    disabled={!canEdit}
                    placeholder="Ej. Base verificada turno noche"
                    value={openNotes}
                    onChange={(e) => setOpenNotes(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-2.5 text-sm"
                  />
                </div>

                <button
                  type="button"
                  disabled={!canEdit || busy}
                  onClick={() => void handleOpenShift()}
                  className="press-response flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl bg-success px-5 text-sm font-bold text-primary-foreground disabled:opacity-50"
                >
                  <Unlock className="h-4 w-4" />
                  Abrir Caja e Iniciar Ventas
                </button>
              </div>
            </div>
          ) : (
            /* ESTADO 2: TURNO ABIERTO -> RESUMEN SIMPLE + GASTO/ADICIONAL + CIERRE CON BODEGA */
            <>
              {activeShift.isExpired24h && (
                <div className="flex items-center gap-2.5 rounded-2xl border border-destructive/45 bg-destructive/15 px-4 py-3 text-xs font-bold text-destructive">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                  <span>
                    Este turno lleva {activeShift.hoursOpen} horas abierto (&gt;24h). Las ventas en
                    el POS están bloqueadas hasta cerrar este turno y abrir uno nuevo.
                  </span>
                </div>
              )}

              {Math.abs(activeShift.openingDiscrepancy) >= 1 && (
                <div className="flex items-center gap-2 rounded-2xl border border-warning/35 bg-warning/10 px-4 py-2 text-xs text-warning">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>
                    Este turno abrió con {formatCOP(activeShift.report.openingFloat)} (diferencia
                    de apertura:{" "}
                    <strong>
                      {activeShift.openingDiscrepancy > 0
                        ? `+${formatCOP(activeShift.openingDiscrepancy)}`
                        : formatCOP(activeShift.openingDiscrepancy)}
                    </strong>
                    ).
                  </span>
                </div>
              )}

              {/* 3 KPIs esenciales del turno actual */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="solid-card rounded-2xl p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Vendido Neto (Este Turno)
                  </p>
                  <p className="mt-1.5 font-display text-2xl font-bold tabular-nums text-foreground">
                    {formatCOP(activeShift.report.totalNetSales)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Abierto{" "}
                    {new Date(activeShift.openedAt).toLocaleTimeString("es-CO", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    ({activeShift.hoursOpen}h)
                  </p>
                </div>

                <div className="solid-card rounded-2xl border-success/30 p-4">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-success">
                    <Banknote className="h-3.5 w-3.5" />
                    Efectivo Esperado en Caja
                  </p>
                  <p className="mt-1.5 font-display text-2xl font-bold tabular-nums text-success">
                    {formatCOP(activeShift.report.expectedPhysicalCash)}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    Base {formatCOP(activeShift.report.openingFloat)} · Recaudado total{" "}
                    {formatCOP(activeShift.report.totalCollectedOverall)}
                  </p>
                </div>

                <div className="solid-card rounded-2xl p-4">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                    <CreditCard className="h-3.5 w-3.5" />
                    Medios Digitales y Fiado
                  </p>
                  <div className="mt-1.5 space-y-1 text-xs tabular-nums">
                    {activeShift.report.paymentBreakdown
                      .filter((m) => !m.countsAsPhysicalCash)
                      .map((m) => (
                        <div key={m.paymentMethodId} className="flex justify-between">
                          <span className="text-muted-foreground">{m.paymentMethodName}</span>
                          <span className="font-bold text-foreground">
                            {formatCOP(m.totalCollected)}
                          </span>
                        </div>
                      ))}
                    {activeShift.report.totalCreditIssued > 0 && (
                      <div className="flex justify-between text-warning">
                        <span>Fiado en turno</span>
                        <span className="font-bold">
                          {formatCOP(activeShift.report.totalCreditIssued)}
                        </span>
                      </div>
                    )}
                    {activeShift.report.paymentBreakdown.filter((m) => !m.countsAsPhysicalCash)
                      .length === 0 &&
                      activeShift.report.totalCreditIssued === 0 && (
                        <p className="text-muted-foreground">Sin movimientos digitales aún.</p>
                      )}
                  </div>
                </div>
              </div>

              {/* Movimientos rápidos del turno (Gasto / Ingreso adicional) */}
              <div className="solid-card space-y-3 rounded-2xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-display text-sm font-bold">
                      Gastos e Ingresos Adicionales de Este Turno
                    </h3>
                    <p className="text-[11px] text-muted-foreground">
                      Anota compras rápidas (hielo, domicilio) o entradas extra (cover, daño) del
                      turno.
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          haptics.tap();
                          setQuickForm((v) => (v === "extra" ? "none" : "extra"));
                          setQuickCategory("otro");
                          setQuickMethodId(store.paymentMethods[0]?.id ?? "");
                        }}
                        className="press-response flex min-h-9 items-center gap-1 rounded-xl bg-success/15 px-3 text-xs font-bold text-success ring-1 ring-success/30"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Ingreso Adicional
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          haptics.tap();
                          setQuickForm((v) => (v === "expense" ? "none" : "expense"));
                          setQuickCategory("insumos");
                          setQuickMethodId(store.paymentMethods[0]?.id ?? "");
                        }}
                        className="press-response flex min-h-9 items-center gap-1 rounded-xl bg-destructive/15 px-3 text-xs font-bold text-destructive ring-1 ring-destructive/30"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Gasto / Egreso
                      </button>
                    </div>
                  )}
                </div>

                {canEdit && quickForm !== "none" && (
                  <div className="space-y-2.5 rounded-xl border border-white/15 bg-background/70 p-3">
                    <div className="flex flex-wrap gap-1.5">
                      {(quickForm === "expense" ? EXPENSE_CATEGORIES : EXTRA_CATEGORIES).map(
                        (c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setQuickCategory(c.id)}
                            className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold ${
                              quickCategory === c.id
                                ? "border-primary bg-primary/20 text-primary"
                                : "border-white/10 bg-card text-muted-foreground"
                            }`}
                          >
                            {c.label}
                          </button>
                        ),
                      )}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-12">
                      <input
                        type="text"
                        placeholder="Concepto *"
                        value={quickDesc}
                        onChange={(e) => setQuickDesc(e.target.value)}
                        className="rounded-xl border border-white/15 bg-card px-3 py-2 text-xs sm:col-span-5"
                      />
                      <select
                        value={quickMethodId || store.paymentMethods[0]?.id || ""}
                        onChange={(e) => setQuickMethodId(e.target.value)}
                        className="rounded-xl border border-white/15 bg-card px-2.5 py-2 text-xs sm:col-span-3"
                      >
                        {store.paymentMethods.map((pm) => (
                          <option key={pm.id} value={pm.id}>
                            {pm.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={1}
                        placeholder="Monto COP"
                        value={quickAmount}
                        onChange={(e) => setQuickAmount(e.target.value)}
                        className="rounded-xl border border-white/15 bg-card px-3 py-2 text-xs font-bold tabular-nums sm:col-span-2"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSaveQuickMovement()}
                        className="press-response rounded-xl bg-primary px-3 py-2 text-xs font-bold text-primary-foreground sm:col-span-2"
                      >
                        Guardar
                      </button>
                    </div>
                  </div>
                )}

                {(activeShift.shiftExtras.length > 0 || activeShift.shiftExpenses.length > 0) && (
                  <div className="divide-y divide-white/10 rounded-xl bg-background/50 px-3 text-xs tabular-nums">
                    {activeShift.shiftExtras.map((ext) => (
                      <div key={ext.id} className="flex items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-foreground">
                            <ArrowUpCircle className="mr-1 inline h-3.5 w-3.5 text-success" />
                            {ext.description}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {ext.paymentMethodName} · {ext.userName}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-success">+{formatCOP(ext.amount)}</span>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => void handleDeleteQuick("extra", ext.id)}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    {activeShift.shiftExpenses.map((exp) => (
                      <div key={exp.id} className="flex items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-foreground">
                            <ArrowDownCircle className="mr-1 inline h-3.5 w-3.5 text-destructive" />
                            {exp.description}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {exp.paymentMethodName} · {exp.userName}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-destructive">
                            -{formatCOP(exp.amount)}
                          </span>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => void handleDeleteQuick("expense", exp.id)}
                              className="text-muted-foreground hover:text-destructive"
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

              {/* Cierre de Turno Minimalista + Traslado a Bodega + Limpieza de mesas $0 */}
              {canEdit && (
                <div className="solid-card space-y-4 rounded-2xl border-primary/30 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Lock className="h-5 w-5 text-primary" />
                      <div>
                        <h3 className="font-display text-base font-bold">Cerrar Turno de Caja</h3>
                        <p className="text-xs text-muted-foreground">
                          Cuenta el efectivo físico, decide cuánto pasa a Bodega y cierra el turno.
                        </p>
                      </div>
                    </div>
                  </div>

                  {(activeShift.emptyOpenAccountsCount > 0 || activeShift.openTablesCount > 0) && (
                    <div className="flex flex-wrap gap-2 text-xs">
                      {activeShift.emptyOpenAccountsCount > 0 && (
                        <span className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-1.5 font-semibold text-primary">
                          {activeShift.emptyOpenAccountsCount} mesa(s) abierta(s) en $0 se limpiarán
                          automáticamente al cerrar
                        </span>
                      )}
                      {activeShift.openTablesPendingAmount > 0 && (
                        <span className="rounded-xl border border-warning/35 bg-warning/10 px-3 py-1.5 font-semibold text-warning">
                          Mesas con consumo ({formatCOP(activeShift.openTablesPendingAmount)})
                          seguirán activas para el siguiente turno
                        </span>
                      )}
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                        Efectivo contado en caja (COP)
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={declaredCash}
                        onChange={(e) => setDeclaredCash(e.target.value)}
                        className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-2.5 text-base font-bold tabular-nums"
                      />
                      <p
                        className={`mt-1 text-xs font-bold tabular-nums ${
                          Math.abs(closeDiff) < 1
                            ? "text-success"
                            : closeDiff < 0
                              ? "text-destructive"
                              : "text-warning"
                        }`}
                      >
                        {Math.abs(closeDiff) < 1
                          ? "Efectivo cuadrado exacto"
                          : closeDiff < 0
                            ? `Faltante en efectivo: ${formatCOP(closeDiff)}`
                            : `Sobrante en efectivo: +${formatCOP(closeDiff)}`}
                      </p>
                    </div>

                    <div>
                      <label className="mb-1 flex items-center gap-1 text-xs font-semibold text-warning">
                        <Vault className="h-3.5 w-3.5" />
                        Llevar a Bodega / Caja Fuerte (opcional)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={declaredCashNum}
                        value={transferToVault}
                        onChange={(e) => setTransferToVault(e.target.value)}
                        className="w-full rounded-xl border border-warning/35 bg-background px-3.5 py-2.5 text-base font-bold tabular-nums text-warning"
                      />
                      <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                        Queda en caja para la próxima apertura:{" "}
                        <strong className="text-foreground">{formatCOP(cashLeftAfterClose)}</strong>
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={openNextShift}
                        onChange={(e) => setOpenNextShift(e.target.checked)}
                        className="h-4 w-4 accent-primary"
                      />
                      Abrir el siguiente turno inmediatamente con {formatCOP(cashLeftAfterClose)}{" "}
                      (cambio de turno en el mismo día)
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <input
                      type="text"
                      placeholder="Notas del cierre (opcional)"
                      value={closeNotes}
                      onChange={(e) => setCloseNotes(e.target.value)}
                      className="min-w-52 flex-1 rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleCloseShift()}
                      className="press-response flex min-h-11 items-center gap-2 rounded-xl bg-primary px-6 text-sm font-bold text-primary-foreground disabled:opacity-50"
                    >
                      <Lock className="h-4 w-4" />
                      {openNextShift ? "Cerrar y Abrir Nuevo Turno" : "Cerrar Turno de Caja"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* === TAB 2: CUENTAS — CARTERA DUAL (NOS DEBEN vs DEBEMOS PROVEEDORES & ALIADOS) === */}
      {tab === "accounts" && (
        <div className="space-y-5">
          {/* Resumen Dual */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="solid-card rounded-2xl border-success/35 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-success">
                Nos Deben (Clientes Fiados)
              </p>
              <p className="mt-1 font-display text-2xl font-bold tabular-nums text-success">
                {formatCOP(totalCustomerDebt)}
              </p>
              <p className="text-xs text-muted-foreground">{debtors.length} cliente(s) con saldo</p>
            </div>
            <div className="solid-card rounded-2xl border-warning/35 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-warning">
                Debemos (Proveedores Stock + Aliados)
              </p>
              <p className="mt-1 font-display text-2xl font-bold tabular-nums text-warning">
                {formatCOP(totalSupplierDebt + totalAllyDebt)}
              </p>
              <p className="text-xs tabular-nums text-muted-foreground">
                Proveedores: {formatCOP(totalSupplierDebt)} · Aliados: {formatCOP(totalAllyDebt)}
              </p>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* Columna Izquierda: NOS DEBEN (Clientes) */}
            <section className="solid-card space-y-3 rounded-2xl p-4">
              <h3 className="flex items-center gap-2 font-display text-base font-bold text-success">
                <Users className="h-4 w-4" />
                Nos Deben · Cartera Clientes
              </h3>
              {debtors.length === 0 ? (
                <p className="rounded-xl bg-background/50 p-5 text-center text-xs text-muted-foreground">
                  Ningún cliente tiene saldo pendiente.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {debtors.map((c) => (
                    <div
                      key={c.id}
                      className="space-y-2 rounded-xl border border-white/10 bg-background/60 p-3 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="font-bold text-foreground">{c.fullName}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {c.nickname ? `${c.nickname} · ` : ""}
                            {c.phone ?? "Sin teléfono"}
                          </p>
                        </div>
                        <div className="text-right tabular-nums">
                          <p className="text-sm font-bold text-success">
                            {formatCOP(c.currentDebt)}
                          </p>
                          <div className="mt-1 flex justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => void loadCustomerLedger(c.id)}
                              className="rounded-lg bg-secondary px-2 py-1 text-[10px] font-bold text-muted-foreground"
                            >
                              Extracto
                            </button>
                            {canEdit && (
                              <button
                                type="button"
                                onClick={() => {
                                  setRepayCustomerId(repayCustomerId === c.id ? null : c.id);
                                  setRepayAmount(String(Math.round(c.currentDebt)));
                                  setRepayMethodId(store.paymentMethods[0]?.id ?? "");
                                }}
                                className="rounded-lg bg-success/20 px-2.5 py-1 text-[10px] font-bold text-success"
                              >
                                Abonar
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {repayCustomerId === c.id && (
                        <div className="grid gap-2 border-t border-white/10 pt-2 sm:grid-cols-3">
                          <input
                            type="number"
                            min={1}
                            value={repayAmount}
                            onChange={(e) => setRepayAmount(e.target.value)}
                            className="rounded-lg border border-white/15 bg-card px-2.5 py-1.5 font-bold tabular-nums"
                          />
                          <select
                            value={repayMethodId || store.paymentMethods[0]?.id || ""}
                            onChange={(e) => setRepayMethodId(e.target.value)}
                            className="rounded-lg border border-white/15 bg-card px-2 py-1.5"
                          >
                            {store.paymentMethods.map((pm) => (
                              <option key={pm.id} value={pm.id}>
                                {pm.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRegisterRepayment(c.id)}
                            className="rounded-lg bg-success px-3 py-1.5 font-bold text-primary-foreground"
                          >
                            Confirmar Abono
                          </button>
                        </div>
                      )}

                      {ledgerCustomerId === c.id && (
                        <div className="divide-y divide-white/10 rounded-lg bg-card/80 px-2.5 text-[11px] tabular-nums">
                          {ledgerRows.map((row) => (
                            <div key={row.id} className="flex justify-between py-1.5">
                              <span>
                                {row.entryType === "repayment" ? "Abono" : "Cargo"} ·{" "}
                                {row.paymentMethodName ?? row.notes ?? ""}
                              </span>
                              <span
                                className={
                                  row.entryType === "repayment"
                                    ? "font-bold text-success"
                                    : "font-bold text-warning"
                                }
                              >
                                {row.entryType === "repayment" ? "-" : "+"}
                                {formatCOP(Math.abs(row.amountDelta))}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Columna Derecha: DEBEMOS (Proveedores de Stock + Aliados) */}
            <section className="space-y-4">
              <div className="solid-card space-y-3 rounded-2xl p-4">
                <h3 className="flex items-center gap-2 font-display text-base font-bold text-warning">
                  <Wallet className="h-4 w-4" />
                  Debemos · Proveedores de Inventario
                </h3>
                {openPayables.length === 0 ? (
                  <p className="rounded-xl bg-background/50 p-5 text-center text-xs text-muted-foreground">
                    Sin facturas de proveedores pendientes. Al comprar stock como “Pendiente” o
                    “Parcial”, aparecerá aquí automáticamente.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {openPayables.map((p) => (
                      <div
                        key={p.id}
                        className="space-y-2 rounded-xl border border-warning/25 bg-warning/5 p-3 text-xs"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-bold text-foreground">{p.supplierName}</p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {p.description}
                            </p>
                            <p className="text-[10px] tabular-nums text-muted-foreground">
                              Total: {formatCOP(p.totalAmount)} · Pagado: {formatCOP(p.paidAmount)}
                            </p>
                          </div>
                          <div className="shrink-0 text-right tabular-nums">
                            <p className="text-sm font-bold text-warning">
                              {formatCOP(p.remainingAmount)}
                            </p>
                            {(canEdit || canEditFinance || isAdmin) && (
                              <button
                                type="button"
                                onClick={() => {
                                  setPaySupplierId(paySupplierId === p.id ? null : p.id);
                                  setPaySupplierAmount(String(Math.round(p.remainingAmount)));
                                  setPaySupplierMethodId(treasuryAccounts[0]?.id ?? "");
                                }}
                                className="mt-1 rounded-lg bg-warning px-2.5 py-1 text-[10px] font-bold text-primary-foreground"
                              >
                                Pagar / Abonar
                              </button>
                            )}
                          </div>
                        </div>

                        {paySupplierId === p.id && (
                          <div className="grid gap-2 border-t border-white/10 pt-2 sm:grid-cols-3">
                            <input
                              type="number"
                              min={1}
                              max={p.remainingAmount}
                              value={paySupplierAmount}
                              onChange={(e) => setPaySupplierAmount(e.target.value)}
                              className="rounded-lg border border-white/15 bg-card px-2.5 py-1.5 font-bold tabular-nums"
                            />
                            <select
                              value={paySupplierMethodId || treasuryAccounts[0]?.id || ""}
                              onChange={(e) => setPaySupplierMethodId(e.target.value)}
                              className="rounded-lg border border-white/15 bg-card px-2 py-1.5"
                            >
                              {treasuryAccounts.map((acc) => (
                                <option key={acc.id} value={acc.id}>
                                  Sale de: {acc.name}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handlePaySupplier(p.id)}
                              className="rounded-lg bg-success px-3 py-1.5 font-bold text-primary-foreground"
                            >
                              Confirmar Pago
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="solid-card space-y-3 rounded-2xl p-4">
                <h3 className="flex items-center gap-2 font-display text-base font-bold text-primary">
                  <Handshake className="h-4 w-4" />
                  Debemos · Aliados Pendientes
                </h3>
                {allyPending.length === 0 ? (
                  <p className="rounded-xl bg-background/50 p-4 text-center text-xs text-muted-foreground">
                    Sin saldos pendientes con aliados.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {allyPending.map((a) => (
                      <div
                        key={a.allyId}
                        className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-background/60 p-3 text-xs"
                      >
                        <div>
                          <p className="font-bold">{a.allyName}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {a.itemsCount} ítem(s) vendidos
                          </p>
                        </div>
                        <div className="flex items-center gap-2.5 tabular-nums">
                          <span className="text-sm font-bold text-warning">
                            {formatCOP(a.totalPending)}
                          </span>
                          {canEdit && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleSettleAlly(a.allyId, a.allyName)}
                              className="rounded-lg bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground"
                            >
                              Liquidar
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* === TAB 3: HISTORIAL DE TURNOS (CON DIFERENCIA DE APERTURA Y TRASLADO A BODEGA) === */}
      {tab === "history" && (
        <div className="solid-card space-y-3 rounded-2xl p-4">
          <h3 className="font-display text-base font-bold">Historial de Cierres de Turno</h3>
          {shiftHistory.length === 0 ? (
            <p className="rounded-xl bg-background/50 p-6 text-center text-xs text-muted-foreground">
              Aún no hay cierres de turno registrados.
            </p>
          ) : (
            <div className="divide-y divide-white/10 text-xs tabular-nums">
              {shiftHistory.map((sh) => (
                <div key={sh.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-bold text-foreground">
                      {new Date(sh.openedAt).toLocaleString("es-CO", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      →{" "}
                      {new Date(sh.closedAt).toLocaleTimeString("es-CO", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Abrió: {sh.openedByName} · Cerró: {sh.closedByName ?? "—"}
                      {sh.notes ? ` · ${sh.notes}` : ""}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                      <span>Base: {formatCOP(sh.openingFloat)}</span>
                      {Math.abs(sh.openingDiscrepancy) >= 1 && (
                        <span className="font-bold text-warning">
                          Dif. apertura:{" "}
                          {sh.openingDiscrepancy > 0
                            ? `+${formatCOP(sh.openingDiscrepancy)}`
                            : formatCOP(sh.openingDiscrepancy)}
                        </span>
                      )}
                      {sh.transferToVaultAmount > 0 && (
                        <span className="font-bold text-primary">
                          → Bodega: {formatCOP(sh.transferToVaultAmount)}
                        </span>
                      )}
                      {sh.closingCashLeft !== null && (
                        <span>Quedó en caja: {formatCOP(sh.closingCashLeft)}</span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-foreground">
                      Vendido: {formatCOP(sh.totalNetSales)}
                    </p>
                    <p
                      className={`text-[11px] font-bold ${
                        Math.abs(sh.cashDiscrepancy) < 1
                          ? "text-success"
                          : sh.cashDiscrepancy < 0
                            ? "text-destructive"
                            : "text-warning"
                      }`}
                    >
                      {Math.abs(sh.cashDiscrepancy) < 1
                        ? "Cierre cuadrado"
                        : `Dif. cierre: ${sh.cashDiscrepancy > 0 ? `+${formatCOP(sh.cashDiscrepancy)}` : formatCOP(sh.cashDiscrepancy)}`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
