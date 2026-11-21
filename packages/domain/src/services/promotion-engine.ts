import type { PresentationGroup, PromotionRule } from "../entities/types.js";
import { Money } from "../value-objects/money.js";
import { isWithinTimeWindow } from "./availability-evaluator.js";

export interface PricedLineInput {
  id?: string;
  categoryId: string;
  menuProductId: string;
  presentationId: string;
  presentationGroup?: PresentationGroup | null;
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

export interface QuickPromoOffer {
  rule: PromotionRule;
  bundleQty: number;
  regularTotal: number;
  discountAmount: number;
  promoTotal: number;
  shortBadge: string;
  isManual: boolean;
}

export function formatPromotionShortBadge(rule: PromotionRule): string {
  switch (rule.ruleType) {
    case "bxgy": {
      const buyQty = rule.config.buyQty ?? 2;
      const payQty = rule.config.payQty ?? 1;
      return `${buyQty}x${payQty}`;
    }
    case "percentage_discount":
      return `-${Math.round(rule.config.percent ?? 0)}%`;
    case "fixed_discount":
      return `-$${Math.round(rule.config.fixedAmount ?? 0).toLocaleString("es-CO")}`;
    case "fixed_price":
      return "Precio promo";
    default:
      return "Promo";
  }
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
  let scopeOk = false;
  switch (rule.scopeType) {
    case "category":
      scopeOk = rule.targetId === line.categoryId;
      break;
    case "product":
      scopeOk = rule.targetId === line.menuProductId;
      break;
    case "presentation":
      scopeOk = rule.targetId === line.presentationId;
      break;
    case "order":
      scopeOk = true;
      break;
    default:
      scopeOk = false;
  }

  if (!scopeOk) return false;

  // Optional presentation-group filter (e.g. "all Pintas" or "only Jirafas" within Craft Beers category)
  const allowedGroups = rule.config?.presentationGroups;
  if (rule.scopeType !== "presentation" && Array.isArray(allowedGroups) && allowedGroups.length > 0) {
    if (!line.presentationGroup) return false;
    return allowedGroups.includes(line.presentationGroup);
  }

  return true;
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
 * Evaluates single-line promotions (e.g. Happy Hour -15% on Pintas, or 1-click 2x1 promo bundles).
 * Skips `manual_at_checkout` rules UNLESS `forcedRuleId` explicitly selects that eligible rule.
 */
export function evaluateLinePromotion(params: {
  line: PricedLineInput;
  rules: readonly PromotionRule[];
  isoDayOfWeek: number;
  currentTimeHHMM: string;
  currentDateYYYYMMDD?: string;
  forcedRuleId?: string | null;
}): AppliedPromotionResult {
  const { line, rules, isoDayOfWeek, currentTimeHHMM, currentDateYYYYMMDD, forcedRuleId } = params;
  const gross = Money.fromMajor(line.unitPrice).multiply(line.quantity);
  const clock: PromotionClockContext = { isoDayOfWeek, currentTimeHHMM, currentDateYYYYMMDD };

  if (forcedRuleId) {
    const forced = rules.find((r) => r.id === forcedRuleId);
    if (forced && isPromotionEligibleAt(forced, clock) && ruleMatchesScope(forced, line)) {
      const discountCents = calculateRuleDiscountCents(forced, line);
      if (discountCents > 0) {
        const discount = Money.fromCents(Math.min(gross.toCents(), discountCents));
        const net = gross.subtract(discount).maxZero();
        return {
          promotionRuleId: forced.id,
          promotionName: forced.name,
          grossTotal: gross.toMajor(),
          discountAmount: discount.toMajor(),
          netTotal: net.toMajor(),
        };
      }
    }
  }

  const eligible = rules
    .filter((r) => (r.applicationMode ?? "automatic") === "automatic")
    .filter((r) => isPromotionEligibleAt(r, clock))
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
 * Returns all active promotions currently eligible for a specific product presentation,
 * including both automatic and manual rules, along with their 1-click bundle quantity and net price.
 */
export function getQuickPromoOffersForPresentation(params: {
  categoryId: string;
  menuProductId: string;
  presentationId: string;
  presentationGroup?: PresentationGroup | null;
  unitPrice: number;
  rules: readonly PromotionRule[];
  isoDayOfWeek: number;
  currentTimeHHMM: string;
  currentDateYYYYMMDD?: string;
}): QuickPromoOffer[] {
  const {
    categoryId,
    menuProductId,
    presentationId,
    presentationGroup,
    unitPrice,
    rules,
    isoDayOfWeek,
    currentTimeHHMM,
    currentDateYYYYMMDD,
  } = params;
  const clock: PromotionClockContext = { isoDayOfWeek, currentTimeHHMM, currentDateYYYYMMDD };

  const offers: QuickPromoOffer[] = [];
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    if (!isPromotionEligibleAt(rule, clock)) continue;

    const bundleQty =
      rule.ruleType === "bxgy"
        ? Math.max(rule.config.buyQty ?? 2, rule.config.minQuantity ?? 1)
        : Math.max(1, rule.config.minQuantity ?? 1);

    const line: PricedLineInput = {
      categoryId,
      menuProductId,
      presentationId,
      presentationGroup: presentationGroup ?? null,
      unitPrice,
      quantity: bundleQty,
    };

    if (!ruleMatchesScope(rule, line)) continue;

    const grossCents = Money.fromMajor(unitPrice).toCents() * bundleQty;
    const rawDiscountCents = calculateRuleDiscountCents(rule, line);
    const clampedDiscountCents = Math.min(grossCents, rawDiscountCents);
    if (clampedDiscountCents <= 0) continue;

    offers.push({
      rule,
      bundleQty,
      regularTotal: Money.fromCents(grossCents).toMajor(),
      discountAmount: Money.fromCents(clampedDiscountCents).toMajor(),
      promoTotal: Money.fromCents(grossCents - clampedDiscountCents).toMajor(),
      shortBadge: formatPromotionShortBadge(rule),
      isManual: (rule.applicationMode ?? "automatic") === "manual_at_checkout",
    });
  }

  return offers;
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

    // 1. Allocate complete bundles directly to each line first (keeps 1-click promo bundles cleanly attributed)
    const leftoverUnits: Array<{ lineId: string; unitCents: number }> = [];
    for (const line of matching) {
      const unitCents = Money.fromMajor(line.unitPrice).toCents();
      const lineCompleteBundles = Math.floor(line.quantity / buyQty);
      if (lineCompleteBundles > 0) {
        const lineFreeUnits = lineCompleteBundles * (buyQty - payQty);
        discountCentsByLine.set(
          line.id,
          (discountCentsByLine.get(line.id) ?? 0) + lineFreeUnits * unitCents,
        );
      }
      const remainder = line.quantity % buyQty;
      for (let i = 0; i < remainder; i += 1) {
        leftoverUnits.push({ lineId: line.id, unitCents });
      }
    }

    // 2. Allocate remaining cross-line bundles from leftover units (cheapest eligible unit free first)
    const crossLineFreeUnits = Math.floor(leftoverUnits.length / buyQty) * (buyQty - payQty);
    if (crossLineFreeUnits > 0) {
      leftoverUnits.sort((a, b) => a.unitCents - b.unitCents);
      for (let i = 0; i < Math.min(crossLineFreeUnits, leftoverUnits.length); i += 1) {
        const unit = leftoverUnits[i]!;
        discountCentsByLine.set(
          unit.lineId,
          (discountCentsByLine.get(unit.lineId) ?? 0) + unit.unitCents,
        );
      }
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
