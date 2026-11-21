import { useState } from "react";
import { Beer, Cigarette, ImagePlus, PackagePlus, Plus, Trash2, Utensils, Wine, X } from "lucide-react";
import type { BaseUnit, DisplayUnit, MenuCategory, PresentationGroup } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import { haptics } from "../../shared/lib/haptics.js";

interface SellablePresentationDraft {
  name: string;
  presentationGroup: PresentationGroup;
  salePrice: string;
  displayUnit: DisplayUnit;
  displayQuantity: string;
  pourLossPercent: string;
  fixedLossBase: string;
}

type PresetId = "keg" | "liquor" | "cigarettes" | "snacks" | "empanadas";

interface PresetConfig {
  id: PresetId;
  label: string;
  example: string;
  icon: typeof Beer;
  baseUnit: BaseUnit;
  isKeg: boolean;
  defaultPourLossPercent: string;
  purchaseName: string;
  purchaseFactor: string;
  initialStock: string;
  minStock: string;
  suggestedCategoryName: string;
  presentations: SellablePresentationDraft[];
}

const PRESETS: PresetConfig[] = [
  {
    id: "snacks",
    label: "Papas / Snacks",
    example: "Papas Margarita Pollo",
    icon: PackagePlus,
    baseUnit: "unit",
    isKeg: false,
    defaultPourLossPercent: "0",
    purchaseName: "Paca x12 paquetes",
    purchaseFactor: "12",
    initialStock: "24",
    minStock: "6",
    suggestedCategoryName: "Snacks & Mecato",
    presentations: [
      {
        name: "Paquete",
        presentationGroup: "comida",
        salePrice: "4500",
        displayUnit: "unit",
        displayQuantity: "1",
        pourLossPercent: "0",
        fixedLossBase: "0",
      },
    ],
  },
  {
    id: "empanadas",
    label: "Empanadas / Casa",
    example: "Empanada de Carne de la Casa",
    icon: Utensils,
    baseUnit: "unit",
    isKeg: false,
    defaultPourLossPercent: "0",
    purchaseName: "Bandeja x20 und",
    purchaseFactor: "20",
    initialStock: "20",
    minStock: "5",
    suggestedCategoryName: "Comida de la Casa",
    presentations: [
      {
        name: "Unidad",
        presentationGroup: "comida",
        salePrice: "3500",
        displayUnit: "unit",
        displayQuantity: "1",
        pourLossPercent: "0",
        fixedLossBase: "0",
      },
      {
        name: "Porción x3",
        presentationGroup: "combo",
        salePrice: "9500",
        displayUnit: "unit",
        displayQuantity: "3",
        pourLossPercent: "0",
        fixedLossBase: "0",
      },
    ],
  },
  {
    id: "cigarettes",
    label: "Cigarrillos",
    example: "Marlboro Rojo",
    icon: Cigarette,
    baseUnit: "unit",
    isKeg: false,
    defaultPourLossPercent: "0",
    purchaseName: "Cajetilla x20 und",
    purchaseFactor: "20",
    initialStock: "40",
    minStock: "10",
    suggestedCategoryName: "Cigarrillos",
    presentations: [
      {
        name: "Unidad (1 cig.)",
        presentationGroup: "otro",
        salePrice: "1000",
        displayUnit: "unit",
        displayQuantity: "1",
        pourLossPercent: "0",
        fixedLossBase: "0",
      },
      {
        name: "Cajetilla x20",
        presentationGroup: "otro",
        salePrice: "16000",
        displayUnit: "unit",
        displayQuantity: "20",
        pourLossPercent: "0",
        fixedLossBase: "0",
      },
    ],
  },
  {
    id: "liquor",
    label: "Licor (Shots/Bot.)",
    example: "Aguardiente Amarillo",
    icon: Wine,
    baseUnit: "ml",
    isKeg: false,
    defaultPourLossPercent: "2",
    purchaseName: "Botella 750ml",
    purchaseFactor: "750",
    initialStock: "1500",
    minStock: "300",
    suggestedCategoryName: "Licores & Shots",
    presentations: [
      {
        name: "Shot 1 oz",
        presentationGroup: "shot",
        salePrice: "8000",
        displayUnit: "oz",
        displayQuantity: "1",
        pourLossPercent: "2",
        fixedLossBase: "0",
      },
      {
        name: "Media 375ml",
        presentationGroup: "botella",
        salePrice: "55000",
        displayUnit: "ml",
        displayQuantity: "375",
        pourLossPercent: "0",
        fixedLossBase: "0",
      },
      {
        name: "Botella 750ml",
        presentationGroup: "botella",
        salePrice: "105000",
        displayUnit: "ml",
        displayQuantity: "750",
        pourLossPercent: "0",
        fixedLossBase: "0",
      },
    ],
  },
  {
    id: "keg",
    label: "Barril Artesanal",
    example: "Stout Negra Artesanal",
    icon: Beer,
    baseUnit: "ml",
    isKeg: true,
    defaultPourLossPercent: "8",
    purchaseName: "Barril 30L",
    purchaseFactor: "30000",
    initialStock: "30000",
    minStock: "4000",
    suggestedCategoryName: "Cervezas Artesanales",
    presentations: [
      {
        name: "Vaso 330ml",
        presentationGroup: "vaso",
        salePrice: "10000",
        displayUnit: "ml",
        displayQuantity: "330",
        pourLossPercent: "8",
        fixedLossBase: "10",
      },
      {
        name: "Pinta 500ml",
        presentationGroup: "pinta",
        salePrice: "14000",
        displayUnit: "ml",
        displayQuantity: "500",
        pourLossPercent: "8",
        fixedLossBase: "15",
      },
      {
        name: "Jirafa 3L",
        presentationGroup: "jirafa",
        salePrice: "72000",
        displayUnit: "L",
        displayQuantity: "3",
        pourLossPercent: "3",
        fixedLossBase: "25",
      },
    ],
  },
];

interface NewInventoryItemModalProps {
  branchId: string;
  userId: string;
  categories: MenuCategory[];
  onCreated: () => Promise<void>;
  onClose: () => void;
}

export function NewInventoryItemModal({
  branchId,
  userId,
  categories,
  onCreated,
  onClose,
}: NewInventoryItemModalProps) {
  const [presetId, setPresetId] = useState<PresetId>("snacks");
  const [name, setName] = useState("");
  const [baseUnit, setBaseUnit] = useState<BaseUnit>("unit");
  const [isKeg, setIsKeg] = useState(false);
  const [defaultPourLossPct, setDefaultPourLossPct] = useState("0");
  const [purchaseName, setPurchaseName] = useState("Paca x12 paquetes");
  const [purchaseFactor, setPurchaseFactor] = useState("12");
  const [initialStock, setInitialStock] = useState("24");
  const [initialCost, setInitialCost] = useState("48000");
  const [minStock, setMinStock] = useState("6");

  const [publishToMenu, setPublishToMenu] = useState(true);
  const [categoryId, setCategoryId] = useState<string>("__new__");
  const [newCategoryName, setNewCategoryName] = useState("Snacks & Mecato");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [presentations, setPresentations] = useState<SellablePresentationDraft[]>(
    PRESETS[0]!.presentations,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (p: PresetConfig) => {
    haptics.tap();
    setPresetId(p.id);
    setBaseUnit(p.baseUnit);
    setIsKeg(p.isKeg);
    setDefaultPourLossPct(p.defaultPourLossPercent);
    setPurchaseName(p.purchaseName);
    setPurchaseFactor(p.purchaseFactor);
    setInitialStock(p.initialStock);
    setMinStock(p.minStock);
    setPresentations(p.presentations.map((x) => ({ ...x })));

    const matchingCat = categories.find(
      (c) => c.name.toLowerCase() === p.suggestedCategoryName.toLowerCase(),
    );
    if (matchingCat) {
      setCategoryId(matchingCat.id);
      setNewCategoryName("");
    } else {
      setCategoryId("__new__");
      setNewCategoryName(p.suggestedCategoryName);
    }
  };

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

  const updatePres = (idx: number, patch: Partial<SellablePresentationDraft>) => {
    setPresentations((prev) => prev.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  };

  const addEmptyPres = () => {
    setPresentations((prev) => [
      ...prev,
      {
        name: baseUnit === "ml" ? "Presentación nueva" : "Unidad",
        presentationGroup: baseUnit === "ml" ? "trago" : "otro",
        salePrice: "5000",
        displayUnit: baseUnit,
        displayQuantity: "1",
        pourLossPercent: defaultPourLossPct,
        fixedLossBase: "0",
      },
    ]);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Escribe el nombre del producto o insumo.");
      return;
    }
    if (publishToMenu && categoryId === "__new__" && !newCategoryName.trim()) {
      setError("Elige una categoría o escribe el nombre de la nueva categoría.");
      return;
    }

    setSaving(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/inventory/items`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          baseUnit,
          initialStockBase: Number(initialStock) || 0,
          initialTotalCost: Number(initialCost) || 0,
          minStockBase: Number(minStock) || 0,
          defaultPourLossPercent: Number(defaultPourLossPct) || 0,
          isKeg,
          userId,
          purchasePresentation: purchaseName.trim()
            ? {
                name: purchaseName.trim(),
                factorToBase: Math.max(0.001, Number(purchaseFactor) || 1),
                lastPurchaseCost: Number(initialCost) || 0,
              }
            : undefined,
          publishToMenu: publishToMenu
            ? {
                categoryId: categoryId !== "__new__" ? categoryId : undefined,
                newCategoryName: categoryId === "__new__" ? newCategoryName.trim() : undefined,
                productName: name.trim(),
                imageUrl,
                presentations: presentations.map((p) => ({
                  name: p.name.trim() || "Estándar",
                  presentationGroup: p.presentationGroup,
                  salePrice: Number(p.salePrice) || 0,
                  displayUnit: p.displayUnit,
                  displayQuantity: Math.max(0.001, Number(p.displayQuantity) || 1),
                  pourLossPercent: Number(p.pourLossPercent) || 0,
                  fixedLossBase: Number(p.fixedLossBase) || 0,
                })),
              }
            : undefined,
        }),
      });
      haptics.success();
      await onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el insumo.");
    } finally {
      setSaving(false);
    }
  };

  const currentPreset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm md:p-5">
      <div className="material-thick flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-bold">
              Nuevo Insumo / Producto (Licores, Papas, Cigarrillos, Empanadas...)
            </h2>
            <p className="text-xs text-muted-foreground">
              Elige una plantilla rápida y en 1 paso queda en tu inventario y listo para vender en el
              POS.
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

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {/* 1. Plantillas de 1 toque */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              1. ¿Qué tipo de producto vas a agregar?
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {PRESETS.map((p) => {
                const Icon = p.icon;
                const active = p.id === presetId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={`press-response flex flex-col items-center gap-1.5 rounded-2xl border p-3 text-center text-xs font-bold ${
                      active
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-white/10 bg-secondary/60 text-muted-foreground"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    <span>{p.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Datos de Inventario */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              2. Datos de Inventario y Compra
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs text-muted-foreground">Nombre *</label>
                <input
                  type="text"
                  placeholder={`Ej. ${currentPreset.example}`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm font-semibold focus:border-primary focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Unidad base</label>
                <select
                  value={baseUnit}
                  onChange={(e) => setBaseUnit(e.target.value as BaseUnit)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                >
                  <option value="unit">Unidades (papas, empanadas, cigarrillos)</option>
                  <option value="ml">Mililitros (barriles, licores)</option>
                  <option value="g">Gramos (insumos sólidos)</option>
                </select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Stock inicial ({baseUnit})
                </label>
                <input
                  type="number"
                  min={0}
                  value={initialStock}
                  onChange={(e) => setInitialStock(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Stock mínimo alerta
                </label>
                <input
                  type="number"
                  min={0}
                  value={minStock}
                  onChange={(e) => setMinStock(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Presentación compra
                </label>
                <input
                  type="text"
                  value={purchaseName}
                  onChange={(e) => setPurchaseName(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Trae ({baseUnit})
                </label>
                <input
                  type="number"
                  min={1}
                  value={purchaseFactor}
                  onChange={(e) => setPurchaseFactor(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm tabular-nums"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Costo compra inicial (COP)
                </label>
                <input
                  type="number"
                  min={0}
                  value={initialCost}
                  onChange={(e) => setInitialCost(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  % Merma / Espuma base
                </label>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={defaultPourLossPct}
                  onChange={(e) => setDefaultPourLossPct(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <div className="flex items-end">
                <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-background/60 px-3 py-2 text-xs font-semibold">
                  <input
                    type="checkbox"
                    checked={isKeg}
                    onChange={(e) => setIsKeg(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  Es barril de cerveza
                </label>
              </div>
            </div>
          </div>

          {/* 3. Publicar directo en Menú del POS */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-bold text-success">
                <input
                  type="checkbox"
                  checked={publishToMenu}
                  onChange={(e) => setPublishToMenu(e.target.checked)}
                  className="h-4 w-4 accent-success"
                />
                3. Publicar inmediatamente en el Menú del POS
              </label>

              {publishToMenu && (
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
              )}
            </div>

            {publishToMenu && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">
                      Categoría en el POS
                    </label>
                    <select
                      value={categoryId}
                      onChange={(e) => setCategoryId(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
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
                        Nombre de la nueva categoría
                      </label>
                      <input
                        type="text"
                        placeholder="Ej. Snacks & Mecato, Cigarrillos..."
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        className="w-full rounded-xl border border-primary/40 bg-background px-3 py-2 text-sm"
                      />
                    </div>
                  )}
                </div>

                {/* Presentaciones vendibles */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted-foreground">
                      ¿Cómo lo vendes y a qué precio? (puedes poner varias presentaciones)
                    </span>
                    <button
                      type="button"
                      onClick={addEmptyPres}
                      className="press-response flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-xs font-bold text-primary"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Otra presentación
                    </button>
                  </div>

                  {presentations.map((pr, idx) => (
                    <div
                      key={idx}
                      className="grid items-center gap-2 rounded-xl border border-white/10 bg-background/60 p-2.5 sm:grid-cols-12"
                    >
                      <input
                        type="text"
                        placeholder="Ej. Unidad, Cajetilla, Shot 1oz"
                        value={pr.name}
                        onChange={(e) => updatePres(idx, { name: e.target.value })}
                        className="rounded-lg border border-white/10 bg-card px-2.5 py-1.5 text-xs font-semibold sm:col-span-4"
                      />
                      <input
                        type="number"
                        placeholder="Precio COP"
                        value={pr.salePrice}
                        onChange={(e) => updatePres(idx, { salePrice: e.target.value })}
                        className="rounded-lg border border-white/10 bg-card px-2.5 py-1.5 text-xs font-bold tabular-nums text-primary sm:col-span-3"
                      />
                      <div className="flex gap-1 sm:col-span-3">
                        <input
                          type="number"
                          step="0.5"
                          value={pr.displayQuantity}
                          onChange={(e) => updatePres(idx, { displayQuantity: e.target.value })}
                          className="w-16 rounded-lg border border-white/10 bg-card px-2 py-1.5 text-xs tabular-nums"
                        />
                        <select
                          value={pr.displayUnit}
                          onChange={(e) =>
                            updatePres(idx, { displayUnit: e.target.value as DisplayUnit })
                          }
                          className="flex-1 rounded-lg border border-white/10 bg-card px-1.5 py-1.5 text-xs"
                        >
                          {baseUnit === "unit" ? (
                            <option value="unit">und</option>
                          ) : baseUnit === "ml" ? (
                            <>
                              <option value="ml">ml</option>
                              <option value="oz">oz</option>
                              <option value="L">L</option>
                            </>
                          ) : (
                            <>
                              <option value="g">g</option>
                              <option value="kg">kg</option>
                            </>
                          )}
                        </select>
                      </div>
                      <div className="flex items-center justify-end gap-1 sm:col-span-2">
                        {baseUnit === "ml" && (
                          <input
                            type="number"
                            title="% espuma"
                            value={pr.pourLossPercent}
                            onChange={(e) => updatePres(idx, { pourLossPercent: e.target.value })}
                            className="w-12 rounded-lg border border-white/10 bg-card px-1.5 py-1.5 text-xs tabular-nums"
                          />
                        )}
                        {presentations.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setPresentations((prev) => prev.filter((_, i) => i !== idx))
                            }
                            className="rounded-lg bg-destructive/15 p-1.5 text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
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
            {saving
              ? "Guardando..."
              : publishToMenu
                ? "Crear y Publicar en POS"
                : "Guardar Solo en Inventario"}
          </button>
        </div>
      </div>
    </div>
  );
}

