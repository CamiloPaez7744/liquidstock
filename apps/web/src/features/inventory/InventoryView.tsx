import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Beer,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  History,
  ImagePlus,
  Layers,
  LayoutGrid,
  List,
  Martini,
  MinusCircle,
  Package,
  PackagePlus,
  Plus,
  RefreshCw,
  Scale,
  Search,
  Tag,
  X,
} from "lucide-react";
import type { MenuProduct } from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { useFeedback } from "../../shared/components/FeedbackProvider.js";
import { InventoryItemTypeIcon } from "../../shared/components/ProductTypeIcon.js";
import { formatBaseQuantity, formatHumanStock } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";
import { CatalogPricesTab } from "./CatalogPricesTab.js";
import { CentralizedCombosTab } from "./CentralizedCombosTab.js";
import { ComposedRecipeModal } from "./ComposedRecipeModal.js";
import { NewInventoryItemModal } from "./NewInventoryItemModal.js";
import { ReconcileStockModal } from "./ReconcileStockModal.js";

type StoreType = ReturnType<typeof useLiquiStock>;
type StockFilter = "all" | "low" | "seasonal" | "keg" | "ml" | "g" | "unit";
type ViewMode = "list" | "cards";
type StockTab = "inventory" | "catalog" | "combos";

const EDITION_TAG_PRESETS = ["", "Temporada", "Edición Limitada", "Nueva", "Recomendada"] as const;

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

export function InventoryView({
  store,
  branchId,
  isAdmin,
  isBranchAdmin = false,
}: {
  store: StoreType;
  branchId: string;
  isAdmin: boolean;
  isBranchAdmin?: boolean;
}) {
  const { toast } = useFeedback();
  const [activeTab, setActiveTab] = useState<StockTab>("inventory");
  const [showReconcileModal, setShowReconcileModal] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntryRow[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerHasMore, setLedgerHasMore] = useState(false);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [showLedger, setShowLedger] = useState(false);

  // Search, filter & view mode
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StockFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  // Selection & mobile detail drawer
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [selectedPresId, setSelectedPresId] = useState<string>("");
  const [units, setUnits] = useState("1");
  const [freeQuantity, setFreeQuantity] = useState("1");
  const [cost, setCost] = useState("0");
  const [purchasePayStatus, setPurchasePayStatus] = useState<"paid" | "pending" | "partial" | "none">("paid");
  const [purchasePayMethodId, setPurchasePayMethodId] = useState("");
  const [purchasePaidAmount, setPurchasePaidAmount] = useState("");
  const [purchaseSupplierName, setPurchaseSupplierName] = useState("");
  const [wasteQty, setWasteQty] = useState("500");
  const [wasteReason, setWasteReason] = useState("Purga de línea / espuma excesiva");
  const [saving, setSaving] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showComposedModal, setShowComposedModal] = useState(false);

  // Add new purchase format inline
  const [showAddFormat, setShowAddFormat] = useState(false);
  const [newFormatName, setNewFormatName] = useState("");
  const [newFormatFactor, setNewFormatFactor] = useState("30");

  const loadLedger = useCallback(
    async (offset = 0, append = false) => {
      if (!isAdmin) return;
      setLedgerLoading(true);
      try {
        const res = await apiFetch<{
          entries: LedgerEntryRow[];
          total: number;
          hasMore: boolean;
        }>(`/api/v1/branches/${branchId}/inventory/ledger?limit=10&offset=${offset}`);
        setLedger((prev) => {
          if (!append) return res.entries;
          const seen = new Set(prev.map((x) => x.id));
          return [...prev, ...res.entries.filter((x) => !seen.has(x.id))];
        });
        setLedgerTotal(res.total ?? res.entries.length);
        setLedgerHasMore(Boolean(res.hasMore));
      } catch {
        // Offline: keep previous ledger snapshot
      } finally {
        setLedgerLoading(false);
      }
    },
    [branchId, isAdmin],
  );

  useEffect(() => {
    if (isAdmin) {
      void loadLedger(0, false);
    }
  }, [isAdmin, loadLedger, store.lastHydratedAt]);

  const handleLedgerScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!ledgerHasMore || ledgerLoading) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) {
      void loadLedger(ledger.length, true);
    }
  };

  const baseItems = useMemo(
    () =>
      isAdmin
        ? store.inventoryItems
        : store.inventoryItems.filter((item) => item.currentStockBase > 0),
    [isAdmin, store.inventoryItems],
  );

  const linkedProductsByItemId = useMemo(() => {
    const productMap = new Map(store.menuProducts.map((p) => [p.id, p]));
    const result = new Map<string, MenuProduct[]>();
    for (const pres of store.presentations) {
      const prod = productMap.get(pres.menuProductId);
      if (!prod) continue;
      for (const rec of pres.recipes) {
        const list = result.get(rec.inventoryItemId) ?? [];
        if (!list.some((p) => p.id === prod.id)) {
          list.push(prod);
          result.set(rec.inventoryItemId, list);
        }
      }
    }
    return result;
  }, [store.menuProducts, store.presentations]);

  const seasonalOrHiddenCount = useMemo(
    () =>
      baseItems.filter((item) => {
        const prods = linkedProductsByItemId.get(item.id) ?? [];
        return prods.some((p) => Boolean(p.editionTag) || !p.isAvailable);
      }).length,
    [baseItems, linkedProductsByItemId],
  );

  const lowCount = useMemo(
    () => baseItems.filter((i) => i.currentStockBase <= i.minStockBase).length,
    [baseItems],
  );

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return baseItems.filter((item) => {
      const prods = linkedProductsByItemId.get(item.id) ?? [];
      if (
        q &&
        !item.name.toLowerCase().includes(q) &&
        !prods.some((p) => (p.editionTag ?? "").toLowerCase().includes(q))
      ) {
        return false;
      }
      if (filter === "low") return item.currentStockBase <= item.minStockBase;
      if (filter === "seasonal") {
        return prods.some((p) => Boolean(p.editionTag) || !p.isAvailable);
      }
      if (filter === "keg") return item.isKeg;
      if (filter === "ml") return item.baseUnit === "ml" && !item.isKeg;
      if (filter === "g") return item.baseUnit === "g";
      if (filter === "unit") return item.baseUnit === "unit";
      return true;
    });
  }, [baseItems, search, filter, linkedProductsByItemId]);

  const handleUpdateLinkedProduct = async (
    product: MenuProduct,
    patch: { isAvailable?: boolean; editionTag?: string | null },
  ) => {
    if (saving) return;
    setSaving(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/products/${product.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      haptics.success();
      await store.refresh();
      if (patch.isAvailable !== undefined) {
        toast({
          kind: patch.isAvailable ? "success" : "info",
          title: patch.isAvailable ? `${product.name} activado en POS` : `${product.name} oculto del POS`,
          description: patch.isAvailable
            ? "Ya aparece disponible para los meseros."
            : "Pausado de la carta sin perder su stock ni historial.",
        });
      } else if ("editionTag" in patch) {
        toast({
          kind: "success",
          title: patch.editionTag ? `Etiqueta «${patch.editionTag}» asignada` : "Etiqueta eliminada",
          description: product.name,
        });
      }
    } catch (err) {
      haptics.blocked();
      toast({
        kind: "error",
        title: "No se pudo actualizar el producto",
        description: err instanceof Error ? err.message : "Error de conexión",
      });
    } finally {
      setSaving(false);
    }
  };

  const filterBar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="relative min-w-52 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          type="search"
          placeholder="Buscar producto o insumo..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-xl border border-white/15 bg-card py-2 pl-9 pr-3 text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <div className="no-scrollbar flex max-w-full gap-1 overflow-x-auto">
          {(
            [
              { id: "all", label: `Todos (${baseItems.length})` },
              ...(isAdmin
                ? [{ id: "low" as const, label: `Bajo / Agotado (${lowCount})` }]
                : []),
              ...(isAdmin && seasonalOrHiddenCount > 0
                ? [{ id: "seasonal" as const, label: `Temporada / Ocultos (${seasonalOrHiddenCount})` }]
                : []),
              { id: "unit", label: "Unidades" },
              { id: "keg", label: "Barriles" },
              { id: "ml", label: "Líquidos" },
              { id: "g", label: "Gramos / Café" },
            ] as Array<{ id: StockFilter; label: string }>
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                haptics.tap();
                setFilter(f.id);
              }}
              className={`press-response shrink-0 rounded-xl px-2.5 py-1.5 text-[11px] font-bold ${
                filter === f.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary/70 text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex rounded-xl bg-secondary/70 p-0.5">
          <button
            type="button"
            title="Vista en lista"
            onClick={() => {
              haptics.tap();
              setViewMode("list");
            }}
            className={`press-response flex h-8 w-8 items-center justify-center rounded-lg ${
              viewMode === "list"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <List className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Vista en tarjetas"
            onClick={() => {
              haptics.tap();
              setViewMode("cards");
            }}
            className={`press-response flex h-8 w-8 items-center justify-center rounded-lg ${
              viewMode === "cards"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );

  // ============================================================================
  // VISTA SOLO LECTURA PARA ROLES DIFERENTES AL ADMIN (Mesero / Cajero)
  // ============================================================================
  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg font-bold">Stock Disponible</h2>
          <button
            type="button"
            onClick={() => void store.refresh()}
            className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-secondary px-3 text-xs font-semibold"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Actualizar
          </button>
        </div>

        {baseItems.length > 0 && filterBar}

        {filteredItems.length === 0 ? (
          <div className="solid-card rounded-2xl p-8 text-center text-sm text-muted-foreground">
            {baseItems.length === 0
              ? "No hay productos disponibles en stock en este momento."
              : "No hay productos que coincidan con tu búsqueda o filtro."}
          </div>
        ) : viewMode === "list" ? (
          <div className="solid-card divide-y divide-white/10 overflow-hidden rounded-2xl">
            {filteredItems.map((item) => {
              const formats = store.purchasePresentations.filter(
                (p) => p.inventoryItemId === item.id,
              );
              const human = formatHumanStock({
                name: item.name,
                stockBase: item.currentStockBase,
                baseUnit: item.baseUnit,
                isKeg: item.isKeg,
                pourLossPercent: item.defaultPourLossPercent,
                purchasePresentations: formats,
              });
              const isLow = item.currentStockBase <= item.minStockBase;
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <InventoryItemTypeIcon
                      name={item.name}
                      baseUnit={item.baseUnit}
                      isKeg={item.isKeg}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">{item.name}</p>
                      {human && (
                        <p className="truncate text-[11px] text-muted-foreground">{human}</p>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <p
                      className={`text-sm font-bold ${isLow ? "text-warning" : "text-primary"}`}
                    >
                      {formatBaseQuantity(item.currentStockBase, item.baseUnit)}
                    </p>
                    {isLow && (
                      <span className="text-[10px] font-bold text-warning">Quedan pocos</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredItems.map((item) => {
              const formats = store.purchasePresentations.filter(
                (p) => p.inventoryItemId === item.id,
              );
              const human = formatHumanStock({
                name: item.name,
                stockBase: item.currentStockBase,
                baseUnit: item.baseUnit,
                isKeg: item.isKeg,
                pourLossPercent: item.defaultPourLossPercent,
                purchasePresentations: formats,
              });
              const isLow = item.currentStockBase <= item.minStockBase;
              return (
                <div
                  key={item.id}
                  className={`solid-card flex items-center justify-between gap-3 rounded-2xl p-4 ${
                    isLow ? "border-warning/40" : ""
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background/70">
                      <InventoryItemTypeIcon
                        name={item.name}
                        baseUnit={item.baseUnit}
                        isKeg={item.isKeg}
                      />
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate font-display text-sm font-bold">{item.name}</h3>
                      {human && (
                        <p className="truncate text-[11px] text-muted-foreground">{human}</p>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <p
                      className={`text-base font-bold ${isLow ? "text-warning" : "text-primary"}`}
                    >
                      {formatBaseQuantity(item.currentStockBase, item.baseUnit)}
                    </p>
                    {isLow && (
                      <span className="text-[10px] font-bold text-warning">Quedan pocos</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ============================================================================
  // VISTA ADMINISTRADOR (MASTER-DETAIL 2 COLUMNAS EN PC + DRAWER EN CELULAR)
  // ============================================================================
  const activeItem =
    filteredItems.find((i) => i.id === selectedItemId) ??
    store.inventoryItems.find((i) => i.id === selectedItemId) ??
    filteredItems[0] ??
    store.inventoryItems[0];

  const itemPresentations = store.purchasePresentations
    .filter((p) => p.inventoryItemId === activeItem?.id)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.factorToBase - a.factorToBase);
  const selectedBelongsToItem = itemPresentations.some((p) => p.id === selectedPresId);
  const isFreePurchase = selectedPresId === "__free__" || itemPresentations.length === 0;
  const activePres = isFreePurchase
    ? null
    : selectedBelongsToItem
      ? (itemPresentations.find((p) => p.id === selectedPresId) ?? itemPresentations[0] ?? null)
      : (itemPresentations[0] ?? null);

  const previewAddedBase = activeItem
    ? isFreePurchase
      ? Math.max(0, Number(freeQuantity) || 0)
      : Math.max(0, (activePres?.factorToBase ?? 1) * (Number(units) || 0))
    : 0;

  const selectInventoryItem = (itemId: string, openMobileSheet: boolean) => {
    haptics.tap();
    setSelectedItemId(itemId);
    setShowAddFormat(false);
    const formats = store.purchasePresentations
      .filter((p) => p.inventoryItemId === itemId)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.factorToBase - a.factorToBase);
    const defPres = formats[0];
    if (defPres) {
      setSelectedPresId(defPres.id);
      setCost(defPres.lastPurchaseCost ? String(defPres.lastPurchaseCost) : "0");
    } else {
      setSelectedPresId("__free__");
      setCost("0");
    }
    if (openMobileSheet) {
      setMobileDetailOpen(true);
    }
  };

  const handleRegisterPurchase = async () => {
    if (!activeItem || saving || previewAddedBase <= 0) return;
    setSaving(true);
    try {
      const treasuryList =
        store.treasuryAccounts.length > 0 ? store.treasuryAccounts : store.paymentMethods;
      const financePayload =
        Number(cost) > 0 && purchasePayStatus !== "none"
          ? {
              paymentStatus: purchasePayStatus,
              paymentMethodId:
                purchasePayStatus === "paid" || purchasePayStatus === "partial"
                  ? purchasePayMethodId || treasuryList[0]?.id || undefined
                  : undefined,
              paidAmount:
                purchasePayStatus === "partial" ? Number(purchasePaidAmount) || 0 : undefined,
              supplierName: purchaseSupplierName.trim() || undefined,
            }
          : { paymentStatus: "none" };

      await apiFetch(`/api/v1/branches/${branchId}/inventory/movements`, {
        method: "POST",
        body: JSON.stringify(
          isFreePurchase || !activePres
            ? {
                inventoryItemId: activeItem.id,
                movementType: "purchase",
                quantityBase: previewAddedBase,
                totalCost: Number(cost) || 0,
                reason: `Compra directa (${formatBaseQuantity(previewAddedBase, activeItem.baseUnit)})`,
                userId: store.activeUserId,
                ...financePayload,
              }
            : {
                inventoryItemId: activeItem.id,
                movementType: "purchase",
                presentationId: activePres.id,
                presentationUnits: Number(units) || 1,
                totalCost: Number(cost) || 0,
                reason: `Compra ${units}x ${activePres.name}`,
                userId: store.activeUserId,
                ...financePayload,
              },
        ),
      });
      haptics.success();
      setPurchasePaidAmount("");
      setPurchaseSupplierName("");
      await Promise.all([store.refresh(), loadLedger()]);
      const chosenAccName =
        (store.treasuryAccounts.length > 0 ? store.treasuryAccounts : store.paymentMethods).find(
          (a) => a.id === (purchasePayMethodId || store.treasuryAccounts[0]?.id || store.paymentMethods[0]?.id),
        )?.name ?? "Cuenta";
      const financeNote =
        Number(cost) <= 0 || purchasePayStatus === "none"
          ? "Solo inventario (sin movimiento financiero)."
          : purchasePayStatus === "paid"
            ? `Egreso registrado en ${chosenAccName}.`
            : purchasePayStatus === "pending"
              ? `Registrado como fiado por pagar a ${purchaseSupplierName.trim() || "proveedor"}.`
              : `Abono registrado en ${chosenAccName} y saldo en cuentas por pagar.`;
      toast({
        kind: "success",
        title: `Stock sumado: +${formatBaseQuantity(previewAddedBase, activeItem.baseUnit)}`,
        description: `${activeItem.name} · ${financeNote}`,
      });
    } catch (err) {
      haptics.blocked();
      toast({
        kind: "error",
        title: "No se pudo registrar la compra",
        description: err instanceof Error ? err.message : "Error de conexión",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAddPurchaseFormat = async () => {
    if (!activeItem || !newFormatName.trim() || !(Number(newFormatFactor) > 0)) return;
    setSaving(true);
    try {
      const created = await apiFetch<{ id: string }>(
        `/api/v1/branches/${branchId}/inventory/items/${activeItem.id}/purchase-presentations`,
        {
          method: "POST",
          body: JSON.stringify({
            name: newFormatName.trim(),
            factorToBase: Number(newFormatFactor),
          }),
        },
      );
      haptics.success();
      setNewFormatName("");
      setShowAddFormat(false);
      await store.refresh();
      setSelectedPresId(created.id);
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
      const chosenAccName =
        (store.treasuryAccounts.length > 0 ? store.treasuryAccounts : store.paymentMethods).find(
          (a) => a.id === (purchasePayMethodId || store.treasuryAccounts[0]?.id || store.paymentMethods[0]?.id),
        )?.name ?? "Cuenta";
      const financeNote =
        Number(cost) <= 0 || purchasePayStatus === "none"
          ? "Solo inventario (sin movimiento financiero)."
          : purchasePayStatus === "paid"
            ? `Egreso registrado en ${chosenAccName}.`
            : purchasePayStatus === "pending"
              ? `Registrado como fiado por pagar a ${purchaseSupplierName.trim() || "proveedor"}.`
              : `Abono registrado en ${chosenAccName} y saldo en cuentas por pagar.`;
      toast({
        kind: "success",
        title: `Stock sumado: +${formatBaseQuantity(previewAddedBase, activeItem.baseUnit)}`,
        description: `${activeItem.name} · ${financeNote}`,
      });
    } catch (err) {
      haptics.blocked();
      toast({
        kind: "error",
        title: "No se pudo registrar la compra",
        description: err instanceof Error ? err.message : "Error de conexión",
      });
    } finally {
      setSaving(false);
    }
  };

  const renderDetailPanels = (inMobileSheet: boolean) => {
    if (!activeItem) return null;
    const supportsPourLoss = activeItem.isKeg || activeItem.defaultPourLossPercent > 0;
    const activeHuman = formatHumanStock({
      name: activeItem.name,
      stockBase: activeItem.currentStockBase,
      baseUnit: activeItem.baseUnit,
      isKeg: activeItem.isKeg,
      pourLossPercent: activeItem.defaultPourLossPercent,
      purchasePresentations: itemPresentations,
    });

    return (
      <div className="space-y-4">
        {/* Resumen del insumo seleccionado */}
        <div className="solid-card flex items-center justify-between gap-3 rounded-2xl border-primary/30 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15">
              <InventoryItemTypeIcon
                name={activeItem.name}
                baseUnit={activeItem.baseUnit}
                isKeg={activeItem.isKeg}
                className="h-5 w-5"
              />
            </div>
            <div className="min-w-0">
              <h3 className="truncate font-display text-base font-bold">{activeItem.name}</h3>
              <p className="text-xs text-muted-foreground">
                Stock actual:{" "}
                <strong className="text-foreground">
                  {formatBaseQuantity(activeItem.currentStockBase, activeItem.baseUnit)}
                </strong>
                {activeHuman ? ` · ${activeHuman}` : ""}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isBranchAdmin && (
              <button
                type="button"
                onClick={() => {
                  haptics.tap();
                  setShowReconcileModal(true);
                }}
                title="Corregir stock físico real (requiere contraseña de Administrador)"
                className="press-response flex min-h-9 items-center gap-1.5 rounded-xl border border-warning/40 bg-warning/15 px-3 text-xs font-bold text-warning"
              >
                <Scale className="h-3.5 w-3.5" />
                Corregir Stock
              </button>
            )}
            {inMobileSheet && (
              <button
                type="button"
                onClick={() => setMobileDetailOpen(false)}
                className="press-response flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Control rápido de visibilidad en POS y etiqueta Temporada / Edición Limitada */}
        {(() => {
          const linkedProducts = linkedProductsByItemId.get(activeItem.id) ?? [];
          if (linkedProducts.length === 0) return null;
          return (
            <div className="solid-card space-y-3 rounded-2xl p-4">
              <div className="flex items-center gap-2">
                <Tag className="h-4 w-4 text-accent" />
                <h3 className="font-display text-sm font-bold">
                  Carta POS y Etiqueta (Temporada / Edición Limitada)
                </h3>
              </div>

              <div className="space-y-2.5">
                {linkedProducts.map((prod) => (
                  <div
                    key={prod.id}
                    className={`space-y-2.5 rounded-xl border p-3 ${
                      prod.isAvailable
                        ? "border-white/10 bg-background/50"
                        : "border-warning/35 bg-warning/5"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold text-foreground">{prod.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {prod.isAvailable
                            ? "Activo y visible para los meseros en el POS"
                            : "Pausado: oculto del POS sin perder stock ni historial"}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() =>
                          void handleUpdateLinkedProduct(prod, { isAvailable: !prod.isAvailable })
                        }
                        className={`press-response flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-bold disabled:opacity-50 ${
                          prod.isAvailable
                            ? "bg-success/20 text-success ring-1 ring-success/40"
                            : "bg-warning/20 text-warning ring-1 ring-warning/40"
                        }`}
                      >
                        {prod.isAvailable ? (
                          <>
                            <Eye className="h-3.5 w-3.5" />
                            Visible en POS
                          </>
                        ) : (
                          <>
                            <EyeOff className="h-3.5 w-3.5" />
                            Oculto · Activar
                          </>
                        )}
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {EDITION_TAG_PRESETS.map((tagOpt) => {
                        const currentTag = (prod.editionTag ?? "").trim();
                        const active = currentTag === tagOpt;
                        return (
                          <button
                            key={tagOpt || "none"}
                            type="button"
                            disabled={saving}
                            onClick={() =>
                              void handleUpdateLinkedProduct(prod, {
                                editionTag: tagOpt || null,
                              })
                            }
                            className={`press-response rounded-lg border px-2.5 py-1 text-[11px] font-bold transition disabled:opacity-50 ${
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
                        key={`${prod.id}:${prod.editionTag ?? ""}`}
                        type="text"
                        maxLength={24}
                        defaultValue={prod.editionTag ?? ""}
                        placeholder="Etiqueta propia..."
                        onBlur={(e) => {
                          const next = e.target.value.trim() || null;
                          const prev = prod.editionTag?.trim() || null;
                          if (next !== prev) {
                            void handleUpdateLinkedProduct(prod, { editionTag: next });
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          }
                        }}
                        className="min-w-28 flex-1 rounded-lg border border-white/15 bg-background px-2 py-1 text-[11px]"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Card de Ingresar Compra */}
        <div className="solid-card space-y-3 rounded-2xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <PackagePlus className="h-5 w-5 text-success" />
              <h3 className="font-display text-base font-bold">Ingresar Compra</h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowAddFormat((v) => !v);
                setNewFormatName("");
                setNewFormatFactor(
                  activeItem.baseUnit === "unit"
                    ? "30"
                    : activeItem.baseUnit === "g"
                      ? "500"
                      : "750",
                );
              }}
              className="press-response flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-[11px] font-bold text-primary"
            >
              <Plus className="h-3 w-3" />
              Otro formato
            </button>
          </div>

          {showAddFormat && (
            <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">Atajos rápidos:</span>
                {(activeItem.baseUnit === "unit"
                  ? [
                      { name: "Unidad x1", factor: "1" },
                      { name: "Six-pack x6", factor: "6" },
                      { name: "Caja x24", factor: "24" },
                      { name: "Canasta x30", factor: "30" },
                    ]
                  : activeItem.baseUnit === "g"
                    ? [
                        { name: "Bolsa 250g", factor: "250" },
                        { name: "Libra (500g)", factor: "500" },
                        { name: "Kilo (1000g)", factor: "1000" },
                      ]
                    : activeItem.isKeg
                      ? [
                          { name: "Barril 20L", factor: "20000" },
                          { name: "Barril 30L", factor: "30000" },
                          { name: "Barril 50L", factor: "50000" },
                        ]
                      : [
                          { name: "Botella 750ml", factor: "750" },
                          { name: "Litro 1000ml", factor: "1000" },
                          { name: "Caja x12 (750ml)", factor: "9000" },
                        ]
                ).map((quick) => (
                  <button
                    key={quick.name}
                    type="button"
                    onClick={() => {
                      setNewFormatName(quick.name);
                      setNewFormatFactor(quick.factor);
                    }}
                    className="rounded-lg bg-secondary px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-primary/20 hover:text-primary"
                  >
                    + {quick.name}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="Ej. Canasta x30, Six-pack, Libra"
                  value={newFormatName}
                  onChange={(e) => setNewFormatName(e.target.value)}
                  className="min-w-36 flex-1 rounded-lg border border-white/15 bg-background px-2.5 py-1.5"
                />
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  value={newFormatFactor}
                  onChange={(e) => setNewFormatFactor(e.target.value)}
                  className="w-20 rounded-lg border border-white/15 bg-background px-2 py-1.5 tabular-nums"
                />
                <span className="text-muted-foreground">{activeItem.baseUnit}</span>
                <button
                  type="button"
                  disabled={saving || !newFormatName.trim()}
                  onClick={() => void handleAddPurchaseFormat()}
                  className="press-response rounded-lg bg-primary px-3 py-1.5 font-bold text-primary-foreground"
                >
                  Guardar
                </button>
              </div>
            </div>
          )}

          {/* Formatos de compra visibles a 1 toque */}
          <div className="space-y-2">
            <label className="block text-xs text-muted-foreground">
              ¿Cómo lo compraste hoy? ({itemPresentations.length} formato
              {itemPresentations.length === 1 ? "" : "s"})
            </label>
            <div className="flex flex-wrap gap-1.5">
              {itemPresentations.map((p) => {
                const selected = !isFreePurchase && activePres?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      haptics.tap();
                      setSelectedPresId(p.id);
                      if (p.lastPurchaseCost) setCost(String(p.lastPurchaseCost));
                    }}
                    className={`press-response rounded-xl border px-3 py-2 text-xs font-bold tabular-nums ${
                      selected
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-white/10 bg-background/70 text-foreground hover:border-primary/40"
                    }`}
                  >
                    {p.name}{" "}
                    <span className="font-normal text-muted-foreground">
                      (+{formatBaseQuantity(p.factorToBase, activeItem.baseUnit)})
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  haptics.tap();
                  setSelectedPresId("__free__");
                }}
                className={`press-response rounded-xl border px-3 py-2 text-xs font-bold ${
                  isFreePurchase
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-white/10 bg-background/70 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
              >
                Cantidad libre ({activeItem.baseUnit})
              </button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {isFreePurchase
                  ? `Cantidad directa (${activeItem.baseUnit})`
                  : `Cantidad de "${activePres?.name ?? "empaques"}"`}
              </label>
              {isFreePurchase ? (
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  value={freeQuantity}
                  onChange={(e) => setFreeQuantity(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm font-bold tabular-nums"
                />
              ) : (
                <input
                  type="number"
                  min={0.5}
                  step="0.5"
                  value={units}
                  onChange={(e) => setUnits(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm font-bold tabular-nums"
                />
              )}
            </div>
            <div>
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
          </div>

          {/* Medio de pago / Fiado siempre visible al ingresar compra */}
          <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-3 text-xs">
            <p className="font-bold text-primary">
              Pago de la compra (se registra en Ingresos y Egresos / Proveedores)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { id: "paid", label: "Pagado" },
                  { id: "pending", label: "Pendiente (fiado)" },
                  { id: "partial", label: "Pago parcial" },
                  { id: "none", label: "Solo stock" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setPurchasePayStatus(opt.id)}
                  className={`press-response rounded-lg border px-2.5 py-1 text-[11px] font-bold ${
                    purchasePayStatus === opt.id
                      ? "border-primary bg-primary/20 text-primary"
                      : "border-white/10 bg-background/70 text-muted-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {purchasePayStatus !== "none" && (
              <>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(purchasePayStatus === "paid" || purchasePayStatus === "partial") && (
                    <select
                      value={
                        purchasePayMethodId ||
                        (store.treasuryAccounts[0]?.id ?? store.paymentMethods[0]?.id ?? "")
                      }
                      onChange={(e) => setPurchasePayMethodId(e.target.value)}
                      className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
                    >
                      {(store.treasuryAccounts.length > 0
                        ? store.treasuryAccounts
                        : store.paymentMethods
                      ).map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          Sale de: {acc.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {purchasePayStatus === "partial" && (
                    <input
                      type="number"
                      min={0}
                      placeholder="Abono inicial (COP)"
                      value={purchasePaidAmount}
                      onChange={(e) => setPurchasePaidAmount(e.target.value)}
                      className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs font-bold tabular-nums"
                    />
                  )}
                  <input
                    type="text"
                    placeholder={
                      purchasePayStatus === "paid"
                        ? "Proveedor (opcional)"
                        : "Nombre proveedor *"
                    }
                    value={purchaseSupplierName}
                    onChange={(e) => setPurchaseSupplierName(e.target.value)}
                    className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
                  />
                </div>
                {!(Number(cost) > 0) && (
                  <p className="text-[11px] font-medium text-warning">
                    Ingresa el costo total de la factura arriba (mayor a $0) para que se registre en Ingresos y Egresos / Proveedores.
                  </p>
                )}
              </>
            )}
          </div>

          {previewAddedBase > 0 && (
            <p className="rounded-xl bg-success/10 px-3 py-1.5 text-xs font-semibold tabular-nums text-success">
              Sumará +{formatBaseQuantity(previewAddedBase, activeItem.baseUnit)} → Nuevo stock:{" "}
              {formatBaseQuantity(
                activeItem.currentStockBase + previewAddedBase,
                activeItem.baseUnit,
              )}
            </p>
          )}

          <button
            type="button"
            disabled={saving || previewAddedBase <= 0}
            onClick={handleRegisterPurchase}
            className="press-response min-h-11 w-full rounded-xl bg-success px-5 text-sm font-bold text-primary-foreground disabled:opacity-50"
          >
            Registrar Ingreso al Stock
          </button>
        </div>

        {/* Card de Merma / Purga (solo si el insumo aplica merma o es barril) */}
        {supportsPourLoss && (
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="flex items-center gap-2">
              <MinusCircle className="h-5 w-5 text-warning" />
              <h3 className="font-display text-base font-bold">Registrar Merma / Purga</h3>
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
              className="press-response min-h-11 w-full rounded-xl bg-warning px-5 text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              Registrar Merma en Ledger
            </button>
          </div>
        )}
      </div>
    );
  };

  const totalCombosCount =
    store.comboTemplates.length +
    store.menuProducts.filter(
      (p) => p.productKind === "combo" || p.productKind === "third_party_ally",
    ).length;

  return (
    <div className="space-y-4">
      {/* Cabecera unificada con 3 tabs: Inventario | Carta y Precios | Combos */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-lg font-bold">Stock y Carta</h2>
          <div className="flex rounded-2xl border border-white/10 bg-secondary/60 p-1">
            {(
              [
                { id: "inventory", label: "Inventario", icon: Package, count: store.inventoryItems.length },
                { id: "catalog", label: "Carta y Precios", icon: ImagePlus, count: store.menuProducts.length },
                { id: "combos", label: "Combos", icon: Layers, count: totalCombosCount },
              ] as const
            ).map(({ id, label, icon: TabIcon, count }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    haptics.tap();
                    setActiveTab(id);
                  }}
                  className={`press-response flex min-h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-bold transition ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <TabIcon className="h-3.5 w-3.5" />
                  <span>{label}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                      active ? "bg-black/20 text-primary-foreground" : "bg-background/70 text-muted-foreground"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeTab === "inventory" && (
            <>
              <button
                type="button"
                onClick={() => {
                  haptics.tap();
                  setShowNewModal(true);
                }}
                className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-xs font-bold text-primary-foreground"
              >
                <Plus className="h-4 w-4" />
                Nuevo Insumo / Producto
              </button>
              <button
                type="button"
                onClick={() => {
                  haptics.tap();
                  setShowComposedModal(true);
                }}
                className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-accent/20 px-3.5 text-xs font-bold text-accent ring-1 ring-accent/35"
              >
                <Martini className="h-4 w-4" />
                Cóctel / Café / Receta
              </button>
            </>
          )}
          <button
            type="button"
            title="Actualizar datos"
            onClick={() => void Promise.all([store.refresh(), loadLedger()])}
            className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-secondary px-3 text-xs font-semibold"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {activeTab === "catalog" ? (
        <CatalogPricesTab store={store} branchId={branchId} />
      ) : activeTab === "combos" ? (
        <CentralizedCombosTab store={store} branchId={branchId} />
      ) : (
        <>
      {store.inventoryItems.length === 0 ? (
        <div className="solid-card flex flex-col items-center justify-center gap-3 rounded-2xl p-8 text-center">
          <Beer className="h-10 w-10 text-primary" />
          <div>
            <p className="font-display text-base font-bold">Tu inventario está listo para empezar</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              Agrega cervezas en botella, barriles artesanales, café en grano, licores, snacks o
              activa presets de cócteles y cafés compuestos en 1 clic.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
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
            <button
              type="button"
              onClick={() => {
                haptics.tap();
                setShowComposedModal(true);
              }}
              className="press-response flex min-h-11 items-center gap-2 rounded-xl bg-secondary px-4 text-sm font-bold text-accent"
            >
              <Martini className="h-4 w-4" />
              Preset Cóctel / Café
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Barra de búsqueda, filtros y tipo de vista */}
          {filterBar}

          {/* Layout Master-Detail: 2 columnas en PC/Tablet (Izq: productos · Der: compra) */}
          <div className="grid items-start gap-4 lg:grid-cols-12">
            <div className="lg:col-span-6 xl:col-span-7">
              {filteredItems.length === 0 ? (
                <div className="solid-card rounded-2xl p-8 text-center text-xs text-muted-foreground">
                  No se encontraron productos con este filtro o búsqueda.
                </div>
              ) : viewMode === "list" ? (
                <div className="solid-card divide-y divide-white/10 overflow-hidden rounded-2xl">
                  {filteredItems.map((item) => {
                    const formats = store.purchasePresentations.filter(
                      (p) => p.inventoryItemId === item.id,
                    );
                    const linkedProds = linkedProductsByItemId.get(item.id) ?? [];
                    const firstEditionTag = linkedProds.find((p) => p.editionTag)?.editionTag ?? null;
                    const allHiddenInPos =
                      linkedProds.length > 0 && linkedProds.every((p) => !p.isAvailable);
                    const isSelected = activeItem?.id === item.id;
                    const isDepleted = item.currentStockBase <= 0;
                    const isLow = item.currentStockBase <= item.minStockBase;
                    const human = formatHumanStock({
                      name: item.name,
                      stockBase: item.currentStockBase,
                      baseUnit: item.baseUnit,
                      isKeg: item.isKeg,
                      pourLossPercent: item.defaultPourLossPercent,
                      purchasePresentations: formats,
                    });
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => selectInventoryItem(item.id, true)}
                        className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition ${
                          isSelected
                            ? "bg-primary/12 ring-1 ring-inset ring-primary/45"
                            : "hover:bg-white/[0.03]"
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background/70">
                            <InventoryItemTypeIcon
                              name={item.name}
                              baseUnit={item.baseUnit}
                              isKeg={item.isKeg}
                            />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="truncate font-display text-sm font-bold text-foreground">
                                {item.name}
                              </p>
                              {firstEditionTag && (
                                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent/20 px-1.5 py-0.5 text-[9px] font-bold text-accent">
                                  <Tag className="h-2.5 w-2.5" />
                                  {firstEditionTag}
                                </span>
                              )}
                              {allHiddenInPos && (
                                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">
                                  <EyeOff className="h-2.5 w-2.5" />
                                  Oculto POS
                                </span>
                              )}
                              {isDepleted ? (
                                <span className="shrink-0 rounded-full bg-destructive/20 px-1.5 py-0.5 text-[9px] font-bold text-destructive">
                                  Agotado
                                </span>
                              ) : isLow ? (
                                <span className="shrink-0 rounded-full bg-warning/20 px-1.5 py-0.5 text-[9px] font-bold text-warning">
                                  Bajo
                                </span>
                              ) : null}
                            </div>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {human ?? `Mín: ${formatBaseQuantity(item.minStockBase, item.baseUnit)}`}
                            </p>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-2 tabular-nums">
                          <div className="text-right">
                            <p
                              className={`text-sm font-bold ${
                                isDepleted
                                  ? "text-destructive"
                                  : isLow
                                    ? "text-warning"
                                    : "text-primary"
                              }`}
                            >
                              {formatBaseQuantity(item.currentStockBase, item.baseUnit)}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {formats.length} fmt
                            </p>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {filteredItems.map((item) => {
                    const formats = store.purchasePresentations.filter(
                      (p) => p.inventoryItemId === item.id,
                    );
                    const linkedProds = linkedProductsByItemId.get(item.id) ?? [];
                    const firstEditionTag = linkedProds.find((p) => p.editionTag)?.editionTag ?? null;
                    const allHiddenInPos =
                      linkedProds.length > 0 && linkedProds.every((p) => !p.isAvailable);
                    const isDepleted = item.currentStockBase <= 0;
                    const isLow = item.currentStockBase <= item.minStockBase;
                    const maxFactor = Math.max(...formats.map((f) => f.factorToBase), 1);
                    const refCap = item.isKeg
                      ? Math.max(30000, item.currentStockBase)
                      : Math.max(item.minStockBase * 4, maxFactor * 2, 10);
                    const pct = Math.max(
                      0,
                      Math.min(100, Math.round((item.currentStockBase / refCap) * 100)),
                    );
                    const human = formatHumanStock({
                      name: item.name,
                      stockBase: item.currentStockBase,
                      baseUnit: item.baseUnit,
                      isKeg: item.isKeg,
                      pourLossPercent: item.defaultPourLossPercent,
                      purchasePresentations: formats,
                    });

                    return (
                      <div
                        key={item.id}
                        onClick={() => selectInventoryItem(item.id, true)}
                        className={`solid-card cursor-pointer rounded-2xl p-4 transition ${
                          activeItem?.id === item.id ? "ring-2 ring-primary" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <InventoryItemTypeIcon
                                name={item.name}
                                baseUnit={item.baseUnit}
                                isKeg={item.isKeg}
                              />
                              <h3 className="truncate font-display text-sm font-bold">
                                {item.name}
                              </h3>
                            </div>
                            {(firstEditionTag || allHiddenInPos) && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {firstEditionTag && (
                                  <span className="inline-flex items-center gap-0.5 rounded-full bg-accent/20 px-1.5 py-0.5 text-[9px] font-bold text-accent">
                                    <Tag className="h-2.5 w-2.5" />
                                    {firstEditionTag}
                                  </span>
                                )}
                                {allHiddenInPos && (
                                  <span className="inline-flex items-center gap-0.5 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">
                                    <EyeOff className="h-2.5 w-2.5" />
                                    Oculto POS
                                  </span>
                                )}
                              </div>
                            )}
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              Mín: {formatBaseQuantity(item.minStockBase, item.baseUnit)}
                              {item.defaultPourLossPercent > 0
                                ? ` · Merma ${item.defaultPourLossPercent}%`
                                : ""}
                            </p>
                          </div>
                          {isDepleted ? (
                            <span className="shrink-0 rounded-full bg-destructive/20 px-2 py-0.5 text-[10px] font-bold text-destructive">
                              Agotado
                            </span>
                          ) : isLow ? (
                            <span className="flex shrink-0 items-center gap-1 rounded-full bg-warning/20 px-2 py-0.5 text-[10px] font-bold text-warning">
                              <AlertTriangle className="h-3 w-3" />
                              Bajo
                            </span>
                          ) : null}
                        </div>

                        <div className="mt-3 flex items-baseline justify-between gap-2 tabular-nums">
                          <span className="text-xl font-bold text-foreground">
                            {formatBaseQuantity(item.currentStockBase, item.baseUnit)}
                          </span>
                          {human && (
                            <span className="truncate text-xs font-medium text-primary">
                              {human}
                            </span>
                          )}
                        </div>

                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-background">
                          <div
                            className={`h-full rounded-full ${
                              isDepleted
                                ? "bg-destructive"
                                : isLow
                                  ? "bg-warning"
                                  : item.isKeg
                                    ? "bg-warning"
                                    : "bg-primary"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Columna derecha fija en Desktop/Tablet (>= lg): Compra y Merma del producto seleccionado */}
            <aside className="hidden lg:sticky lg:top-0 lg:col-span-6 lg:block xl:col-span-5">
              {renderDetailPanels(false)}
            </aside>
          </div>

          {/* Bottom-Sheet en Celular (< lg) al tocar cualquier producto */}
          {mobileDetailOpen && activeItem && (
            <div className="fixed inset-0 z-40 flex items-end bg-black/75 backdrop-blur-sm lg:hidden">
              <div className="material-thick safe-bottom max-h-[88dvh] w-full overflow-y-auto rounded-t-3xl border-t border-white/15 p-4">
                {renderDetailPanels(true)}
              </div>
            </div>
          )}
        </>
      )}

      {/* Libro Mayor Inmutable (desplegable, carga de 10 en 10 al hacer scroll) */}
      <section className="solid-card overflow-hidden rounded-2xl">
        <button
          type="button"
          onClick={() => setShowLedger((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            <h3 className="font-display text-sm font-bold">
              Historial de Movimientos ({ledgerTotal})
            </h3>
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              · Desplegable · últimos 10 con carga al bajar
            </span>
          </div>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              showLedger ? "rotate-180" : ""
            }`}
          />
        </button>

        {showLedger && (
          <div
            onScroll={handleLedgerScroll}
            className="max-h-96 overflow-y-auto border-t border-white/10"
          >
            {ledger.length === 0 ? (
              <p className="p-6 text-center text-xs text-muted-foreground">
                Aún no hay movimientos registrados.
              </p>
            ) : (
              <>
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
                      {row.reason && (
                        <p className="text-[11px] text-muted-foreground">{row.reason}</p>
                      )}
                    </div>
                  ))}
                </div>

                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-left text-xs tabular-nums">
                    <thead className="sticky top-0 bg-card text-muted-foreground">
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
                            {new Date(row.createdAt).toLocaleString("es-CO", {
                              day: "2-digit",
                              month: "2-digit",
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
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {row.reason ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {ledgerHasMore && (
                  <div className="border-t border-white/10 p-3 text-center">
                    <button
                      type="button"
                      disabled={ledgerLoading}
                      onClick={() => void loadLedger(ledger.length, true)}
                      className="press-response rounded-xl bg-secondary px-4 py-2 text-xs font-semibold text-primary disabled:opacity-50"
                    >
                      {ledgerLoading
                        ? "Cargando más movimientos..."
                        : `Cargar 10 más (${ledger.length} de ${ledgerTotal})`}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {showNewModal && (
        <NewInventoryItemModal
          branchId={branchId}
          userId={store.activeUserId}
          categories={store.categories}
          treasuryAccounts={
            store.treasuryAccounts.length > 0 ? store.treasuryAccounts : store.paymentMethods
          }
          onClose={() => setShowNewModal(false)}
          onCreated={async (createdItemId) => {
            await Promise.all([store.refresh(), loadLedger()]);
            if (createdItemId) {
              setSelectedItemId(createdItemId);
              setSelectedPresId("");
            }
          }}
        />
      )}

      {showComposedModal && (
        <ComposedRecipeModal
          branchId={branchId}
          categories={store.categories}
          inventoryItems={store.inventoryItems}
          onClose={() => setShowComposedModal(false)}
          onCreated={async () => {
            await Promise.all([store.refresh(), loadLedger()]);
          }}
        />
      )}

      {showReconcileModal && activeItem && isBranchAdmin && (
        <ReconcileStockModal
          branchId={branchId}
          item={activeItem}
          onClose={() => setShowReconcileModal(false)}
          onReconciled={async (res) => {
            await Promise.all([store.refresh(), loadLedger()]);
            toast({
              kind: "success",
              title: "Stock cuadrado y auditado",
              description: `${activeItem.name}: ${formatBaseQuantity(res.previousStockBase, activeItem.baseUnit)} → ${formatBaseQuantity(res.nextStockBase, activeItem.baseUnit)} (${res.deltaBase >= 0 ? "+" : ""}${formatBaseQuantity(res.deltaBase, activeItem.baseUnit)})`,
            });
          }}
        />
      )}
        </>
      )}
    </div>
  );
}
