import { describe, expect, it } from "vitest";
import {
  calculateCashShiftClosure,
  calculatePourDeduction,
  convertToBaseUnit,
  evaluateCreditRequest,
  evaluateLinePromotion,
  evaluatePresentationAvailability,
  evaluateSubAccountPromotion,
  explodePresentationSale,
  generateUuidV7,
  isPromotionEligibleAt,
  type Ally,
  type Customer,
  type InventoryItem,
  type MenuProduct,
  type ProductPresentation,
  type PromotionRule,
} from "../index.js";

describe("LiquiStock Domain Core", () => {
  it("converts kegs (L), shots (oz), and bottles (ml) accurately to base unit ml", () => {
    expect(convertToBaseUnit(30, "L", "ml")).toBe(30000);
    expect(convertToBaseUnit(1.5, "oz", "ml")).toBe(44.36);
    expect(convertToBaseUnit(2, "oz", "ml")).toBe(59.147);
    expect(convertToBaseUnit(750, "ml", "ml")).toBe(750);
  });

  it("calculates craft beer keg pour deduction with foam percentage + fixed purge loss", () => {
    // Pinta 500 ml + 8% foam (40 ml) + 15 ml line purge = 555 ml real deduction per pinta
    const result = calculatePourDeduction({
      nominalQuantityBase: 500,
      servings: 2,
      pourLossPercent: 8,
      fixedLossPerServingBase: 15,
    });

    expect(result.nominalTotalBase).toBe(1000);
    expect(result.pourLossTotalBase).toBe(110); // 80 ml foam + 30 ml purge
    expect(result.realDeductionTotalBase).toBe(1110);
  });

  it("explodes a mixed Combo (Jirafa 3L from keg + Ally wings) deducting keg with foam AND recording ally payout", () => {
    const comboPresentation: ProductPresentation = {
      id: "pres-combo",
      branchId: "b1",
      menuProductId: "prod-combo",
      name: "Combo Jirafa 3L + Alitas",
      presentationGroup: "combo",
      salePrice: 85000,
      allyId: "ally-wings",
      allyPayoutAmount: 24000,
      isAvailable: true,
      sortOrder: 1,
      recipes: [
        {
          id: "rec-1",
          presentationId: "pres-combo",
          inventoryItemId: "keg-ipa",
          displayUnit: "L",
          displayQuantity: 3,
          quantityBase: 3000,
          pourLossPercent: 3, // 3% foam on jirafa = 90 ml
          fixedLossBase: 20, // 20 ml purge
        },
      ],
    };

    const explosion = explodePresentationSale({
      productKind: "combo",
      presentation: comboPresentation,
      quantity: 1,
    });

    expect(explosion.affectsBarInventory).toBe(true);
    expect(explosion.allyId).toBe("ally-wings");
    expect(explosion.totalAllyPayout).toBe(24000);
    expect(explosion.deductions).toEqual([
      {
        inventoryItemId: "keg-ipa",
        nominalQuantityBase: 3000,
        pourLossQuantityBase: 110,
        totalDeductionBase: 3110,
      },
    ]);
  });

  it("never touches bar inventory for pure third_party_ally products", () => {
    const allyPresentation: ProductPresentation = {
      id: "pres-burger",
      branchId: "b1",
      menuProductId: "prod-burger",
      name: "Hamburguesa Especial",
      presentationGroup: "comida",
      salePrice: 28000,
      allyId: "ally-burger",
      allyPayoutAmount: 22000,
      isAvailable: true,
      sortOrder: 1,
      recipes: [],
    };

    const explosion = explodePresentationSale({
      productKind: "third_party_ally",
      presentation: allyPresentation,
      quantity: 2,
    });

    expect(explosion.affectsBarInventory).toBe(false);
    expect(explosion.deductions).toHaveLength(0);
    expect(explosion.totalAllyPayout).toBe(44000);
  });

  it("synchronizes catalog availability with keg stock: blocks Jirafa 3L while still allowing Pinta 500ml", () => {
    const kegIpa: InventoryItem = {
      id: "keg-ipa",
      branchId: "b1",
      name: "Barril IPA Artesanal",
      baseUnit: "ml",
      currentStockBase: 1800, // Only 1.8 L left in keg!
      minStockBase: 3000,
      avgUnitCostBase: 12,
      defaultPourLossPercent: 8,
      isKeg: true,
      isActive: true,
    };

    const ipaProduct: MenuProduct = {
      id: "prod-ipa",
      branchId: "b1",
      categoryId: "cat-beer",
      name: "Cerveza IPA Artesanal",
      productKind: "standard",
      isAvailable: true,
      sortOrder: 1,
    };

    const jirafa3L: ProductPresentation = {
      id: "pres-jirafa",
      branchId: "b1",
      menuProductId: "prod-ipa",
      name: "Jirafa 3L",
      presentationGroup: "jirafa",
      salePrice: 65000,
      allyPayoutAmount: 0,
      isAvailable: true,
      sortOrder: 2,
      recipes: [
        {
          id: "r-j",
          presentationId: "pres-jirafa",
          inventoryItemId: "keg-ipa",
          displayUnit: "L",
          displayQuantity: 3,
          quantityBase: 3000,
          pourLossPercent: 3,
          fixedLossBase: 0,
        },
      ],
    };

    const pinta500: ProductPresentation = {
      id: "pres-pinta",
      branchId: "b1",
      menuProductId: "prod-ipa",
      name: "Pinta 500ml",
      presentationGroup: "pinta",
      salePrice: 14000,
      allyPayoutAmount: 0,
      isAvailable: true,
      sortOrder: 1,
      recipes: [
        {
          id: "r-p",
          presentationId: "pres-pinta",
          inventoryItemId: "keg-ipa",
          displayUnit: "ml",
          displayQuantity: 500,
          quantityBase: 500,
          pourLossPercent: 8, // 540 ml real deduction
          fixedLossBase: 0,
        },
      ],
    };

    const inventoryMap = new Map([[kegIpa.id, kegIpa]]);
    const alliesMap = new Map<string, Ally>();

    const jirafaAvail = evaluatePresentationAvailability({
      product: ipaProduct,
      presentation: jirafa3L,
      inventoryById: inventoryMap,
      alliesById: alliesMap,
      isoDayOfWeek: 5,
      currentTimeHHMM: "21:00",
    });
    expect(jirafaAvail.available).toBe(false);
    expect(jirafaAvail.reason).toBe("OUT_OF_STOCK");

    const pintaAvail = evaluatePresentationAvailability({
      product: ipaProduct,
      presentation: pinta500,
      inventoryById: inventoryMap,
      alliesById: alliesMap,
      isoDayOfWeek: 5,
      currentTimeHHMM: "21:00",
    });
    expect(pintaAvail.available).toBe(true);
    expect(pintaAvail.maxServings).toBe(3); // floor(1800 / 540) = 3
    expect(pintaAvail.isLowStock).toBe(true);
  });

  it("hides ally combos automatically once the ally restaurant closes for the night", () => {
    const ally: Ally = {
      id: "ally-1",
      branchId: "b1",
      name: "Hamburguesas El Vecino",
      operatingSchedule: {
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        openTime: "17:00",
        closeTime: "23:00",
      },
      isTemporarilyClosed: false,
      isActive: true,
    };

    const product: MenuProduct = {
      id: "prod-combo",
      branchId: "b1",
      categoryId: "cat-combos",
      name: "Combo Burger + Pinta",
      productKind: "third_party_ally",
      allyId: "ally-1",
      isAvailable: true,
      sortOrder: 1,
    };

    const presentation: ProductPresentation = {
      id: "pres-combo",
      branchId: "b1",
      menuProductId: "prod-combo",
      name: "Combo Clásico",
      presentationGroup: "combo",
      salePrice: 35000,
      allyId: "ally-1",
      allyPayoutAmount: 20000,
      isAvailable: true,
      sortOrder: 1,
      recipes: [],
    };

    const alliesMap = new Map([[ally.id, ally]]);
    const emptyInv = new Map<string, InventoryItem>();

    // Open at 22:30
    const openRes = evaluatePresentationAvailability({
      product,
      presentation,
      inventoryById: emptyInv,
      alliesById: alliesMap,
      isoDayOfWeek: 5,
      currentTimeHHMM: "22:30",
    });
    expect(openRes.available).toBe(true);

    // Closed at 23:15
    const closedRes = evaluatePresentationAvailability({
      product,
      presentation,
      inventoryById: emptyInv,
      alliesById: alliesMap,
      isoDayOfWeek: 5,
      currentTimeHHMM: "23:15",
    });
    expect(closedRes.available).toBe(false);
    expect(closedRes.reason).toBe("ALLY_CLOSED");
  });

  it("applies 2x1 Thursdays promotion rule offline and online identically", () => {
    const rules: PromotionRule[] = [
      {
        id: "promo-thu-2x1",
        branchId: "b1",
        name: "Jueves 2x1 Cócteles",
        ruleType: "bxgy",
        scopeType: "category",
        targetId: "cat-cocktails",
        daysOfWeek: [4], // Thursday
        startTime: "18:00",
        endTime: "23:59",
        config: { buyQty: 2, payQty: 1 },
        priority: 10,
        isStackable: false,
        isActive: true,
      },
    ];

    const thursday = evaluateLinePromotion({
      line: {
        categoryId: "cat-cocktails",
        menuProductId: "prod-mojito",
        presentationId: "pres-mojito",
        unitPrice: 24000,
        quantity: 3,
      },
      rules,
      isoDayOfWeek: 4,
      currentTimeHHMM: "20:00",
    });
    expect(thursday.grossTotal).toBe(72000);
    expect(thursday.discountAmount).toBe(24000); // 1 free out of 3
    expect(thursday.netTotal).toBe(48000);

    const friday = evaluateLinePromotion({
      line: {
        categoryId: "cat-cocktails",
        menuProductId: "prod-mojito",
        presentationId: "pres-mojito",
        unitPrice: 24000,
        quantity: 2,
      },
      rules,
      isoDayOfWeek: 5,
      currentTimeHHMM: "20:00",
    });
    expect(friday.discountAmount).toBe(0);
  });

  it("enforces Lista Negra hard block and Lista Blanca credit limits", () => {
    const blacklisted: Customer = {
      id: "c1",
      branchId: "b1",
      fullName: "Pedro Moroso",
      creditStatus: "blacklist_blocked",
      currentDebt: 180000,
      statusReason: "Deuda vencida > 45 días",
    };

    const resBlack = evaluateCreditRequest(blacklisted, 50000);
    expect(resBlack.allowed).toBe(false);
    expect(resBlack.code).toBe("BLOCKED_BLACKLIST");
    expect(resBlack.requiresAdminOverride).toBe(false);

    const whitelisted: Customer = {
      id: "c2",
      branchId: "b1",
      fullName: "Carlos Frecuente",
      creditStatus: "whitelist_credit",
      creditLimit: 200000,
      currentDebt: 150000,
    };

    const resOver = evaluateCreditRequest(whitelisted, 70000);
    expect(resOver.allowed).toBe(false);
    expect(resOver.code).toBe("EXCEEDS_CREDIT_LIMIT");
    expect(resOver.maxCreditableAmount).toBe(50000);
    expect(resOver.requiredUpfrontCash).toBe(20000);
  });

  it("separates Cash Shift Closure cleanly into Total Sold, Collected by Method, Allies, and Credit", () => {
    const report = calculateCashShiftClosure({
      openingFloat: 200000,
      grossSales: 2540000,
      discounts: 90000,
      creditIssued: 320000,
      allyPayablesByAlly: [
        { allyId: "a1", allyName: "El Vecino", amount: 180000 },
        { allyId: "a2", allyName: "Pizzería", amount: 60000 },
      ],
      payments: [
        {
          paymentMethodId: "pm-cash",
          paymentMethodName: "Efectivo",
          countsAsPhysicalCash: true,
          purpose: "sale_payment",
          amount: 950000,
        },
        {
          paymentMethodId: "pm-cash",
          paymentMethodName: "Efectivo",
          countsAsPhysicalCash: true,
          purpose: "credit_repayment",
          amount: 100000,
        },
        {
          paymentMethodId: "pm-nequi",
          paymentMethodName: "Nequi",
          countsAsPhysicalCash: false,
          purpose: "sale_payment",
          amount: 1180000,
        },
      ],
      declaredPhysicalCash: 1250000,
    });

    expect(report.totalNetSales).toBe(2450000);
    expect(report.totalCollectedFromSales).toBe(2130000);
    expect(report.totalCreditRecovered).toBe(100000);
    expect(report.totalAllyPayable).toBe(240000);
    expect(report.totalCreditIssued).toBe(320000);
    expect(report.expectedPhysicalCash).toBe(1250000); // 200k base + 950k sales + 100k recovery
    expect(report.cashDiscrepancy).toBe(0);
  });

  it("generates monotonically sortable RFC 9562 UUIDv7 identifiers", () => {
    const id1 = generateUuidV7(1700000000000);
    const id2 = generateUuidV7(1700000005000);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id2 > id1).toBe(true);
  });

  it("evaluates accumulated sub-account promos: '10+1 gratis' across multiple rounds & March Women's Month 3x2", () => {
    // 1) Toma 10, la 11 es gratis (buyQty=11, payQty=10) across 3 separate beer rounds
    const rule10Plus1: PromotionRule = {
      id: "promo-10-plus-1",
      branchId: "b1",
      name: "Toma 10, la 11 es gratis",
      ruleType: "bxgy",
      scopeType: "category",
      applicationMode: "automatic",
      targetId: "cat-beer",
      config: { buyQty: 11, payQty: 10 },
      priority: 10,
      isStackable: false,
      isActive: true,
    };

    const rounds = [
      { id: "l1", categoryId: "cat-beer", menuProductId: "p1", presentationId: "pr1", unitPrice: 14000, quantity: 4 },
      { id: "l2", categoryId: "cat-beer", menuProductId: "p1", presentationId: "pr1", unitPrice: 14000, quantity: 4 },
      { id: "l3", categoryId: "cat-beer", menuProductId: "p1", presentationId: "pr1", unitPrice: 14000, quantity: 3 },
    ];
    const res11 = evaluateSubAccountPromotion(rule10Plus1, rounds);
    expect(res11.totalDiscount).toBe(14000); // 11 beers accumulated -> 1 free!

    // 2) Marzo Mes de la Mujer 3x2 (manual_at_checkout, date-scoped March only)
    const womensMonth: PromotionRule = {
      id: "promo-march-3x2",
      branchId: "b1",
      name: "Mes de la Mujer · Mesa con chicas 3x2",
      ruleType: "bxgy",
      scopeType: "category",
      applicationMode: "manual_at_checkout",
      targetId: "cat-cocktails",
      validFrom: "2026-03-01",
      validUntil: "2026-03-31",
      config: { buyQty: 3, payQty: 2 },
      priority: 5,
      isStackable: false,
      isActive: true,
    };

    expect(
      isPromotionEligibleAt(womensMonth, {
        isoDayOfWeek: 5,
        currentTimeHHMM: "21:00",
        currentDateYYYYMMDD: "2026-03-15",
      }),
    ).toBe(true);
    expect(
      isPromotionEligibleAt(womensMonth, {
        isoDayOfWeek: 5,
        currentTimeHHMM: "21:00",
        currentDateYYYYMMDD: "2026-04-02",
      }),
    ).toBe(false);

    const cocktailRes = evaluateSubAccountPromotion(womensMonth, [
      { id: "c1", categoryId: "cat-cocktails", menuProductId: "m1", presentationId: "pm1", unitPrice: 22000, quantity: 2 },
      { id: "c2", categoryId: "cat-cocktails", menuProductId: "m2", presentationId: "pm2", unitPrice: 20000, quantity: 1 },
    ]);
    // 3 cocktails total -> cheapest one (20.000) is free!
    expect(cocktailRes.totalDiscount).toBe(20000);
  });
});

