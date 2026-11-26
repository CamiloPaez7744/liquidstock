import { useState } from "react";
import { Lock, Scale, ShieldAlert, X } from "lucide-react";
import type { InventoryItem } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import { formatBaseQuantity } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

const REASON_PRESETS = [
  "Conteo físico de inventario",
  "Error en ingreso anterior",
  "Ajuste de apertura",
];

export function ReconcileStockModal({
  branchId,
  item,
  onClose,
  onReconciled,
}: {
  branchId: string;
  item: InventoryItem;
  onClose: () => void;
  onReconciled: (result: { previousStockBase: number; nextStockBase: number; deltaBase: number }) => Promise<void>;
}) {
  const canUseLargeUnit = item.baseUnit === "ml" || item.baseUnit === "g";
  const [inputMode, setInputMode] = useState<"base" | "large">(
    item.isKeg && item.baseUnit === "ml" ? "large" : "base",
  );
  const [rawTarget, setRawTarget] = useState<string>(() =>
    item.isKeg && item.baseUnit === "ml"
      ? String(Math.round((item.currentStockBase / 1000) * 1000) / 1000)
      : String(item.currentStockBase),
  );
  const [reason, setReason] = useState("Conteo físico de inventario");
  const [adminPassword, setAdminPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedNum = Number(rawTarget);
  const targetStockBase = Number.isFinite(parsedNum) && parsedNum >= 0
    ? Math.round((inputMode === "large" ? parsedNum * 1000 : parsedNum) * 1000) / 1000
    : NaN;
  const deltaBase = Number.isFinite(targetStockBase)
    ? Math.round((targetStockBase - item.currentStockBase) * 1000) / 1000
    : 0;
  const hasChange = Number.isFinite(targetStockBase) && Math.abs(deltaBase) >= 0.001;

  const largeUnitLabel = item.baseUnit === "ml" ? "Litros (L)" : "Kilos (kg)";

  const handleToggleUnit = (nextMode: "base" | "large") => {
    if (nextMode === inputMode) return;
    setInputMode(nextMode);
    if (Number.isFinite(targetStockBase)) {
      setRawTarget(
        nextMode === "large"
          ? String(Math.round((targetStockBase / 1000) * 1000) / 1000)
          : String(targetStockBase),
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasChange || !reason.trim() || !adminPassword) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{
        previousStockBase: number;
        nextStockBase: number;
        deltaBase: number;
      }>(`/api/v1/branches/${branchId}/inventory/items/${item.id}/reconcile`, {
        method: "POST",
        body: JSON.stringify({
          targetStockBase,
          reason: reason.trim(),
          adminPassword,
        }),
      });
      haptics.success();
      await onReconciled(res);
      onClose();
    } catch (err) {
      haptics.blocked();
      setError(err instanceof Error ? err.message : "No se pudo corregir el stock.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="solid-card w-full max-w-md overflow-hidden rounded-3xl border-warning/40 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-warning/15 text-warning">
              <Scale className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-display text-base font-bold">Corregir / Cuadrar Stock</h3>
              <p className="text-xs text-muted-foreground">{item.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press-response flex h-9 w-9 items-center justify-center rounded-xl bg-secondary text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 p-5 text-xs">
          {/* Stock actual vs stock real */}
          <div className="flex items-center justify-between rounded-xl border border-white/10 bg-background/60 px-3.5 py-2.5">
            <span className="text-muted-foreground">Stock en sistema</span>
            <strong className="text-sm tabular-nums text-foreground">
              {formatBaseQuantity(item.currentStockBase, item.baseUnit)}
            </strong>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="font-semibold text-foreground">Stock físico real contado</label>
              {canUseLargeUnit && (
                <div className="flex rounded-lg bg-secondary p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => handleToggleUnit("base")}
                    className={`rounded-md px-2 py-0.5 font-bold ${
                      inputMode === "base" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {item.baseUnit}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleUnit("large")}
                    className={`rounded-md px-2 py-0.5 font-bold ${
                      inputMode === "large" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {largeUnitLabel}
                  </button>
                </div>
              )}
            </div>
            <input
              type="number"
              min={0}
              step="any"
              required
              autoFocus
              value={rawTarget}
              onChange={(e) => setRawTarget(e.target.value)}
              className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-2.5 text-base font-bold tabular-nums"
            />

            {Number.isFinite(targetStockBase) && (
              <div
                className={`flex items-center justify-between rounded-xl px-3 py-2 font-semibold tabular-nums ${
                  !hasChange
                    ? "bg-secondary/60 text-muted-foreground"
                    : deltaBase > 0
                      ? "bg-success/15 text-success"
                      : "bg-destructive/15 text-destructive"
                }`}
              >
                <span>Diferencia automática en Kardex:</span>
                <strong>
                  {!hasChange
                    ? "Sin cambio"
                    : `${deltaBase > 0 ? "+" : ""}${formatBaseQuantity(deltaBase, item.baseUnit)}`}
                </strong>
              </div>
            )}
          </div>

          {/* Motivo obligatorio */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-foreground">Motivo del ajuste *</label>
            <div className="flex flex-wrap gap-1">
              {REASON_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setReason(preset)}
                  className={`rounded-lg border px-2 py-1 text-[10px] font-semibold ${
                    reason === preset
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-white/10 bg-secondary/60 text-muted-foreground"
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
            <input
              type="text"
              required
              minLength={3}
              maxLength={200}
              placeholder="Ej. Conteo físico nocturno, faltaban 2 botellas..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
            />
          </div>

          {/* Contraseña de Administrador */}
          <div className="space-y-1.5 rounded-xl border border-warning/35 bg-warning/5 p-3">
            <label className="flex items-center gap-1.5 font-bold text-warning">
              <Lock className="h-3.5 w-3.5" />
              Contraseña de Administrador *
            </label>
            <input
              type="password"
              required
              autoComplete="current-password"
              placeholder="Confirma tu contraseña para autorizar el cuadre"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Quedará registrado con tu usuario y diferencia exacta en el historial inmutable (Kardex).
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs font-semibold text-destructive">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="press-response rounded-xl bg-secondary px-4 py-2.5 font-bold text-muted-foreground"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || !hasChange || reason.trim().length < 3 || !adminPassword}
              className="press-response rounded-xl bg-warning px-5 py-2.5 font-bold text-primary-foreground disabled:opacity-50"
            >
              {submitting ? "Guardando..." : "Confirmar Cuadre"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
