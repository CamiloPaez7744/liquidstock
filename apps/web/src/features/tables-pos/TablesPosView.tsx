import { useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Beer,
  ChevronDown,
  ChevronRight,
  Clock,
  CreditCard,
  Handshake,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  evaluateLinePromotion,
  evaluatePresentationAvailability,
  isAllyOpenAt,
  type MenuProduct,
  type ProductPresentation,
} from "@liquistock/domain";
import { apiFetch, resolveImageUrl } from "../../infrastructure/api/api-client.js";
import { localDb } from "../../infrastructure/storage/dexie/db.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { formatCOP, getCurrentIsoDayAndTime } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";
import { CheckoutModal } from "./CheckoutModal.js";
import { DigitalReceiptModal, type DigitalReceiptData } from "./DigitalReceiptModal.js";

type StoreType = ReturnType<typeof useLiquiStock>;

export function TablesPosView({
  store,
  isAdmin,
  onGoToInventory,
}: {
  store: StoreType;
  isAdmin: boolean;
  onGoToInventory?: () => void;
}) {
  const [selectedTableId, setSelectedTableId] = useState<string | null>(
    store.diningTables[0]?.id ?? null,
  );
  const [selectedSubAccountId, setSelectedSubAccountId] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [showMobileOrderSheet, setShowMobileOrderSheet] = useState(false);
  const [movingItemId, setMovingItemId] = useState<string | null>(null);
  const [showCheckout, setShowCheckout] = useState(false);
  const [receipt, setReceipt] = useState<DigitalReceiptData | null>(null);

  const { isoDay, hhmm } = getCurrentIsoDayAndTime();

  const inventoryMap = useMemo(
    () => new Map(store.inventoryItems.map((i) => [i.id, i])),
    [store.inventoryItems],
  );
  const alliesMap = useMemo(
    () => new Map(store.allies.map((a) => [a.id, a])),
    [store.allies],
  );

  const closedAllies = useMemo(
    () => store.allies.filter((a) => !isAllyOpenAt(a, isoDay, hhmm)),
    [store.allies, isoDay, hhmm],
  );

  const activeSession = useMemo(() => {
    return (
      store.tableSessions.find(
        (s) => s.status === "open" && s.diningTableId === selectedTableId,
      ) ?? null
    );
  }, [store.tableSessions, selectedTableId]);

  const sessionSubAccounts = useMemo(() => {
    if (!activeSession) return [];
    return store.subAccounts.filter(
      (sa) => sa.tableSessionId === activeSession.id && sa.status === "open",
    );
  }, [store.subAccounts, activeSession]);

  const currentSubAccount = useMemo(() => {
    if (sessionSubAccounts.length === 0) return null;
    return (
      sessionSubAccounts.find((sa) => sa.id === selectedSubAccountId) ??
      sessionSubAccounts[0] ??
      null
    );
  }, [sessionSubAccounts, selectedSubAccountId]);

  const currentSubItems = useMemo(() => {
    if (!currentSubAccount) return [];
    return store.orderItems.filter(
      (item) => item.subAccountId === currentSubAccount.id && item.status === "active",
    );
  }, [store.orderItems, currentSubAccount]);

  // Live count per presentation in the current sub-account for instant thumb feedback
  const qtyByPresentationId = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of currentSubItems) {
      map.set(item.presentationId, (map.get(item.presentationId) ?? 0) + item.quantity);
    }
    return map;
  }, [currentSubItems]);

  const totalUnitsInSubAccount = useMemo(
    () => currentSubItems.reduce((acc, i) => acc + i.quantity, 0),
    [currentSubItems],
  );

  const currentPendingBalance = currentSubAccount
    ? Math.max(
        0,
        currentSubAccount.totalAmount -
          currentSubAccount.paidAmount -
          currentSubAccount.creditAmount,
      )
    : 0;

  const currentTableLabel =
    store.diningTables.find((t) => t.id === selectedTableId)?.label ?? "Barra Rápida";

  const visibleCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    return store.menuProducts
      .filter((p) => (selectedCategoryId === "all" ? true : p.categoryId === selectedCategoryId))
      .filter((p) => {
        if (!q) return true;
        if (p.name.toLowerCase().includes(q)) return true;
        return store.presentations.some(
          (pr) => pr.menuProductId === p.id && pr.name.toLowerCase().includes(q),
        );
      })
      .map((product) => {
        const presList = store.presentations
          .filter((pr) => pr.menuProductId === product.id)
          .map((presentation) => {
            const availability = evaluatePresentationAvailability({
              product,
              presentation,
              inventoryById: inventoryMap,
              alliesById: alliesMap,
              isoDayOfWeek: isoDay,
              currentTimeHHMM: hhmm,
              applyFoamLossFormula: store.featureFlags.enableFoamLossFormula,
              autoHideClosedAllies: store.featureFlags.autoHideClosedAllies,
            });
            const promoPreview = store.featureFlags.enablePromotions
              ? evaluateLinePromotion({
                  line: {
                    categoryId: product.categoryId,
                    menuProductId: product.id,
                    presentationId: presentation.id,
                    unitPrice: presentation.salePrice,
                    quantity: 2,
                  },
                  rules: store.promotionRules,
                  isoDayOfWeek: isoDay,
                  currentTimeHHMM: hhmm,
                })
              : null;

            return {
              presentation,
              availability,
              promoName: promoPreview?.discountAmount ? promoPreview.promotionName : null,
            };
          })
          .filter((entry) => {
            if (
              entry.availability.reason === "ALLY_CLOSED" &&
              store.featureFlags.autoHideClosedAllies
            ) {
              return false;
            }
            if (
              entry.availability.reason === "OUT_OF_STOCK" &&
              store.featureFlags.hideOutOfStockInPos
            ) {
              return false;
            }
            return true;
          });

        return { product, entries: presList };
      })
      .filter((group) => group.entries.length > 0);
  }, [
    store.menuProducts,
    store.presentations,
    store.promotionRules,
    store.featureFlags,
    selectedCategoryId,
    search,
    inventoryMap,
    alliesMap,
    isoDay,
    hhmm,
  ]);

  const handleTapPresentation = async (product: MenuProduct, presentation: ProductPresentation) => {
    haptics.tap();
    let targetSubId = currentSubAccount?.id;
    if (!targetSubId) {
      const opened = await store.openTableSession(selectedTableId, "Cuenta 1");
      targetSubId = opened.subAccountId;
      setSelectedSubAccountId(targetSubId);
    }
    await store.addOrderItem(targetSubId, product, presentation, 1);
  };

  const handleSplitAccount = async () => {
    haptics.tap();
    if (!activeSession) {
      const opened = await store.openTableSession(selectedTableId, "Cuenta 1");
      setSelectedSubAccountId(opened.subAccountId);
      return;
    }
    const nextNum = sessionSubAccounts.length + 1;
    const newId = await store.createSubAccount(activeSession.id, `Cuenta ${nextNum}`);
    setSelectedSubAccountId(newId);
  };

  const handleMoveToSubAccount = async (targetSubId: string) => {
    if (!movingItemId) return;
    haptics.tap();
    await store.moveOrderItem(movingItemId, targetSubId);
    setMovingItemId(null);
  };

  const getTableOpenTotal = (tableId: string | null) => {
    const sess = store.tableSessions.find((s) => s.status === "open" && s.diningTableId === tableId);
    if (!sess) return { total: 0, count: 0 };
    const subs = store.subAccounts.filter((sa) => sa.tableSessionId === sess.id && sa.status === "open");
    return {
      total: subs.reduce(
        (acc, s) => acc + Math.max(0, s.totalAmount - s.paidAmount - s.creditAmount),
        0,
      ),
      count: subs.length,
    };
  };

  const selectTable = (tableId: string | null) => {
    haptics.tap();
    setSelectedTableId(tableId);
    setSelectedSubAccountId(null);
    setMovingItemId(null);
    setShowTablePicker(false);
  };

  // Shared Comanda & Sub-Accounts content (used inside Desktop sidebar AND Mobile Bottom Sheet)
  const renderOrderContent = (isSheet: boolean) => (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold">{currentTableLabel}</h2>
            <p className="text-xs text-muted-foreground">
              {totalUnitsInSubAccount} producto(s) en {currentSubAccount?.label ?? "Cuenta 1"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {store.featureFlags.enableSplitAccounts && (
              <button
                type="button"
                onClick={handleSplitAccount}
                className="press-response flex min-h-10 items-center gap-1 rounded-xl bg-secondary px-3 text-xs font-bold text-primary"
              >
                <Plus className="h-4 w-4" />
                Dividir
              </button>
            )}
            {isSheet && (
              <button
                type="button"
                onClick={() => setShowMobileOrderSheet(false)}
                className="press-response flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>

        {sessionSubAccounts.length > 0 && (
          <div className="no-scrollbar mt-2.5 flex gap-1.5 overflow-x-auto">
            {sessionSubAccounts.map((sa) => {
              const active = sa.id === currentSubAccount?.id;
              const isMoveTarget = Boolean(movingItemId && !active);
              return (
                <button
                  key={sa.id}
                  type="button"
                  onClick={() => {
                    if (isMoveTarget) {
                      void handleMoveToSubAccount(sa.id);
                    } else {
                      haptics.tap();
                      setSelectedSubAccountId(sa.id);
                    }
                  }}
                  className={`press-response min-h-10 shrink-0 rounded-xl px-3.5 text-xs font-bold ${
                    isMoveTarget
                      ? "animate-pulse bg-warning text-primary-foreground ring-2 ring-warning"
                      : active
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary/70 text-muted-foreground"
                  }`}
                >
                  {isMoveTarget ? `→ Mover a ${sa.label}` : sa.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3.5">
        {currentSubItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-8 text-center text-muted-foreground">
            <Beer className="mb-2 h-8 w-8 opacity-40" />
            <p className="text-sm font-semibold text-foreground">Cuenta sin pedidos</p>
            <p className="mt-1 text-xs">Toca cualquier producto del menú para agregarlo.</p>
          </div>
        ) : (
          currentSubItems.map((item) => {
            const isMovingThis = movingItemId === item.id;
            return (
              <div
                key={item.id}
                className={`rounded-xl border p-3 ${
                  isMovingThis
                    ? "border-warning bg-warning/10"
                    : "border-white/10 bg-background/60"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-foreground">
                      {item.quantity}× {item.productNameSnap}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.presentationNameSnap}
                      {item.allyIdSnap ? " · Aliado" : ""}
                    </p>
                    {item.discountAmount > 0 && (
                      <span className="mt-1 inline-block rounded bg-success/15 px-1.5 py-0.5 text-[11px] font-bold text-success">
                        Promo (-{formatCOP(item.discountAmount)})
                      </span>
                    )}
                  </div>
                  <p className="shrink-0 text-sm font-bold tabular-nums text-foreground">
                    {formatCOP(item.lineTotal)}
                  </p>
                </div>

                <div className="mt-2.5 flex items-center justify-end gap-2">
                  {sessionSubAccounts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        haptics.tap();
                        setMovingItemId(isMovingThis ? null : item.id);
                      }}
                      className={`press-response flex min-h-9 items-center gap-1 rounded-lg px-3 text-xs font-semibold ${
                        isMovingThis
                          ? "bg-warning text-primary-foreground"
                          : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5" />
                      {isMovingThis ? "Elige cuenta arriba" : "Mover"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      haptics.tap();
                      void store.voidOrderItem(item.id, "Retirado en comanda");
                    }}
                    className="press-response flex min-h-9 items-center gap-1 rounded-lg bg-destructive/15 px-3 text-xs font-semibold text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Anular
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="shrink-0 space-y-3 border-t border-white/10 p-4">
        <div className="space-y-1 text-sm tabular-nums">
          {currentSubAccount && currentSubAccount.discountAmount > 0 && (
            <div className="flex justify-between text-xs text-success">
              <span>Promociones</span>
              <span>-{formatCOP(currentSubAccount.discountAmount)}</span>
            </div>
          )}
          {currentSubAccount && currentSubAccount.paidAmount > 0 && (
            <div className="flex justify-between text-xs text-success">
              <span>Abonado</span>
              <span>-{formatCOP(currentSubAccount.paidAmount)}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-lg font-bold">
            <span>Total {currentSubAccount?.label ?? ""}</span>
            <span className="text-primary">{formatCOP(currentPendingBalance)}</span>
          </div>
        </div>

        <button
          type="button"
          disabled={!currentSubAccount || currentSubItems.length === 0}
          onClick={() => {
            haptics.tap();
            setShowMobileOrderSheet(false);
            setShowCheckout(true);
          }}
          className="press-response flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-40"
        >
          <CreditCard className="h-5 w-5" />
          Cobrar / Fiar · {formatCOP(currentPendingBalance)}
        </button>
      </div>
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* === MOBILE TOP CONTROL BAR (< 1024px): compacta, 1 línea, 100% enfocada en el catálogo === */}
      <div className="shrink-0 border-b border-white/10 bg-background/80 px-3 py-2 backdrop-blur-md lg:hidden">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              haptics.tap();
              setShowTablePicker(true);
            }}
            className="press-response flex min-h-11 flex-1 items-center justify-between gap-2 rounded-xl border border-primary/35 bg-primary/12 px-3 text-left"
          >
            <div className="flex min-w-0 items-center gap-2">
              {selectedTableId === null ? (
                <Zap className="h-4 w-4 shrink-0 text-primary" />
              ) : (
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary" />
              )}
              <span className="truncate text-sm font-bold text-foreground">
                {currentTableLabel}
              </span>
              {sessionSubAccounts.length > 1 && (
                <span className="shrink-0 rounded-full bg-warning/20 px-2 py-0.5 text-[11px] font-bold text-warning">
                  {currentSubAccount?.label}
                </span>
              )}
            </div>
            <ChevronDown className="h-4 w-4 shrink-0 text-primary" />
          </button>

          <button
            type="button"
            onClick={() => {
              haptics.tap();
              setShowMobileSearch((v) => !v);
              if (showMobileSearch) setSearch("");
            }}
            aria-label="Buscar producto"
            className={`press-response flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${
              showMobileSearch || search
                ? "border-primary bg-primary/20 text-primary"
                : "border-white/10 bg-card text-foreground"
            }`}
          >
            {showMobileSearch ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
          </button>
        </div>

        {showMobileSearch && (
          <div className="mt-2">
            <input
              type="search"
              autoFocus
              placeholder="Buscar cerveza, shot, combo, papas..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-primary/40 bg-card px-3.5 py-2.5 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        )}

        {/* Rail horizontal de categorías (nunca hace wrap a varias líneas en celular) */}
        <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto pb-0.5">
          <button
            type="button"
            onClick={() => {
              haptics.tap();
              setSelectedCategoryId("all");
            }}
            className={`press-response min-h-10 shrink-0 rounded-full px-4 text-xs font-bold ${
              selectedCategoryId === "all"
                ? "bg-primary text-primary-foreground"
                : "bg-secondary/80 text-muted-foreground"
            }`}
          >
            Todo
          </button>
          {store.categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => {
                haptics.tap();
                setSelectedCategoryId(cat.id);
              }}
              className={`press-response min-h-10 shrink-0 rounded-full px-4 text-xs font-bold ${
                selectedCategoryId === cat.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary/80 text-muted-foreground"
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* === DESKTOP / TABLET TOP BAR (>= 1024px) === */}
      <div className="mb-3 hidden shrink-0 gap-2 overflow-x-auto pb-1 lg:flex">
        <button
          type="button"
          onClick={() => selectTable(null)}
          className={`press-response flex min-h-14 shrink-0 items-center gap-2 rounded-2xl border px-4 text-left ${
            selectedTableId === null
              ? "border-primary bg-primary/20 text-primary"
              : "border-white/10 bg-card text-foreground"
          }`}
        >
          <Zap className="h-4 w-4" />
          <div>
            <p className="text-sm font-bold leading-tight">Barra Rápida</p>
            <p className="text-[11px] tabular-nums text-muted-foreground">
              {getTableOpenTotal(null).total > 0
                ? formatCOP(getTableOpenTotal(null).total)
                : "Venta directa"}
            </p>
          </div>
        </button>

        {store.diningTables.map((table) => {
          const active = selectedTableId === table.id;
          const summary = getTableOpenTotal(table.id);
          return (
            <button
              key={table.id}
              type="button"
              onClick={() => selectTable(table.id)}
              className={`press-response flex min-h-14 min-w-28 shrink-0 flex-col justify-center rounded-2xl border px-3.5 text-left ${
                active
                  ? "border-primary bg-primary/20 text-primary"
                  : summary.total > 0
                    ? "border-warning/40 bg-warning/10 text-foreground"
                    : "border-white/10 bg-card text-foreground"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold">{table.label}</span>
                {summary.count > 1 && (
                  <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-bold text-warning">
                    {summary.count} ctas
                  </span>
                )}
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">
                {summary.total > 0 ? formatCOP(summary.total) : "Libre"}
              </span>
            </button>
          );
        })}
      </div>

      {/* Aviso discreto si algún aliado está cerrado */}
      {store.featureFlags.autoHideClosedAllies && closedAllies.length > 0 && (
        <div className="mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning lg:mx-0 lg:mb-3 lg:mt-0">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            Aliado cerrado ({closedAllies.map((a) => a.name).join(", ")}): combos ocultos.
          </span>
        </div>
      )}

      {/* === CONTENIDO PRINCIPAL: Full-Screen Menu en Mobile | Master-Detail en Desktop === */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-12">
        {/* Catálogo de Productos */}
        <div className="flex min-h-0 flex-col lg:col-span-7 xl:col-span-8">
          {/* Filtros de categoría y búsqueda solo en Desktop/Tablet (mobile ya tiene su rail superior) */}
          <div className="mb-3 hidden shrink-0 flex-wrap items-center gap-2 lg:flex">
            <button
              type="button"
              onClick={() => setSelectedCategoryId("all")}
              className={`press-response min-h-10 rounded-xl px-4 text-xs font-bold ${
                selectedCategoryId === "all"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              Todo
            </button>
            {store.categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategoryId(cat.id)}
                className={`press-response min-h-10 rounded-xl px-4 text-xs font-bold ${
                  selectedCategoryId === cat.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground"
                }`}
              >
                {cat.name}
              </button>
            ))}
            <div className="relative ml-auto min-w-52">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="search"
                placeholder="Buscar producto..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-card py-2 pl-9 pr-3 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
          </div>

          {/* Lista / Grid de Productos: 100% scrollable y ultra-legible en celular */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-2.5 lg:px-0 lg:pb-2 lg:pt-0">
            {visibleCatalog.length === 0 ? (
              <div className="solid-card space-y-3 rounded-2xl p-8 text-center">
                <Beer className="mx-auto h-10 w-10 text-primary/60" />
                <p className="text-base font-bold text-foreground">
                  {store.menuProducts.length === 0
                    ? "Tu carta está vacía"
                    : "No se encontraron productos"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {store.menuProducts.length === 0
                    ? "Crea tu primer barril artesanal, licor, papas, cigarrillos o empanadas desde Barriles & Stock para empezar a vender."
                    : "Prueba otra categoría o limpia la búsqueda."}
                </p>
                {store.menuProducts.length === 0 && isAdmin && onGoToInventory && (
                  <button
                    type="button"
                    onClick={onGoToInventory}
                    className="press-response mt-2 inline-flex min-h-12 items-center gap-2 rounded-2xl bg-primary px-5 text-sm font-bold text-primary-foreground"
                  >
                    <Plus className="h-4 w-4" />
                    Crear mi primer producto / barril
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {visibleCatalog.map(({ product, entries }) => {
                  const imgUrl = resolveImageUrl(product.imageUrl);
                  const singleEntry = entries.length === 1 ? entries[0] : null;

                  return (
                    <article
                      key={product.id}
                      className="solid-card flex flex-col gap-3 rounded-2xl p-3.5"
                    >
                      {/* Cabecera clara y limpia del producto */}
                      <div className="flex items-center gap-3">
                        {imgUrl ? (
                          <img
                            src={imgUrl}
                            alt={product.name}
                            loading="lazy"
                            className="h-14 w-14 shrink-0 rounded-xl object-cover ring-1 ring-white/10"
                          />
                        ) : (
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                            {product.allyId ? (
                              <Handshake className="h-6 w-6 text-warning" />
                            ) : (
                              <Beer className="h-6 w-6" />
                            )}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="truncate font-display text-base font-bold leading-snug text-foreground">
                              {product.name}
                            </h3>
                            {product.allyId && (
                              <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-bold text-warning">
                                Aliado
                              </span>
                            )}
                          </div>
                          {singleEntry && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {singleEntry.presentation.name}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Botón único ancho si solo tiene 1 presentación, o grid de botones táctiles grandes si tiene varias */}
                      {singleEntry ? (
                        (() => {
                          const { presentation, availability, promoName } = singleEntry;
                          const disabled = !availability.available;
                          const inCartQty = qtyByPresentationId.get(presentation.id) ?? 0;
                          return (
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => {
                                if (disabled) {
                                  haptics.blocked();
                                  return;
                                }
                                void handleTapPresentation(product, presentation);
                              }}
                              className={`press-response flex min-h-14 w-full items-center justify-between gap-2 rounded-xl border px-4 ${
                                disabled
                                  ? "cursor-not-allowed border-destructive/30 bg-destructive/10 opacity-65"
                                  : inCartQty > 0
                                    ? "border-primary/60 bg-primary/15"
                                    : "border-white/10 bg-secondary/75"
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-base font-bold tabular-nums text-primary">
                                  {formatCOP(presentation.salePrice)}
                                </span>
                                {promoName && !disabled && (
                                  <span className="flex items-center gap-1 rounded-full bg-success/20 px-2 py-0.5 text-[11px] font-bold text-success">
                                    <Sparkles className="h-3 w-3" />
                                    Promo
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                {disabled ? (
                                  <span className="rounded-lg bg-destructive/20 px-2.5 py-1 text-xs font-bold text-destructive">
                                    Agotado
                                  </span>
                                ) : (
                                  <>
                                    {availability.isLowStock &&
                                      availability.maxServings !== null && (
                                        <span className="rounded-lg bg-warning/20 px-2 py-0.5 text-[11px] font-bold text-warning">
                                          Quedan {availability.maxServings}
                                        </span>
                                      )}
                                    {inCartQty > 0 ? (
                                      <span className="flex h-8 min-w-8 items-center justify-center rounded-full bg-primary px-2 text-xs font-bold tabular-nums text-primary-foreground">
                                        {inCartQty}
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1 rounded-lg bg-primary/20 px-3 py-1.5 text-xs font-bold text-primary">
                                        <Plus className="h-3.5 w-3.5" />
                                        Agregar
                                      </span>
                                    )}
                                  </>
                                )}
                              </div>
                            </button>
                          );
                        })()
                      ) : (
                        <div className="grid grid-cols-2 gap-2">
                          {entries.map(({ presentation, availability, promoName }) => {
                            const disabled = !availability.available;
                            const inCartQty = qtyByPresentationId.get(presentation.id) ?? 0;
                            return (
                              <button
                                key={presentation.id}
                                type="button"
                                disabled={disabled}
                                onClick={() => {
                                  if (disabled) {
                                    haptics.blocked();
                                    return;
                                  }
                                  void handleTapPresentation(product, presentation);
                                }}
                                className={`press-response relative flex min-h-16 flex-col justify-between rounded-xl border p-3 text-left ${
                                  disabled
                                    ? "cursor-not-allowed border-destructive/30 bg-destructive/10 opacity-65"
                                    : inCartQty > 0
                                      ? "border-primary/65 bg-primary/15"
                                      : "border-white/10 bg-secondary/75"
                                }`}
                              >
                                <div className="flex w-full items-start justify-between gap-1.5">
                                  <span className="text-[13px] font-semibold leading-tight text-foreground">
                                    {presentation.shortLabel ?? presentation.name}
                                  </span>
                                  {inCartQty > 0 && !disabled && (
                                    <span className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold tabular-nums text-primary-foreground">
                                      {inCartQty}
                                    </span>
                                  )}
                                  {inCartQty === 0 && promoName && !disabled && (
                                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-success" />
                                  )}
                                </div>

                                <div className="mt-1.5 flex w-full items-end justify-between gap-1">
                                  <span className="text-[15px] font-bold tabular-nums text-primary">
                                    {formatCOP(presentation.salePrice)}
                                  </span>
                                  {disabled ? (
                                    <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-bold text-destructive">
                                      Agotado
                                    </span>
                                  ) : availability.isLowStock &&
                                    availability.maxServings !== null ? (
                                    <span className="rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-bold text-warning">
                                      Quedan {availability.maxServings}
                                    </span>
                                  ) : null}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Panel derecho persistente SOLO en Tablet/Desktop (>= 1024px) */}
        <aside className="solid-card hidden min-h-0 flex-col rounded-2xl lg:col-span-5 lg:flex xl:col-span-4">
          {renderOrderContent(false)}
        </aside>
      </div>

      {/* === BARRA FLOTANTE DE COMANDA EN ZONA DE PULGAR (SOLO MOBILE < 1024px) === */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.1rem+env(safe-area-inset-bottom))] z-30 px-3 lg:hidden">
        <button
          type="button"
          onClick={() => {
            haptics.tap();
            setShowMobileOrderSheet(true);
          }}
          className={`press-response pointer-events-auto flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl px-4 shadow-2xl ${
            totalUnitsInSubAccount > 0
              ? "bg-primary text-primary-foreground"
              : "material-thick border border-white/15 text-foreground"
          }`}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={`flex h-8 min-w-8 items-center justify-center rounded-xl px-2 text-sm font-bold tabular-nums ${
                totalUnitsInSubAccount > 0
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              {totalUnitsInSubAccount > 0 ? (
                totalUnitsInSubAccount
              ) : (
                <ShoppingBag className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0 text-left">
              <p className="truncate text-sm font-bold leading-tight">
                {totalUnitsInSubAccount > 0
                  ? `Ver ${currentSubAccount?.label ?? "Cuenta"} · ${currentTableLabel}`
                  : `${currentTableLabel} (sin pedidos)`}
              </p>
              {sessionSubAccounts.length > 1 && (
                <p className="text-[11px] opacity-80">
                  {sessionSubAccounts.length} sub-cuentas abiertas
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <span className="text-base font-bold tabular-nums">
              {formatCOP(currentPendingBalance)}
            </span>
            <ChevronRight className="h-5 w-5" />
          </div>
        </button>
      </div>

      {/* === BOTTOM SHEET: SELECTOR DE MESAS EN CELULAR === */}
      {showTablePicker && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/70 backdrop-blur-sm lg:hidden"
          onClick={() => setShowTablePicker(false)}
        >
          <div
            className="material-thick safe-bottom w-full rounded-t-3xl border-t border-white/15 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-white/20" />
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">Elegir Mesa o Barra</h3>
              <button
                type="button"
                onClick={() => setShowTablePicker(false)}
                className="press-response flex h-10 w-10 items-center justify-center rounded-xl bg-secondary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="grid max-h-[60dvh] grid-cols-2 gap-2.5 overflow-y-auto pb-2">
              <button
                type="button"
                onClick={() => selectTable(null)}
                className={`press-response flex min-h-16 items-center gap-2.5 rounded-2xl border p-3 text-left ${
                  selectedTableId === null
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-white/10 bg-card text-foreground"
                }`}
              >
                <Zap className="h-5 w-5 shrink-0" />
                <div>
                  <p className="text-sm font-bold">Barra Rápida</p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {getTableOpenTotal(null).total > 0
                      ? formatCOP(getTableOpenTotal(null).total)
                      : "Venta directa"}
                  </p>
                </div>
              </button>

              {store.diningTables.map((table) => {
                const active = selectedTableId === table.id;
                const summary = getTableOpenTotal(table.id);
                return (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => selectTable(table.id)}
                    className={`press-response flex min-h-16 flex-col justify-between rounded-2xl border p-3 text-left ${
                      active
                        ? "border-primary bg-primary/20 text-primary"
                        : summary.total > 0
                          ? "border-warning/40 bg-warning/10 text-foreground"
                          : "border-white/10 bg-card text-foreground"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-bold">{table.label}</span>
                      {summary.count > 1 && (
                        <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-bold text-warning">
                          {summary.count} ctas
                        </span>
                      )}
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {summary.total > 0 ? formatCOP(summary.total) : "Libre"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* === BOTTOM SHEET: COMANDA Y SUB-CUENTAS EN CELULAR === */}
      {showMobileOrderSheet && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/75 backdrop-blur-sm lg:hidden"
          onClick={() => setShowMobileOrderSheet(false)}
        >
          <div
            className="material-thick safe-bottom flex h-[84dvh] w-full flex-col overflow-hidden rounded-t-3xl border-t border-white/15"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mt-2.5 h-1.5 w-12 shrink-0 rounded-full bg-white/20" />
            <div className="min-h-0 flex-1">{renderOrderContent(true)}</div>
          </div>
        </div>
      )}

      {/* Modal Cobro & Fiado & Cortesías */}
      {showCheckout && currentSubAccount && (
        <CheckoutModal
          tableLabel={currentTableLabel}
          subAccount={currentSubAccount}
          items={currentSubItems}
          paymentMethods={store.paymentMethods}
          customers={store.customers}
          promotionRules={store.promotionRules}
          enableCredit={store.featureFlags.enableCreditAccounts}
          isAdmin={isAdmin}
          onQuickAddWhitelistCustomer={async (input) => {
            const branchId = store.branch?.id;
            if (!branchId) throw new Error("Sucursal no cargada");
            const created = await apiFetch<{ id: string }>(
              `/api/v1/branches/${branchId}/customers`,
              {
                method: "POST",
                body: JSON.stringify({
                  fullName: input.fullName,
                  nickname: input.nickname ?? null,
                  phone: input.phone ?? null,
                  creditStatus: "whitelist_credit",
                  creditLimit: input.creditLimit ?? null,
                  statusReason: "Autorizado por Admin en caja",
                }),
              },
            );
            const newCustomer = {
              id: created.id,
              branchId,
              fullName: input.fullName,
              nickname: input.nickname ?? null,
              phone: input.phone ?? null,
              creditStatus: "whitelist_credit" as const,
              creditLimit: input.creditLimit ?? null,
              currentDebt: 0,
              statusReason: "Autorizado por Admin en caja",
            };
            await localDb.customers.put(newCustomer);
            void store.refresh();
            return newCustomer;
          }}
          onPromoteToWhitelist={async (customerId) => {
            const branchId = store.branch?.id;
            if (!branchId) return;
            await apiFetch(`/api/v1/branches/${branchId}/customers/${customerId}`, {
              method: "PATCH",
              body: JSON.stringify({
                creditStatus: "whitelist_credit",
                statusReason: "Autorizado por Admin en caja",
              }),
            });
            await localDb.customers.update(customerId, {
              creditStatus: "whitelist_credit",
            });
            void store.refresh();
          }}
          onAdjustItemPrice={async (itemId, newLineTotal, reason) => {
            await store.adjustOrderItemPrice(itemId, newLineTotal, reason);
          }}
          onApplyManualPromo={async (rule) => {
            await store.applyPromotionToSubAccount(currentSubAccount.id, rule);
          }}
          onClose={() => setShowCheckout(false)}
          onPay={async (pmId, amount, methodName) => {
            const snapshotItems = [...currentSubItems];
            const remainingAfter = Math.max(
              0,
              currentSubAccount.totalAmount -
                currentSubAccount.paidAmount -
                currentSubAccount.creditAmount -
                amount,
            );
            if (amount > 0) {
              await store.recordPayment(currentSubAccount.id, pmId, amount);
            } else {
              // 100% courtesy ($0 remaining): settle cleanly via $0 closure or close UI
              await store.recordPayment(currentSubAccount.id, pmId, 0);
            }
            if (remainingAfter <= 0.01) {
              setShowCheckout(false);
              setReceipt({
                branchName: store.branch?.name ?? "LiquiStock Bar",
                tableLabel: currentTableLabel,
                subAccountLabel: currentSubAccount.label,
                closedAt: new Date().toISOString(),
                items: snapshotItems,
                subtotal: currentSubAccount.subtotalAmount,
                discount: currentSubAccount.discountAmount,
                total: currentSubAccount.totalAmount,
                paymentSummary: amount > 0 ? `Pagado (${methodName})` : "Cortesía 100% ($0)",
              });
            }
          }}
          onChargeCredit={async (customer, amount, adminOverride) => {
            const snapshotItems = [...currentSubItems];
            await store.chargeCredit(currentSubAccount.id, customer.id, amount, adminOverride);
            setShowCheckout(false);
            setReceipt({
              branchName: store.branch?.name ?? "LiquiStock Bar",
              tableLabel: currentTableLabel,
              subAccountLabel: currentSubAccount.label,
              closedAt: new Date().toISOString(),
              items: snapshotItems,
              subtotal: currentSubAccount.subtotalAmount,
              discount: currentSubAccount.discountAmount,
              total: currentSubAccount.totalAmount,
              paymentSummary: "Cargado a Cartera (Fiado)",
              customerName: customer.fullName,
              creditAmount: amount,
            });
          }}
        />
      )}

      {/* Pop-up Recibo Digital */}
      {receipt && <DigitalReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
