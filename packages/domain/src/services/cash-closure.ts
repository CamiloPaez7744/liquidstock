import { Money } from "../value-objects/money.js";

export interface ShiftPaymentRecord {
  paymentMethodId: string;
  paymentMethodName: string;
  countsAsPhysicalCash: boolean;
  purpose: "sale_payment" | "credit_repayment";
  amount: number;
}

export interface ShiftSaleSummaryInput {
  openingFloat: number;
  grossSales: number;
  discounts: number;
  creditIssued: number;
  allyPayablesByAlly: Array<{ allyId: string; allyName: string; amount: number }>;
  payments: ShiftPaymentRecord[];
  declaredPhysicalCash?: number | null;
}

export interface PaymentMethodBreakdown {
  paymentMethodId: string;
  paymentMethodName: string;
  countsAsPhysicalCash: boolean;
  saleCollected: number;
  creditRepaymentsCollected: number;
  totalCollected: number;
}

export interface CashShiftClosureReport {
  openingFloat: number;
  totalGrossSales: number;
  totalDiscounts: number;
  totalNetSales: number;
  totalCollectedFromSales: number;
  totalCreditRecovered: number;
  totalCollectedOverall: number;
  totalCreditIssued: number;
  totalAllyPayable: number;
  allyPayablesByAlly: Array<{ allyId: string; allyName: string; amount: number }>;
  paymentBreakdown: PaymentMethodBreakdown[];
  expectedPhysicalCash: number;
  declaredPhysicalCash: number | null;
  cashDiscrepancy: number | null;
}

/**
 * Pure financial closure engine supporting partial closures with pending credit (fiado)
 * and third-party ally settlement separation.
 */
export function calculateCashShiftClosure(input: ShiftSaleSummaryInput): CashShiftClosureReport {
  const openingFloat = Money.fromMajor(input.openingFloat);
  const grossSales = Money.fromMajor(input.grossSales);
  const discounts = Money.fromMajor(input.discounts);
  const netSales = grossSales.subtract(discounts).maxZero();
  const creditIssued = Money.fromMajor(input.creditIssued);

  const byMethod = new Map<
    string,
    {
      paymentMethodId: string;
      paymentMethodName: string;
      countsAsPhysicalCash: boolean;
      saleCents: number;
      repaymentCents: number;
    }
  >();

  let saleCollectedCents = 0;
  let creditRecoveredCents = 0;
  let physicalCashInflowCents = 0;

  for (const p of input.payments) {
    const amountCents = Money.fromMajor(p.amount).toCents();
    const bucket = byMethod.get(p.paymentMethodId) ?? {
      paymentMethodId: p.paymentMethodId,
      paymentMethodName: p.paymentMethodName,
      countsAsPhysicalCash: p.countsAsPhysicalCash,
      saleCents: 0,
      repaymentCents: 0,
    };

    if (p.purpose === "sale_payment") {
      bucket.saleCents += amountCents;
      saleCollectedCents += amountCents;
    } else {
      bucket.repaymentCents += amountCents;
      creditRecoveredCents += amountCents;
    }

    if (p.countsAsPhysicalCash) {
      physicalCashInflowCents += amountCents;
    }

    byMethod.set(p.paymentMethodId, bucket);
  }

  let totalAllyCents = 0;
  const allyMap = new Map<string, { allyId: string; allyName: string; cents: number }>();
  for (const a of input.allyPayablesByAlly) {
    const c = Money.fromMajor(a.amount).toCents();
    totalAllyCents += c;
    const prev = allyMap.get(a.allyId);
    if (prev) {
      prev.cents += c;
    } else {
      allyMap.set(a.allyId, { allyId: a.allyId, allyName: a.allyName, cents: c });
    }
  }

  const expectedPhysicalCash = openingFloat.add(Money.fromCents(physicalCashInflowCents));
  const declared =
    input.declaredPhysicalCash !== null && input.declaredPhysicalCash !== undefined
      ? Money.fromMajor(input.declaredPhysicalCash)
      : null;

  return {
    openingFloat: openingFloat.toMajor(),
    totalGrossSales: grossSales.toMajor(),
    totalDiscounts: discounts.toMajor(),
    totalNetSales: netSales.toMajor(),
    totalCollectedFromSales: Money.fromCents(saleCollectedCents).toMajor(),
    totalCreditRecovered: Money.fromCents(creditRecoveredCents).toMajor(),
    totalCollectedOverall: Money.fromCents(saleCollectedCents + creditRecoveredCents).toMajor(),
    totalCreditIssued: creditIssued.toMajor(),
    totalAllyPayable: Money.fromCents(totalAllyCents).toMajor(),
    allyPayablesByAlly: Array.from(allyMap.values()).map((a) => ({
      allyId: a.allyId,
      allyName: a.allyName,
      amount: Money.fromCents(a.cents).toMajor(),
    })),
    paymentBreakdown: Array.from(byMethod.values()).map((m) => ({
      paymentMethodId: m.paymentMethodId,
      paymentMethodName: m.paymentMethodName,
      countsAsPhysicalCash: m.countsAsPhysicalCash,
      saleCollected: Money.fromCents(m.saleCents).toMajor(),
      creditRepaymentsCollected: Money.fromCents(m.repaymentCents).toMajor(),
      totalCollected: Money.fromCents(m.saleCents + m.repaymentCents).toMajor(),
    })),
    expectedPhysicalCash: expectedPhysicalCash.toMajor(),
    declaredPhysicalCash: declared ? declared.toMajor() : null,
    cashDiscrepancy: declared ? declared.subtract(expectedPhysicalCash).toMajor() : null,
  };
}

