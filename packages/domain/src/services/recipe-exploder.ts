import type { ProductKind, ProductPresentation } from "../entities/types.js";
import { Money } from "../value-objects/money.js";
import { calculatePourDeduction } from "../value-objects/units.js";

export interface InventoryDeductionLine {
  inventoryItemId: string;
  nominalQuantityBase: number;
  pourLossQuantityBase: number;
  totalDeductionBase: number;
}

export interface PresentationExplosionResult {
  deductions: InventoryDeductionLine[];
  allyId: string | null;
  totalAllyPayout: number;
  affectsBarInventory: boolean;
}

/**
 * Explodes any sold presentation (craft beer pinta/jirafa, liquor shot, multi-ingredient cocktail,
 * mixed combo with ally food, or pure third-party ally item) into exact inventory ledger deltas
 * and ally settlement payouts.
 *
 * Rule:
 * - Pure `third_party_ally` products NEVER touch bar inventory, only record ally payout.
 * - `combo` products can both deduct bar recipes (e.g. Jirafa 3L) AND record an ally payout (e.g. Wings from neighbor).
 */
export function explodePresentationSale(params: {
  productKind: ProductKind;
  presentation: ProductPresentation;
  quantity: number;
  applyFoamLossFormula?: boolean;
}): PresentationExplosionResult {
  const { productKind, presentation, quantity, applyFoamLossFormula = true } = params;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Sale quantity must be a positive integer, got: ${quantity}`);
  }

  const totalAllyPayout =
    presentation.allyId && presentation.allyPayoutAmount > 0
      ? Money.fromMajor(presentation.allyPayoutAmount).multiply(quantity).toMajor()
      : 0;

  // Pure third-party ally items never affect bar inventory
  if (productKind === "third_party_ally") {
    return {
      deductions: [],
      allyId: presentation.allyId ?? null,
      totalAllyPayout,
      affectsBarInventory: false,
    };
  }

  // Aggregate deductions by inventoryItemId in case a combo references the same liquor twice
  const aggregated = new Map<string, InventoryDeductionLine>();

  for (const ingredient of presentation.recipes) {
    const pour = calculatePourDeduction({
      nominalQuantityBase: ingredient.quantityBase,
      servings: quantity,
      pourLossPercent: applyFoamLossFormula ? ingredient.pourLossPercent : 0,
      fixedLossPerServingBase: applyFoamLossFormula ? ingredient.fixedLossBase : 0,
    });

    const existing = aggregated.get(ingredient.inventoryItemId);
    if (existing) {
      existing.nominalQuantityBase = Math.round((existing.nominalQuantityBase + pour.nominalTotalBase) * 1000) / 1000;
      existing.pourLossQuantityBase =
        Math.round((existing.pourLossQuantityBase + pour.pourLossTotalBase) * 1000) / 1000;
      existing.totalDeductionBase =
        Math.round((existing.totalDeductionBase + pour.realDeductionTotalBase) * 1000) / 1000;
    } else {
      aggregated.set(ingredient.inventoryItemId, {
        inventoryItemId: ingredient.inventoryItemId,
        nominalQuantityBase: pour.nominalTotalBase,
        pourLossQuantityBase: pour.pourLossTotalBase,
        totalDeductionBase: pour.realDeductionTotalBase,
      });
    }
  }

  const deductions = Array.from(aggregated.values());

  return {
    deductions,
    allyId: presentation.allyId ?? null,
    totalAllyPayout,
    affectsBarInventory: deductions.length > 0,
  };
}

