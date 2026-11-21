import { useState } from "react";
import { Beer, Handshake, ImagePlus, Plus, Trash2, X } from "lucide-react";
import type { Ally, DisplayUnit, InventoryItem, MenuCategory } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

interface IngredientDraft {
  inventoryItemId: string;
  displayQuantity: string;
  displayUnit: DisplayUnit;
  pourLossPercent: string;
  fixedLossBase: string;
}

interface NewComboModalProps {
  branchId: string;
  categories: MenuCategory[];
  inventoryItems: InventoryItem[];
  allies: Ally[];
  onCreated: () => Promise<void>;
  onClose: () => void;
}

export function NewComboModal({
  branchId,
  categories,
  inventoryItems,
  allies,
  onCreated,
  onClose,
}: NewComboModalProps) {
  const defaultInv = inventoryItems[0];
  const defaultAllyCat = categories.find((c) => c.name.toLowerCase().includes("combo"))?.id;

  const [name, setName] = useState("");
  const [presentationLabel, setPresentationLabel] = useState("Combo");
  const [salePrice, setSalePrice] = useState("29000");
  const [categoryId, setCategoryId] = useState(defaultAllyCat ?? categories[0]?.id ?? "__new__");
  const [newCategoryName, setNewCategoryName] = useState("Combos Especiales");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [ingredients, setIngredients] = useState<IngredientDraft[]>(
    defaultInv
      ? [
          {
            inventoryItemId: defaultInv.id,
            displayQuantity: defaultInv.baseUnit === "ml" ? "500" : "1",
            displayUnit: defaultInv.baseUnit === "ml" ? "ml" : defaultInv.baseUnit,
            pourLossPercent: String(defaultInv.defaultPourLossPercent ?? 0),
            fixedLossBase: defaultInv.isKeg ? "15" : "0",
          },
        ]
      : [],
  );

  const [includeAlly, setIncludeAlly] = useState(allies.length > 0);
  const [allyId, setAllyId] = useState(allies[0]?.id ?? "");
  const [allyPayoutAmount, setAllyPayoutAmount] = useState("16000");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUploadPhoto = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch<{ imageUrl: string }>("/api/v1/uploads/image", {
        method: "POST",
        body: form,
      });
      setImageUrl(res.imageUrl);
    } finally {
      setUploading(false);
    }
  };

  const addIngredient = () => {
    const pick = inventoryItems[0];
    if (!pick) return;
    setIngredients((prev) => [
      ...prev,
      {
        inventoryItemId: pick.id,
        displayQuantity: pick.baseUnit === "ml" ? "500" : "1",
        displayUnit: pick.baseUnit === "ml" ? "ml" : pick.baseUnit,
        pourLossPercent: String(pick.defaultPourLossPercent ?? 0),
        fixedLossBase: pick.isKeg ? "15" : "0",
      },
    ]);
  };

  const updateIngredient = (idx: number, patch: Partial<IngredientDraft>) => {
    setIngredients((prev) =>
      prev.map((row, i) => {
        if (i !== idx) return row;
        const merged = { ...row, ...patch };
        if (patch.inventoryItemId) {
          const inv = inventoryItems.find((x) => x.id === patch.inventoryItemId);
          if (inv) {
            merged.displayUnit = inv.baseUnit === "ml" ? "ml" : inv.baseUnit;
            merged.displayQuantity = inv.baseUnit === "ml" ? "500" : "1";
            merged.pourLossPercent = String(inv.defaultPourLossPercent ?? 0);
            merged.fixedLossBase = inv.isKeg ? "15" : "0";
          }
        }
        return merged;
      }),
    );
  };

  const numericPrice = Number(salePrice) || 0;
  const numericAllyPayout = includeAlly && allyId ? Number(allyPayoutAmount) || 0 : 0;
  const barRetainedAmount = Math.max(0, numericPrice - numericAllyPayout);

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Escribe el nombre del combo (ej. Pinta IPA + Salchipapa).");
      return;
    }
    if (ingredients.length === 0 && !(includeAlly && allyId)) {
      setError("Agrega al menos un insumo del bar o activa un componente de aliado.");
      return;
    }

    setSaving(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/combos`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          presentationLabel: presentationLabel.trim() || "Combo",
          categoryId: categoryId !== "__new__" ? categoryId : undefined,
          newCategoryName: categoryId === "__new__" ? newCategoryName.trim() : undefined,
          imageUrl,
          salePrice: numericPrice,
          allyId: includeAlly && allyId ? allyId : null,
          allyPayoutAmount: numericAllyPayout,
          recipes: ingredients.map((ing) => ({
            inventoryItemId: ing.inventoryItemId,
            displayUnit: ing.displayUnit,
            displayQuantity: Math.max(0.001, Number(ing.displayQuantity) || 1),
            pourLossPercent: Number(ing.pourLossPercent) || 0,
            fixedLossBase: Number(ing.fixedLossBase) || 0,
          })),
        }),
      });
      haptics.success();
      await onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el combo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm md:p-5">
      <div className="material-thick flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-bold">
              Constructor de Combos (Ej. Pinta + Salchipapa)
            </h2>
            <p className="text-xs text-muted-foreground">
              Combina cerveza/licores/empanadas de tu inventario con comida de locales aliados en un
              solo botón del POS.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press-response flex h-10 w-10 items-center justify-center rounded-xl bg-secondary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* 1. Datos generales */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                1. Nombre, Precio y Foto del Combo
              </p>
              <label className="press-response flex cursor-pointer items-center gap-1.5 rounded-xl bg-secondary px-3 py-1.5 text-xs font-semibold text-primary">
                <ImagePlus className="h-4 w-4" />
                {uploading ? "Subiendo..." : imageUrl ? "Foto cargada ✓" : "Subir foto"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleUploadPhoto(f);
                  }}
                />
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs text-muted-foreground">
                  Nombre del Combo *
                </label>
                <input
                  type="text"
                  placeholder="Ej. Pinta IPA + Salchipapa"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm font-semibold focus:border-primary focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Precio venta combo (COP) *
                </label>
                <input
                  type="number"
                  min={0}
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm font-bold tabular-nums text-primary"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Etiqueta botón POS
                </label>
                <input
                  type="text"
                  value={presentationLabel}
                  onChange={(e) => setPresentationLabel(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Categoría</label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value="__new__">+ Crear categoría nueva...</option>
                </select>
              </div>
              {categoryId === "__new__" && (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Nombre categoría
                  </label>
                  <input
                    type="text"
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    className="w-full rounded-xl border border-primary/40 bg-background px-3 py-2 text-xs"
                  />
                </div>
              )}
            </div>
          </div>

          {/* 2. Ingredientes del inventario del Bar */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-warning">
                <Beer className="h-4 w-4" />
                2. Qué descuenta de TU inventario (Cerveza, Licores, Empanadas...)
              </p>
              <button
                type="button"
                onClick={addIngredient}
                className="press-response flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-bold text-primary"
              >
                <Plus className="h-3.5 w-3.5" />
                Agregar insumo
              </button>
            </div>

            {ingredients.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Sin descuento de inventario propio (combo 100% de aliado externo).
              </p>
            ) : (
              <div className="space-y-2">
                {ingredients.map((ing, idx) => {
                  const inv = inventoryItems.find((i) => i.id === ing.inventoryItemId);
                  return (
                    <div
                      key={idx}
                      className="grid items-center gap-2 rounded-xl border border-white/10 bg-background/60 p-2.5 sm:grid-cols-12"
                    >
                      <select
                        value={ing.inventoryItemId}
                        onChange={(e) =>
                          updateIngredient(idx, { inventoryItemId: e.target.value })
                        }
                        className="rounded-lg border border-white/10 bg-card px-2 py-1.5 text-xs font-semibold sm:col-span-4"
                      >
                        {inventoryItems.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                      </select>

                      <input
                        type="number"
                        step="0.5"
                        value={ing.displayQuantity}
                        onChange={(e) =>
                          updateIngredient(idx, { displayQuantity: e.target.value })
                        }
                        className="rounded-lg border border-white/10 bg-card px-2 py-1.5 text-xs tabular-nums sm:col-span-2"
                      />

                      <select
                        value={ing.displayUnit}
                        onChange={(e) =>
                          updateIngredient(idx, { displayUnit: e.target.value as DisplayUnit })
                        }
                        className="rounded-lg border border-white/10 bg-card px-2 py-1.5 text-xs sm:col-span-2"
                      >
                        {inv?.baseUnit === "unit" ? (
                          <option value="unit">und</option>
                        ) : inv?.baseUnit === "g" ? (
                          <>
                            <option value="g">g</option>
                            <option value="kg">kg</option>
                          </>
                        ) : (
                          <>
                            <option value="ml">ml</option>
                            <option value="L">L</option>
                            <option value="oz">oz</option>
                          </>
                        )}
                      </select>

                      <div className="flex items-center gap-1 sm:col-span-3">
                        <input
                          type="number"
                          title="% espuma"
                          value={ing.pourLossPercent}
                          onChange={(e) =>
                            updateIngredient(idx, { pourLossPercent: e.target.value })
                          }
                          className="w-14 rounded-lg border border-white/10 bg-card px-1.5 py-1.5 text-xs tabular-nums"
                        />
                        <span className="text-[10px] text-muted-foreground">% esp.</span>
                        <input
                          type="number"
                          title="Purga fija ml"
                          value={ing.fixedLossBase}
                          onChange={(e) =>
                            updateIngredient(idx, { fixedLossBase: e.target.value })
                          }
                          className="w-14 rounded-lg border border-white/10 bg-card px-1.5 py-1.5 text-xs tabular-nums"
                        />
                        <span className="text-[10px] text-muted-foreground">ml</span>
                      </div>

                      <div className="flex justify-end sm:col-span-1">
                        <button
                          type="button"
                          onClick={() =>
                            setIngredients((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="rounded-lg bg-destructive/15 p-1.5 text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 3. Componente de Aliado Externo */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-bold text-warning">
              <input
                type="checkbox"
                checked={includeAlly}
                onChange={(e) => setIncludeAlly(e.target.checked)}
                className="h-4 w-4 accent-warning"
              />
              <Handshake className="h-4 w-4" />
              3. ¿Incluye comida de un local Aliado? (ej. Salchipapa, Alitas, Burger)
            </label>

            {includeAlly && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Local Aliado</label>
                  <select
                    value={allyId}
                    onChange={(e) => setAllyId(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                  >
                    {allies.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.operatingSchedule?.openTime ?? "00:00"}–
                        {a.operatingSchedule?.closeTime ?? "23:59"})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Cuánto se liquida al Aliado por cada combo (COP)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={allyPayoutAmount}
                    onChange={(e) => setAllyPayoutAmount(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm font-bold tabular-nums text-warning"
                  />
                </div>
                <div className="rounded-xl bg-background/60 p-3 text-xs sm:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 tabular-nums">
                    <span>
                      Precio cliente: <strong>{formatCOP(numericPrice)}</strong>
                    </span>
                    <span className="text-warning">
                      Pago al Aliado: <strong>{formatCOP(numericAllyPayout)}</strong>
                    </span>
                    <span className="text-success">
                      Ingreso neto Bar: <strong>{formatCOP(barRetainedAmount)}</strong>
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Si el aliado cierra por horario o cierre manual, este combo se ocultará
                    automáticamente del POS.
                  </p>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/15 px-3.5 py-2.5 text-xs font-semibold text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="press-response min-h-12 rounded-xl bg-secondary px-5 text-sm font-semibold"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSubmit}
            className="press-response min-h-12 rounded-xl bg-primary px-6 text-sm font-bold text-primary-foreground disabled:opacity-50"
          >
            {saving ? "Creando Combo..." : "Publicar Combo en POS"}
          </button>
        </div>
      </div>
    </div>
  );
}

