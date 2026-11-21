import { useMemo, useState } from "react";
import { Coffee, ImagePlus, Martini, Plus, Trash2, Utensils, X } from "lucide-react";
import {
  convertToBaseUnit,
  type BaseUnit,
  type DisplayUnit,
  type InventoryItem,
  type MenuCategory,
  type PresentationGroup,
} from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import {
  BeerBottleIcon,
  type ProductIconToken,
} from "../../shared/components/ProductTypeIcon.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

interface RecipePresetIngredient {
  suggestedName: string;
  matchKeywords: string[];
  baseUnit: BaseUnit;
  displayUnit: DisplayUnit;
  displayQuantity: number;
  defaultInitialStock: number;
  defaultInitialCost: number;
  defaultMinStock: number;
  purchaseFormats: Array<{ name: string; factorToBase: number }>;
}

interface ComposedRecipePreset {
  id: string;
  group: "cocktail" | "coffee" | "custom";
  label: string;
  productName: string;
  presentationName: string;
  presentationGroup: PresentationGroup;
  suggestedCategory: string;
  suggestedPrice: number;
  icon: typeof Martini | typeof Coffee | typeof BeerBottleIcon | typeof Utensils;
  iconToken: ProductIconToken;
  ingredients: RecipePresetIngredient[];
}

const RECIPE_PRESETS: ComposedRecipePreset[] = [
  // === CÓCTELES CLÁSICOS ===
  {
    id: "margarita",
    group: "cocktail",
    label: "Margarita",
    productName: "Margarita Clásica",
    presentationName: "Copa",
    presentationGroup: "coctel",
    suggestedCategory: "Cócteles",
    suggestedPrice: 24000,
    icon: Martini,
    iconToken: "icon:cocktail",
    ingredients: [
      {
        suggestedName: "Tequila Blanco",
        matchKeywords: ["tequila"],
        baseUnit: "ml",
        displayUnit: "oz",
        displayQuantity: 2,
        defaultInitialStock: 750,
        defaultInitialCost: 95000,
        defaultMinStock: 200,
        purchaseFormats: [
          { name: "Botella 750ml", factorToBase: 750 },
          { name: "Litro 1000ml", factorToBase: 1000 },
        ],
      },
      {
        suggestedName: "Triple Sec / Cointreau",
        matchKeywords: ["triple sec", "cointreau", "naranja"],
        baseUnit: "ml",
        displayUnit: "oz",
        displayQuantity: 1,
        defaultInitialStock: 750,
        defaultInitialCost: 58000,
        defaultMinStock: 150,
        purchaseFormats: [{ name: "Botella 750ml", factorToBase: 750 }],
      },
      {
        suggestedName: "Zumo de Limón",
        matchKeywords: ["limón", "limon"],
        baseUnit: "ml",
        displayUnit: "oz",
        displayQuantity: 1,
        defaultInitialStock: 1000,
        defaultInitialCost: 12000,
        defaultMinStock: 200,
        purchaseFormats: [{ name: "Litro 1000ml", factorToBase: 1000 }],
      },
    ],
  },
  {
    id: "mojito",
    group: "cocktail",
    label: "Mojito",
    productName: "Mojito Clásico",
    presentationName: "Vaso Alto",
    presentationGroup: "coctel",
    suggestedCategory: "Cócteles",
    suggestedPrice: 22000,
    icon: Martini,
    iconToken: "icon:cocktail",
    ingredients: [
      {
        suggestedName: "Ron Blanco",
        matchKeywords: ["ron"],
        baseUnit: "ml",
        displayUnit: "oz",
        displayQuantity: 2,
        defaultInitialStock: 750,
        defaultInitialCost: 65000,
        defaultMinStock: 200,
        purchaseFormats: [{ name: "Botella 750ml", factorToBase: 750 }],
      },
      {
        suggestedName: "Soda / Agua con Gas",
        matchKeywords: ["soda", "gas"],
        baseUnit: "ml",
        displayUnit: "ml",
        displayQuantity: 150,
        defaultInitialStock: 3000,
        defaultInitialCost: 18000,
        defaultMinStock: 600,
        purchaseFormats: [
          { name: "Botella 300ml", factorToBase: 300 },
          { name: "Paca x12 (300ml)", factorToBase: 3600 },
        ],
      },
      {
        suggestedName: "Zumo de Limón",
        matchKeywords: ["limón", "limon"],
        baseUnit: "ml",
        displayUnit: "oz",
        displayQuantity: 1,
        defaultInitialStock: 1000,
        defaultInitialCost: 12000,
        defaultMinStock: 200,
        purchaseFormats: [{ name: "Litro 1000ml", factorToBase: 1000 }],
      },
    ],
  },
  {
    id: "gin_tonic",
    group: "cocktail",
    label: "Gin Tonic",
    productName: "Gin Tonic",
    presentationName: "Copa Balón",
    presentationGroup: "coctel",
    suggestedCategory: "Cócteles",
    suggestedPrice: 26000,
    icon: Martini,
    iconToken: "icon:cocktail",
    ingredients: [
      {
        suggestedName: "Ginebra",
        matchKeywords: ["ginebra", "gin"],
        baseUnit: "ml",
        displayUnit: "oz",
        displayQuantity: 2,
        defaultInitialStock: 750,
        defaultInitialCost: 110000,
        defaultMinStock: 200,
        purchaseFormats: [{ name: "Botella 750ml", factorToBase: 750 }],
      },
      {
        suggestedName: "Agua Tónica",
        matchKeywords: ["tónica", "tonica"],
        baseUnit: "ml",
        displayUnit: "ml",
        displayQuantity: 200,
        defaultInitialStock: 2400,
        defaultInitialCost: 30000,
        defaultMinStock: 600,
        purchaseFormats: [
          { name: "Botella 200ml", factorToBase: 200 },
          { name: "Six-pack x6", factorToBase: 1200 },
        ],
      },
    ],
  },
  {
    id: "cuba_libre",
    group: "cocktail",
    label: "Cuba Libre",
    productName: "Cuba Libre",
    presentationName: "Vaso Alto",
    presentationGroup: "coctel",
    suggestedCategory: "Cócteles",
    suggestedPrice: 18000,
    icon: Martini,
    iconToken: "icon:cocktail",
    ingredients: [
      {
        suggestedName: "Ron Añejo",
        matchKeywords: ["ron"],
        baseUnit: "ml",
        displayUnit: "oz",
        displayQuantity: 2,
        defaultInitialStock: 750,
        defaultInitialCost: 68000,
        defaultMinStock: 200,
        purchaseFormats: [{ name: "Botella 750ml", factorToBase: 750 }],
      },
      {
        suggestedName: "Gaseosa Cola",
        matchKeywords: ["cola", "coca", "gaseosa"],
        baseUnit: "ml",
        displayUnit: "ml",
        displayQuantity: 200,
        defaultInitialStock: 3000,
        defaultInitialCost: 15000,
        defaultMinStock: 600,
        purchaseFormats: [{ name: "Botella 1.5L", factorToBase: 1500 }],
      },
    ],
  },
  {
    id: "michelada",
    group: "cocktail",
    label: "Michelada",
    productName: "Michelada Clásica",
    presentationName: "Vaso",
    presentationGroup: "coctel",
    suggestedCategory: "Cócteles",
    suggestedPrice: 12000,
    icon: BeerBottleIcon,
    iconToken: "icon:beer_bottle",
    ingredients: [
      {
        suggestedName: "Cerveza Rubia 330ml",
        matchKeywords: ["cerveza", "poker", "club", "aguila", "corona"],
        baseUnit: "unit",
        displayUnit: "unit",
        displayQuantity: 1,
        defaultInitialStock: 30,
        defaultInitialCost: 90000,
        defaultMinStock: 10,
        purchaseFormats: [
          { name: "Canasta x30", factorToBase: 30 },
          { name: "Six-pack x6", factorToBase: 6 },
          { name: "Unidad x1", factorToBase: 1 },
        ],
      },
      {
        suggestedName: "Zumo de Limón",
        matchKeywords: ["limón", "limon"],
        baseUnit: "ml",
        displayUnit: "oz",
        displayQuantity: 1.5,
        defaultInitialStock: 1000,
        defaultInitialCost: 12000,
        defaultMinStock: 200,
        purchaseFormats: [{ name: "Litro 1000ml", factorToBase: 1000 }],
      },
    ],
  },
  // === CAFÉS COMPUESTOS (CON LECHE Y CON LICOR) ===
  {
    id: "latte",
    group: "coffee",
    label: "Latte",
    productName: "Café Latte",
    presentationName: "Taza 9 oz",
    presentationGroup: "otro",
    suggestedCategory: "Cafetería",
    suggestedPrice: 8500,
    icon: Coffee,
    iconToken: "icon:coffee",
    ingredients: [
      {
        suggestedName: "Café en Grano",
        matchKeywords: ["café", "cafe", "grano"],
        baseUnit: "g",
        displayUnit: "g",
        displayQuantity: 18,
        defaultInitialStock: 1000,
        defaultInitialCost: 52000,
        defaultMinStock: 200,
        purchaseFormats: [
          { name: "Libra (500g)", factorToBase: 500 },
          { name: "Kilo (1000g)", factorToBase: 1000 },
          { name: "Bolsa 250g", factorToBase: 250 },
        ],
      },
      {
        suggestedName: "Leche Entera",
        matchKeywords: ["leche"],
        baseUnit: "ml",
        displayUnit: "ml",
        displayQuantity: 180,
        defaultInitialStock: 3000,
        defaultInitialCost: 15000,
        defaultMinStock: 500,
        purchaseFormats: [
          { name: "Bolsa / Caja 1L", factorToBase: 1000 },
          { name: "Six-pack 6L", factorToBase: 6000 },
        ],
      },
    ],
  },
  {
    id: "capuccino",
    group: "coffee",
    label: "Capuccino",
    productName: "Capuccino",
    presentationName: "Taza 7 oz",
    presentationGroup: "otro",
    suggestedCategory: "Cafetería",
    suggestedPrice: 8500,
    icon: Coffee,
    iconToken: "icon:coffee",
    ingredients: [
      {
        suggestedName: "Café en Grano",
        matchKeywords: ["café", "cafe", "grano"],
        baseUnit: "g",
        displayUnit: "g",
        displayQuantity: 18,
        defaultInitialStock: 1000,
        defaultInitialCost: 52000,
        defaultMinStock: 200,
        purchaseFormats: [
          { name: "Libra (500g)", factorToBase: 500 },
          { name: "Kilo (1000g)", factorToBase: 1000 },
        ],
      },
      {
        suggestedName: "Leche Entera",
        matchKeywords: ["leche"],
        baseUnit: "ml",
        displayUnit: "ml",
        displayQuantity: 150,
        defaultInitialStock: 3000,
        defaultInitialCost: 15000,
        defaultMinStock: 500,
        purchaseFormats: [{ name: "Bolsa / Caja 1L", factorToBase: 1000 }],
      },
    ],
  },
  {
    id: "carajillo",
    group: "coffee",
    label: "Carajillo / Café Licor",
    productName: "Carajillo",
    presentationName: "Copa / Taza",
    presentationGroup: "coctel",
    suggestedCategory: "Cafetería",
    suggestedPrice: 18000,
    icon: Coffee,
    iconToken: "icon:coffee",
    ingredients: [
      {
        suggestedName: "Café en Grano",
        matchKeywords: ["café", "cafe", "grano"],
        baseUnit: "g",
        displayUnit: "g",
        displayQuantity: 18,
        defaultInitialStock: 1000,
        defaultInitialCost: 52000,
        defaultMinStock: 200,
        purchaseFormats: [
          { name: "Libra (500g)", factorToBase: 500 },
          { name: "Kilo (1000g)", factorToBase: 1000 },
        ],
      },
      {
        suggestedName: "Licor 43 / Baileys / Ron",
        matchKeywords: ["licor 43", "baileys", "whisky", "ron", "brandy"],
        baseUnit: "ml",
        displayUnit: "oz",
        displayQuantity: 1.5,
        defaultInitialStock: 750,
        defaultInitialCost: 115000,
        defaultMinStock: 150,
        purchaseFormats: [{ name: "Botella 750ml", factorToBase: 750 }],
      },
    ],
  },
  {
    id: "custom",
    group: "custom",
    label: "Receta Libre",
    productName: "",
    presentationName: "Estándar",
    presentationGroup: "coctel",
    suggestedCategory: "Especiales",
    suggestedPrice: 20000,
    icon: Utensils,
    iconToken: "icon:cocktail",
    ingredients: [],
  },
];

interface DraftIngredient {
  mode: "existing" | "create";
  inventoryItemId: string;
  newName: string;
  baseUnit: BaseUnit;
  displayUnit: DisplayUnit;
  displayQuantity: string;
  initialStock: string;
  initialCost: string;
  minStock: string;
  purchaseFormats: Array<{ name: string; factorToBase: number }>;
}

function buildDraftsFromPreset(
  preset: ComposedRecipePreset,
  inventoryItems: InventoryItem[],
): DraftIngredient[] {
  if (preset.ingredients.length === 0) {
    const first = inventoryItems[0];
    return [
      {
        mode: first ? "existing" : "create",
        inventoryItemId: first?.id ?? "",
        newName: "",
        baseUnit: first?.baseUnit ?? "ml",
        displayUnit: first?.baseUnit === "ml" ? "oz" : first?.baseUnit ?? "ml",
        displayQuantity: first?.baseUnit === "ml" ? "1.5" : "1",
        initialStock: "750",
        initialCost: "50000",
        minStock: "150",
        purchaseFormats: [{ name: "Botella 750ml", factorToBase: 750 }],
      },
    ];
  }

  return preset.ingredients.map((ing) => {
    const matched = inventoryItems.find((inv) => {
      if (inv.baseUnit !== ing.baseUnit) return false;
      const lower = inv.name.toLowerCase();
      return ing.matchKeywords.some((kw) => lower.includes(kw));
    });
    return {
      mode: matched ? "existing" : "create",
      inventoryItemId: matched?.id ?? inventoryItems.find((i) => i.baseUnit === ing.baseUnit)?.id ?? "",
      newName: ing.suggestedName,
      baseUnit: ing.baseUnit,
      displayUnit: ing.displayUnit,
      displayQuantity: String(ing.displayQuantity),
      initialStock: String(ing.defaultInitialStock),
      initialCost: String(ing.defaultInitialCost),
      minStock: String(ing.defaultMinStock),
      purchaseFormats: ing.purchaseFormats,
    };
  });
}

export function ComposedRecipeModal({
  branchId,
  categories,
  inventoryItems,
  onCreated,
  onClose,
}: {
  branchId: string;
  categories: MenuCategory[];
  inventoryItems: InventoryItem[];
  onCreated: () => Promise<void>;
  onClose: () => void;
}) {
  const first = RECIPE_PRESETS[0]!;
  const matchCat = categories.find(
    (c) => c.name.toLowerCase() === first.suggestedCategory.toLowerCase(),
  );

  const [presetId, setPresetId] = useState(first.id);
  const [name, setName] = useState(first.productName);
  const [presentationName, setPresentationName] = useState(first.presentationName);
  const [presentationGroup, setPresentationGroup] = useState<PresentationGroup>(
    first.presentationGroup,
  );
  const [salePrice, setSalePrice] = useState(String(first.suggestedPrice));
  const [categoryId, setCategoryId] = useState(matchCat?.id ?? "__new__");
  const [newCategoryName, setNewCategoryName] = useState(matchCat ? "" : first.suggestedCategory);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [ingredients, setIngredients] = useState<DraftIngredient[]>(() =>
    buildDraftsFromPreset(first, inventoryItems),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentPreset = RECIPE_PRESETS.find((p) => p.id === presetId) ?? first;

  const applyPreset = (p: ComposedRecipePreset) => {
    haptics.tap();
    setPresetId(p.id);
    setName(p.productName);
    setPresentationName(p.presentationName);
    setPresentationGroup(p.presentationGroup);
    setSalePrice(String(p.suggestedPrice));
    setIngredients(buildDraftsFromPreset(p, inventoryItems));
    const cat = categories.find((c) => c.name.toLowerCase() === p.suggestedCategory.toLowerCase());
    if (cat) {
      setCategoryId(cat.id);
      setNewCategoryName("");
    } else {
      setCategoryId("__new__");
      setNewCategoryName(p.suggestedCategory);
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

  const updateIngredient = (idx: number, patch: Partial<DraftIngredient>) => {
    setIngredients((prev) =>
      prev.map((row, i) => {
        if (i !== idx) return row;
        const next = { ...row, ...patch };
        if (patch.inventoryItemId && next.mode === "existing") {
          const inv = inventoryItems.find((x) => x.id === patch.inventoryItemId);
          if (inv) {
            next.baseUnit = inv.baseUnit;
            if (
              (inv.baseUnit === "unit" && next.displayUnit !== "unit") ||
              (inv.baseUnit === "g" && next.displayUnit !== "g" && next.displayUnit !== "kg") ||
              (inv.baseUnit === "ml" &&
                next.displayUnit !== "ml" &&
                next.displayUnit !== "oz" &&
                next.displayUnit !== "L")
            ) {
              next.displayUnit = inv.baseUnit;
            }
          }
        }
        return next;
      }),
    );
  };

  // Live recipe cost & profit margin calculator
  const { estimatedCost, marginPct } = useMemo(() => {
    let cost = 0;
    for (const ing of ingredients) {
      const qty = Math.max(0, Number(ing.displayQuantity) || 0);
      if (qty <= 0) continue;
      try {
        const qtyBase = convertToBaseUnit(qty, ing.displayUnit, ing.baseUnit);
        if (ing.mode === "existing") {
          const inv = inventoryItems.find((i) => i.id === ing.inventoryItemId);
          cost += qtyBase * (inv?.avgUnitCostBase ?? 0);
        } else {
          const st = Number(ing.initialStock) || 0;
          const tot = Number(ing.initialCost) || 0;
          const unitCost = st > 0 && tot > 0 ? tot / st : 0;
          cost += qtyBase * unitCost;
        }
      } catch {
        // Skip incompatible unit transition
      }
    }
    const price = Number(salePrice) || 0;
    const margin = price > 0 ? Math.round(((price - cost) / price) * 100) : 0;
    return { estimatedCost: Math.round(cost), marginPct: margin };
  }, [ingredients, inventoryItems, salePrice]);

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Escribe el nombre del cóctel o bebida compuesta.");
      return;
    }
    if (ingredients.length === 0) {
      setError("Agrega al menos un ingrediente a la receta.");
      return;
    }
    for (const ing of ingredients) {
      if (ing.mode === "existing" && !ing.inventoryItemId) {
        setError("Selecciona un insumo existente o cambia el ingrediente a '+ Crear insumo'.");
        return;
      }
      if (ing.mode === "create" && !ing.newName.trim()) {
        setError("Escribe el nombre de cada ingrediente nuevo a crear.");
        return;
      }
    }

    setSaving(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/recipes/composed`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          presentationName: presentationName.trim() || "Estándar",
          presentationGroup,
          salePrice: Number(salePrice) || 0,
          categoryId: categoryId !== "__new__" ? categoryId : undefined,
          newCategoryName: categoryId === "__new__" ? newCategoryName.trim() : undefined,
          imageUrl: imageUrl ?? currentPreset.iconToken,
          ingredients: ingredients.map((ing) => ({
            inventoryItemId: ing.mode === "existing" ? ing.inventoryItemId : undefined,
            createIngredient:
              ing.mode === "create"
                ? {
                    name: ing.newName.trim(),
                    baseUnit: ing.baseUnit,
                    initialStockBase: Number(ing.initialStock) || 0,
                    initialTotalCost: Number(ing.initialCost) || 0,
                    minStockBase: Number(ing.minStock) || 0,
                    defaultPourLossPercent: ing.baseUnit === "ml" ? 2 : 0,
                    purchasePresentations: ing.purchaseFormats,
                  }
                : undefined,
            displayUnit: ing.displayUnit,
            displayQuantity: Math.max(0.001, Number(ing.displayQuantity) || 1),
            pourLossPercent: ing.baseUnit === "ml" ? 2 : 0,
            fixedLossBase: 0,
          })),
        }),
      });
      haptics.success();
      await onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la receta.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm md:p-5">
      <div className="material-thick flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <Martini className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display text-lg font-bold">
                Presets de Cócteles, Cafés Compuestos y Recetas
              </h2>
              <p className="text-xs text-muted-foreground">
                Descuenta varios insumos al vender (ej. café + leche + licor, o tequila + limón)
              </p>
            </div>
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
          {/* 1. Presets rápidos (Cócteles & Cafés) */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              1. Elige una plantilla predefinida (editable)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {RECIPE_PRESETS.map((p) => {
                const Icon = p.icon;
                const active = p.id === presetId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={`press-response flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold ${
                      active
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-white/10 bg-secondary/60 text-muted-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Nombre, Precio, Categoría y Foto */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                2. Producto en el Menú del POS
              </p>
              <label className="press-response flex cursor-pointer items-center gap-1.5 rounded-xl bg-secondary px-3 py-1.5 text-xs font-semibold text-primary">
                <ImagePlus className="h-3.5 w-3.5" />
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
            </div>

            <div className="grid gap-2.5 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs text-muted-foreground">Nombre *</label>
                <input
                  type="text"
                  placeholder="Ej. Margarita Clásica, Carajillo..."
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm font-semibold"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Precio venta (COP)</label>
                <input
                  type="number"
                  min={0}
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm font-bold tabular-nums text-primary"
                />
              </div>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Presentación</label>
                <input
                  type="text"
                  value={presentationName}
                  onChange={(e) => setPresentationName(e.target.value)}
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
                  <label className="mb-1 block text-xs text-muted-foreground">Nueva categoría</label>
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

          {/* 3. Ingredientes de la Receta (Vincular existente O crear al vuelo) */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-warning">
                  3. Ingredientes que descuenta del inventario
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Si ya tienes el insumo, vincúlalo; si no existe aún, se crea automáticamente al
                  guardar.
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  setIngredients((prev) => [
                    ...prev,
                    {
                      mode: inventoryItems.length > 0 ? "existing" : "create",
                      inventoryItemId: inventoryItems[0]?.id ?? "",
                      newName: "",
                      baseUnit: inventoryItems[0]?.baseUnit ?? "ml",
                      displayUnit: inventoryItems[0]?.baseUnit ?? "ml",
                      displayQuantity: "1",
                      initialStock: "750",
                      initialCost: "50000",
                      minStock: "150",
                      purchaseFormats: [{ name: "Botella 750ml", factorToBase: 750 }],
                    },
                  ])
                }
                className="press-response flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-bold text-primary"
              >
                <Plus className="h-3.5 w-3.5" />
                Ingrediente
              </button>
            </div>

            <div className="space-y-2.5">
              {ingredients.map((ing, idx) => (
                <div
                  key={idx}
                  className="space-y-2 rounded-xl border border-white/10 bg-background/60 p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={ing.mode === "create" ? "__create__" : ing.inventoryItemId}
                      onChange={(e) => {
                        if (e.target.value === "__create__") {
                          updateIngredient(idx, { mode: "create" });
                        } else {
                          updateIngredient(idx, {
                            mode: "existing",
                            inventoryItemId: e.target.value,
                          });
                        }
                      }}
                      className="min-w-44 flex-1 rounded-lg border border-white/15 bg-card px-2.5 py-1.5 font-semibold"
                    >
                      <option value="__create__">+ Crear insumo nuevo en inventario</option>
                      {inventoryItems.map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          Usar existente: {inv.name} ({inv.baseUnit})
                        </option>
                      ))}
                    </select>

                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground">Usa:</span>
                      <input
                        type="number"
                        step="0.5"
                        value={ing.displayQuantity}
                        onChange={(e) =>
                          updateIngredient(idx, { displayQuantity: e.target.value })
                        }
                        className="w-16 rounded-lg border border-white/15 bg-card px-2 py-1.5 tabular-nums"
                      />
                      <select
                        value={ing.displayUnit}
                        onChange={(e) =>
                          updateIngredient(idx, { displayUnit: e.target.value as DisplayUnit })
                        }
                        className="w-20 rounded-lg border border-white/15 bg-card px-2 py-1.5"
                      >
                        {ing.baseUnit === "unit" ? (
                          <option value="unit">und</option>
                        ) : ing.baseUnit === "g" ? (
                          <>
                            <option value="g">g</option>
                            <option value="kg">kg</option>
                          </>
                        ) : (
                          <>
                            <option value="oz">oz</option>
                            <option value="ml">ml</option>
                            <option value="L">L</option>
                          </>
                        )}
                      </select>
                    </div>

                    {ingredients.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setIngredients((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="rounded-lg bg-destructive/15 p-1.5 text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {ing.mode === "create" && (
                    <div className="grid gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2 sm:grid-cols-4">
                      <input
                        type="text"
                        placeholder="Nombre nuevo insumo *"
                        value={ing.newName}
                        onChange={(e) => updateIngredient(idx, { newName: e.target.value })}
                        className="rounded-lg border border-white/15 bg-background px-2 py-1.5 font-semibold sm:col-span-2"
                      />
                      <input
                        type="number"
                        placeholder={`Stock ini (${ing.baseUnit})`}
                        value={ing.initialStock}
                        onChange={(e) => updateIngredient(idx, { initialStock: e.target.value })}
                        className="rounded-lg border border-white/15 bg-background px-2 py-1.5 tabular-nums"
                      />
                      <input
                        type="number"
                        placeholder="Costo compra (COP)"
                        value={ing.initialCost}
                        onChange={(e) => updateIngredient(idx, { initialCost: e.target.value })}
                        className="rounded-lg border border-white/15 bg-background px-2 py-1.5 tabular-nums"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Calculadora de costo vs margen */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-background/70 px-3.5 py-2.5 text-xs tabular-nums">
              <span>
                Costo estimado receta: <strong>{formatCOP(estimatedCost)}</strong>
              </span>
              <span>
                Precio venta: <strong className="text-primary">{formatCOP(Number(salePrice) || 0)}</strong>
              </span>
              <span className={marginPct >= 50 ? "font-bold text-success" : "font-bold text-warning"}>
                Margen estimado: {marginPct}%
              </span>
            </div>
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
            {saving ? "Publicando..." : "Publicar Receta en POS"}
          </button>
        </div>
      </div>
    </div>
  );
}
