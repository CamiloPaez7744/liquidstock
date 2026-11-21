import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Handshake, Lock, RefreshCw, Wallet } from "lucide-react";
import type { CashShiftClosureReport } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

type StoreType = ReturnType<typeof useLiquiStock>;

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

export function CashShiftView({ store, branchId }: { store: StoreType; branchId: string }) {
  const [shiftData, setShiftData] = useState<CurrentShiftResponse["activeShift"]>(null);
  const [declaredCash, setDeclaredCash] = useState("");
  const [nextShiftFloat, setNextShiftFloat] = useState("200000");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [closedSummary, setClosedSummary] = useState<CashShiftClosureReport | null>(null);

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

  useEffect(() => {
    void loadShift();
  }, [loadShift, store.lastHydratedAt]);

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
      await Promise.all([store.refresh(), loadShift()]);
    } finally {
      setBusy(false);
    }
  };

  const handleSettleAlly = async (allyId: string) => {
    await apiFetch(`/api/v1/branches/${branchId}/allies/${allyId}/settle`, {
      method: "POST",
      body: JSON.stringify({ userId: store.activeUserId }),
    });
    haptics.success();
    await loadShift();
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

  if (!shiftData) {
    return (
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
    );
  }

  const r = shiftData.report;
  const declaredNum = Number(declaredCash) || 0;
  const liveDiscrepancy = declaredNum - r.expectedPhysicalCash;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-xl font-bold">Cierre de Caja (Parcial / Con Deudas)</h2>
          <p className="text-xs text-muted-foreground">
            Turno abierto desde {new Date(shiftData.openedAt).toLocaleString("es-CO")} · Base
            inicial: {formatCOP(r.openingFloat)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadShift()}
          className="press-response flex items-center gap-1.5 rounded-xl bg-secondary px-3 py-2 text-xs font-semibold"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Recalcular
        </button>
      </div>

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
              <p className="text-muted-foreground">Sin saldo pendiente a aliados</p>
            ) : (
              r.allyPayablesByAlly.map((ally) => (
                <div key={ally.allyId} className="flex items-center justify-between gap-2">
                  <span className="truncate text-foreground">
                    {ally.allyName}: <strong className="tabular-nums">{formatCOP(ally.amount)}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleSettleAlly(ally.allyId)}
                    className="press-response shrink-0 rounded-lg bg-warning/20 px-2 py-1 text-[10px] font-bold text-warning"
                  >
                    <Handshake className="mr-1 inline h-3 w-3" />
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
              {formatCOP(shiftData.openTablesPendingAmount)}). Al cerrar turno, se transferirán
              automáticamente al siguiente turno sin perder ningún pedido.
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
}

