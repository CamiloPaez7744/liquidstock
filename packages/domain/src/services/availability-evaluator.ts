import type {
  Ally,
  InventoryItem,
  MenuProduct,
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

export function isAllyOpenAt(ally: Ally, isoDayOfWeek: number, currentTimeHHMM: string): boolean {
  if (!ally.isActive || ally.isTemporarilyClosed) {
    return false;
  }

  const schedule = ally.operatingSchedule;
  if (!schedule) return true;

  if (schedule.daysOfWeek && schedule.daysOfWeek.length > 0 && !schedule.daysOfWeek.includes(isoDayOfWeek)) {
    return false;
  }

  return isWithinTimeWindow(currentTimeHHMM, schedule.openTime, schedule.closeTime);
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

