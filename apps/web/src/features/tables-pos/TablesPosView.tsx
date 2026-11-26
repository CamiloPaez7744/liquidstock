import { useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Beer,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  CreditCard,
  Eye,
  Handshake,
  Layers,
  Lock,
  Pencil,
  Plus,
  PlusCircle,
  Search,
  ShoppingBag,
  Sparkles,
  Tag,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  evaluatePresentationAvailability,
  getMatchingComboTemplatesForPresentation,
  getQuickPromoOffersForPresentation,
  isAllyOpenAt,
  type ComboTemplate,
  type MenuProduct,
  type ProductPresentation,
} from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import { localDb } from "../../infrastructure/storage/dexie/db.js";
import type { LocalSubAccount } from "../../infrastructure/storage/dexie/db.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { useFeedback } from "../../shared/components/FeedbackProvider.js";
import { ProductVisualAvatar } from "../../shared/components/ProductTypeIcon.js";
import { formatCOP, getCurrentIsoDayAndTime } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";
import { CheckoutModal } from "./CheckoutModal.js";
import {
  DigitalReceiptModal,
  type DigitalReceiptData,
  type ReceiptBarBranding,
} from "./DigitalReceiptModal.js";

type StoreType = ReturnType<typeof useLiquiStock>;

export function TablesPosView({
  store,
  isAdmin,
  canEdit = true,
  canEditInventory,
  barBranding,
  onGoToInventory,
  onGoToCash,
}: {
  store: StoreType;
  isAdmin: boolean;
  canEdit?: boolean;
  canEditInventory?: boolean;
  barBranding?: ReceiptBarBranding;
  onGoToInventory?: () => void;
  onGoToCash?: () => void;
}) {
  const { toast, showAlertModal } = useFeedback();
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
  const [draggingSubAccountId, setDraggingSubAccountId] = useState<string | null>(null);
  const [isOverTrashZone, setIsOverTrashZone] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [checkoutInitialMode, setCheckoutInitialMode] = useState<
    "pay" | "credit" | "courtesy" | "extra"
  >("pay");
  const [editingTableName, setEditingTableName] = useState(false);
  const [tableNameDraft, setTableNameDraft] = useState("");
  const [renamingTable, setRenamingTable] = useState(false);
  const [subAccountEditorMode, setSubAccountEditorMode] = useState<"closed" | "edit" | "create">(
    "closed",
  );
  const [subLabelDraft, setSubLabelDraft] = useState("");
  const [subDescDraft, setSubDescDraft] = useState("");
  const [receipt, setReceipt] = useState<DigitalReceiptData | null>(null);

  const { isoDay, hhmm, yyyymmdd } = getCurrentIsoDayAndTime();

  const inventoryMap = useMemo(
    () => new Map(store.inventoryItems.map((i) => [i.id, i])),
    [store.inventoryItems],
  );
  const alliesMap = useMemo(
    () => new Map(store.allies.map((a) => [a.id, a])),
    [store.allies],
  );
  const promotionRuleById = useMemo(
    () => new Map(store.promotionRules.map((r) => [r.id, r])),
    [store.promotionRules],
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
      if (!item.presentationId) continue;
      map.set(item.presentationId, (map.get(item.presentationId) ?? 0) + item.quantity);
    }
    return map;
  }, [currentSubItems]);

  // Live count of applied promo lines per (presentationId:promotionRuleId) for 1-tap promo buttons
  const promoLinesByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of currentSubItems) {
      if (item.presentationId && item.promotionRuleId && item.discountAmount > 0) {
        const key = `${item.presentationId}:${item.promotionRuleId}`;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
    }
    return map;
  }, [currentSubItems]);

  const promoLinesCount = useMemo(
    () => currentSubItems.filter((i) => i.discountAmount > 0).length,
    [currentSubItems],
  );

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

  const evaluatedCatalog = useMemo(() => {
    return store.menuProducts
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
            const promoOffers = store.featureFlags.enablePromotions
              ? getQuickPromoOffersForPresentation({
                  categoryId: product.categoryId,
                  menuProductId: product.id,
                  presentationId: presentation.id,
                  presentationGroup: presentation.presentationGroup,
                  unitPrice: presentation.salePrice,
                  rules: store.promotionRules,
                  isoDayOfWeek: isoDay,
                  currentTimeHHMM: hhmm,
                  currentDateYYYYMMDD: yyyymmdd,
                })
              : [];

            const autoSingleOffer =
              promoOffers.find((o) => !o.isManual && o.bundleQty === 1) ?? null;
            const quickOffers = promoOffers.filter((o) => o.bundleQty > 1 || o.isManual);

            return {
              presentation,
              availability,
              promoOffers,
              autoSingleOffer,
              quickOffers,
            };
          })
          .filter((entry) => {
            if (
              entry.availability.reason === "PRODUCT_DISABLED" ||
              entry.availability.reason === "PRESENTATION_DISABLED"
            ) {
              return false;
            }
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

        return {
          product,
          entries: presList,
          hasActivePromo: presList.some(
            (e) => e.availability.available && e.promoOffers.length > 0,
          ),
          hasEditionTag: Boolean(product.editionTag?.trim()),
        };
      })
      .filter((group) => group.entries.length > 0);
  }, [
    store.menuProducts,
    store.presentations,
    store.promotionRules,
    store.featureFlags,
    inventoryMap,
    alliesMap,
    isoDay,
    hhmm,
    yyyymmdd,
  ]);

  const promoProductsCount = useMemo(
    () => evaluatedCatalog.filter((g) => g.hasActivePromo).length,
    [evaluatedCatalog],
  );

  const seasonalProductsCount = useMemo(
    () => evaluatedCatalog.filter((g) => g.hasEditionTag).length,
    [evaluatedCatalog],
  );

  const visibleCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    return evaluatedCatalog
      .filter((group) => {
        if (selectedCategoryId === "all") return true;
        if (selectedCategoryId === "__promos__") return group.hasActivePromo;
        if (selectedCategoryId === "__seasonal__") return group.hasEditionTag;
        return group.product.categoryId === selectedCategoryId;
      })
      .filter((group) => {
        if (!q) return true;
        if (group.product.name.toLowerCase().includes(q)) return true;
        if ((group.product.editionTag ?? "").toLowerCase().includes(q)) return true;
        return group.entries.some((e) => e.presentation.name.toLowerCase().includes(q));
      });
  }, [evaluatedCatalog, selectedCategoryId, search]);

  const shiftMissing = !store.loading && !store.activeShift;
  const shiftExpired24h = Boolean(store.activeShift?.isExpired24h);
  const posBlockedByShift = shiftMissing || shiftExpired24h;

  const assertShiftOpenForSale = (): boolean => {
    if (!posBlockedByShift) return true;
    haptics.blocked();
    showAlertModal({
      tone: "warning",
      title: shiftExpired24h ? "Turno abierto por más de 24 horas" : "Apertura de caja requerida",
      description: shiftExpired24h
        ? "El turno actual lleva más de 24 horas abierto. Ciérralo y realiza una nueva apertura de caja para continuar vendiendo."
        : "Debes realizar la apertura de caja del día antes de iniciar ventas o abrir mesas en el POS.",
      actions: [
        ...(onGoToCash
          ? [
              {
                label: shiftExpired24h ? "Ir a Cerrar / Abrir Caja" : "Ir a Abrir Caja",
                variant: "primary" as const,
                onClick: () => onGoToCash(),
              },
            ]
          : []),
        { label: "Entendido", variant: "secondary" as const },
      ],
    });
    return false;
  };

  const handleTapPresentation = async (
    product: MenuProduct,
    presentation: ProductPresentation,
    quantity = 1,
    forcedPromotionRuleId?: string | null,
    comboTemplate?: ComboTemplate | null,
  ) => {
    if (!canEdit) {
      haptics.blocked();
      toast({
        kind: "warning",
        title: "Modo solo vista",
        description: "Tu rol puede consultar el POS pero no agregar pedidos.",
      });
      return;
    }
    if (!assertShiftOpenForSale()) return;
    haptics.tap();
    let targetSubId = currentSubAccount?.id;
    if (!targetSubId) {
      const opened = await store.openTableSession(selectedTableId, "Cuenta 1");
      targetSubId = opened.subAccountId;
      setSelectedSubAccountId(targetSubId);
    }
    await store.addOrderItem(
      targetSubId,
      product,
      presentation,
      quantity,
      forcedPromotionRuleId ?? null,
      comboTemplate ?? null,
    );
  };

  const getNextSubAccountLabel = () => {
    const usedLabels = new Set(sessionSubAccounts.map((sa) => sa.label));
    let nextNum = sessionSubAccounts.length + 1;
    while (usedLabels.has(`Cuenta ${nextNum}`)) {
      nextNum += 1;
    }
    return `Cuenta ${nextNum}`;
  };

  const handleSplitAccount = () => {
    if (!canEdit) return;
    if (!assertShiftOpenForSale()) return;
    haptics.tap();
    setSubLabelDraft(getNextSubAccountLabel());
    setSubDescDraft("");
    setSubAccountEditorMode("create");
  };

  const handleOpenEditSubAccount = (sa: LocalSubAccount) => {
    if (!canEdit) return;
    haptics.tap();
    setSelectedSubAccountId(sa.id);
    setSubLabelDraft(sa.label);
    setSubDescDraft(sa.description ?? "");
    setSubAccountEditorMode("edit");
  };

  const handleSaveSubAccountEditor = async () => {
    if (!canEdit) return;
    const cleanLabel = subLabelDraft.trim() || getNextSubAccountLabel();
    const cleanDesc = subDescDraft.trim() || null;

    if (subAccountEditorMode === "create") {
      if (!assertShiftOpenForSale()) return;
      if (!activeSession) {
        const opened = await store.openTableSession(selectedTableId, cleanLabel, cleanDesc);
        setSelectedSubAccountId(opened.subAccountId);
      } else {
        const newId = await store.createSubAccount(activeSession.id, cleanLabel, cleanDesc);
        setSelectedSubAccountId(newId);
      }
      haptics.success();
      setSubAccountEditorMode("closed");
      toast({
        kind: "info",
        title: `Cuenta "${cleanLabel}" creada`,
        description: cleanDesc ?? `Lista para agregar o mover productos en ${currentTableLabel}.`,
      });
      return;
    }

    if (subAccountEditorMode === "edit" && currentSubAccount) {
      await store.updateSubAccount(currentSubAccount.id, {
        label: cleanLabel,
        description: cleanDesc,
      });
      haptics.success();
      setSubAccountEditorMode("closed");
      toast({
        kind: "success",
        title: `Cuenta actualizada: "${cleanLabel}"`,
        description: cleanDesc ?? "Etiqueta guardada sin descripción adicional.",
      });
    }
  };

  const requestDeleteSubAccount = (sa: LocalSubAccount) => {
    haptics.tap();
    const activeItemsInSub = store.orderItems.filter(
      (i) => i.subAccountId === sa.id && i.status === "active",
    );
    const otherOpenSubs = sessionSubAccounts.filter((s) => s.id !== sa.id);
    const fallbackSub = otherOpenSubs[0] ?? null;

    if (sa.paidAmount > 0 || sa.creditAmount > 0) {
      haptics.blocked();
      showAlertModal({
        tone: "danger",
        title: `No se puede eliminar ${sa.label}`,
        description: `Esta cuenta ya tiene pagos o fiado registrados (${formatCOP(
          sa.paidAmount + sa.creditAmount,
        )}). Debes finalizar el cobro desde «Cobrar / Fiar» antes de cerrarla.`,
        actions: [{ label: "Entendido", variant: "primary" }],
      });
      return;
    }

    if (activeItemsInSub.length === 0) {
      showAlertModal({
        tone: "warning",
        title: `¿Eliminar ${sa.label}?`,
        description: fallbackSub
          ? `Esta sub-cuenta está vacía. Se cerrará y volverás a ${fallbackSub.label}.`
          : `Esta cuenta está vacía. Al eliminarla, ${currentTableLabel} volverá a quedar libre.`,
        actions: [
          {
            label: fallbackSub ? `Eliminar ${sa.label}` : "Eliminar y liberar mesa",
            variant: "danger",
            onClick: async () => {
              await store.deleteSubAccount(sa.id, { mode: "empty_only" });
              if (selectedSubAccountId === sa.id) {
                setSelectedSubAccountId(fallbackSub?.id ?? null);
              }
              setMovingItemId(null);
              toast({
                kind: "success",
                title: `${sa.label} eliminada`,
                description: fallbackSub
                  ? `Sub-cuenta cerrada en ${currentTableLabel}.`
                  : `${currentTableLabel} volvió a quedar libre.`,
              });
            },
          },
          { label: "Cancelar", variant: "secondary" },
        ],
      });
      return;
    }

    const unitsCount = activeItemsInSub.reduce((acc, i) => acc + i.quantity, 0);
    showAlertModal({
      tone: "warning",
      title: `${sa.label} tiene ${unitsCount} producto(s) sin cobrar`,
      description: `Saldo actual: ${formatCOP(sa.totalAmount)}. Elige qué hacer con los pedidos antes de eliminar esta cuenta:`,
      bulletItems: activeItemsInSub
        .slice(0, 5)
        .map(
          (i) =>
            `${i.quantity}× ${i.productNameSnap} (${i.presentationNameSnap}) · ${formatCOP(i.lineTotal)}`,
        ),
      actions: [
        ...(fallbackSub
          ? [
              {
                label: `Mover productos a ${fallbackSub.label} y eliminar`,
                variant: "primary" as const,
                onClick: async () => {
                  await store.deleteSubAccount(sa.id, {
                    mode: "move_items",
                    targetSubAccountId: fallbackSub.id,
                  });
                  setSelectedSubAccountId(fallbackSub.id);
                  setMovingItemId(null);
                  toast({
                    kind: "success",
                    title: `${sa.label} unificada en ${fallbackSub.label}`,
                    description: `Se movieron ${unitsCount} producto(s) y se eliminó ${sa.label}.`,
                  });
                },
              },
            ]
          : []),
        {
          label: fallbackSub
            ? "Anular productos (devolver stock) y eliminar"
            : "Anular productos (devolver stock) y liberar mesa",
          variant: "danger",
          onClick: async () => {
            await store.deleteSubAccount(sa.id, {
              mode: "void_items",
              reason: `Cuenta ${sa.label} eliminada en POS`,
            });
            if (selectedSubAccountId === sa.id) {
              setSelectedSubAccountId(fallbackSub?.id ?? null);
            }
            setMovingItemId(null);
            toast({
              kind: "success",
              title: `${sa.label} eliminada`,
              description: `Se anularon ${unitsCount} producto(s) y se devolvió el stock.`,
            });
          },
        },
        { label: "Cancelar", variant: "secondary" },
      ],
    });
  };

  const handleMoveToSubAccount = async (targetSubId: string) => {
    if (!movingItemId) return;
    haptics.tap();
    const target = sessionSubAccounts.find((s) => s.id === targetSubId);
    await store.moveOrderItem(movingItemId, targetSubId);
    setMovingItemId(null);
    if (target) {
      toast({
        kind: "success",
        title: `Producto movido a ${target.label}`,
      });
    }
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
    setEditingTableName(false);
    setSubAccountEditorMode("closed");
    setShowTablePicker(false);
  };

  const handleSaveTableName = async () => {
    if (!selectedTableId || !canEdit || renamingTable) return;
    const trimmed = tableNameDraft.trim();
    if (!trimmed) {
      toast({
        kind: "error",
        title: "Nombre inválido",
        description: "Escribe un nombre para la mesa.",
      });
      return;
    }
    if (trimmed === currentTableLabel) {
      setEditingTableName(false);
      return;
    }
    setRenamingTable(true);
    try {
      await store.renameDiningTable(selectedTableId, trimmed);
      haptics.success();
      setEditingTableName(false);
      toast({
        kind: "success",
        title: "Mesa renombrada",
        description: `Ahora se llama "${trimmed}".`,
      });
    } catch (err) {
      haptics.blocked();
      toast({
        kind: "error",
        title: "No se pudo renombrar la mesa",
        description: err instanceof Error ? err.message : "Intenta con otro nombre.",
      });
    } finally {
      setRenamingTable(false);
    }
  };

  const handleOpenQuickExtraCharge = async () => {
    if (!canEdit) return;
    if (!assertShiftOpenForSale()) return;
    haptics.tap();
    if (!currentSubAccount) {
      const opened = await store.openTableSession(selectedTableId, "Cuenta 1");
      setSelectedSubAccountId(opened.subAccountId);
    }
    setShowMobileOrderSheet(false);
    setCheckoutInitialMode("extra");
    setShowCheckout(true);
  };

  // Shared Comanda & Sub-Accounts content (used inside Desktop sidebar AND Mobile Bottom Sheet)
  const renderOrderContent = (isSheet: boolean) => (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            {editingTableName && selectedTableId !== null && canEdit ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  maxLength={40}
                  value={tableNameDraft}
                  onChange={(e) => setTableNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSaveTableName();
                    } else if (e.key === "Escape") {
                      setEditingTableName(false);
                    }
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-primary/60 bg-background px-2.5 py-1 text-sm font-bold text-foreground focus:outline-none"
                />
                <button
                  type="button"
                  disabled={renamingTable}
                  title="Guardar nombre"
                  onClick={() => void handleSaveTableName()}
                  className="press-response flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success/20 text-success"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title="Cancelar"
                  onClick={() => setEditingTableName(false)}
                  className="press-response flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <h2 className="truncate font-display text-base font-bold">{currentTableLabel}</h2>
                {selectedTableId !== null && canEdit && (
                  <button
                    type="button"
                    title="Editar nombre de esta mesa"
                    aria-label="Editar nombre de esta mesa"
                    onClick={() => {
                      haptics.tap();
                      setTableNameDraft(currentTableLabel);
                      setEditingTableName(true);
                    }}
                    className="press-response flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary/70 text-muted-foreground hover:text-primary"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {totalUnitsInSubAccount} producto(s) en {currentSubAccount?.label ?? "Cuenta 1"}
              {promoLinesCount > 0 && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-bold text-success">
                  <Sparkles className="h-2.5 w-2.5" />
                  {promoLinesCount} {promoLinesCount === 1 ? "promo" : "promos"}
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canEdit && (
              <button
                type="button"
                title="Agregar cobro adicional (vaso roto, descorche, servicio...)"
                onClick={() => void handleOpenQuickExtraCharge()}
                className="press-response flex min-h-10 items-center gap-1 rounded-xl bg-accent/15 px-2.5 text-xs font-bold text-accent ring-1 ring-accent/30"
              >
                <PlusCircle className="h-3.5 w-3.5" />
                Adicional
              </button>
            )}
            {canEdit && store.featureFlags.enableSplitAccounts && (
              <button
                type="button"
                onClick={handleSplitAccount}
                className="press-response flex min-h-10 items-center gap-1 rounded-xl bg-secondary px-2.5 text-xs font-bold text-primary"
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
          <div className="mt-2.5 flex items-center gap-2">
            <div className="no-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
              {sessionSubAccounts.map((sa) => {
                const active = sa.id === currentSubAccount?.id;
                const isMoveTarget = Boolean(movingItemId && !active);
                const isDragging = draggingSubAccountId === sa.id;
                return (
                  <div
                    key={sa.id}
                    draggable={canEdit && !isMoveTarget}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", sa.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDraggingSubAccountId(sa.id);
                    }}
                    onDragEnd={() => {
                      setDraggingSubAccountId(null);
                      setIsOverTrashZone(false);
                    }}
                    className={`flex min-h-10 shrink-0 items-center overflow-hidden rounded-xl transition ${
                      isDragging ? "opacity-50 ring-2 ring-destructive" : ""
                    } ${
                      isMoveTarget
                        ? "animate-pulse bg-warning text-primary-foreground ring-2 ring-warning"
                        : active
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary/70 text-muted-foreground"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (isMoveTarget) {
                          void handleMoveToSubAccount(sa.id);
                        } else {
                          haptics.tap();
                          setSelectedSubAccountId(sa.id);
                        }
                      }}
                      className="press-response flex min-h-10 items-center pl-3 pr-1.5 text-xs font-bold"
                    >
                      {isMoveTarget ? `→ Mover a ${sa.label}` : sa.label}
                    </button>
                    {canEdit && !isMoveTarget && (
                      <button
                        type="button"
                        title={`Editar etiqueta y descripción de ${sa.label}`}
                        aria-label={`Editar etiqueta de ${sa.label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenEditSubAccount(sa);
                        }}
                        className={`press-response flex h-7 w-7 items-center justify-center rounded-lg transition ${
                          active
                            ? "text-primary-foreground/80 hover:bg-black/15 hover:text-primary-foreground"
                            : "text-muted-foreground hover:bg-primary/20 hover:text-primary"
                        }`}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                    {canEdit && !isMoveTarget && (
                      <button
                        type="button"
                        title={`Eliminar ${sa.label} (o arrastra a la papelera)`}
                        aria-label={`Eliminar ${sa.label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          requestDeleteSubAccount(sa);
                        }}
                        className={`press-response mr-1 flex h-7 w-7 items-center justify-center rounded-lg transition ${
                          active
                            ? "text-primary-foreground/75 hover:bg-black/15 hover:text-primary-foreground"
                            : "text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                        }`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Papelera desplegable en la esquina al arrastrar una cuenta */}
            {draggingSubAccountId && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setIsOverTrashZone(true);
                }}
                onDragLeave={() => setIsOverTrashZone(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  const droppedId = e.dataTransfer.getData("text/plain") || draggingSubAccountId;
                  setDraggingSubAccountId(null);
                  setIsOverTrashZone(false);
                  const targetSub = sessionSubAccounts.find((s) => s.id === droppedId);
                  if (targetSub) requestDeleteSubAccount(targetSub);
                }}
                className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl border-2 border-dashed px-3 text-xs font-bold transition ${
                  isOverTrashZone
                    ? "scale-105 border-destructive bg-destructive text-white"
                    : "border-destructive/60 bg-destructive/15 text-destructive"
                }`}
              >
                <Trash2 className="h-4 w-4" />
                <span>Soltar</span>
              </div>
            )}
          </div>
        )}

        {/* Etiqueta / descripción visible de la cuenta activa + acceso rápido a editar */}
        {currentSubAccount && subAccountEditorMode === "closed" && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-background/50 px-2.5 py-1.5 text-[11px]">
            <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <Tag className="h-3.5 w-3.5 shrink-0 text-primary" />
              {currentSubAccount.description ? (
                <span className="truncate text-foreground">
                  <strong className="text-primary">{currentSubAccount.label}:</strong>{" "}
                  {currentSubAccount.description}
                </span>
              ) : (
                <span className="truncate">
                  Sin descripción en <strong className="text-foreground">{currentSubAccount.label}</strong>
                </span>
              )}
            </div>
            {canEdit && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleOpenEditSubAccount(currentSubAccount)}
                  className="press-response rounded-lg bg-secondary px-2 py-0.5 text-[10px] font-bold text-primary"
                >
                  {currentSubAccount.description ? "Editar" : "+ Etiqueta / Nota"}
                </button>
                {currentSubAccount.description && (
                  <button
                    type="button"
                    title="Quitar descripción"
                    onClick={() =>
                      void store.updateSubAccount(currentSubAccount.id, { description: null })
                    }
                    className="press-response flex h-5 w-5 items-center justify-center rounded-md bg-secondary text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Editor en línea para añadir o editar etiqueta + descripción de cuenta */}
        {canEdit && subAccountEditorMode !== "closed" && (
          <div className="mt-2.5 space-y-2 rounded-xl border border-primary/40 bg-primary/8 p-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-bold text-primary">
                {subAccountEditorMode === "create"
                  ? "Nueva cuenta con etiqueta"
                  : "Editar etiqueta y descripción"}
              </span>
              <button
                type="button"
                onClick={() => setSubAccountEditorMode("closed")}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <input
                type="text"
                autoFocus
                maxLength={60}
                placeholder="Nombre / Etiqueta (ej. Camilo, Chicas barra)"
                value={subLabelDraft}
                onChange={(e) => setSubLabelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveSubAccountEditor();
                  } else if (e.key === "Escape") {
                    setSubAccountEditorMode("closed");
                  }
                }}
                className="rounded-lg border border-white/15 bg-background px-2.5 py-1.5 text-xs font-bold text-foreground focus:border-primary focus:outline-none"
              />
              <input
                type="text"
                maxLength={140}
                placeholder="Descripción opcional (ej. Camisa negra, paga aparte)"
                value={subDescDraft}
                onChange={(e) => setSubDescDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveSubAccountEditor();
                  } else if (e.key === "Escape") {
                    setSubAccountEditorMode("closed");
                  }
                }}
                className="rounded-lg border border-white/15 bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setSubAccountEditorMode("closed")}
                className="rounded-lg bg-secondary px-3 py-1.5 text-[11px] font-semibold text-muted-foreground"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleSaveSubAccountEditor()}
                className="press-response flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground"
              >
                <Check className="h-3.5 w-3.5" />
                {subAccountEditorMode === "create" ? "Crear Cuenta" : "Guardar"}
              </button>
            </div>
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
            const appliedPromo = item.promotionRuleId
              ? promotionRuleById.get(item.promotionRuleId) ?? null
              : null;
            const grossLine = item.unitPriceSnap * item.quantity;
            return (
              <div
                key={item.id}
                className={`rounded-xl border p-3 ${
                  isMovingThis
                    ? "border-warning bg-warning/10"
                    : item.discountAmount > 0
                      ? "border-success/30 bg-success/5"
                      : "border-white/10 bg-background/60"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-foreground">
                      {item.quantity}× {item.productNameSnap}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {!item.presentationId ? (
                        <span className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold text-accent">
                          <PlusCircle className="h-2.5 w-2.5" />
                          {item.presentationNameSnap}
                        </span>
                      ) : (
                        <>
                          {item.presentationNameSnap}
                          {item.allyIdSnap ? " · Aliado" : ""}
                        </>
                      )}
                    </p>
                    {item.discountAmount > 0 && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-success/15 px-1.5 py-0.5 text-[11px] font-bold text-success">
                        <Sparkles className="h-3 w-3 shrink-0" />
                        {appliedPromo
                          ? `Promo: ${appliedPromo.name} (-${formatCOP(item.discountAmount)})`
                          : `Promo (-${formatCOP(item.discountAmount)})`}
                      </span>
                    )}
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    {item.discountAmount > 0 && grossLine > item.lineTotal && (
                      <p className="text-[11px] text-muted-foreground line-through">
                        {formatCOP(grossLine)}
                      </p>
                    )}
                    <p className="text-sm font-bold text-foreground">
                      {formatCOP(item.lineTotal)}
                    </p>
                  </div>
                </div>

                {canEdit && (
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
                )}
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
          disabled={!canEdit || !currentSubAccount || currentSubItems.length === 0}
          onClick={() => {
            if (!canEdit) return;
            haptics.tap();
            setShowMobileOrderSheet(false);
            setCheckoutInitialMode("pay");
            setShowCheckout(true);
          }}
          className="press-response flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-40"
        >
          <CreditCard className="h-5 w-5" />
          {canEdit
            ? `Cobrar / Fiar · ${formatCOP(currentPendingBalance)}`
            : `Solo vista · ${formatCOP(currentPendingBalance)}`}
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
          {promoProductsCount > 0 && (
            <button
              type="button"
              onClick={() => {
                haptics.tap();
                setSelectedCategoryId("__promos__");
              }}
              className={`press-response flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-bold ${
                selectedCategoryId === "__promos__"
                  ? "bg-success text-primary-foreground"
                  : "border border-success/40 bg-success/12 text-success"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Promos hoy ({promoProductsCount})
            </button>
          )}
          {seasonalProductsCount > 0 && (
            <button
              type="button"
              onClick={() => {
                haptics.tap();
                setSelectedCategoryId("__seasonal__");
              }}
              className={`press-response flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-bold ${
                selectedCategoryId === "__seasonal__"
                  ? "bg-accent text-primary-foreground"
                  : "border border-accent/40 bg-accent/12 text-accent"
              }`}
            >
              <Tag className="h-3.5 w-3.5" />
              Temporada ({seasonalProductsCount})
            </button>
          )}
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

      {/* Banner si el rol tiene acceso solo vista al POS */}
      {!canEdit && (
        <div className="mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-xl border border-warning/35 bg-warning/10 px-3 py-1.5 text-xs font-semibold text-warning lg:mx-0 lg:mb-3 lg:mt-0">
          <Eye className="h-3.5 w-3.5 shrink-0" />
          <span>
            Modo solo vista: puedes consultar mesas, carta y cuentas sin modificar pedidos ni cobrar.
          </span>
        </div>
      )}

      {/* Bloqueo de ventas si no hay apertura de caja activa (< 24h) */}
      {canEdit && posBlockedByShift && (
        <div className="mx-3 mt-2 flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-2xl border border-destructive/45 bg-destructive/12 px-4 py-2.5 text-xs lg:mx-0 lg:mb-3 lg:mt-0">
          <div className="flex items-center gap-2 text-destructive">
            <Lock className="h-4 w-4 shrink-0" />
            <span className="font-bold">
              {shiftExpired24h
                ? `Turno abierto hace ${store.activeShift?.hoursOpen ?? 24}h (>24h): cierra caja y abre nuevo turno para vender.`
                : "Caja cerrada: realiza la apertura de caja del día para habilitar ventas en el POS."}
            </span>
          </div>
          {onGoToCash && (
            <button
              type="button"
              onClick={() => {
                haptics.tap();
                onGoToCash();
              }}
              className="press-response rounded-xl bg-destructive px-3.5 py-1.5 text-xs font-bold text-white"
            >
              {shiftExpired24h ? "Cerrar / Abrir Caja" : "Abrir Caja Ahora"}
            </button>
          )}
        </div>
      )}

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
            {promoProductsCount > 0 && (
              <button
                type="button"
                onClick={() => setSelectedCategoryId("__promos__")}
                className={`press-response flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold ${
                  selectedCategoryId === "__promos__"
                    ? "bg-success text-primary-foreground"
                    : "border border-success/40 bg-success/12 text-success"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Promos hoy ({promoProductsCount})
              </button>
            )}
            {seasonalProductsCount > 0 && (
              <button
                type="button"
                onClick={() => setSelectedCategoryId("__seasonal__")}
                className={`press-response flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold ${
                  selectedCategoryId === "__seasonal__"
                    ? "bg-accent text-primary-foreground"
                    : "border border-accent/40 bg-accent/12 text-accent"
                }`}
              >
                <Tag className="h-3.5 w-3.5" />
                Temporada ({seasonalProductsCount})
              </button>
            )}
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
                {store.menuProducts.length === 0 && (canEditInventory ?? isAdmin) && onGoToInventory && (
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
                  const singleEntry = entries.length === 1 ? entries[0] : null;

                  return (
                    <article
                      key={product.id}
                      className="solid-card flex flex-col gap-3 rounded-2xl p-3.5"
                    >
                      {/* Cabecera clara y limpia del producto */}
                      <div className="flex items-center gap-3">
                        <ProductVisualAvatar
                          imageUrl={product.imageUrl}
                          name={product.name}
                          productKind={product.productKind}
                          allyId={product.allyId}
                          presentationGroup={entries[0]?.presentation.presentationGroup}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <h3 className="truncate font-display text-base font-bold leading-snug text-foreground">
                              {product.name}
                            </h3>
                            {product.editionTag && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-bold text-accent ring-1 ring-accent/35">
                                <Tag className="h-2.5 w-2.5" />
                                {product.editionTag}
                              </span>
                            )}
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
                          const { presentation, availability, autoSingleOffer, quickOffers } =
                            singleEntry;
                          const disabled = !availability.available;
                          const inCartQty = qtyByPresentationId.get(presentation.id) ?? 0;
                          return (
                            <div className="space-y-2">
                              <button
                                type="button"
                                disabled={disabled}
                                onClick={() => {
                                  if (disabled) {
                                    haptics.blocked();
                                    return;
                                  }
                                  void handleTapPresentation(product, presentation, 1);
                                }}
                                className={`press-response flex min-h-14 w-full items-center justify-between gap-2 rounded-xl border px-4 ${
                                  disabled
                                    ? "cursor-not-allowed border-destructive/30 bg-destructive/10 opacity-65"
                                    : inCartQty > 0
                                      ? "border-primary/60 bg-primary/15"
                                      : "border-white/10 bg-secondary/75"
                                }`}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  {autoSingleOffer && !disabled ? (
                                    <>
                                      <span className="text-base font-bold tabular-nums text-success">
                                        {formatCOP(autoSingleOffer.promoTotal)}
                                      </span>
                                      <span className="text-xs tabular-nums text-muted-foreground line-through">
                                        {formatCOP(presentation.salePrice)}
                                      </span>
                                      <span className="flex items-center gap-1 rounded-full bg-success/20 px-2 py-0.5 text-[11px] font-bold text-success">
                                        <Sparkles className="h-3 w-3" />
                                        {autoSingleOffer.shortBadge}
                                      </span>
                                    </>
                                  ) : (
                                    <span className="text-base font-bold tabular-nums text-primary">
                                      {formatCOP(presentation.salePrice)}
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
                                          1 und
                                        </span>
                                      )}
                                    </>
                                  )}
                                </div>
                              </button>

                              {/* Botones rápidos de Promoción 1 toque (2x1, 3x2, promos de hoy) */}
                              {!disabled && quickOffers.length > 0 && (
                                <div className="space-y-1.5">
                                  {quickOffers.map((offer) => {
                                    const canFulfill =
                                      availability.maxServings === null ||
                                      availability.maxServings >= offer.bundleQty;
                                    const appliedCount =
                                      promoLinesByKey.get(`${presentation.id}:${offer.rule.id}`) ??
                                      0;
                                    return (
                                      <button
                                        key={offer.rule.id}
                                        type="button"
                                        disabled={!canFulfill}
                                        onClick={() => {
                                          if (!canFulfill) {
                                            haptics.blocked();
                                            return;
                                          }
                                          void handleTapPresentation(
                                            product,
                                            presentation,
                                            offer.bundleQty,
                                            offer.rule.id,
                                          );
                                        }}
                                        className={`press-response flex min-h-12 w-full items-center justify-between gap-2 rounded-xl border px-3.5 py-2 text-left transition ${
                                          !canFulfill
                                            ? "cursor-not-allowed border-white/10 bg-secondary/40 opacity-50"
                                            : appliedCount > 0
                                              ? "border-success/65 bg-success/18"
                                              : "border-success/40 bg-success/10 hover:bg-success/16"
                                        }`}
                                      >
                                        <div className="flex min-w-0 items-center gap-2">
                                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-success/20 text-success">
                                            <Sparkles className="h-3.5 w-3.5" />
                                          </span>
                                          <div className="min-w-0">
                                            <p className="flex items-center gap-1.5 text-xs font-bold text-success">
                                              <span>
                                                +{offer.bundleQty} · {offer.shortBadge}
                                              </span>
                                              {appliedCount > 0 && (
                                                <span className="rounded-full bg-success px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-primary-foreground">
                                                  ×{appliedCount}
                                                </span>
                                              )}
                                            </p>
                                            <p className="truncate text-[11px] text-muted-foreground">
                                              {offer.rule.name}
                                            </p>
                                          </div>
                                        </div>

                                        <div className="shrink-0 text-right tabular-nums">
                                          {canFulfill ? (
                                            <>
                                              <p className="text-sm font-bold text-success">
                                                {formatCOP(offer.promoTotal)}
                                              </p>
                                              <p className="text-[10px] text-muted-foreground line-through">
                                                {formatCOP(offer.regularTotal)}
                                              </p>
                                            </>
                                          ) : (
                                            <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-bold text-destructive">
                                              Stock insuf.
                                            </span>
                                          )}
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}

                              {/* Combos unificados (aliado y/o alimento de la casa) para productos de 1 presentación */}
                              {!disabled && (() => {
                                const singleCombos = getMatchingComboTemplatesForPresentation({
                                  product,
                                  presentation,
                                  comboTemplates: store.comboTemplates,
                                  alliesById: alliesMap,
                                  inventoryById: inventoryMap,
                                  presentationMaxServings: availability.maxServings,
                                  isoDayOfWeek: isoDay,
                                  currentTimeHHMM: hhmm,
                                  currentDateYYYYMMDD: yyyymmdd,
                                  autoHideClosedAllies: store.featureFlags.autoHideClosedAllies,
                                });
                                if (singleCombos.length === 0) return null;
                                return (
                                  <div className="space-y-1.5 border-t border-white/10 pt-2">
                                    {singleCombos.map((offer) => {
                                      const baseQty = Math.max(1, offer.template.baseQuantity ?? 1);
                                      const houseSummary =
                                        offer.template.fixedRecipes && offer.template.fixedRecipes.length > 0
                                          ? offer.template.fixedRecipes
                                              .map((r) => `${r.displayQuantity} ${r.displayUnit} ${r.itemName ?? ""}`.trim())
                                              .join(" + ")
                                          : null;
                                      return (
                                        <button
                                          key={`${presentation.id}:combo:${offer.template.id}`}
                                          type="button"
                                          disabled={!offer.canFulfill}
                                          onClick={() => {
                                            if (!offer.canFulfill) {
                                              haptics.blocked();
                                              return;
                                            }
                                            void handleTapPresentation(
                                              product,
                                              presentation,
                                              1,
                                              null,
                                              offer.template,
                                            );
                                          }}
                                          className={`press-response flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 py-1.5 text-left transition ${
                                            offer.canFulfill
                                              ? "border-warning/40 bg-warning/10 hover:bg-warning/18"
                                              : "cursor-not-allowed border-white/10 bg-secondary/40 opacity-50"
                                          }`}
                                        >
                                          <div className="flex min-w-0 items-center gap-2">
                                            <Layers className="h-3.5 w-3.5 shrink-0 text-warning" />
                                            <div className="min-w-0">
                                              <p className="truncate text-xs font-bold text-warning">
                                                {baseQty > 1 ? `${baseQty}× ` : ""}
                                                {presentation.shortLabel ?? presentation.name} +{" "}
                                                {offer.template.shortLabel || offer.template.name}
                                              </p>
                                              <p className="truncate text-[10px] text-muted-foreground">
                                                {!offer.canFulfill
                                                  ? offer.insufficientReason ?? "Stock insuficiente"
                                                  : [
                                                      `Descuenta ${product.name}`,
                                                      offer.allyName ? `Aliado: ${offer.allyName}` : null,
                                                      houseSummary ? `Casa: ${houseSummary}` : null,
                                                    ]
                                                      .filter(Boolean)
                                                      .join(" · ")}
                                              </p>
                                            </div>
                                          </div>
                                          <span className="shrink-0 text-xs font-bold tabular-nums text-warning">
                                            {offer.canFulfill ? formatCOP(offer.finalPrice) : "Agotado"}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })()
                      ) : (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            {entries.map(
                              ({ presentation, availability, autoSingleOffer, quickOffers }) => {
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
                                      void handleTapPresentation(product, presentation, 1);
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
                                      {inCartQty === 0 &&
                                        (autoSingleOffer || quickOffers.length > 0) &&
                                        !disabled && (
                                          <Sparkles className="h-3.5 w-3.5 shrink-0 text-success" />
                                        )}
                                    </div>

                                    <div className="mt-1.5 flex w-full items-end justify-between gap-1">
                                      {autoSingleOffer && !disabled ? (
                                        <div className="flex flex-wrap items-baseline gap-1">
                                          <span className="text-[15px] font-bold tabular-nums text-success">
                                            {formatCOP(autoSingleOffer.promoTotal)}
                                          </span>
                                          <span className="text-[10px] tabular-nums text-muted-foreground line-through">
                                            {formatCOP(presentation.salePrice)}
                                          </span>
                                        </div>
                                      ) : (
                                        <span className="text-[15px] font-bold tabular-nums text-primary">
                                          {formatCOP(presentation.salePrice)}
                                        </span>
                                      )}
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
                              },
                            )}
                          </div>

                          {/* Combos unificados por categoría o producto (aliado y/o alimento de la casa) */}
                          {(() => {
                            const comboRows = entries.flatMap((entry) =>
                              entry.availability.available
                                ? getMatchingComboTemplatesForPresentation({
                                    product,
                                    presentation: entry.presentation,
                                    comboTemplates: store.comboTemplates,
                                    alliesById: alliesMap,
                                    inventoryById: inventoryMap,
                                    presentationMaxServings: entry.availability.maxServings,
                                    isoDayOfWeek: isoDay,
                                    currentTimeHHMM: hhmm,
                                    currentDateYYYYMMDD: yyyymmdd,
                                    autoHideClosedAllies: store.featureFlags.autoHideClosedAllies,
                                  }).map((offer) => ({ entry, offer }))
                                : [],
                            );
                            if (comboRows.length === 0) return null;
                            return (
                              <div className="space-y-1.5 border-t border-white/10 pt-2">
                                {comboRows.map(({ entry, offer }) => {
                                  const baseQty = Math.max(1, offer.template.baseQuantity ?? 1);
                                  const houseSummary =
                                    offer.template.fixedRecipes && offer.template.fixedRecipes.length > 0
                                      ? offer.template.fixedRecipes
                                          .map((r) => `${r.displayQuantity} ${r.displayUnit} ${r.itemName ?? ""}`.trim())
                                          .join(" + ")
                                      : null;
                                  return (
                                    <button
                                      key={`${entry.presentation.id}:combo:${offer.template.id}`}
                                      type="button"
                                      disabled={!offer.canFulfill}
                                      onClick={() => {
                                        if (!offer.canFulfill) {
                                          haptics.blocked();
                                          return;
                                        }
                                        void handleTapPresentation(
                                          product,
                                          entry.presentation,
                                          1,
                                          null,
                                          offer.template,
                                        );
                                      }}
                                      className={`press-response flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 py-1.5 text-left transition ${
                                        offer.canFulfill
                                          ? "border-warning/40 bg-warning/10 hover:bg-warning/18"
                                          : "cursor-not-allowed border-white/10 bg-secondary/40 opacity-50"
                                      }`}
                                    >
                                      <div className="flex min-w-0 items-center gap-2">
                                        <Layers className="h-3.5 w-3.5 shrink-0 text-warning" />
                                        <div className="min-w-0">
                                          <p className="truncate text-xs font-bold text-warning">
                                            {baseQty > 1 ? `${baseQty}× ` : ""}
                                            {entry.presentation.shortLabel ?? entry.presentation.name} +{" "}
                                            {offer.template.shortLabel || offer.template.name}
                                          </p>
                                          <p className="truncate text-[10px] text-muted-foreground">
                                            {!offer.canFulfill
                                              ? offer.insufficientReason ?? "Stock insuficiente"
                                              : [
                                                  `Descuenta ${product.name}`,
                                                  offer.allyName ? `Aliado: ${offer.allyName}` : null,
                                                  houseSummary ? `Casa: ${houseSummary}` : null,
                                                ]
                                                  .filter(Boolean)
                                                  .join(" · ")}
                                          </p>
                                        </div>
                                      </div>
                                      <span className="shrink-0 text-xs font-bold tabular-nums text-warning">
                                        {offer.canFulfill ? formatCOP(offer.finalPrice) : "Agotado"}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}

                          {/* Accesos rápidos de Promoción 1 toque para presentaciones de este producto */}
                          {(() => {
                            const quickRows = entries.flatMap((entry) =>
                              entry.availability.available
                                ? entry.quickOffers.map((offer) => ({ entry, offer }))
                                : [],
                            );
                            if (quickRows.length === 0) return null;
                            return (
                              <div className="space-y-1.5 border-t border-white/10 pt-2">
                                {quickRows.map(({ entry, offer }) => {
                                  const canFulfill =
                                    entry.availability.maxServings === null ||
                                    entry.availability.maxServings >= offer.bundleQty;
                                  const appliedCount =
                                    promoLinesByKey.get(
                                      `${entry.presentation.id}:${offer.rule.id}`,
                                    ) ?? 0;
                                  return (
                                    <button
                                      key={`${entry.presentation.id}:${offer.rule.id}`}
                                      type="button"
                                      disabled={!canFulfill}
                                      onClick={() => {
                                        if (!canFulfill) {
                                          haptics.blocked();
                                          return;
                                        }
                                        void handleTapPresentation(
                                          product,
                                          entry.presentation,
                                          offer.bundleQty,
                                          offer.rule.id,
                                        );
                                      }}
                                      className={`press-response flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 py-1.5 text-left transition ${
                                        !canFulfill
                                          ? "cursor-not-allowed border-white/10 bg-secondary/40 opacity-50"
                                          : appliedCount > 0
                                            ? "border-success/65 bg-success/18"
                                            : "border-success/40 bg-success/10 hover:bg-success/16"
                                      }`}
                                    >
                                      <div className="flex min-w-0 items-center gap-2">
                                        <Sparkles className="h-3.5 w-3.5 shrink-0 text-success" />
                                        <div className="min-w-0">
                                          <p className="flex items-center gap-1.5 truncate text-xs font-bold text-success">
                                            <span>
                                              +{offer.bundleQty}{" "}
                                              {entry.presentation.shortLabel ??
                                                entry.presentation.name}{" "}
                                              · {offer.shortBadge}
                                            </span>
                                            {appliedCount > 0 && (
                                              <span className="rounded-full bg-success px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-primary-foreground">
                                                ×{appliedCount}
                                              </span>
                                            )}
                                          </p>
                                          <p className="truncate text-[10px] text-muted-foreground">
                                            {offer.rule.name}
                                          </p>
                                        </div>
                                      </div>

                                      <div className="shrink-0 text-right tabular-nums">
                                        {canFulfill ? (
                                          <>
                                            <p className="text-xs font-bold text-success">
                                              {formatCOP(offer.promoTotal)}
                                            </p>
                                            <p className="text-[10px] text-muted-foreground line-through">
                                              {formatCOP(offer.regularTotal)}
                                            </p>
                                          </>
                                        ) : (
                                          <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-bold text-destructive">
                                            Stock insuf.
                                          </span>
                                        )}
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}
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

      {/* Modal Cobro & Fiado & Cortesías & Adicionales */}
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
          initialMode={checkoutInitialMode}
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
          onAddCustomCharge={async (input) => {
            await store.addCustomCharge(currentSubAccount.id, input);
            toast({
              kind: "success",
              title: "Cargo adicional agregado",
              description: `${input.description} (+${formatCOP(input.amount * (input.quantity ?? 1))})`,
            });
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
                barBranding,
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
              barBranding,
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
