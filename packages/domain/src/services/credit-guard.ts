import type { Customer } from "../entities/types.js";
import { Money } from "../value-objects/money.js";

export type CreditDecisionCode =
  | "APPROVED"
  | "BLOCKED_BLACKLIST"
  | "NOT_AUTHORIZED_STANDARD"
  | "EXCEEDS_CREDIT_LIMIT";

export interface CreditEvaluationResult {
  allowed: boolean;
  code: CreditDecisionCode;
  message: string;
  availableCredit: number | null;
  /** Suggested maximum credit portion if partial payment + credit is possible. */
  maxCreditableAmount: number;
  requiredUpfrontCash: number;
  requiresAdminOverride: boolean;
}

/**
 * Pure Credit Guard enforcing Lista Blanca / Lista Negra and optional credit limits.
 * Runs offline in the tablet so a waiter can NEVER accidentally extend credit to a blacklisted customer.
 */
export function evaluateCreditRequest(customer: Customer, requestedAmount: number): CreditEvaluationResult {
  const requested = Money.fromMajor(requestedAmount);
  const currentDebt = Money.fromMajor(customer.currentDebt);

  if (customer.creditStatus === "blacklist_blocked") {
    return {
      allowed: false,
      code: "BLOCKED_BLACKLIST",
      message: customer.statusReason
        ? `Cliente en Lista Negra: ${customer.statusReason}`
        : "Cliente bloqueado en Lista Negra. Solo cobro de contado.",
      availableCredit: 0,
      maxCreditableAmount: 0,
      requiredUpfrontCash: requested.toMajor(),
      requiresAdminOverride: false, // Hard block for waiters
    };
  }

  if (customer.creditStatus !== "whitelist_credit") {
    return {
      allowed: false,
      code: "NOT_AUTHORIZED_STANDARD",
      message: "Cliente no está en Lista Blanca de crédito. Requiere autorización de Administrador.",
      availableCredit: 0,
      maxCreditableAmount: 0,
      requiredUpfrontCash: requested.toMajor(),
      requiresAdminOverride: true,
    };
  }

  // Whitelisted with no explicit limit
  if (customer.creditLimit === null || customer.creditLimit === undefined) {
    return {
      allowed: true,
      code: "APPROVED",
      message: "Cliente autorizado (Lista Blanca sin tope).",
      availableCredit: null,
      maxCreditableAmount: requested.toMajor(),
      requiredUpfrontCash: 0,
      requiresAdminOverride: false,
    };
  }

  const limit = Money.fromMajor(customer.creditLimit);
  const available = limit.subtract(currentDebt).maxZero();

  if (requested.isGreaterThan(available)) {
    const upfront = requested.subtract(available);
    return {
      allowed: false,
      code: "EXCEEDS_CREDIT_LIMIT",
      message: `Excede el cupo disponible. Disponible: ${available.toMajor()}, faltante de contado: ${upfront.toMajor()}.`,
      availableCredit: available.toMajor(),
      maxCreditableAmount: available.toMajor(),
      requiredUpfrontCash: upfront.toMajor(),
      requiresAdminOverride: true,
    };
  }

  return {
    allowed: true,
    code: "APPROVED",
    message: "Crédito aprobado dentro del cupo disponible.",
    availableCredit: available.subtract(requested).toMajor(),
    maxCreditableAmount: requested.toMajor(),
    requiredUpfrontCash: 0,
    requiresAdminOverride: false,
  };
}

