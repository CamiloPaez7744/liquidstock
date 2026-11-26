import { useMemo, useState } from "react";
import {
  ChefHat,
  Eye,
  EyeOff,
  Layers,
  Pencil,
  Plus,
  Store,
  Trash2,
  X,
} from "lucide-react";
import type { ComboTemplate, DisplayUnit, PresentationGroup } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { useFeedback } from "../../shared/components/FeedbackProvider.js";
import { ProductVisualAvatar } from "../../shared/components/ProductTypeIcon.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";
import { NewComboModal } from "../settings/NewComboModal.js";

type StoreType = ReturnType<typeof useLiquiStock>;

interface HouseIngredientDraft {
  inventoryItemId: string;
  displayQuantity: string;
  displayUnit: DisplayUnit;
}

const PRES_GROUPS: Array<{ id: PresentationGroup; label: string }> = [
  { id: "vaso", label: "Vaso (ej. 330ml)" },
  { id: "pinta", label: "Pinta (ej. 500ml)" },
  { id: "jarra", label: "Jarra" },
  { id: "jirafa", label: "Jirafa" },
  { id: "botella", label: "Botella" },
  { id: "lata", label: "Lata" },
  { id: "shot", label: "Shot" },
  { id: "trago", label: "Trago" },
  { id: "coctel", label: "Cóctel" },
  { id: "comida", label: "Comida" },
  { id: "otro", label: "Otro" },
];

export function CentralizedCombosTab({
  store,
  branchId,
}: {
  store: StoreType;
  branchId: string;
}) {
  const { toast } = useFeedback();
  const [saving, setSaving] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [showStandaloneAllyModal, setShowStandaloneAllyModal] = useState(false);

  // Unified Combo Builder state
  // Part 1: Bar product (Dynamic category OR specific product + presentation + qty)
  const [scopeType, setScopeType] = useState<"category" | "product">("category");
  const [targetId, setTargetId] = useState("");
  const [presGroup, setPresGroup] = useState<PresentationGroup>("vaso");
  const [baseQuantity, setBaseQuantity] = useState("1");

  // Part 2: Fixed companion (Third-party ally [default], House stock item, or Both)
  const [companionType, setCompanionType] = useState<"ally" | "house" | "both">("ally");
  const [comboName, setComboName] = useState("");
  const [shortLabel, setShortLabel] = useState("");
  const [allyId, setAllyId] = useState("");
  const [allyPayout, setAllyPayout] = useState("10000");
  const [houseIngredients, setHouseIngredients] = useState<HouseIngredientDraft[]>([]);

  // Part 3: Pricing
  const [pricingMode, setPricingMode] = useState<"fixed_price" | "add_on_price">("fixed_price");
  const [priceValue, setPriceValue] = useState("22000");

  const standaloneProducts = useMemo(
    () =>
      store.menuProducts.filter(
        (p) => p.productKind === "combo" || p.productKind === "third_party_ally",
      ),
    [store.menuProducts],
  );

  const defaultUnitForItem = (itemId: string): DisplayUnit => {
    const item = store.inventoryItems.find((i) => i.id === itemId);
    if (!item) return "unit";
    return item.baseUnit === "ml" ? "ml" : item.baseUnit === "g" ? "g" : "unit";
  };

  const resetBuilder = () => {
    setEditingTemplateId(null);
    setScopeType("category");
    setTargetId(store.categories[0]?.id ?? "");
    setPresGroup("vaso");
    setBaseQuantity("1");
    setCompanionType(store.allies.length > 0 ? "ally" : "house");
    setComboName("");
    setShortLabel("");
    setAllyId(store.allies[0]?.id ?? "");
    setAllyPayout("10000");
    setHouseIngredients(
      store.allies.length === 0 && store.inventoryItems[0]
        ? [
            {
              inventoryItemId: store.inventoryItems[0].id,
              displayQuantity: "1",
              displayUnit: defaultUnitForItem(store.inventoryItems[0].id),
            },
          ]
        : [],
    );
    setPricingMode("fixed_price");
    setPriceValue("22000");
  };

  const openNewBuilder = () => {
    haptics.tap();
    resetBuilder();
    setShowBuilder(true);
  };

  const openEditBuilder = (tpl: ComboTemplate) => {
    haptics.tap();
    setEditingTemplateId(tpl.id);
    setScopeType(tpl.scopeType);
    setTargetId(tpl.targetId);
    setPresGroup(tpl.presentationGroup);
    setBaseQuantity(String(Math.max(1, tpl.baseQuantity ?? 1)));
    const inferredCompanion: "ally" | "house" | "both" =
      tpl.companionType ??
      (tpl.allyId && tpl.fixedRecipes && tpl.fixedRecipes.length > 0
        ? "both"
        : tpl.fixedRecipes && tpl.fixedRecipes.length > 0
          ? "house"
          : "ally");
    setCompanionType(inferredCompanion);
    setComboName(tpl.name);
    setShortLabel(tpl.shortLabel ?? "");
    setAllyId(tpl.allyId ?? "");
    setAllyPayout(String(tpl.allyPayoutAmount ?? 0));
    setHouseIngredients(
      (tpl.fixedRecipes ?? []).map((r) => ({
        inventoryItemId: r.inventoryItemId,
        displayQuantity: String(r.displayQuantity),
        displayUnit: r.displayUnit,
      })),
    );
    setPricingMode(tpl.pricingMode);
    setPriceValue(String(tpl.priceValue));
    setShowBuilder(true);
  };

  const handleChangeCompanionType = (next: "ally" | "house" | "both") => {
    setCompanionType(next);
    if ((next === "house" || next === "both") && houseIngredients.length === 0 && store.inventoryItems[0]) {
      setHouseIngredients([
        {
          inventoryItemId: store.inventoryItems[0].id,
          displayQuantity: "1",
          displayUnit: defaultUnitForItem(store.inventoryItems[0].id),
        },
      ]);
    }
    if ((next === "ally" || next === "both") && !allyId && store.allies[0]) {
      setAllyId(store.allies[0].id);
    }
  };

  const runAction = async (successMsg: string, fn: () => Promise<void>) => {
    setSaving(true);
    try {
      await fn();
      haptics.success();
      await store.refresh();
      toast({ kind: "success", title: "Combos actualizados", description: successMsg });
    } catch (err) {
      haptics.blocked();
      toast({
        kind: "error",
        title: "No se pudo guardar",
        description: err instanceof Error ? err.message : "Error de conexión",
      });
    } finally {
      setSaving(false);
    }
  };

  const effectiveTargetId =
    targetId ||
    (scopeType === "category"
      ? (store.categories[0]?.id ?? "")
      : (store.menuProducts[0]?.id ?? ""));

  const effectiveTargetName =
    scopeType === "category"
      ? (store.categories.find((c) => c.id === effectiveTargetId)?.name ?? "Categoría")
      : (store.menuProducts.find((p) => p.id === effectiveTargetId)?.name ?? "Producto");

  const effectiveAllyName =
    companionType !== "house" && allyId
      ? (store.allies.find((a) => a.id === allyId)?.name ?? null)
      : null;

  const validHouseRecipes =
    companionType === "ally"
      ? []
      : houseIngredients
          .filter((r) => r.inventoryItemId && Number(r.displayQuantity) > 0)
          .map((r) => ({
            inventoryItemId: r.inventoryItemId,
            displayUnit: r.displayUnit,
            displayQuantity: Number(r.displayQuantity),
          }));

  const canSaveCombo =
    comboName.trim().length > 0 &&
    Boolean(effectiveTargetId) &&
    (companionType !== "house" || validHouseRecipes.length > 0) &&
    (companionType !== "ally" || Boolean(allyId) || store.allies.length === 0);

  const handleSaveCombo = () => {
    if (!canSaveCombo) return;
    const payload = {
      name: comboName.trim(),
      shortLabel: shortLabel.trim() || null,
      scopeType,
      targetId: effectiveTargetId,
      presentationGroup: presGroup,
      baseQuantity: Math.max(1, Math.trunc(Number(baseQuantity) || 1)),
      companionType,
      pricingMode,
      priceValue: Math.max(0, Number(priceValue) || 0),
      allyId: companionType === "house" ? null : allyId || null,
      allyPayoutAmount:
        companionType === "house" || !allyId ? 0 : Math.max(0, Number(allyPayout) || 0),
      fixedRecipes: validHouseRecipes,
    };

    void runAction(
      editingTemplateId
        ? `Combo "${comboName.trim()}" actualizado`
        : `Combo "${comboName.trim()}" creado`,
      async () => {
        if (editingTemplateId) {
          await apiFetch(`/api/v1/branches/${branchId}/combo-templates/${editingTemplateId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          });
        } else {
          await apiFetch(`/api/v1/branches/${branchId}/combo-templates`, {
            method: "POST",
            body: JSON.stringify(payload),
          });
        }
        setShowBuilder(false);
        setEditingTemplateId(null);
      },
    );
  };

  return (
    <div className="space-y-5">
      {/* Cabecera unificada y minimalista */}
      <div className="solid-card flex flex-wrap items-center justify-between gap-3 rounded-2xl border-primary/25 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-warning/15 text-warning">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-display text-base font-bold">Combos del Bar</h3>
            <p className="text-xs text-muted-foreground">
              Vincula tu bebida (toda una categoría o un producto específico) con un alimento fijo de <strong>aliado</strong> o de la <strong>casa</strong>.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => (showBuilder ? setShowBuilder(false) : openNewBuilder())}
            className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-bold text-primary-foreground"
          >
            {showBuilder ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {showBuilder ? "Cerrar editor" : "Nuevo Combo"}
          </button>
          <button
            type="button"
            onClick={() => {
              haptics.tap();
              setShowStandaloneAllyModal(true);
            }}
            className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-secondary px-3.5 text-xs font-semibold text-foreground"
          >
            <Store className="h-3.5 w-3.5 text-warning" />
            Producto solo de Aliado
          </button>
        </div>
      </div>

      {/* Creador / Editor Unificado en 3 pasos claros */}
      {showBuilder && (
        <section className="solid-card space-y-4 rounded-2xl border-primary/35 p-4 text-xs">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-display text-sm font-bold text-primary">
              {editingTemplateId ? "Editar Combo" : "Configurar Nuevo Combo"}
            </h4>
            <button
              type="button"
              onClick={() => {
                setShowBuilder(false);
                setEditingTemplateId(null);
              }}
              className="rounded-lg bg-secondary p-1.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* PASO 1: Bebida / Producto del bar (dinámico por categoría o específico) */}
          <div className="space-y-2.5 rounded-xl border border-white/10 bg-background/55 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold text-foreground">
                1. Tu producto del bar (se descuenta el que elija el cliente)
              </p>
              <div className="flex rounded-lg bg-secondary p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => {
                    setScopeType("category");
                    setTargetId(store.categories[0]?.id ?? "");
                  }}
                  className={`rounded-md px-2.5 py-1 font-bold ${
                    scopeType === "category"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  Dinámico (Categoría)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScopeType("product");
                    setTargetId(store.menuProducts[0]?.id ?? "");
                  }}
                  className={`rounded-md px-2.5 py-1 font-bold ${
                    scopeType === "product"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  Producto específico
                </button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">
                  {scopeType === "category" ? "Categoría aplicable" : "Producto aplicable"}
                </label>
                <select
                  value={effectiveTargetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-card px-3 py-2"
                >
                  {scopeType === "category"
                    ? store.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))
                    : store.menuProducts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">
                  Presentación incluida
                </label>
                <select
                  value={presGroup}
                  onChange={(e) => setPresGroup(e.target.value as PresentationGroup)}
                  className="w-full rounded-xl border border-white/15 bg-card px-3 py-2"
                >
                  {PRES_GROUPS.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">
                  Cantidad de bebidas (ej. 1 o 2)
                </label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={baseQuantity}
                  onChange={(e) => setBaseQuantity(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-card px-3 py-2 font-bold tabular-nums"
                />
              </div>
            </div>
          </div>

          {/* PASO 2: Acompañamiento fijo (Aliado o Casa o Ambos) */}
          <div className="space-y-2.5 rounded-xl border border-white/10 bg-background/55 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold text-foreground">2. Alimento / Acompañamiento fijo</p>
              <div className="flex rounded-lg bg-secondary p-0.5 text-[11px]">
                {(
                  [
                    { id: "ally", label: "De Aliado (Tercero)", icon: Store },
                    { id: "house", label: "De la Casa (Stock)", icon: ChefHat },
                    { id: "both", label: "Aliado + Casa", icon: Layers },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => handleChangeCompanionType(id)}
                    className={`flex items-center gap-1 rounded-md px-2.5 py-1 font-bold ${
                      companionType === id
                        ? "bg-warning text-primary-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <input
                type="text"
                placeholder="Nombre del acompañamiento (ej. Perro Caliente, Salchipapa, Empanadas)"
                value={comboName}
                onChange={(e) => setComboName(e.target.value)}
                className="rounded-xl border border-white/15 bg-card px-3 py-2"
              />
              <input
                type="text"
                placeholder="Etiqueta corta en botón POS (opcional, ej. Perro)"
                value={shortLabel}
                onChange={(e) => setShortLabel(e.target.value)}
                className="rounded-xl border border-white/15 bg-card px-3 py-2"
              />
            </div>

            {(companionType === "ally" || companionType === "both") && (
              <div className="grid gap-2 rounded-xl border border-warning/25 bg-warning/5 p-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] text-warning">
                    Local Aliado (se oculta si cierra)
                  </label>
                  <select
                    value={allyId}
                    onChange={(e) => setAllyId(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-3 py-2"
                  >
                    <option value="">
                      {store.allies.length === 0
                        ? "Primero crea un aliado en Config Bar → Aliados"
                        : "Selecciona el aliado..."}
                    </option>
                    {store.allies.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-warning">
                    Liquidación al aliado por combo (COP)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={allyPayout}
                    onChange={(e) => setAllyPayout(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 font-bold tabular-nums"
                  />
                </div>
              </div>
            )}

            {(companionType === "house" || companionType === "both") && (
              <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-primary">
                    Alimento(s) de la casa a descontar del inventario
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const firstId = store.inventoryItems[0]?.id ?? "";
                      if (!firstId) return;
                      setHouseIngredients((prev) => [
                        ...prev,
                        {
                          inventoryItemId: firstId,
                          displayQuantity: "1",
                          displayUnit: defaultUnitForItem(firstId),
                        },
                      ]);
                    }}
                    className="rounded-lg bg-primary/20 px-2 py-1 text-[11px] font-bold text-primary"
                  >
                    + Añadir insumo
                  </button>
                </div>

                {houseIngredients.map((ing, idx) => (
                  <div key={idx} className="flex flex-wrap items-center gap-2">
                    <select
                      value={ing.inventoryItemId}
                      onChange={(e) => {
                        const nextId = e.target.value;
                        setHouseIngredients((prev) =>
                          prev.map((row, i) =>
                            i === idx
                              ? {
                                  ...row,
                                  inventoryItemId: nextId,
                                  displayUnit: defaultUnitForItem(nextId),
                                }
                              : row,
                          ),
                        );
                      }}
                      className="min-w-44 flex-1 rounded-xl border border-white/15 bg-background px-2.5 py-2"
                    >
                      {store.inventoryItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.baseUnit})
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={0.1}
                      step="any"
                      value={ing.displayQuantity}
                      onChange={(e) =>
                        setHouseIngredients((prev) =>
                          prev.map((row, i) =>
                            i === idx ? { ...row, displayQuantity: e.target.value } : row,
                          ),
                        )
                      }
                      className="w-20 rounded-xl border border-white/15 bg-background px-2.5 py-2 font-bold tabular-nums"
                    />
                    <select
                      value={ing.displayUnit}
                      onChange={(e) =>
                        setHouseIngredients((prev) =>
                          prev.map((row, i) =>
                            i === idx
                              ? { ...row, displayUnit: e.target.value as DisplayUnit }
                              : row,
                          ),
                        )
                      }
                      className="w-20 rounded-xl border border-white/15 bg-background px-2 py-2"
                    >
                      <option value="unit">und</option>
                      <option value="g">g</option>
                      <option value="kg">kg</option>
                      <option value="ml">ml</option>
                      <option value="L">L</option>
                      <option value="oz">oz</option>
                    </select>
                    {houseIngredients.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setHouseIngredients((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="rounded-lg bg-destructive/15 p-2 text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* PASO 3: Precio y Vista previa */}
          <div className="space-y-3 rounded-xl border border-white/10 bg-background/55 p-3.5">
            <p className="font-bold text-foreground">3. Precio al cliente</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <select
                value={pricingMode}
                onChange={(e) =>
                  setPricingMode(e.target.value as "fixed_price" | "add_on_price")
                }
                className="rounded-xl border border-white/15 bg-card px-3 py-2"
              >
                <option value="fixed_price">Precio fijo total del combo</option>
                <option value="add_on_price">Precio de la bebida + valor adicional</option>
              </select>
              <input
                type="number"
                min={0}
                placeholder="Precio COP"
                value={priceValue}
                onChange={(e) => setPriceValue(e.target.value)}
                className="rounded-xl border border-white/15 bg-card px-3 py-2 text-sm font-bold tabular-nums text-primary"
              />
            </div>

            {comboName.trim() && (
              <div className="rounded-xl border border-primary/25 bg-primary/8 px-3 py-2 text-[11px] text-foreground">
                <strong className="text-primary">En el POS:</strong> aparecerá dentro de{" "}
                <strong>
                  {scopeType === "category"
                    ? `cada producto de ${effectiveTargetName}`
                    : effectiveTargetName}
                </strong>{" "}
                como{" "}
                <strong className="text-warning">
                  {Number(baseQuantity) > 1 ? `${baseQuantity}× ` : ""}
                  {presGroup} + {shortLabel.trim() || comboName.trim()}
                </strong>{" "}
                ·{" "}
                <strong>
                  {pricingMode === "fixed_price"
                    ? formatCOP(Number(priceValue) || 0)
                    : `Bebida + ${formatCOP(Number(priceValue) || 0)}`}
                </strong>
                {effectiveAllyName ? ` · Aliado: ${effectiveAllyName}` : ""}
                {validHouseRecipes.length > 0
                  ? ` · Descuenta bebida + ${validHouseRecipes.length} insumo(s) de la casa`
                  : ""}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowBuilder(false);
                  setEditingTemplateId(null);
                }}
                className="rounded-xl bg-secondary px-4 py-2 font-bold text-muted-foreground"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={saving || !canSaveCombo}
                onClick={handleSaveCombo}
                className="press-response rounded-xl bg-primary px-5 py-2 font-bold text-primary-foreground disabled:opacity-50"
              >
                {editingTemplateId ? "Guardar Cambios" : "Crear Combo"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Lista Unificada de Combos */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-display text-sm font-bold text-foreground">
            Combos Configurados ({store.comboTemplates.length})
          </h4>
          <span className="text-[11px] text-muted-foreground">
            Se muestran en cada bebida compatible del POS y descuentan el stock real elegido
          </span>
        </div>

        {store.comboTemplates.length === 0 ? (
          <div className="solid-card rounded-2xl border-dashed p-6 text-center text-xs text-muted-foreground">
            Aún no has configurado combos. Toca <strong>Nuevo Combo</strong> para vincular una categoría (ej. Cervezas Artesanales) o producto con comida de aliado o de la casa.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {store.comboTemplates.map((ct) => {
              const targetName =
                ct.scopeType === "category"
                  ? (store.categories.find((c) => c.id === ct.targetId)?.name ?? "Categoría")
                  : (store.menuProducts.find((p) => p.id === ct.targetId)?.name ?? "Producto");
              const ctAllyName = ct.allyId
                ? (store.allies.find((a) => a.id === ct.allyId)?.name ?? null)
                : null;
              const qty = Math.max(1, ct.baseQuantity ?? 1);
              const houseItems = ct.fixedRecipes ?? [];
              return (
                <div
                  key={ct.id}
                  className={`solid-card flex items-start justify-between gap-3 rounded-2xl p-4 text-xs ${
                    ct.isActive ? "border-warning/30" : "opacity-60"
                  }`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-sm font-bold text-foreground">
                        {qty > 1 ? `${qty}× ` : ""}
                        <span className="capitalize">{ct.presentationGroup}</span> + {ct.name}
                      </p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          ct.scopeType === "category"
                            ? "bg-primary/15 text-primary"
                            : "bg-accent/20 text-accent"
                        }`}
                      >
                        {ct.scopeType === "category" ? `Cat: ${targetName}` : targetName}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      {ctAllyName && (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-warning/15 px-2 py-0.5 font-semibold text-warning tabular-nums">
                          <Store className="h-3 w-3" />
                          {ctAllyName} ({formatCOP(ct.allyPayoutAmount)})
                        </span>
                      )}
                      {houseItems.length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-success/15 px-2 py-0.5 font-semibold text-success">
                          <ChefHat className="h-3 w-3" />
                          Casa:{" "}
                          {houseItems
                            .map((r) => `${r.displayQuantity} ${r.displayUnit} ${r.itemName ?? ""}`.trim())
                            .join(", ")}
                        </span>
                      )}
                    </div>

                    <p className="font-bold tabular-nums text-primary">
                      {ct.pricingMode === "fixed_price"
                        ? `Precio fijo: ${formatCOP(ct.priceValue)}`
                        : `Precio bebida + ${formatCOP(ct.priceValue)}`}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={saving}
                      title="Editar combo"
                      onClick={() => openEditBuilder(ct)}
                      className="press-response flex h-8 w-8 items-center justify-center rounded-xl bg-secondary text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      title={ct.isActive ? "Pausar combo" : "Activar combo"}
                      onClick={() =>
                        void runAction(
                          ct.isActive ? "Combo pausado" : "Combo activado",
                          async () => {
                            await apiFetch(
                              `/api/v1/branches/${branchId}/combo-templates/${ct.id}`,
                              {
                                method: "PATCH",
                                body: JSON.stringify({ isActive: !ct.isActive }),
                              },
                            );
                          },
                        )
                      }
                      className={`press-response flex h-8 w-8 items-center justify-center rounded-xl ${
                        ct.isActive
                          ? "bg-success/15 text-success"
                          : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      {ct.isActive ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      title="Eliminar combo"
                      onClick={() =>
                        void runAction("Combo eliminado", async () => {
                          await apiFetch(
                            `/api/v1/branches/${branchId}/combo-templates/${ct.id}`,
                            { method: "DELETE" },
                          );
                        })
                      }
                      className="press-response flex h-8 w-8 items-center justify-center rounded-xl bg-destructive/15 text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Sección secundaria discreta: Productos solos de Aliado (o combos fijos anteriores) */}
      {standaloneProducts.length > 0 && (
        <section className="space-y-2.5 border-t border-white/10 pt-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-display text-sm font-bold text-muted-foreground">
              Productos de Aliado / Tarjetas Independientes ({standaloneProducts.length})
            </h4>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {standaloneProducts.map((prod) => {
              const presList = store.presentations.filter((p) => p.menuProductId === prod.id);
              const prodAllyName = prod.allyId
                ? (store.allies.find((a) => a.id === prod.allyId)?.name ?? null)
                : null;
              return (
                <div
                  key={prod.id}
                  className={`solid-card space-y-2 rounded-2xl p-3.5 ${
                    prod.isAvailable ? "" : "border-warning/35 opacity-70"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ProductVisualAvatar
                        imageUrl={prod.imageUrl}
                        name={prod.name}
                        productKind={prod.productKind}
                        allyId={prod.allyId}
                        presentationGroup={presList[0]?.presentationGroup}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold">{prod.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {prod.productKind === "third_party_ally" ? "Solo Aliado" : "Tarjeta fija"}
                          {prodAllyName ? ` · ${prodAllyName}` : ""}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() =>
                        void runAction(
                          prod.isAvailable ? `${prod.name} pausado` : `${prod.name} activado`,
                          async () => {
                            await apiFetch(`/api/v1/branches/${branchId}/products/${prod.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ isAvailable: !prod.isAvailable }),
                            });
                          },
                        )
                      }
                      className={`press-response flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-[11px] font-bold ${
                        prod.isAvailable
                          ? "bg-success/15 text-success"
                          : "bg-warning/20 text-warning"
                      }`}
                    >
                      {prod.isAvailable ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      {prod.isAvailable ? "Activo" : "Pausado"}
                    </button>
                  </div>

                  {presList.map((pr) => (
                    <div
                      key={pr.id}
                      className="flex items-center justify-between gap-2 rounded-xl bg-background/60 px-2.5 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-semibold">{pr.name}</span>
                        {pr.allyPayoutAmount > 0 && (
                          <span className="ml-2 text-[11px] tabular-nums text-warning">
                            (Aliado: {formatCOP(pr.allyPayoutAmount)})
                          </span>
                        )}
                      </div>
                      <input
                        key={`${pr.id}:${pr.salePrice}`}
                        type="number"
                        min={0}
                        defaultValue={pr.salePrice}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v >= 0 && v !== pr.salePrice) {
                            void runAction(`Precio actualizado a ${formatCOP(v)}`, async () => {
                              await apiFetch(
                                `/api/v1/branches/${branchId}/presentations/${pr.id}`,
                                {
                                  method: "PATCH",
                                  body: JSON.stringify({ salePrice: v }),
                                },
                              );
                            });
                          }
                        }}
                        className="w-24 rounded-lg border border-white/10 bg-card px-2 py-1 text-right font-bold tabular-nums text-primary"
                      />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {showStandaloneAllyModal && (
        <NewComboModal
          branchId={branchId}
          categories={store.categories}
          inventoryItems={store.inventoryItems}
          allies={store.allies}
          onClose={() => setShowStandaloneAllyModal(false)}
          onCreated={async () => {
            await store.refresh();
            toast({
              kind: "success",
              title: "Producto publicado",
              description: "Ya está disponible en Mesas & POS.",
            });
          }}
        />
      )}
    </div>
  );
}
