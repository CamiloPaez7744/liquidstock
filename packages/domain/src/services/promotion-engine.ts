import type { PromotionRule } from "../entities/types.js";
import { Money } from "../value-objects/money.js";
import { isWithinTimeWindow } from "./availability-evaluator.js";

export interface PricedLineInput {
  categoryId: string;
  menuProductId: string;
  presentationId: string;
  unitPrice: number;
  quantity: number;
}

export interface AppliedPromotionResult {
  promotionRuleId: string | null;
  promotionName: string | null;
  grossTotal: number;
  discountAmount: number;
  netTotal: number;
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
 * Pure, extensible promotion evaluator shared by Offline POS and Fastify Backend.
 * Picks the highest-priority (or best) active rule matching day of week & time window.
 */
export function evaluateLinePromotion(params: {
  line: PricedLineInput;
  rules: readonly PromotionRule[];
  isoDayOfWeek: number; // 1=Mon .. 7=Sun
  currentTimeHHMM: string;
}): AppliedPromotionResult {
  const { line, rules, isoDayOfWeek, currentTimeHHMM } = params;
  const gross = Money.fromMajor(line.unitPrice).multiply(line.quantity);

  const eligible = rules
    .filter((r) => r.isActive)
    .filter((r) => !r.daysOfWeek || r.daysOfWeek.length === 0 || r.daysOfWeek.includes(isoDayOfWeek))
    .filter((r) => isWithinTimeWindow(currentTimeHHMM, r.startTime, r.endTime))
    .filter((r) => ruleMatchesScope(r, line))
    .sort((a, b) => a.priority - b.priority);

  let bestRule: PromotionRule | null = null;
  let bestDiscountCents = 0;

  for (const rule of eligible) {
    const discountCents = calculateRuleDiscountCents(rule, line);
    if (discountCents > bestDiscountCents) {
      bestDiscountCents = discountCents;
      bestRule = rule;
      if (!rule.isStackable) {
        break;
      }
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

