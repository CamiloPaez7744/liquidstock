export type BaseUnit = "ml" | "g" | "unit";
export type DisplayUnit = "ml" | "oz" | "L" | "g" | "kg" | "unit";

/** US fluid ounce to milliliters (bar industry standard). */
export const ML_PER_FLUID_OZ = 29.5735;
export const ML_PER_LITER = 1000;
export const G_PER_KG = 1000;

/** Rounds base quantities to 3 decimal places matching PostgreSQL numeric(14, 3). */
export function roundBaseQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Converts a display unit quantity (e.g., 1.5 oz, 3 L jirafa, 30 L keg, 500 ml pinta)
 * into the canonical base unit stored in inventory_items & inventory_ledger.
 */
export function convertToBaseUnit(quantity: number, fromUnit: DisplayUnit, targetBaseUnit: BaseUnit): number {
  if (quantity < 0 || !Number.isFinite(quantity)) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }

  if (targetBaseUnit === "ml") {
    switch (fromUnit) {
      case "ml":
        return roundBaseQuantity(quantity);
      case "oz":
        return roundBaseQuantity(quantity * ML_PER_FLUID_OZ);
      case "L":
        return roundBaseQuantity(quantity * ML_PER_LITER);
      default:
        throw new Error(`Cannot convert ${fromUnit} to volume base unit ml`);
    }
  }

  if (targetBaseUnit === "g") {
    switch (fromUnit) {
      case "g":
        return roundBaseQuantity(quantity);
      case "kg":
        return roundBaseQuantity(quantity * G_PER_KG);
      default:
        throw new Error(`Cannot convert ${fromUnit} to weight base unit g`);
    }
  }

  if (targetBaseUnit === "unit") {
    if (fromUnit !== "unit") {
      throw new Error(`Cannot convert ${fromUnit} to discrete base unit`);
    }
    return roundBaseQuantity(quantity);
  }

  throw new Error(`Unsupported base unit: ${targetBaseUnit}`);
}

export interface PourDeductionInput {
  /** Nominal volume/quantity sold to customer in base unit (e.g. 500 ml pinta, 3000 ml jirafa, 44.360 ml shot). */
  nominalQuantityBase: number;
  /** Number of servings sold (e.g. 2 pintas). */
  servings?: number;
  /** Foam / spillage loss percentage (e.g. 8 for 8% foam loss on craft beer keg). */
  pourLossPercent?: number;
  /** Fixed line-purge loss per serving in base unit (e.g. 15 ml per tap pull). */
  fixedLossPerServingBase?: number;
}

export interface PourDeductionResult {
  nominalTotalBase: number;
  pourLossTotalBase: number;
  realDeductionTotalBase: number;
}

/**
 * Calculates the real inventory deduction including craft beer foam / tap purge / liquor spill loss:
 *   Q_real = Q_nominal * (1 + p_espuma / 100) + Q_purga_fija
 * Separated into nominal vs pour_loss for immutable ledger auditing & keg yield KPIs.
 */
export function calculatePourDeduction(input: PourDeductionInput): PourDeductionResult {
  const servings = input.servings ?? 1;
  const pourLossPercent = input.pourLossPercent ?? 0;
  const fixedLossPerServingBase = input.fixedLossPerServingBase ?? 0;

  if (input.nominalQuantityBase < 0 || servings <= 0 || pourLossPercent < 0 || fixedLossPerServingBase < 0) {
    throw new Error("Pour deduction parameters must be non-negative and servings > 0");
  }

  const nominalTotalBase = roundBaseQuantity(input.nominalQuantityBase * servings);
  const percentageLoss = nominalTotalBase * (pourLossPercent / 100);
  const fixedLoss = fixedLossPerServingBase * servings;
  const pourLossTotalBase = roundBaseQuantity(percentageLoss + fixedLoss);
  const realDeductionTotalBase = roundBaseQuantity(nominalTotalBase + pourLossTotalBase);

  return {
    nominalTotalBase,
    pourLossTotalBase,
    realDeductionTotalBase,
  };
}

