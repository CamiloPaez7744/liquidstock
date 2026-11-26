import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  buildComboPresentationForExplosion,
  computeComboTemplatePrice,
  DEFAULT_BRANCH_FEATURE_FLAGS,
  evaluateLinePromotion,
  evaluateSubAccountPromotion,
  explodePresentationSale,
  generateUuidV7,
  isPromotionEligibleAt,
  type Ally,
  type Branch,
  type ComboTemplate,
  type Customer,
  type InventoryItem,
  type MenuCategory,
  type MenuProduct,
  type OrderItemLine,
  type PaymentMethod,
  type ProductPresentation,
  type PromotionRule,
  type PurchasePresentation,
} from "@liquistock/domain";
import { apiFetch } from "../api/api-client.js";
import {
  enqueueOfflineCommand,
  localDb,
  type LocalBranchUser,
  type LocalDiningTable,
  type LocalSubAccount,
  type LocalTableSession,
} from "../storage/dexie/db.js";
import { syncEngine } from "./sync-engine.js";
import { getCurrentIsoDayAndTime } from "../../shared/lib/format.js";

export interface ActiveShiftSnapshot {
  id: string;
  openingFloat: number;
  expectedOpeningFloat?: number;
  openingDiscrepancy?: number;
  openedAt: string;
  status: string;
  hoursOpen?: number;
  isExpired24h?: boolean;
}

interface BootstrapResponse {
  serverTime: string;
  branch: Branch;
  users: LocalBranchUser[];
  diningTables: LocalDiningTable[];
  activeShift: ActiveShiftSnapshot | null;
  lastClosedCashLeft?: number;
  categories: MenuCategory[];
  menuProducts: MenuProduct[];
  presentations: ProductPresentation[];
  inventoryItems: InventoryItem[];
  purchasePresentations: PurchasePresentation[];
  allies: Ally[];
  customers: Customer[];
  paymentMethods: PaymentMethod[];
  treasuryAccounts?: PaymentMethod[];
  promotionRules: PromotionRule[];
  comboTemplates?: ComboTemplate[];
  openTableSessions: LocalTableSession[];
  openSubAccounts: LocalSubAccount[];
  openOrderItems: OrderItemLine[];
}

async function recalcLocalSubAccount(subAccountId: string): Promise<void> {
  const items = await localDb.orderItems
    .where("subAccountId")
    .equals(subAccountId)
    .filter((i) => i.status === "active")
    .toArray();

  const subtotal = items.reduce((acc, i) => acc + i.unitPriceSnap * i.quantity, 0);
  const discount = items.reduce((acc, i) => acc + i.discountAmount, 0);
  const total = items.reduce((acc, i) => acc + i.lineTotal, 0);

  await localDb.subAccounts.update(subAccountId, {
    subtotalAmount: subtotal,
    discountAmount: discount,
    totalAmount: total,
    updatedAt: new Date().toISOString(),
  });
}

export function useLiquiStock(branchId: string, authenticatedUserId: string) {
  const [loading, setLoading] = useState(true);
  const activeUserId = authenticatedUserId;
  const [lastHydratedAt, setLastHydratedAt] = useState<string | null>(null);
  const [activeShift, setActiveShift] = useState<ActiveShiftSnapshot | null>(null);
  const [lastClosedCashLeft, setLastClosedCashLeft] = useState<number>(0);

  const hydrateFromServer = useCallback(async () => {
    try {
      // Flush pending local commands BEFORE pulling server snapshot so local drafts win
      await syncEngine.flushOutbox(branchId);
      const pending = await syncEngine.refreshPendingCount();

      const data = await apiFetch<BootstrapResponse>(`/api/v1/branches/${branchId}/bootstrap`);
      setActiveShift(data.activeShift ?? null);
      setLastClosedCashLeft(Number(data.lastClosedCashLeft ?? 0));

      await localDb.transaction(
        "rw",
        [
          localDb.branches,
          localDb.branchUsers,
          localDb.diningTables,
          localDb.categories,
          localDb.menuProducts,
          localDb.presentations,
          localDb.inventoryItems,
          localDb.purchasePresentations,
          localDb.allies,
          localDb.customers,
          localDb.paymentMethods,
          localDb.treasuryAccounts,
          localDb.promotionRules,
          localDb.comboTemplates,
          localDb.tableSessions,
          localDb.subAccounts,
          localDb.orderItems,
        ],
        async () => {
          await localDb.branches.put(data.branch);
          await localDb.branchUsers.clear();
          await localDb.branchUsers.bulkPut(data.users);
          await localDb.diningTables.where("branchId").equals(branchId).delete();
          await localDb.diningTables.bulkPut(data.diningTables);
          await localDb.categories.where("branchId").equals(branchId).delete();
          await localDb.categories.bulkPut(data.categories);
          await localDb.menuProducts.where("branchId").equals(branchId).delete();
          await localDb.menuProducts.bulkPut(data.menuProducts);
          await localDb.presentations.where("branchId").equals(branchId).delete();
          await localDb.presentations.bulkPut(data.presentations);
          await localDb.inventoryItems.where("branchId").equals(branchId).delete();
          await localDb.inventoryItems.bulkPut(data.inventoryItems);
          await localDb.purchasePresentations.clear();
          await localDb.purchasePresentations.bulkPut(data.purchasePresentations);
          await localDb.allies.where("branchId").equals(branchId).delete();
          await localDb.allies.bulkPut(data.allies);
          await localDb.customers.where("branchId").equals(branchId).delete();
          await localDb.customers.bulkPut(data.customers);
          await localDb.paymentMethods.where("branchId").equals(branchId).delete();
          await localDb.paymentMethods.bulkPut(data.paymentMethods);
          await localDb.treasuryAccounts.where("branchId").equals(branchId).delete();
          await localDb.treasuryAccounts.bulkPut(data.treasuryAccounts ?? data.paymentMethods);
          await localDb.promotionRules.where("branchId").equals(branchId).delete();
          await localDb.promotionRules.bulkPut(data.promotionRules);
          await localDb.comboTemplates.where("branchId").equals(branchId).delete();
          await localDb.comboTemplates.bulkPut(data.comboTemplates ?? []);

          // Only replace open tables/orders when outbox is clean to avoid overwriting offline drafts
          if (pending === 0) {
            await localDb.tableSessions.where("branchId").equals(branchId).delete();
            await localDb.tableSessions.bulkPut(data.openTableSessions);
            await localDb.subAccounts.where("branchId").equals(branchId).delete();
            await localDb.subAccounts.bulkPut(data.openSubAccounts);
            await localDb.orderItems.clear();
            await localDb.orderItems.bulkPut(data.openOrderItems);
          }
        },
      );
      setLastHydratedAt(data.serverTime);
    } catch {
      // Offline mode: IndexedDB already has cached catalog & open orders!
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void hydrateFromServer();
    const unsubRemote = syncEngine.onRemoteChange((eventType) => {
      if (eventType === "OPERATIONS_PURGED") {
        void (async () => {
          await localDb.transaction(
            "rw",
            [localDb.syncOutbox, localDb.tableSessions, localDb.subAccounts, localDb.orderItems],
            async () => {
              await localDb.syncOutbox.where("branchId").equals(branchId).delete();
              await localDb.tableSessions.where("branchId").equals(branchId).delete();
              await localDb.subAccounts.where("branchId").equals(branchId).delete();
              await localDb.orderItems.clear();
            },
          );
          await syncEngine.refreshPendingCount();
          await hydrateFromServer();
        })();
        return;
      }
      void hydrateFromServer();
    });
    return unsubRemote;
  }, [branchId, hydrateFromServer]);

  const branch = useLiveQuery(() => localDb.branches.get(branchId), [branchId]);
  const users = useLiveQuery(() => localDb.branchUsers.toArray(), []) ?? [];
  const diningTables =
    useLiveQuery(
      () => localDb.diningTables.where("branchId").equals(branchId).sortBy("sortOrder"),
      [branchId],
    ) ?? [];
  const categories =
    useLiveQuery(
      () => localDb.categories.where("branchId").equals(branchId).sortBy("sortOrder"),
      [branchId],
    ) ?? [];
  const menuProducts =
    useLiveQuery(
      () => localDb.menuProducts.where("branchId").equals(branchId).sortBy("sortOrder"),
      [branchId],
    ) ?? [];
  const presentations =
    useLiveQuery(
      () => localDb.presentations.where("branchId").equals(branchId).sortBy("sortOrder"),
      [branchId],
    ) ?? [];
  const inventoryItems =
    useLiveQuery(
      () => localDb.inventoryItems.where("branchId").equals(branchId).toArray(),
      [branchId],
    ) ?? [];
  const purchasePresentations =
    useLiveQuery(() => localDb.purchasePresentations.toArray(), []) ?? [];
  const allies =
    useLiveQuery(() => localDb.allies.where("branchId").equals(branchId).toArray(), [branchId]) ?? [];
  const customers =
    useLiveQuery(
      () => localDb.customers.where("branchId").equals(branchId).sortBy("fullName"),
      [branchId],
    ) ?? [];
  const paymentMethods =
    useLiveQuery(
      () => localDb.paymentMethods.where("branchId").equals(branchId).sortBy("sortOrder"),
      [branchId],
    ) ?? [];
  const treasuryAccounts =
    useLiveQuery(
      () => localDb.treasuryAccounts.where("branchId").equals(branchId).sortBy("sortOrder"),
      [branchId],
    ) ?? [];
  const promotionRules =
    useLiveQuery(
      () => localDb.promotionRules.where("branchId").equals(branchId).sortBy("priority"),
      [branchId],
    ) ?? [];
  const comboTemplates =
    useLiveQuery(
      () => localDb.comboTemplates.where("branchId").equals(branchId).toArray(),
      [branchId],
    ) ?? [];
  const tableSessions =
    useLiveQuery(
      () =>
        localDb.tableSessions
          .where("branchId")
          .equals(branchId)
          .filter((s) => s.status === "open")
          .toArray(),
      [branchId],
    ) ?? [];
  const subAccounts =
    useLiveQuery(
      () => localDb.subAccounts.where("branchId").equals(branchId).toArray(),
      [branchId],
    ) ?? [];
  const orderItems =
    useLiveQuery(
      () => localDb.orderItems.filter((i) => i.status === "active").toArray(),
      [],
    ) ?? [];

  const featureFlags = branch?.featureFlags ?? DEFAULT_BRANCH_FEATURE_FLAGS;

  // === LOCAL-FIRST ATOMIC POS COMMANDS (<16ms UI + IndexedDB Outbox + Async Sync) ===

  const openTableSession = useCallback(
    async (diningTableId: string | null, label = "Cuenta 1", description?: string | null) => {
      const tableSessionId = generateUuidV7();
      const subAccountId = generateUuidV7();
      const nowIso = new Date().toISOString();
      const cleanLabel = label.trim() || "Cuenta 1";
      const cleanDesc = description?.trim() || null;

      await localDb.transaction(
        "rw",
        [localDb.tableSessions, localDb.subAccounts, localDb.syncOutbox],
        async () => {
          await localDb.tableSessions.put({
            id: tableSessionId,
            branchId,
            diningTableId,
            cashShiftId: "local-active",
            status: "open",
            openedAt: nowIso,
          });
          await localDb.subAccounts.put({
            id: subAccountId,
            branchId,
            tableSessionId,
            label: cleanLabel,
            description: cleanDesc,
            status: "open",
            subtotalAmount: 0,
            discountAmount: 0,
            totalAmount: 0,
            paidAmount: 0,
            creditAmount: 0,
            version: 1,
            updatedAt: nowIso,
          });
          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "OPEN_TABLE_SESSION",
            payload: {
              tableSessionId,
              diningTableId,
              subAccountId,
              label: cleanLabel,
              description: cleanDesc,
            },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
      return { tableSessionId, subAccountId };
    },
    [branchId, activeUserId],
  );

  const createSubAccount = useCallback(
    async (tableSessionId: string, label: string, description?: string | null) => {
      const subAccountId = generateUuidV7();
      const nowIso = new Date().toISOString();
      const cleanLabel = label.trim() || "Cuenta nueva";
      const cleanDesc = description?.trim() || null;

      await localDb.transaction("rw", [localDb.subAccounts, localDb.syncOutbox], async () => {
        await localDb.subAccounts.put({
          id: subAccountId,
          branchId,
          tableSessionId,
          label: cleanLabel,
          description: cleanDesc,
          status: "open",
          subtotalAmount: 0,
          discountAmount: 0,
          totalAmount: 0,
          paidAmount: 0,
          creditAmount: 0,
          version: 1,
          updatedAt: nowIso,
        });
        await enqueueOfflineCommand({
          branchId,
          userId: activeUserId,
          commandType: "CREATE_SUB_ACCOUNT",
          payload: { subAccountId, tableSessionId, label: cleanLabel, description: cleanDesc },
        });
      });

      void syncEngine.flushOutbox(branchId);
      return subAccountId;
    },
    [branchId, activeUserId],
  );

  const updateSubAccount = useCallback(
    async (subAccountId: string, patch: { label?: string; description?: string | null }) => {
      const sub = await localDb.subAccounts.get(subAccountId);
      if (!sub) return;
      const cleanLabel = patch.label !== undefined ? patch.label.trim() || sub.label : sub.label;
      const hasDesc = "description" in patch;
      const cleanDesc = hasDesc ? (patch.description?.trim() || null) : (sub.description ?? null);

      await localDb.transaction("rw", [localDb.subAccounts, localDb.syncOutbox], async () => {
        await localDb.subAccounts.update(subAccountId, {
          label: cleanLabel,
          description: cleanDesc,
          version: sub.version + 1,
          updatedAt: new Date().toISOString(),
        });
        await enqueueOfflineCommand({
          branchId,
          userId: activeUserId,
          commandType: "UPDATE_SUB_ACCOUNT",
          payload: {
            subAccountId,
            label: cleanLabel,
            ...(hasDesc ? { description: cleanDesc } : {}),
          },
        });
      });

      void syncEngine.flushOutbox(branchId);
    },
    [branchId, activeUserId],
  );

  const deleteSubAccount = useCallback(
    async (
      subAccountId: string,
      options?: {
        mode?: "empty_only" | "move_items" | "void_items";
        targetSubAccountId?: string | null;
        reason?: string;
      },
    ) => {
      const sub = await localDb.subAccounts.get(subAccountId);
      if (!sub || sub.status !== "open") return;
      if (sub.paidAmount > 0 || sub.creditAmount > 0) {
        throw new Error(
          "Esta cuenta ya tiene abonos o fiado registrados. Debes finalizar el cobro antes de cerrarla.",
        );
      }

      const mode = options?.mode ?? "empty_only";
      const targetSubAccountId = options?.targetSubAccountId ?? null;
      const reason = options?.reason ?? "Cuenta eliminada en POS";

      await localDb.transaction(
        "rw",
        [
          localDb.subAccounts,
          localDb.tableSessions,
          localDb.orderItems,
          localDb.inventoryItems,
          localDb.presentations,
          localDb.syncOutbox,
        ],
        async () => {
          const activeItems = await localDb.orderItems
            .where("subAccountId")
            .equals(subAccountId)
            .filter((i) => i.status === "active")
            .toArray();

          if (activeItems.length > 0) {
            if (mode === "move_items" && targetSubAccountId && targetSubAccountId !== subAccountId) {
              for (const item of activeItems) {
                await localDb.orderItems.update(item.id, { subAccountId: targetSubAccountId });
              }
              await recalcLocalSubAccount(targetSubAccountId);
            } else if (mode === "void_items") {
              for (const item of activeItems) {
                await localDb.orderItems.update(item.id, { status: "voided" });
                const pres = item.presentationId
                  ? await localDb.presentations.get(item.presentationId)
                  : undefined;
                if (pres) {
                  const explosion = explodePresentationSale({
                    productKind: item.productKindSnap,
                    presentation: pres,
                    quantity: item.quantity,
                    applyFoamLossFormula: featureFlags.enableFoamLossFormula,
                  });
                  for (const d of explosion.deductions) {
                    const inv = await localDb.inventoryItems.get(d.inventoryItemId);
                    if (inv) {
                      await localDb.inventoryItems.update(inv.id, {
                        currentStockBase:
                          Math.round((inv.currentStockBase + d.totalDeductionBase) * 1000) / 1000,
                      });
                    }
                  }
                }
              }
            } else {
              throw new Error("Esta cuenta aún tiene productos activos.");
            }
          }

          await localDb.subAccounts.update(subAccountId, {
            status: "voided",
            subtotalAmount: 0,
            discountAmount: 0,
            totalAmount: 0,
            updatedAt: new Date().toISOString(),
          });

          const openSiblings = await localDb.subAccounts
            .where("tableSessionId")
            .equals(sub.tableSessionId)
            .filter((s) => s.status === "open")
            .count();
          if (openSiblings === 0) {
            await localDb.tableSessions.update(sub.tableSessionId, { status: "closed" });
          }

          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "DELETE_SUB_ACCOUNT",
            payload: {
              subAccountId,
              mode,
              targetSubAccountId,
              reason,
            },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
    },
    [branchId, activeUserId, featureFlags.enableFoamLossFormula],
  );

  const addOrderItem = useCallback(
    async (
      subAccountId: string,
      product: MenuProduct,
      presentation: ProductPresentation,
      quantity = 1,
      forcedPromotionRuleId?: string | null,
      comboTemplate?: ComboTemplate | null,
    ) => {
      const orderItemId = generateUuidV7();
      const { isoDay, hhmm, yyyymmdd } = getCurrentIsoDayAndTime();
      const unitPrice = comboTemplate
        ? computeComboTemplatePrice(comboTemplate, presentation.salePrice)
        : presentation.salePrice;
      const comboBaseQty = Math.max(1, comboTemplate?.baseQuantity ?? 1);
      const effectivePresentationName = comboTemplate
        ? `${comboBaseQty > 1 ? `${comboBaseQty}× ` : ""}${presentation.name} + ${comboTemplate.shortLabel || comboTemplate.name}`
        : presentation.name;
      const effectiveProductKind = comboTemplate ? "combo" : product.productKind;
      const effectiveAllyId = comboTemplate?.allyId ?? presentation.allyId ?? product.allyId ?? null;
      const effectiveAllyPayout = comboTemplate?.allyId
        ? comboTemplate.allyPayoutAmount
        : presentation.allyPayoutAmount;

      const promoRes =
        !comboTemplate && featureFlags.enablePromotions
          ? evaluateLinePromotion({
              line: {
                categoryId: product.categoryId,
                menuProductId: product.id,
                presentationId: presentation.id,
                presentationGroup: presentation.presentationGroup,
                unitPrice,
                quantity,
              },
              rules: promotionRules,
              isoDayOfWeek: isoDay,
              currentTimeHHMM: hhmm,
              currentDateYYYYMMDD: yyyymmdd,
              forcedRuleId: forcedPromotionRuleId ?? null,
            })
          : {
              promotionRuleId: null,
              discountAmount: 0,
              netTotal: unitPrice * quantity,
            };

      const basePresForExplosion: ProductPresentation = {
        ...presentation,
        salePrice: unitPrice,
        allyId: effectiveAllyId,
        allyPayoutAmount: effectiveAllyPayout,
      };
      const explosion = explodePresentationSale({
        productKind: effectiveProductKind,
        presentation: comboTemplate
          ? buildComboPresentationForExplosion(basePresForExplosion, comboTemplate)
          : basePresForExplosion,
        quantity,
        applyFoamLossFormula: featureFlags.enableFoamLossFormula,
      });

      const manualRuleIds = new Set(
        promotionRules
          .filter((r) => (r.applicationMode ?? "automatic") === "manual_at_checkout")
          .map((r) => r.id),
      );

      await localDb.transaction(
        "rw",
        [localDb.orderItems, localDb.subAccounts, localDb.inventoryItems, localDb.syncOutbox],
        async () => {
          await localDb.orderItems.put({
            id: orderItemId,
            subAccountId,
            menuProductId: product.id,
            presentationId: presentation.id,
            categoryId: product.categoryId,
            productNameSnap: product.name,
            presentationNameSnap: effectivePresentationName,
            presentationGroupSnap: presentation.presentationGroup,
            productKindSnap: effectiveProductKind,
            quantity,
            unitPriceSnap: unitPrice,
            allyIdSnap: effectiveAllyId,
            allyPayoutSnap: effectiveAllyPayout,
            promotionRuleId: promoRes.promotionRuleId,
            discountAmount: promoRes.discountAmount,
            lineTotal: promoRes.netTotal,
            adjustmentReason: comboTemplate ? `Combo: ${comboTemplate.name}` : null,
            status: "active",
          });

          // Re-evaluate accumulated automatic sub-account rules locally (e.g. 10+1 gratis across rounds)
          if (featureFlags.enablePromotions) {
            const eligibleAccum = promotionRules.filter(
              (r) =>
                (r.applicationMode ?? "automatic") === "automatic" &&
                (r.ruleType === "bxgy" || (r.config.minQuantity ?? 1) > 1) &&
                isPromotionEligibleAt(r, {
                  isoDayOfWeek: isoDay,
                  currentTimeHHMM: hhmm,
                  currentDateYYYYMMDD: yyyymmdd,
                }),
            );

            if (eligibleAccum.length > 0) {
              const activeItems = await localDb.orderItems
                .where("subAccountId")
                .equals(subAccountId)
                .filter(
                  (i) =>
                    i.status === "active" &&
                    !i.adjustmentReason &&
                    Boolean(i.menuProductId && i.presentationId && i.categoryId) &&
                    !(i.promotionRuleId && manualRuleIds.has(i.promotionRuleId)),
                )
                .toArray();
              const lineInputs = activeItems.map((i) => ({
                id: i.id,
                categoryId: i.categoryId!,
                menuProductId: i.menuProductId!,
                presentationId: i.presentationId!,
                presentationGroup: i.presentationGroupSnap,
                unitPrice: i.unitPriceSnap,
                quantity: i.quantity,
              }));
              for (const rule of eligibleAccum) {
                const preview = evaluateSubAccountPromotion(rule, lineInputs);
                for (const alloc of preview.allocations) {
                  const target = activeItems.find((i) => i.id === alloc.lineId);
                  if (target && alloc.discountAmount >= target.discountAmount) {
                    await localDb.orderItems.update(alloc.lineId, {
                      promotionRuleId: alloc.promotionRuleId,
                      discountAmount: alloc.discountAmount,
                      lineTotal: alloc.netTotal,
                    });
                  }
                }
              }
            }
          }

          // Optimistically deduct local inventory immediately so keg stock & out-of-stock syncs in <16ms!
          for (const d of explosion.deductions) {
            const inv = await localDb.inventoryItems.get(d.inventoryItemId);
            if (inv) {
              await localDb.inventoryItems.update(inv.id, {
                currentStockBase: Math.round((inv.currentStockBase - d.totalDeductionBase) * 1000) / 1000,
              });
            }
          }

          await recalcLocalSubAccount(subAccountId);

          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "ADD_ORDER_ITEM",
            payload: {
              orderItemId,
              subAccountId,
              presentationId: presentation.id,
              quantity,
              ...(forcedPromotionRuleId ? { forcedPromotionRuleId } : {}),
              ...(comboTemplate ? { comboTemplateId: comboTemplate.id } : {}),
            },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
      return orderItemId;
    },
    [branchId, activeUserId, featureFlags, promotionRules],
  );

  const addCustomCharge = useCallback(
    async (
      subAccountId: string,
      input: {
        description: string;
        amount: number;
        categoryLabel?: string;
        quantity?: number;
      },
    ) => {
      const orderItemId = generateUuidV7();
      const description = input.description.trim();
      const categoryLabel = input.categoryLabel?.trim() || "Cargo adicional";
      const quantity = Math.max(1, Math.round(input.quantity ?? 1));
      const unitAmount = Math.round(input.amount * 100) / 100;
      if (!description || !Number.isFinite(unitAmount) || unitAmount <= 0) return null;
      const lineTotal = Math.round(unitAmount * quantity * 100) / 100;

      await localDb.transaction(
        "rw",
        [localDb.orderItems, localDb.subAccounts, localDb.syncOutbox],
        async () => {
          await localDb.orderItems.put({
            id: orderItemId,
            subAccountId,
            menuProductId: null,
            presentationId: null,
            categoryId: null,
            productNameSnap: description,
            presentationNameSnap: categoryLabel,
            presentationGroupSnap: "otro",
            productKindSnap: "standard",
            quantity,
            unitPriceSnap: unitAmount,
            allyIdSnap: null,
            allyPayoutSnap: 0,
            promotionRuleId: null,
            discountAmount: 0,
            lineTotal,
            adjustmentReason: categoryLabel,
            status: "active",
          });

          await recalcLocalSubAccount(subAccountId);

          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "ADD_CUSTOM_CHARGE",
            payload: {
              orderItemId,
              subAccountId,
              description,
              categoryLabel,
              amount: unitAmount,
              quantity,
            },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
      return orderItemId;
    },
    [branchId, activeUserId],
  );

  const renameDiningTable = useCallback(
    async (tableId: string, label: string) => {
      const cleaned = label.trim();
      if (!cleaned) throw new Error("Escribe un nombre para la mesa.");
      const updated = await apiFetch<{ id: string; label: string; zone: string }>(
        `/api/v1/branches/${branchId}/tables/${tableId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ label: cleaned }),
        },
      );
      await localDb.diningTables.update(tableId, { label: updated.label });
      return updated;
    },
    [branchId],
  );

  const voidOrderItem = useCallback(
    async (orderItemId: string, reason = "Anulado en POS") => {
      const item = await localDb.orderItems.get(orderItemId);
      if (!item) return;

      const pres = item.presentationId ? await localDb.presentations.get(item.presentationId) : undefined;

      await localDb.transaction(
        "rw",
        [localDb.orderItems, localDb.subAccounts, localDb.inventoryItems, localDb.syncOutbox],
        async () => {
          await localDb.orderItems.update(orderItemId, { status: "voided" });

          // Restore local stock immediately
          if (pres) {
            const explosion = explodePresentationSale({
              productKind: item.productKindSnap,
              presentation: pres,
              quantity: item.quantity,
              applyFoamLossFormula: featureFlags.enableFoamLossFormula,
            });
            for (const d of explosion.deductions) {
              const inv = await localDb.inventoryItems.get(d.inventoryItemId);
              if (inv) {
                await localDb.inventoryItems.update(inv.id, {
                  currentStockBase:
                    Math.round((inv.currentStockBase + d.totalDeductionBase) * 1000) / 1000,
                });
              }
            }
          }

          await recalcLocalSubAccount(item.subAccountId);

          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "VOID_ORDER_ITEM",
            payload: { orderItemId, reason },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
    },
    [branchId, activeUserId, featureFlags],
  );

  const moveOrderItem = useCallback(
    async (orderItemId: string, toSubAccountId: string) => {
      const item = await localDb.orderItems.get(orderItemId);
      if (!item || item.subAccountId === toSubAccountId) return;
      const fromSubAccountId = item.subAccountId;

      await localDb.transaction(
        "rw",
        [localDb.orderItems, localDb.subAccounts, localDb.syncOutbox],
        async () => {
          await localDb.orderItems.update(orderItemId, { subAccountId: toSubAccountId });
          await recalcLocalSubAccount(fromSubAccountId);
          await recalcLocalSubAccount(toSubAccountId);

          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "MOVE_ORDER_ITEM",
            payload: { orderItemId, toSubAccountId },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
    },
    [branchId, activeUserId],
  );

  const adjustOrderItemPrice = useCallback(
    async (orderItemId: string, newLineTotal: number, reason: string) => {
      const item = await localDb.orderItems.get(orderItemId);
      if (!item) return;

      const gross = item.unitPriceSnap * item.quantity;
      const clampedNet = Math.max(0, Math.min(gross, Math.round(newLineTotal)));
      const discount = Math.max(0, gross - clampedNet);

      await localDb.transaction(
        "rw",
        [localDb.orderItems, localDb.subAccounts, localDb.syncOutbox],
        async () => {
          await localDb.orderItems.update(orderItemId, {
            discountAmount: discount,
            lineTotal: clampedNet,
            adjustmentReason: reason,
          });
          await recalcLocalSubAccount(item.subAccountId);

          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "ADJUST_ORDER_ITEM_PRICE",
            payload: { orderItemId, newLineTotal: clampedNet, reason },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
    },
    [branchId, activeUserId],
  );

  const applyPromotionToSubAccount = useCallback(
    async (subAccountId: string, rule: PromotionRule) => {
      await localDb.transaction(
        "rw",
        [localDb.orderItems, localDb.subAccounts, localDb.syncOutbox],
        async () => {
          const activeItems = await localDb.orderItems
            .where("subAccountId")
            .equals(subAccountId)
            .filter(
              (i) =>
                i.status === "active" &&
                !i.adjustmentReason &&
                Boolean(i.menuProductId && i.presentationId && i.categoryId),
            )
            .toArray();
          const preview = evaluateSubAccountPromotion(
            rule,
            activeItems.map((i) => ({
              id: i.id,
              categoryId: i.categoryId!,
              menuProductId: i.menuProductId!,
              presentationId: i.presentationId!,
              presentationGroup: i.presentationGroupSnap,
              unitPrice: i.unitPriceSnap,
              quantity: i.quantity,
            })),
          );

          for (const alloc of preview.allocations) {
            const target = activeItems.find((i) => i.id === alloc.lineId);
            if (target && alloc.discountAmount >= target.discountAmount) {
              await localDb.orderItems.update(alloc.lineId, {
                promotionRuleId: alloc.promotionRuleId,
                discountAmount: alloc.discountAmount,
                lineTotal: alloc.netTotal,
              });
            }
          }

          await recalcLocalSubAccount(subAccountId);

          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "APPLY_PROMOTION_TO_SUB_ACCOUNT",
            payload: { subAccountId, promotionRuleId: rule.id },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
    },
    [branchId, activeUserId],
  );

  const recordPayment = useCallback(
    async (subAccountId: string, paymentMethodId: string, amount: number) => {
      const paymentId = generateUuidV7();
      const sub = await localDb.subAccounts.get(subAccountId);
      if (!sub) return;

      const nextPaid = sub.paidAmount + amount;
      const settled = nextPaid + sub.creditAmount >= sub.totalAmount - 0.01;

      await localDb.transaction(
        "rw",
        [localDb.subAccounts, localDb.tableSessions, localDb.syncOutbox],
        async () => {
          await localDb.subAccounts.update(subAccountId, {
            paidAmount: nextPaid,
            status: settled ? (sub.creditAmount > 0 ? "partial_credit" : "paid") : sub.status,
            updatedAt: new Date().toISOString(),
          });

          if (settled) {
            const openSiblings = await localDb.subAccounts
              .where("tableSessionId")
              .equals(sub.tableSessionId)
              .filter((s) => s.status === "open")
              .count();
            if (openSiblings === 0) {
              await localDb.tableSessions.update(sub.tableSessionId, { status: "closed" });
            }
          }

          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "RECORD_PAYMENT",
            payload: {
              paymentId,
              subAccountId,
              paymentMethodId,
              paymentPurpose: "sale_payment",
              amount,
            },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
    },
    [branchId, activeUserId],
  );

  const chargeCredit = useCallback(
    async (subAccountId: string, customerId: string, amount: number, adminOverride = false) => {
      const sub = await localDb.subAccounts.get(subAccountId);
      const cust = await localDb.customers.get(customerId);
      if (!sub || !cust) return;

      await localDb.transaction(
        "rw",
        [localDb.subAccounts, localDb.customers, localDb.tableSessions, localDb.syncOutbox],
        async () => {
          await localDb.customers.update(customerId, {
            currentDebt: cust.currentDebt + amount,
          });
          await localDb.subAccounts.update(subAccountId, {
            customerId,
            creditAmount: sub.creditAmount + amount,
            status: sub.paidAmount > 0 ? "partial_credit" : "credit",
            updatedAt: new Date().toISOString(),
          });

          const openSiblings = await localDb.subAccounts
            .where("tableSessionId")
            .equals(sub.tableSessionId)
            .filter((s) => s.status === "open")
            .count();
          if (openSiblings === 0) {
            await localDb.tableSessions.update(sub.tableSessionId, { status: "closed" });
          }

          await enqueueOfflineCommand({
            branchId,
            userId: activeUserId,
            commandType: "CHARGE_SUB_ACCOUNT_CREDIT",
            payload: { subAccountId, customerId, amount, adminOverride },
          });
        },
      );

      void syncEngine.flushOutbox(branchId);
    },
    [branchId, activeUserId],
  );

  return {
    loading,
    branch,
    featureFlags,
    users,
    activeUserId,
    diningTables,
    categories,
    menuProducts,
    presentations,
    inventoryItems,
    purchasePresentations,
    allies,
    customers,
    paymentMethods,
    treasuryAccounts,
    promotionRules,
    comboTemplates,
    activeShift,
    lastClosedCashLeft,
    tableSessions,
    subAccounts,
    orderItems,
    lastHydratedAt,
    refresh: hydrateFromServer,
    openTableSession,
    createSubAccount,
    updateSubAccount,
    deleteSubAccount,
    addOrderItem,
    addCustomCharge,
    renameDiningTable,
    voidOrderItem,
    moveOrderItem,
    adjustOrderItemPrice,
    applyPromotionToSubAccount,
    recordPayment,
    chargeCredit,
  };
}

