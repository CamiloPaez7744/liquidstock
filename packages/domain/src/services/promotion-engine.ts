import type { PromotionRule } from "../entities/types.js";
import { Money } from "../value-objects/money.js";
import { isWithinTimeWindow } from "./availability-evaluator.js";

export interface PricedLineInput {
  id?: string;
  categoryId: string;
  menuProductId: string;
  presentationId: string;
  unitPrice: number;
  quantity: number;
}

export interface PromotionClockContext {
  isoDayOfWeek: number; // 1=Mon .. 7=Sun
  currentTimeHHMM: string; // "HH:MM"
  currentDateYYYYMMDD?: string; // Optional "YYYY-MM-DD"
}

export interface AppliedPromotionResult {
  promotionRuleId: string | null;
  promotionName: string | null;
  grossTotal: number;
  discountAmount: number;
  netTotal: number;
}

export interface SubAccountPromotionAllocation {
  lineId: string;
  promotionRuleId: string;
  discountAmount: number;
  netTotal: number;
}

export interface SubAccountPromotionPreview {
  ruleId: string;
  ruleName: string;
  totalDiscount: number;
  allocations: SubAccountPromotionAllocation[];
}

export function isWithinDateRange(
  currentDateYYYYMMDD?: string,
  validFrom?: string | null,
  validUntil?: string | null,
): boolean {
  if (!currentDateYYYYMMDD) return true;
  if (validFrom && currentDateYYYYMMDD < validFrom) return false;
  if (validUntil && currentDateYYYYMMDD > validUntil) return false;
  return true;
}

export function isPromotionEligibleAt(
  rule: PromotionRule,
  clock: PromotionClockContext,
): boolean {
  if (!rule.isActive) return false;
  if (!isWithinDateRange(clock.currentDateYYYYMMDD, rule.validFrom, rule.validUntil)) return false;
  if (rule.daysOfWeek && rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(clock.isoDayOfWeek)) {
    return false;
  }
  return isWithinTimeWindow(clock.currentTimeHHMM, rule.startTime, rule.endTime);
}

function ruleMatchesScope(rule: PromotionRule, line: PricedLineInput): boolean {
  switch (rule.scopeType) {
    case "category":
      return rule.targetId === line.categoryId;
    case "product":
      return rule.targetId === line.menuProductId;
    case "presentation":
      return rule.targetId === line.presentationId;
    case "order":
      return true;
    default:
      return false;
  }
}

function calculateRuleDiscountCents(rule: PromotionRule, line: PricedLineInput): number {
  const unitCents = Money.fromMajor(line.unitPrice).toCents();
  const grossCents = unitCents * line.quantity;
  const minQty = rule.config.minQuantity ?? 1;
  if (line.quantity < minQty) return 0;

  switch (rule.ruleType) {
    case "bxgy": {
      const buyQty = rule.config.buyQty ?? 2;
      const payQty = rule.config.payQty ?? 1;
      if (buyQty <= 1 || payQty >= buyQty || line.quantity < buyQty) {
        return 0;
      }
      const completeBundles = Math.floor(line.quantity / buyQty);
      const freeUnits = completeBundles * (buyQty - payQty);
      return freeUnits * unitCents;
    }
    case "percentage_discount": {
      const percent = Math.max(0, Math.min(100, rule.config.percent ?? 0));
      return Math.round((grossCents * percent) / 100);
    }
    case "fixed_discount": {
      const perUnitDiscount = Money.fromMajor(rule.config.fixedAmount ?? 0).toCents();
      return Math.min(grossCents, perUnitDiscount * line.quantity);
    }
    case "fixed_price": {
      const promoUnitCents = Money.fromMajor(rule.config.fixedUnitPrice ?? line.unitPrice).toCents();
      if (promoUnitCents >= unitCents) return 0;
      return (unitCents - promoUnitCents) * line.quantity;
    }
    default:
      return 0;
  }
}

/**
 * Evaluates automatic single-line promotions (e.g. Happy Hour -15% on Pintas).
 * Skips `manual_at_checkout` rules (like Women's Month 3x2 for tables with women).
 */
export function evaluateLinePromotion(params: {
  line: PricedLineInput;
  rules: readonly PromotionRule[];
  isoDayOfWeek: number;
  currentTimeHHMM: string;
  currentDateYYYYMMDD?: string;
}): AppliedPromotionResult {
  const { line, rules, isoDayOfWeek, currentTimeHHMM, currentDateYYYYMMDD } = params;
  const gross = Money.fromMajor(line.unitPrice).multiply(line.quantity);

  const eligible = rules
    .filter((r) => (r.applicationMode ?? "automatic") === "automatic")
    .filter((r) => isPromotionEligibleAt(r, { isoDayOfWeek, currentTimeHHMM, currentDateYYYYMMDD }))
    .filter((r) => ruleMatchesScope(r, line))
    .sort((a, b) => a.priority - b.priority);

  let bestRule: PromotionRule | null = null;
  let bestDiscountCents = 0;

  for (const rule of eligible) {
    const discountCents = calculateRuleDiscountCents(rule, line);
    if (discountCents > bestDiscountCents) {
      bestDiscountCents = discountCents;
      bestRule = rule;
      if (!rule.isStackable) break;
    }
  }

  const discount = Money.fromCents(Math.min(gross.toCents(), bestDiscountCents));
  const net = gross.subtract(discount).maxZero();

  return {
    promotionRuleId: bestRule?.id ?? null,
    promotionName: bestRule?.name ?? null,
    grossTotal: gross.toMajor(),
    discountAmount: discount.toMajor(),
    netTotal: net.toMajor(),
  };
}

/**
 * Evaluates a single promotion rule across ALL accumulated active items on a sub-account.
 * Handles real bar scenarios across multiple separate rounds/taps:
 * - "Toma 10, la 11 es gratis" (bxgy buyQty=11, payQty=10 across 11 separate beer taps!)
 * - "Mes de la Mujer 3x2" (bxgy buyQty=3, payQty=2 applied manually at checkout!)
 * - "Descuento 15% si lleva 6+ cervezas" (percentage_discount with minQuantity=6!)
 */
export function evaluateSubAccountPromotion(
  rule: PromotionRule,
  lines: readonly (PricedLineInput & { id: string })[],
): SubAccountPromotionPreview {
  const matching = lines.filter((l) => l.quantity > 0 && ruleMatchesScope(rule, l));
  const totalQty = matching.reduce((acc, l) => acc + l.quantity, 0);
  const minQty = rule.config.minQuantity ?? 1;

  if (matching.length === 0 || totalQty < minQty) {
    return { ruleId: rule.id, ruleName: rule.name, totalDiscount: 0, allocations: [] };
  }

  const discountCentsByLine = new Map<string, number>();

  if (rule.ruleType === "bxgy") {
    const buyQty = rule.config.buyQty ?? 2;
    const payQty = rule.config.payQty ?? 1;
    if (buyQty <= 1 || payQty >= buyQty || totalQty < buyQty) {
      return { ruleId: rule.id, ruleName: rule.name, totalDiscount: 0, allocations: [] };
    }
    const freeUnitsTotal = Math.floor(totalQty / buyQty) * (buyQty - payQty);

    // Bar industry standard: free units apply to the lowest-priced eligible units first
    const expandedUnits: Array<{ lineId: string; unitCents: number }> = [];
    for (const line of matching) {
      const unitCents = Money.fromMajor(line.unitPrice).toCents();
      for (let i = 0; i < line.quantity; i += 1) {
        expandedUnits.push({ lineId: line.id, unitCents });
      }
    }
    expandedUnits.sort((a, b) => a.unitCents - b.unitCents);

    for (let i = 0; i < Math.min(freeUnitsTotal, expandedUnits.length); i += 1) {
      const unit = expandedUnits[i]!;
      discountCentsByLine.set(
        unit.lineId,
        (discountCentsByLine.get(unit.lineId) ?? 0) + unit.unitCents,
      );
    }
  } else {
    for (const line of matching) {
      const unitCents = Money.fromMajor(line.unitPrice).toCents();
      const grossCents = unitCents * line.quantity;
      let discCents = 0;

      if (rule.ruleType === "percentage_discount") {
        const pct = Math.max(0, Math.min(100, rule.config.percent ?? 0));
        discCents = Math.round((grossCents * pct) / 100);
      } else if (rule.ruleType === "fixed_discount") {
        discCents = Math.min(grossCents, Money.fromMajor(rule.config.fixedAmount ?? 0).toCents() * line.quantity);
      } else if (rule.ruleType === "fixed_price") {
        const promoUnit = Money.fromMajor(rule.config.fixedUnitPrice ?? line.unitPrice).toCents();
        discCents = promoUnit < unitCents ? (unitCents - promoUnit) * line.quantity : 0;
      }

      if (discCents > 0) {
        discountCentsByLine.set(line.id, discCents);
      }
    }
  }

  const allocations: SubAccountPromotionAllocation[] = [];
  let totalDiscountCents = 0;

  for (const line of matching) {
    const discCents = discountCentsByLine.get(line.id) ?? 0;
    if (discCents > 0) {
      const grossCents = Money.fromMajor(line.unitPrice).toCents() * line.quantity;
      const clamped = Math.min(grossCents, discCents);
      totalDiscountCents += clamped;
      allocations.push({
        lineId: line.id,
        promotionRuleId: rule.id,
        discountAmount: Money.fromCents(clamped).toMajor(),
        netTotal: Money.fromCents(grossCents - clamped).toMajor(),
      });
    }
  }

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    totalDiscount: Money.fromCents(totalDiscountCents).toMajor(),
    allocations,
  };
}
