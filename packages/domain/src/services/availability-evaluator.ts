import type {
  Ally,
  ComboTemplate,
  InventoryItem,
  MenuProduct,
  OperatingScheduleSlot,
  ProductPresentation,
} from "../entities/types.js";
import { explodePresentationSale } from "./recipe-exploder.js";

export type UnavailabilityReason =
  | "PRODUCT_DISABLED"
  | "PRESENTATION_DISABLED"
  | "OUT_OF_STOCK"
  | "ALLY_CLOSED"
  | "OUTSIDE_SCHEDULE";

export interface PresentationAvailability {
  presentationId: string;
  available: boolean;
  /** Maximum servings currently possible based on limiting ingredient (null = unlimited / ally-only). */
  maxServings: number | null;
  /** True when maxServings is low (<= 5) so POS can show a helpful amber badge without blocking. */
  isLowStock: boolean;
  reason?: UnavailabilityReason;
  detail?: string;
}

/**
 * Checks if a local "HH:MM" time falls inside [startTime, endTime],
 * naturally handling overnight bar windows (e.g., 18:00 -> 02:00).
 */
export function isWithinTimeWindow(
  currentTimeHHMM: string,
  startTime?: string | null,
  endTime?: string | null,
): boolean {
  if (!startTime || !endTime) return true;
  if (startTime <= endTime) {
    return currentTimeHHMM >= startTime && currentTimeHHMM <= endTime;
  }
  // Overnight window (e.g. 18:00 to 02:00)
  return currentTimeHHMM >= startTime || currentTimeHHMM <= endTime;
}

export function isScheduleOpenAt(
  slots: readonly OperatingScheduleSlot[] | null | undefined,
  isoDayOfWeek: number,
  currentTimeHHMM: string,
  currentDateYYYYMMDD?: string,
): boolean {
  if (!slots || slots.length === 0) return true;
  const prevIsoDay = isoDayOfWeek === 1 ? 7 : isoDayOfWeek - 1;

  for (const slot of slots) {
    if (currentDateYYYYMMDD) {
      if (slot.validFrom && currentDateYYYYMMDD < slot.validFrom) continue;
      if (slot.validUntil && currentDateYYYYMMDD > slot.validUntil) continue;
    }

    const days = slot.daysOfWeek ?? [];
    const appliesToday = days.length === 0 || days.includes(isoDayOfWeek);
    const appliesYesterday = days.length === 0 || days.includes(prevIsoDay);

    if (slot.openTime <= slot.closeTime) {
      // Same-day window (e.g. 12:00 -> 23:00)
      if (appliesToday && currentTimeHHMM >= slot.openTime && currentTimeHHMM <= slot.closeTime) {
        return true;
      }
    } else {
      // Overnight window (e.g. Fri 17:00 -> Sat 03:00)
      if (appliesToday && currentTimeHHMM >= slot.openTime) {
        return true;
      }
      if (appliesYesterday && currentTimeHHMM <= slot.closeTime) {
        return true;
      }
    }
  }

  return false;
}

export function isAllyOpenAt(
  ally: Ally,
  isoDayOfWeek: number,
  currentTimeHHMM: string,
  currentDateYYYYMMDD?: string,
): boolean {
  if (!ally.isActive || ally.isTemporarilyClosed) {
    return false;
  }

  if (ally.operatingSchedules && ally.operatingSchedules.length > 0) {
    return isScheduleOpenAt(ally.operatingSchedules, isoDayOfWeek, currentTimeHHMM, currentDateYYYYMMDD);
  }

  const schedule = ally.operatingSchedule;
  if (!schedule) return true;

  if (schedule.openTime && schedule.closeTime && schedule.openTime > schedule.closeTime) {
    const prevIsoDay = isoDayOfWeek === 1 ? 7 : isoDayOfWeek - 1;
    const days = schedule.daysOfWeek ?? [];
    const appliesToday = days.length === 0 || days.includes(isoDayOfWeek);
    const appliesYesterday = days.length === 0 || days.includes(prevIsoDay);
    return (
      (appliesToday && currentTimeHHMM >= schedule.openTime) ||
      (appliesYesterday && currentTimeHHMM <= schedule.closeTime)
    );
  }

  if (schedule.daysOfWeek && schedule.daysOfWeek.length > 0 && !schedule.daysOfWeek.includes(isoDayOfWeek)) {
    return false;
  }

  return isWithinTimeWindow(currentTimeHHMM, schedule.openTime, schedule.closeTime);
}

export interface MatchedComboOffer {
  template: ComboTemplate;
  finalPrice: number;
  allyName: string | null;
  canFulfill: boolean;
  insufficientReason?: string | null;
}

export function computeComboTemplatePrice(
  template: ComboTemplate,
  presentationSalePrice: number,
): number {
  const baseQty = Math.max(1, Math.trunc(template.baseQuantity ?? 1));
  if (template.pricingMode === "add_on_price") {
    return Math.round((presentationSalePrice * baseQty + template.priceValue) * 100) / 100;
  }
  return Math.round(template.priceValue * 100) / 100;
}

/**
 * Builds the effective presentation recipes for a unified combo sale:
 * - Scales the chosen drink's own recipes by `template.baseQuantity` (preserving foam/pour loss)
 * - Appends any fixed in-house companion ingredients (`template.fixedRecipes`) so BOTH
 *   the dynamically chosen drink and the fixed house food deduct atomically in one ledger pass!
 */
export function buildComboPresentationForExplosion(
  presentation: ProductPresentation,
  template: ComboTemplate,
): ProductPresentation {
  const baseQty = Math.max(1, Math.trunc(template.baseQuantity ?? 1));
  const scaledDrinkRecipes = presentation.recipes.map((rec) => ({
    ...rec,
    displayQuantity: Math.round(rec.displayQuantity * baseQty * 1000) / 1000,
    quantityBase: Math.round(rec.quantityBase * baseQty * 1000) / 1000,
    fixedLossBase: Math.round(rec.fixedLossBase * baseQty * 1000) / 1000,
  }));

  const houseRecipes = (template.fixedRecipes ?? []).map((fr, idx) => ({
    id: `combo-fixed-${template.id}-${idx}`,
    presentationId: presentation.id,
    inventoryItemId: fr.inventoryItemId,
    displayUnit: fr.displayUnit,
    displayQuantity: fr.displayQuantity,
    quantityBase: fr.quantityBase,
    pourLossPercent: 0,
    fixedLossBase: 0,
  }));

  return {
    ...presentation,
    recipes: [...scaledDrinkRecipes, ...houseRecipes],
  };
}

export function getMatchingComboTemplatesForPresentation(params: {
  product: MenuProduct;
  presentation: ProductPresentation;
  comboTemplates: readonly ComboTemplate[];
  alliesById: ReadonlyMap<string, Ally>;
  inventoryById?: ReadonlyMap<string, InventoryItem>;
  presentationMaxServings?: number | null;
  isoDayOfWeek: number;
  currentTimeHHMM: string;
  currentDateYYYYMMDD?: string;
  autoHideClosedAllies?: boolean;
}): MatchedComboOffer[] {
  const {
    product,
    presentation,
    comboTemplates,
    alliesById,
    inventoryById,
    presentationMaxServings,
    isoDayOfWeek,
    currentTimeHHMM,
    currentDateYYYYMMDD,
    autoHideClosedAllies = true,
  } = params;

  const offers: MatchedComboOffer[] = [];
  for (const tpl of comboTemplates) {
    if (!tpl.isActive) continue;
    if (tpl.presentationGroup !== presentation.presentationGroup) continue;
    if (tpl.scopeType === "category" && tpl.targetId !== product.categoryId) continue;
    if (tpl.scopeType === "product" && tpl.targetId !== product.id) continue;

    let allyName: string | null = null;
    if (tpl.allyId) {
      const ally = alliesById.get(tpl.allyId);
      if (ally) {
        allyName = ally.name;
        if (
          autoHideClosedAllies &&
          !isAllyOpenAt(ally, isoDayOfWeek, currentTimeHHMM, currentDateYYYYMMDD)
        ) {
          continue;
        }
      }
    }

    const baseQty = Math.max(1, Math.trunc(tpl.baseQuantity ?? 1));
    let canFulfill = true;
    let insufficientReason: string | null = null;

    if (
      presentationMaxServings !== undefined &&
      presentationMaxServings !== null &&
      presentationMaxServings < baseQty
    ) {
      canFulfill = false;
      insufficientReason = `Requiere ${baseQty}× ${presentation.shortLabel ?? presentation.name}`;
    }

    if (canFulfill && inventoryById && tpl.fixedRecipes && tpl.fixedRecipes.length > 0) {
      for (const fr of tpl.fixedRecipes) {
        const inv = inventoryById.get(fr.inventoryItemId);
        if (inv && inv.currentStockBase + 0.0001 < fr.quantityBase) {
          canFulfill = false;
          insufficientReason = `Sin stock de ${inv.name}`;
          break;
        }
      }
    }

    offers.push({
      template: tpl,
      finalPrice: computeComboTemplatePrice(tpl, presentation.salePrice),
      allyName,
      canFulfill,
      insufficientReason,
    });
  }
  return offers;
}

/**
 * Real-time catalog & inventory synchronization evaluator (runs identically offline in tablets and on server):
 * 1. Prevents selling items whose keg / bottle / recipe ingredients are depleted (accounting for foam loss!).
 *    Example: If an IPA keg has 1,800 ml left -> Jirafa 3L is OUT_OF_STOCK, while Pinta 500 ml still shows 3 left!
 * 2. Automatically hides/blocks third-party ally products & combos once the ally restaurant closes for the night.
 */
export function evaluatePresentationAvailability(params: {
  product: MenuProduct;
  presentation: ProductPresentation;
  inventoryById: ReadonlyMap<string, InventoryItem>;
  alliesById: ReadonlyMap<string, Ally>;
  isoDayOfWeek: number; // 1=Mon .. 7=Sun
  currentTimeHHMM: string; // "HH:MM" in branch timezone
  applyFoamLossFormula?: boolean;
  autoHideClosedAllies?: boolean;
}): PresentationAvailability {
  const {
    product,
    presentation,
    inventoryById,
    alliesById,
    isoDayOfWeek,
    currentTimeHHMM,
    applyFoamLossFormula = true,
    autoHideClosedAllies = true,
  } = params;

  if (!product.isAvailable) {
    return {
      presentationId: presentation.id,
      available: false,
      maxServings: 0,
      isLowStock: false,
      reason: "PRODUCT_DISABLED",
      detail: "Producto desactivado por el administrador",
    };
  }

  if (!presentation.isAvailable) {
    return {
      presentationId: presentation.id,
      available: false,
      maxServings: 0,
      isLowStock: false,
      reason: "PRESENTATION_DISABLED",
      detail: "Presentación desactivada",
    };
  }

  if (!isWithinTimeWindow(currentTimeHHMM, product.availableFrom, product.availableUntil)) {
    return {
      presentationId: presentation.id,
      available: false,
      maxServings: 0,
      isLowStock: false,
      reason: "OUTSIDE_SCHEDULE",
      detail: `Disponible de ${product.availableFrom} a ${product.availableUntil}`,
    };
  }

  // Check third-party ally schedule (for pure ally products OR combos that include an ally)
  const effectiveAllyId = presentation.allyId ?? product.allyId ?? null;
  if (effectiveAllyId && autoHideClosedAllies) {
    const ally = alliesById.get(effectiveAllyId);
    if (!ally || !isAllyOpenAt(ally, isoDayOfWeek, currentTimeHHMM)) {
      return {
        presentationId: presentation.id,
        available: false,
        maxServings: 0,
        isLowStock: false,
        reason: "ALLY_CLOSED",
        detail: ally
          ? `${ally.name} cerrado en este horario`
          : "Aliado no disponible",
      };
    }
  }

  // Pure ally product doesn't depend on bar inventory
  if (product.productKind === "third_party_ally") {
    return {
      presentationId: presentation.id,
      available: true,
      maxServings: null,
      isLowStock: false,
    };
  }

  // Compute exact 1-serving requirement (including foam/pour loss!)
  const singleServing = explodePresentationSale({
    productKind: product.productKind,
    presentation,
    quantity: 1,
    applyFoamLossFormula,
  });

  if (singleServing.deductions.length === 0) {
    return {
      presentationId: presentation.id,
      available: true,
      maxServings: null,
      isLowStock: false,
    };
  }

  let limitingServings = Number.POSITIVE_INFINITY;
  let limitingIngredientName = "";

  for (const deduction of singleServing.deductions) {
    const item = inventoryById.get(deduction.inventoryItemId);
    if (!item || !item.isActive || deduction.totalDeductionBase <= 0) {
      limitingServings = 0;
      limitingIngredientName = item?.name ?? "Insumo";
      break;
    }

    const possible = Math.floor(Math.max(0, item.currentStockBase) / deduction.totalDeductionBase);
    if (possible < limitingServings) {
      limitingServings = possible;
      limitingIngredientName = item.name;
    }
  }

  if (limitingServings <= 0) {
    return {
      presentationId: presentation.id,
      available: false,
      maxServings: 0,
      isLowStock: false,
      reason: "OUT_OF_STOCK",
      detail: `Sin stock suficiente de ${limitingIngredientName}`,
    };
  }

  return {
    presentationId: presentation.id,
    available: true,
    maxServings: limitingServings,
    isLowStock: limitingServings <= 5,
  };
}

