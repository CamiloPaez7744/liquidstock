import { useState } from "react";
import {
  Beer,
  Cigarette,
  Coffee,
  ImagePlus,
  Package,
  Plus,
  Trash2,
  Utensils,
  Wine,
  X,
} from "lucide-react";
import type {
  BaseUnit,
  DisplayUnit,
  MenuCategory,
  PaymentMethod,
  PresentationGroup,
} from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import {
  BeerBottleIcon,
  type ProductIconToken,
} from "../../shared/components/ProductTypeIcon.js";
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

interface PurchaseFormatDraft {
  name: string;
  factorToBase: string;
}

type PresetId =
  | "beer_bottle"
  | "keg"
  | "coffee"
  | "liquor"
  | "empanadas"
  | "snacks"
  | "cigarettes";

interface PresetConfig {
  id: PresetId;
  label: string;
  example: string;
  icon: typeof Beer | typeof BeerBottleIcon;
  iconToken: ProductIconToken;
  baseUnit: BaseUnit;
  isKeg: boolean;
  defaultPourLossPercent: string;
  purchaseFormats: PurchaseFormatDraft[];
  initialStock: string;
  initialCost: string;
  minStock: string;
  suggestedCategoryName: string;
  presentations: SellablePresentationDraft[];
}

const PRESETS: PresetConfig[] = [
  {
    id: "beer_bottle",
    label: "Cerveza Botella",
    example: "Club Colombia Dorada 330ml",
    icon: BeerBottleIcon,
    iconToken: "icon:beer_bottle",
    baseUnit: "unit",
    isKeg: false,
    defaultPourLossPercent: "0",
    purchaseFormats: [
      { name: "Canasta x30", factorToBase: "30" },
      { name: "Six-pack x6", factorToBase: "6" },
      { name: "Unidad x1", factorToBase: "1" },
    ],
    initialStock: "30",
    initialCost: "96000",
    minStock: "12",
    suggestedCategoryName: "Cervezas",
    presentations: [
      {
        name: "Botella 330ml",
        presentationGroup: "botella",
        salePrice: "7000",
        displayUnit: "unit",
        displayQuantity: "1",
        pourLossPercent: "0",
        fixedLossBase: "0",
      },
      {
        name: "Cubetazo x5",
        presentationGroup: "combo",
        salePrice: "32000",
        displayUnit: "unit",
        displayQuantity: "5",
        pourLossPercent: "0",
        fixedLossBase: "0",
      },
    ],
  },
  {
    id: "keg",
    label: "Artesanal (Barril)",
    example: "IPA Artesanal",
    icon: Beer,
    iconToken: "icon:craft_beer",
    baseUnit: "ml",
    isKeg: true,
    defaultPourLossPercent: "8",
    purchaseFormats: [
      { name: "Barril 30L", factorToBase: "30000" },
      { name: "Barril 20L", factorToBase: "20000" },
      { name: "Barril 50L", factorToBase: "50000" },
    ],
    initialStock: "30000",
    initialCost: "345000",
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
        name: "Jarra 1.5L",
        presentationGroup: "jarra",
        salePrice: "38000",
        displayUnit: "L",
        displayQuantity: "1.5",
        pourLossPercent: "5",
        fixedLossBase: "20",
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
  {
    id: "coffee",
    label: "Café en Grano",
    example: "Café Origen Huila",
    icon: Coffee,
    iconToken: "icon:coffee",
    baseUnit: "g",
    isKeg: false,
    defaultPourLossPercent: "2",
    purchaseFormats: [
      { name: "Libra (500g)", factorToBase: "500" },
      { name: "Kilo (1000g)", factorToBase: "1000" },
      { name: "Bolsa 250g", factorToBase: "250" },
    ],
    initialStock: "1000",
    initialCost: "52000",
    minStock: "200",
    suggestedCategoryName: "Cafetería",
    presentations: [
      {
        name: "Tinto / Espresso",
        presentationGroup: "otro",
        salePrice: "4500",
        displayUnit: "g",
        displayQuantity: "18",
        pourLossPercent: "2",
        fixedLossBase: "0",
      },
      {
        name: "Americano",
        presentationGroup: "otro",
        salePrice: "5500",
        displayUnit: "g",
        displayQuantity: "18",
        pourLossPercent: "2",
        fixedLossBase: "0",
      },
      {
        name: "Espresso Doble",
        presentationGroup: "otro",
        salePrice: "7000",
        displayUnit: "g",
        displayQuantity: "36",
        pourLossPercent: "2",
        fixedLossBase: "0",
      },
    ],
  },
  {
    id: "liquor",
    label: "Licor / Shots",
    example: "Aguardiente Amarillo",
    icon: Wine,
    iconToken: "icon:liquor",
    baseUnit: "ml",
    isKeg: false,
    defaultPourLossPercent: "2",
    purchaseFormats: [
      { name: "Botella 750ml", factorToBase: "750" },
      { name: "Litro 1000ml", factorToBase: "1000" },
      { name: "Caja x12 (750ml)", factorToBase: "9000" },
    ],
    initialStock: "1500",
    initialCost: "90000",
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
    id: "empanadas",
    label: "Empanadas / Casa",
    example: "Empanada de Carne",
    icon: Utensils,
    iconToken: "icon:food",
    baseUnit: "unit",
    isKeg: false,
    defaultPourLossPercent: "0",
    purchaseFormats: [
      { name: "Bandeja x20", factorToBase: "20" },
      { name: "Unidad x1", factorToBase: "1" },
    ],
    initialStock: "20",
    initialCost: "32000",
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
    id: "snacks",
    label: "Papas / Snacks",
    example: "Papas Margarita Pollo",
    icon: Package,
    iconToken: "icon:snacks",
    baseUnit: "unit",
    isKeg: false,
    defaultPourLossPercent: "0",
    purchaseFormats: [
      { name: "Paca x12", factorToBase: "12" },
      { name: "Unidad x1", factorToBase: "1" },
    ],
    initialStock: "24",
    initialCost: "48000",
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
    id: "cigarettes",
    label: "Cigarrillos",
    example: "Marlboro Rojo",
    icon: Cigarette,
    iconToken: "icon:cigarettes",
    baseUnit: "unit",
    isKeg: false,
    defaultPourLossPercent: "0",
    purchaseFormats: [
      { name: "Cajetilla x20", factorToBase: "20" },
      { name: "Cartón x200", factorToBase: "200" },
      { name: "Unidad x1", factorToBase: "1" },
    ],
    initialStock: "40",
    initialCost: "24000",
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
];

interface NewInventoryItemModalProps {
  branchId: string;
  userId: string;
  categories: MenuCategory[];
  treasuryAccounts?: PaymentMethod[];
  onCreated: (createdItemId?: string) => Promise<void>;
  onClose: () => void;
}

export function NewInventoryItemModal({
  branchId,
  userId,
  categories,
  treasuryAccounts = [],
  onCreated,
  onClose,
}: NewInventoryItemModalProps) {
  const firstPreset = PRESETS[0]!;
  const initialCat = categories.find(
    (c) => c.name.toLowerCase() === firstPreset.suggestedCategoryName.toLowerCase(),
  );

  const [presetId, setPresetId] = useState<PresetId>(firstPreset.id);
  const [name, setName] = useState("");
  const [baseUnit, setBaseUnit] = useState<BaseUnit>(firstPreset.baseUnit);
  const [isKeg, setIsKeg] = useState(firstPreset.isKeg);
  const [defaultPourLossPct, setDefaultPourLossPct] = useState(firstPreset.defaultPourLossPercent);
  const [purchaseFormats, setPurchaseFormats] = useState<PurchaseFormatDraft[]>(
    firstPreset.purchaseFormats.map((f) => ({ ...f })),
  );
  const [initialStock, setInitialStock] = useState(firstPreset.initialStock);
  const [initialCost, setInitialCost] = useState(firstPreset.initialCost);
  const [minStock, setMinStock] = useState(firstPreset.minStock);
  const [paymentStatus, setPaymentStatus] = useState<"paid" | "pending" | "partial" | "none">("paid");
  const [paymentMethodId, setPaymentMethodId] = useState(treasuryAccounts[0]?.id ?? "");
  const [paidAmount, setPaidAmount] = useState("");
  const [supplierName, setSupplierName] = useState("");

  const [publishToMenu, setPublishToMenu] = useState(true);
  const [categoryId, setCategoryId] = useState<string>(initialCat?.id ?? "__new__");
  const [newCategoryName, setNewCategoryName] = useState(
    initialCat ? "" : firstPreset.suggestedCategoryName,
  );
  const [editionTag, setEditionTag] = useState<string>("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [presentations, setPresentations] = useState<SellablePresentationDraft[]>(
    firstPreset.presentations.map((p) => ({ ...p })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentPreset = PRESETS.find((p) => p.id === presetId) ?? firstPreset;

  const applyPreset = (p: PresetConfig) => {
    haptics.tap();
    setPresetId(p.id);
    setBaseUnit(p.baseUnit);
    setIsKeg(p.isKeg);
    setDefaultPourLossPct(p.defaultPourLossPercent);
    setPurchaseFormats(p.purchaseFormats.map((f) => ({ ...f })));
    setInitialStock(p.initialStock);
    setInitialCost(p.initialCost);
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
        name: baseUnit === "ml" ? "Presentación nueva" : baseUnit === "g" ? "Taza / Porción" : "Unidad",
        presentationGroup: baseUnit === "ml" ? "trago" : "otro",
        salePrice: "5000",
        displayUnit: baseUnit,
        displayQuantity: baseUnit === "g" ? "18" : "1",
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

    const validFormats = purchaseFormats
      .filter((f) => f.name.trim() && Number(f.factorToBase) > 0)
      .map((f, idx) => ({
        name: f.name.trim(),
        factorToBase: Number(f.factorToBase),
        lastPurchaseCost: idx === 0 ? Number(initialCost) || 0 : null,
        isDefault: idx === 0,
      }));

    setSaving(true);
    try {
      const created = await apiFetch<{ id: string }>(`/api/v1/branches/${branchId}/inventory/items`, {
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
          paymentStatus: Number(initialCost) > 0 ? paymentStatus : "none",
          paymentMethodId:
            paymentStatus === "paid" || paymentStatus === "partial"
              ? paymentMethodId || treasuryAccounts[0]?.id || undefined
              : undefined,
          paidAmount: paymentStatus === "partial" ? Number(paidAmount) || 0 : undefined,
          supplierName: supplierName.trim() || undefined,
          purchasePresentations: validFormats.length > 0 ? validFormats : undefined,
          publishToMenu: publishToMenu
            ? {
                categoryId: categoryId !== "__new__" ? categoryId : undefined,
                newCategoryName: categoryId === "__new__" ? newCategoryName.trim() : undefined,
                productName: name.trim(),
                imageUrl: imageUrl ?? currentPreset.iconToken,
                editionTag: editionTag.trim() || null,
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
      await onCreated(created.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el insumo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm md:p-5">
      <div className="material-thick flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-bold">Nuevo Insumo / Producto</h2>
            <p className="text-xs text-muted-foreground">
              Elige un preset y define múltiples formatos de compra (unidad, six-pack, canasta,
              libra, barril)
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
          {/* 1. Plantillas con íconos vectoriales coherentes */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              1. Tipo de producto
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {PRESETS.map((p) => {
                const Icon = p.icon;
                const active = p.id === presetId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={`press-response flex flex-col items-center justify-center gap-1.5 rounded-2xl border p-2.5 text-center text-[11px] font-bold ${
                      active
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-white/10 bg-secondary/60 text-muted-foreground"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="leading-tight">{p.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Datos de Inventario y Múltiples Formatos de Compra */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              2. Datos de Inventario y Formatos de Compra
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
                  <option value="unit">Unidades (botellas, snacks, empanadas)</option>
                  <option value="ml">Mililitros (barriles, licores, leche)</option>
                  <option value="g">Gramos (café en grano, sólidos)</option>
                </select>
              </div>
            </div>

            <div className={`grid gap-3 ${baseUnit === "ml" || baseUnit === "g" ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
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
              {(baseUnit === "ml" || baseUnit === "g") && (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    {baseUnit === "ml" ? "% Merma / Espuma (opcional)" : "% Merma molienda (opcional)"}
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
              )}
            </div>

            {/* Formatos de compra flexibles (Unidad, Six-pack, Canasta x30, Libra, Kilo...) */}
            <div className="space-y-2 rounded-xl border border-white/10 bg-background/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  Formatos en los que compras este insumo (puedes tener varios)
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPurchaseFormats((prev) => [...prev, { name: "", factorToBase: "1" }])
                  }
                  className="press-response flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-[11px] font-bold text-primary"
                >
                  <Plus className="h-3 w-3" />
                  Agregar formato
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {purchaseFormats.map((pf, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-card p-1.5"
                  >
                    <input
                      type="text"
                      placeholder="Ej. Canasta x30, Libra"
                      value={pf.name}
                      onChange={(e) =>
                        setPurchaseFormats((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)),
                        )
                      }
                      className="min-w-0 flex-1 rounded-md bg-background px-2 py-1 text-xs font-semibold"
                    />
                    <span className="text-[10px] text-muted-foreground">=</span>
                    <input
                      type="number"
                      min={0.1}
                      step="any"
                      value={pf.factorToBase}
                      onChange={(e) =>
                        setPurchaseFormats((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, factorToBase: e.target.value } : x,
                          ),
                        )
                      }
                      className="w-16 rounded-md bg-background px-2 py-1 text-right text-xs tabular-nums"
                    />
                    <span className="pr-1 text-[10px] text-muted-foreground">{baseUnit}</span>
                    {purchaseFormats.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setPurchaseFormats((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="rounded-md bg-destructive/15 p-1 text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {baseUnit === "ml" && (
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-background/60 px-3 py-2 text-xs font-semibold">
                <input
                  type="checkbox"
                  checked={isKeg}
                  onChange={(e) => setIsKeg(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                Es barril de cerveza artesanal (calcula pintas restantes y espuma)
              </label>
            )}

            {/* Conexión automática con Ingresos/Egresos y Cuentas por Pagar a Proveedores (siempre visible) */}
            <div className="space-y-2.5 rounded-xl border border-primary/25 bg-primary/5 p-3 text-xs">
              <p className="font-bold text-primary">
                Registro en Ingresos y Egresos (editable luego en Finanzas)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { id: "paid", label: "Pagado completo" },
                    { id: "pending", label: "Pendiente (fiado proveedor)" },
                    { id: "partial", label: "Pago parcial" },
                    { id: "none", label: "Solo stock (sin afectar caja)" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setPaymentStatus(opt.id)}
                    className={`press-response rounded-lg border px-2.5 py-1.5 text-[11px] font-bold ${
                      paymentStatus === opt.id
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-white/10 bg-background/70 text-muted-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {paymentStatus !== "none" && (
                <>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(paymentStatus === "paid" || paymentStatus === "partial") && (
                      <select
                        value={paymentMethodId || treasuryAccounts[0]?.id || ""}
                        onChange={(e) => setPaymentMethodId(e.target.value)}
                        className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
                      >
                        {treasuryAccounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            Sale de: {acc.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {paymentStatus === "partial" && (
                      <input
                        type="number"
                        min={0}
                        placeholder="Abono inicial (COP)"
                        value={paidAmount}
                        onChange={(e) => setPaidAmount(e.target.value)}
                        className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs font-bold tabular-nums"
                      />
                    )}
                    <input
                      type="text"
                      placeholder={
                        paymentStatus === "paid"
                          ? "Proveedor (opcional)"
                          : "Nombre del proveedor *"
                      }
                      value={supplierName}
                      onChange={(e) => setSupplierName(e.target.value)}
                      className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
                    />
                  </div>
                  {!(Number(initialCost) > 0) && (
                    <p className="text-[11px] font-medium text-warning">
                      Ingresa el costo de inversión arriba (mayor a $0) para que se registre en Ingresos y Egresos / Proveedores.
                    </p>
                  )}
                </>
              )}
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
                  {uploading ? "Subiendo..." : imageUrl ? "Foto cargada ✓" : "Subir foto (opcional)"}
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
                        placeholder="Ej. Cervezas, Cafetería, Snacks..."
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        className="w-full rounded-xl border border-primary/40 bg-background px-3 py-2 text-sm"
                      />
                    </div>
                  )}
                </div>

                {/* Etiqueta especial en el POS (Temporada / Edición Limitada / Nueva) */}
                <div className="space-y-2 rounded-xl border border-white/10 bg-background/50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-muted-foreground">
                      Etiqueta destacada en el POS (opcional)
                    </span>
                    {editionTag.trim() && (
                      <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[11px] font-bold text-accent">
                        {editionTag.trim()}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {["", "Temporada", "Edición Limitada", "Nueva", "Recomendada"].map((tagOpt) => {
                      const active = editionTag.trim() === tagOpt;
                      return (
                        <button
                          key={tagOpt || "none"}
                          type="button"
                          onClick={() => {
                            haptics.tap();
                            setEditionTag(tagOpt);
                          }}
                          className={`press-response rounded-lg border px-2.5 py-1 text-xs font-bold transition ${
                            active
                              ? tagOpt
                                ? "border-accent bg-accent/20 text-accent"
                                : "border-primary bg-primary/15 text-primary"
                              : "border-white/10 bg-secondary/60 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {tagOpt || "Sin etiqueta"}
                        </button>
                      );
                    })}
                    <input
                      type="text"
                      maxLength={24}
                      placeholder="Otra (ej. Oktoberfest)"
                      value={editionTag}
                      onChange={(e) => setEditionTag(e.target.value)}
                      className="min-w-36 flex-1 rounded-lg border border-white/15 bg-background px-2.5 py-1 text-xs"
                    />
                  </div>
                </div>

                {/* Presentaciones vendibles */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted-foreground">
                      ¿Cómo lo vendes y cuánto descuenta?
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
                        placeholder="Ej. Botella 330ml, Tinto, Shot"
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
