import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Beer, History, MinusCircle, PackagePlus, Plus, RefreshCw } from "lucide-react";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { formatBaseQuantity } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";
import { NewInventoryItemModal } from "./NewInventoryItemModal.js";

type StoreType = ReturnType<typeof useLiquiStock>;

interface LedgerEntryRow {
  id: string;
  itemName: string;
  baseUnit: "ml" | "g" | "unit";
  movementType: string;
  quantityDeltaBase: number;
  nominalQtyBase: number;
  pourLossQtyBase: number;
  stockAfterBase: number;
  reason: string | null;
  createdByName: string;
  createdAt: string;
}

export function InventoryView({ store, branchId }: { store: StoreType; branchId: string }) {
  const [ledger, setLedger] = useState<LedgerEntryRow[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [selectedPresId, setSelectedPresId] = useState<string>("");
  const [units, setUnits] = useState("1");
  const [cost, setCost] = useState("345000");
  const [wasteQty, setWasteQty] = useState("500");
  const [wasteReason, setWasteReason] = useState("Purga de línea / espuma excesiva");
  const [saving, setSaving] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);

  const loadLedger = useCallback(async () => {
    try {
      const res = await apiFetch<{ entries: LedgerEntryRow[] }>(
        `/api/v1/branches/${branchId}/inventory/ledger`,
      );
      setLedger(res.entries);
    } catch {
      // Offline: keep previous ledger snapshot
    }
  }, [branchId]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger, store.lastHydratedAt]);

  const activeItem =
    store.inventoryItems.find((i) => i.id === selectedItemId) ?? store.inventoryItems[0];
  const itemPresentations = store.purchasePresentations.filter(
    (p) => p.inventoryItemId === activeItem?.id,
  );
  const activePres =
    itemPresentations.find((p) => p.id === selectedPresId) ?? itemPresentations[0];

  const handleRegisterPurchase = async () => {
    if (!activeItem || !activePres || saving) return;
    setSaving(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/inventory/movements`, {
        method: "POST",
        body: JSON.stringify({
          inventoryItemId: activeItem.id,
          movementType: "purchase",
          presentationId: activePres.id,
          presentationUnits: Number(units) || 1,
          totalCost: Number(cost) || 0,
          reason: `Compra ${units}x ${activePres.name}`,
          userId: store.activeUserId,
        }),
      });
      haptics.success();
      await Promise.all([store.refresh(), loadLedger()]);
    } finally {
      setSaving(false);
    }
  };

  const handleRegisterWaste = async () => {
    if (!activeItem || saving) return;
    setSaving(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/inventory/movements`, {
        method: "POST",
        body: JSON.stringify({
          inventoryItemId: activeItem.id,
          movementType: "waste",
          quantityBase: Math.abs(Number(wasteQty) || 0),
          reason: wasteReason || "Merma operativa",
          userId: store.activeUserId,
        }),
      });
      haptics.tap();
      await Promise.all([store.refresh(), loadLedger()]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Barriles e Insumos en Unidad Base */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-bold">Barriles Artesanales e Inventario en Vivo</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                haptics.tap();
                setShowNewModal(true);
              }}
              className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-bold text-primary-foreground"
            >
              <Plus className="h-4 w-4" />
              Nuevo Insumo / Producto
            </button>
            <button
              type="button"
              onClick={() => void Promise.all([store.refresh(), loadLedger()])}
              className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-secondary px-3 text-xs font-semibold"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Actualizar
            </button>
          </div>
        </div>

        {store.inventoryItems.length === 0 ? (
          <div className="solid-card flex flex-col items-center justify-center gap-3 rounded-2xl p-8 text-center">
            <Beer className="h-10 w-10 text-primary" />
            <div>
              <p className="font-display text-base font-bold">Tu inventario está listo para empezar</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                Agrega tu primer barril artesanal, botella de licor, snack o empanada y publícalo en el
                POS en un solo paso.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                haptics.tap();
                setShowNewModal(true);
              }}
              className="press-response flex min-h-11 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground"
            >
              <Plus className="h-4 w-4" />
              Crear Primer Insumo / Producto
            </button>
          </div>
        ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {store.inventoryItems.map((item) => {
            const isLow = item.currentStockBase <= item.minStockBase;
            const refCap = item.isKeg ? 30000 : Math.max(item.minStockBase * 4, 1500);
            const pct = Math.max(0, Math.min(100, Math.round((item.currentStockBase / refCap) * 100)));
            const estimatedPintas =
              item.isKeg && item.baseUnit === "ml"
                ? Math.floor(
                    Math.max(0, item.currentStockBase) / (500 * (1 + item.defaultPourLossPercent / 100)),
                  )
                : null;

            return (
              <div
                key={item.id}
                onClick={() => {
                  setSelectedItemId(item.id);
                  const defPres = store.purchasePresentations.find(
                    (p) => p.inventoryItemId === item.id,
                  );
                  if (defPres) {
                    setSelectedPresId(defPres.id);
                    if (defPres.lastPurchaseCost) setCost(String(defPres.lastPurchaseCost));
                  }
                }}
                className={`solid-card cursor-pointer rounded-2xl p-4 transition ${
                  activeItem?.id === item.id ? "ring-2 ring-primary" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5">
                      {item.isKeg && <Beer className="h-4 w-4 text-warning" />}
                      <h3 className="font-display text-sm font-bold">{item.name}</h3>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Merma espuma base: {item.defaultPourLossPercent}% · Mín:{" "}
                      {formatBaseQuantity(item.minStockBase, item.baseUnit)}
                    </p>
                  </div>
                  {isLow && (
                    <span className="flex items-center gap-1 rounded-full bg-destructive/20 px-2 py-0.5 text-[10px] font-bold text-destructive">
                      <AlertTriangle className="h-3 w-3" />
                      Bajo
                    </span>
                  )}
                </div>

                <div className="mt-3 flex items-baseline justify-between tabular-nums">
                  <span className="text-xl font-bold text-foreground">
                    {formatBaseQuantity(item.currentStockBase, item.baseUnit)}
                  </span>
                  {estimatedPintas !== null && (
                    <span className="text-xs text-primary">~{estimatedPintas} pintas 500ml</span>
                  )}
                </div>

                <div className="mt-2 h-2 overflow-hidden rounded-full bg-background">
                  <div
                    className={`h-full rounded-full ${isLow ? "bg-destructive" : item.isKeg ? "bg-warning" : "bg-primary"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        )}
      </section>

      {/* Panel de Compra por Presentación (Barriles / Botellas / Canastas) y Merma */}
      {activeItem && (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="flex items-center gap-2">
              <PackagePlus className="h-5 w-5 text-success" />
              <h3 className="font-display text-base font-bold">
                Ingresar Compra · {activeItem.name}
              </h3>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs text-muted-foreground">
                  Presentación de compra
                </label>
                <select
                  value={activePres?.id ?? ""}
                  onChange={(e) => setSelectedPresId(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                >
                  {itemPresentations.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (+{formatBaseQuantity(p.factorToBase, activeItem.baseUnit)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Cantidad</label>
                <input
                  type="number"
                  min={1}
                  value={units}
                  onChange={(e) => setUnits(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm tabular-nums"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-muted-foreground">
                  Costo total factura (COP)
                </label>
                <input
                  type="number"
                  min={0}
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm tabular-nums"
                />
              </div>
              <button
                type="button"
                disabled={saving || !activePres}
                onClick={handleRegisterPurchase}
                className="press-response min-h-11 rounded-xl bg-success px-5 text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                Registrar Ingreso
              </button>
            </div>
          </div>

          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="flex items-center gap-2">
              <MinusCircle className="h-5 w-5 text-warning" />
              <h3 className="font-display text-base font-bold">
                Registrar Merma / Purga · {activeItem.name}
              </h3>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Cantidad ({activeItem.baseUnit})
                </label>
                <input
                  type="number"
                  min={1}
                  value={wasteQty}
                  onChange={(e) => setWasteQty(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm tabular-nums"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs text-muted-foreground">Motivo</label>
                <input
                  type="text"
                  value={wasteReason}
                  onChange={(e) => setWasteReason(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={handleRegisterWaste}
              className="press-response min-h-11 rounded-xl bg-warning px-5 text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              Registrar Merma en Ledger
            </button>
          </div>
        </section>
      )}

      {/* Libro Mayor Inmutable (Cards en Mobile, Tabla en Tablet/Desktop) */}
      <section className="solid-card overflow-hidden rounded-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <History className="h-4 w-4 text-primary" />
          <h3 className="font-display text-sm font-bold">
            Libro Mayor Inmutable (Nominal vs. Espuma)
          </h3>
        </div>

        {/* Vista tarjetas para celular (< 768px) */}
        <div className="divide-y divide-white/10 md:hidden">
          {ledger.map((row) => (
            <div key={row.id} className="space-y-1 p-3.5 text-xs tabular-nums">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-foreground">{row.itemName}</span>
                <span
                  className={`font-bold ${
                    row.quantityDeltaBase >= 0 ? "text-success" : "text-destructive"
                  }`}
                >
                  {row.quantityDeltaBase >= 0 ? "+" : ""}
                  {formatBaseQuantity(row.quantityDeltaBase, row.baseUnit)}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="rounded bg-secondary px-1.5 py-0.5 font-bold uppercase text-foreground">
                  {row.movementType}
                </span>
                {row.pourLossQtyBase > 0 && (
                  <span className="text-warning">
                    Espuma: +{formatBaseQuantity(row.pourLossQtyBase, row.baseUnit)}
                  </span>
                )}
                <span>Saldo: {formatBaseQuantity(row.stockAfterBase, row.baseUnit)}</span>
              </div>
              {row.reason && <p className="text-[11px] text-muted-foreground">{row.reason}</p>}
            </div>
          ))}
        </div>

        {/* Vista tabla para tablet y escritorio (>= 768px) */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="bg-background/60 text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">Fecha</th>
                <th className="px-4 py-2.5">Insumo</th>
                <th className="px-4 py-2.5">Tipo</th>
                <th className="px-4 py-2.5">Delta Total</th>
                <th className="px-4 py-2.5">Espuma / Purga</th>
                <th className="px-4 py-2.5">Saldo</th>
                <th className="px-4 py-2.5">Detalle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {ledger.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                    {new Date(row.createdAt).toLocaleTimeString("es-CO", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-4 py-2.5 font-semibold">{row.itemName}</td>
                  <td className="px-4 py-2.5">
                    <span className="rounded bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase">
                      {row.movementType}
                    </span>
                  </td>
                  <td
                    className={`px-4 py-2.5 font-bold ${
                      row.quantityDeltaBase >= 0 ? "text-success" : "text-destructive"
                    }`}
                  >
                    {row.quantityDeltaBase >= 0 ? "+" : ""}
                    {formatBaseQuantity(row.quantityDeltaBase, row.baseUnit)}
                  </td>
                  <td className="px-4 py-2.5 text-warning">
                    {row.pourLossQtyBase > 0
                      ? `+${formatBaseQuantity(row.pourLossQtyBase, row.baseUnit)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5 font-semibold">
                    {formatBaseQuantity(row.stockAfterBase, row.baseUnit)}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{row.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showNewModal && (
        <NewInventoryItemModal
          branchId={branchId}
          userId={store.activeUserId}
          categories={store.categories}
          onClose={() => setShowNewModal(false)}
          onCreated={async () => {
            await Promise.all([store.refresh(), loadLedger()]);
          }}
        />
      )}
    </div>
  );
}

