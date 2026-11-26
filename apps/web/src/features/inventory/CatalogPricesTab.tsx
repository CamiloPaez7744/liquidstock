import { useMemo, useState } from "react";
import { Eye, EyeOff, ImagePlus, Plus, Search, Tag, X } from "lucide-react";
import type { DisplayUnit, PresentationGroup } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { useFeedback } from "../../shared/components/FeedbackProvider.js";
import { ProductVisualAvatar } from "../../shared/components/ProductTypeIcon.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

type StoreType = ReturnType<typeof useLiquiStock>;

export function CatalogPricesTab({
  store,
  branchId,
}: {
  store: StoreType;
  branchId: string;
}) {
  const { toast } = useFeedback();
  const [search, setSearch] = useState("");
  const [selectedCatId, setSelectedCatId] = useState<string>("all");
  const [uploadingProductId, setUploadingProductId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Collapsible form: add presentation to existing product
  const [showAddPres, setShowAddPres] = useState(false);
  const [newPresProductId, setNewPresProductId] = useState("");
  const [newPresName, setNewPresName] = useState("Jirafa 5 Litros");
  const [newPresGroup, setNewPresGroup] = useState<PresentationGroup>("jirafa");
  const [newPresPrice, setNewPresPrice] = useState("115000");
  const [newPresInvId, setNewPresInvId] = useState("");
  const [newPresUnit, setNewPresUnit] = useState<DisplayUnit>("L");
  const [newPresQty, setNewPresQty] = useState("5");
  const [newPresFoamPct, setNewPresFoamPct] = useState("3");
  const [newPresPurgeMl, setNewPresPurgeMl] = useState("30");

  // Standard products first (combos/allies have their own centralized tab, but still show here if searched)
  const standardProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return store.menuProducts.filter((p) => {
      if (selectedCatId !== "all" && p.categoryId !== selectedCatId) return false;
      if (q && !p.name.toLowerCase().includes(q) && !(p.editionTag ?? "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [store.menuProducts, search, selectedCatId]);

  const effectivePresProductId = newPresProductId || store.menuProducts[0]?.id || "";
  const effectivePresInvId = newPresInvId || store.inventoryItems[0]?.id || "";
  const selectedPresInv = store.inventoryItems.find((i) => i.id === effectivePresInvId);
  const selectedPresSupportsFoam = Boolean(
    selectedPresInv && (selectedPresInv.isKeg || selectedPresInv.baseUnit === "ml"),
  );

  const runAction = async (successMsg: string, fn: () => Promise<void>) => {
    setSaving(true);
    try {
      await fn();
      haptics.success();
      await store.refresh();
      toast({ kind: "success", title: "Carta actualizada", description: successMsg });
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

  const handleUploadImage = async (productId: string, file: File) => {
    setUploadingProductId(productId);
    try {
      const form = new FormData();
      form.append("file", file);
      const uploaded = await apiFetch<{ imageUrl: string }>("/api/v1/uploads/image", {
        method: "POST",
        body: form,
      });
      await apiFetch(`/api/v1/branches/${branchId}/products/${productId}`, {
        method: "PATCH",
        body: JSON.stringify({ imageUrl: uploaded.imageUrl }),
      });
      haptics.success();
      await store.refresh();
      toast({ kind: "success", title: "Foto actualizada", description: "Visible en POS inmediatamente." });
    } catch (err) {
      haptics.blocked();
      toast({
        kind: "error",
        title: "Error subiendo imagen",
        description: err instanceof Error ? err.message : "Intenta con otra imagen",
      });
    } finally {
      setUploadingProductId(null);
    }
  };

  const handleCreatePresentation = () => {
    if (!effectivePresProductId || !newPresName.trim()) return;
    void runAction(`Presentación "${newPresName.trim()}" añadida`, async () => {
      await apiFetch(`/api/v1/branches/${branchId}/presentations`, {
        method: "POST",
        body: JSON.stringify({
          menuProductId: effectivePresProductId,
          name: newPresName.trim(),
          shortLabel: newPresName.trim().slice(0, 14),
          presentationGroup: newPresGroup,
          salePrice: Number(newPresPrice) || 0,
          recipes: effectivePresInvId
            ? [
                {
                  inventoryItemId: effectivePresInvId,
                  displayUnit: newPresUnit,
                  displayQuantity: Math.max(0.001, Number(newPresQty) || 1),
                  pourLossPercent: selectedPresSupportsFoam ? Number(newPresFoamPct) || 0 : 0,
                  fixedLossBase: selectedPresSupportsFoam ? Number(newPresPurgeMl) || 0 : 0,
                },
              ]
            : [],
        }),
      });
      setShowAddPres(false);
    });
  };

  return (
    <div className="space-y-4">
      {/* Cabecera minimalista + botón para añadir presentación */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-base font-bold">Carta, Precios y Fotos del POS</h3>
          <p className="text-xs text-muted-foreground">
            Edita cualquier precio (se guarda al salir del campo), sube fotos o agrega tamaños a un producto.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            haptics.tap();
            setShowAddPres((v) => !v);
          }}
          className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-xs font-bold text-primary-foreground"
        >
          {showAddPres ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {showAddPres ? "Cerrar formulario" : "Añadir Presentación"}
        </button>
      </div>

      {/* Formulario desplegable: Añadir Presentación a Producto Existente */}
      {showAddPres && (
        <div className="solid-card space-y-3 rounded-2xl border-primary/30 p-4">
          <p className="flex items-center gap-1.5 text-sm font-bold text-primary">
            <Plus className="h-4 w-4" />
            Nueva Presentación en Producto Existente (ej. Jirafa 5L, Jarra 1.5L, Shot 2oz)
          </p>
          <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <select
              value={effectivePresProductId}
              onChange={(e) => setNewPresProductId(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
            >
              {store.menuProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Nombre (ej. Jirafa 5L)"
              value={newPresName}
              onChange={(e) => setNewPresName(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
            />
            <select
              value={newPresGroup}
              onChange={(e) => setNewPresGroup(e.target.value as PresentationGroup)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
            >
              <option value="vaso">vaso</option>
              <option value="pinta">pinta</option>
              <option value="jarra">jarra</option>
              <option value="jirafa">jirafa</option>
              <option value="shot">shot</option>
              <option value="trago">trago</option>
              <option value="coctel">coctel</option>
              <option value="botella">botella</option>
              <option value="lata">lata</option>
              <option value="comida">comida</option>
              <option value="otro">otro</option>
            </select>
            <input
              type="number"
              min={0}
              placeholder="Precio COP"
              value={newPresPrice}
              onChange={(e) => setNewPresPrice(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs font-bold tabular-nums"
            />
            <select
              value={effectivePresInvId}
              onChange={(e) => setNewPresInvId(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
            >
              {store.inventoryItems.map((i) => (
                <option key={i.id} value={i.id}>
                  Insumo: {i.name}
                </option>
              ))}
            </select>
            <div className="flex gap-1.5">
              <input
                type="number"
                step="0.5"
                value={newPresQty}
                onChange={(e) => setNewPresQty(e.target.value)}
                className="w-16 rounded-xl border border-white/15 bg-background px-2 py-2 text-xs tabular-nums"
              />
              <select
                value={newPresUnit}
                onChange={(e) => setNewPresUnit(e.target.value as DisplayUnit)}
                className="flex-1 rounded-xl border border-white/15 bg-background px-2 py-2 text-xs"
              >
                <option value="ml">ml</option>
                <option value="L">L</option>
                <option value="oz">oz</option>
                <option value="g">g</option>
                <option value="kg">kg</option>
                <option value="unit">und</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            {selectedPresSupportsFoam && (
              <>
                <label className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">% Espuma:</span>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={newPresFoamPct}
                    onChange={(e) => setNewPresFoamPct(e.target.value)}
                    className="w-16 rounded-lg border border-white/15 bg-background px-2 py-1.5 tabular-nums"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Purga fija (ml):</span>
                  <input
                    type="number"
                    min={0}
                    value={newPresPurgeMl}
                    onChange={(e) => setNewPresPurgeMl(e.target.value)}
                    className="w-16 rounded-lg border border-white/15 bg-background px-2 py-1.5 tabular-nums"
                  />
                </label>
              </>
            )}
            <button
              type="button"
              disabled={saving || !effectivePresProductId || !newPresName.trim()}
              onClick={handleCreatePresentation}
              className="press-response ml-auto rounded-xl bg-primary px-4 py-2 font-bold text-primary-foreground disabled:opacity-50"
            >
              Guardar Presentación
            </button>
          </div>
        </div>
      )}

      {/* Búsqueda y filtro por categoría */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="search"
            placeholder="Buscar producto en carta..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-white/15 bg-card py-2 pl-9 pr-3 text-xs"
          />
        </div>
        <div className="no-scrollbar flex max-w-full gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => setSelectedCatId("all")}
            className={`press-response shrink-0 rounded-xl px-2.5 py-1.5 text-[11px] font-bold ${
              selectedCatId === "all"
                ? "bg-primary text-primary-foreground"
                : "bg-secondary/70 text-muted-foreground hover:text-foreground"
            }`}
          >
            Todas ({store.menuProducts.length})
          </button>
          {store.categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCatId(cat.id)}
              className={`press-response shrink-0 rounded-xl px-2.5 py-1.5 text-[11px] font-bold ${
                selectedCatId === cat.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary/70 text-muted-foreground hover:text-foreground"
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* Grilla de productos con edición rápida de precios y foto */}
      {standardProducts.length === 0 ? (
        <div className="solid-card rounded-2xl p-8 text-center text-xs text-muted-foreground">
          No hay productos que coincidan con este filtro.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {standardProducts.map((prod) => {
            const presList = store.presentations.filter((p) => p.menuProductId === prod.id);
            const catName = store.categories.find((c) => c.id === prod.categoryId)?.name ?? "";
            return (
              <div
                key={prod.id}
                className={`solid-card rounded-2xl p-3.5 ${
                  prod.isAvailable ? "" : "border-warning/35 opacity-85"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <ProductVisualAvatar
                      imageUrl={prod.imageUrl}
                      name={prod.name}
                      productKind={prod.productKind}
                      allyId={prod.allyId}
                      presentationGroup={presList[0]?.presentationGroup}
                      size="sm"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate font-bold">{prod.name}</p>
                        {prod.editionTag && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-accent/20 px-1.5 py-0.5 text-[9px] font-bold text-accent">
                            <Tag className="h-2.5 w-2.5" />
                            {prod.editionTag}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {catName}
                        {prod.productKind !== "standard" ? ` · ${prod.productKind}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={saving}
                      title={prod.isAvailable ? "Ocultar del POS" : "Activar en POS"}
                      onClick={() =>
                        void runAction(
                          prod.isAvailable ? `${prod.name} oculto del POS` : `${prod.name} visible en POS`,
                          async () => {
                            await apiFetch(`/api/v1/branches/${branchId}/products/${prod.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ isAvailable: !prod.isAvailable }),
                            });
                          },
                        )
                      }
                      className={`press-response flex h-8 w-8 items-center justify-center rounded-xl ${
                        prod.isAvailable
                          ? "bg-success/15 text-success"
                          : "bg-warning/20 text-warning"
                      }`}
                    >
                      {prod.isAvailable ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    </button>
                    <label className="press-response flex cursor-pointer items-center gap-1 rounded-xl bg-secondary px-2.5 py-1.5 text-[11px] font-semibold text-primary">
                      <ImagePlus className="h-3.5 w-3.5" />
                      {uploadingProductId === prod.id ? "Subiendo..." : "Foto"}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void handleUploadImage(prod.id, f);
                        }}
                      />
                    </label>
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  {presList.map((pr) => (
                    <div
                      key={pr.id}
                      className="flex items-center justify-between gap-2 rounded-xl bg-background/60 px-2.5 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-semibold">{pr.name}</span>
                        {pr.recipes[0] && (
                          <span className="ml-1.5 text-[11px] text-muted-foreground">
                            ({pr.recipes[0].displayQuantity} {pr.recipes[0].displayUnit}
                            {pr.recipes[0].pourLossPercent > 0 || pr.recipes[0].fixedLossBase > 0
                              ? ` · espuma ${pr.recipes[0].pourLossPercent}%${pr.recipes[0].fixedLossBase > 0 ? ` + ${pr.recipes[0].fixedLossBase}ml` : ""}`
                              : ""}
                            )
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
