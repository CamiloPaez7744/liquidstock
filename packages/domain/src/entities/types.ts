import type { BaseUnit, DisplayUnit } from "../value-objects/units.js";

export type UserRole = "admin" | "waiter" | "cashier";

export type CreditStatus = "standard" | "whitelist_credit" | "blacklist_blocked";

export type ProductKind = "standard" | "combo" | "third_party_ally";

export type PresentationGroup =
  | "vaso"
  | "pinta"
  | "jarra"
  | "jirafa"
  | "shot"
  | "trago"
  | "coctel"
  | "botella"
  | "lata"
  | "combo"
  | "comida"
  | "otro";

export type SubAccountStatus = "open" | "paid" | "credit" | "partial_credit" | "voided";

export type InventoryMovementType =
  | "purchase"
  | "sale"
  | "sale_void_reversal"
  | "waste"
  | "manual_adjustment"
  | "transfer_in"
  | "transfer_out";

export interface BranchFeatureFlags {
  enableTables: boolean;
  enableSplitAccounts: boolean;
  enableCreditAccounts: boolean;
  enableAllies: boolean;
  enablePromotions: boolean;
  enableFoamLossFormula: boolean;
  hideOutOfStockInPos: boolean;
  autoHideClosedAllies: boolean;
  allowCloseShiftWithOpenTables: boolean;
}

export const DEFAULT_BRANCH_FEATURE_FLAGS: BranchFeatureFlags = {
  enableTables: true,
  enableSplitAccounts: true,
  enableCreditAccounts: true,
  enableAllies: true,
  enablePromotions: true,
  enableFoamLossFormula: true,
  hideOutOfStockInPos: false, // false = shows disabled "Agotado" badge so waiter knows why
  autoHideClosedAllies: true,
  allowCloseShiftWithOpenTables: true,
};

export interface Branch {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  timezone: string;
  featureFlags: BranchFeatureFlags;
  isActive: boolean;
}

export interface InventoryItem {
  id: string;
  branchId: string;
  sku?: string | null;
  name: string;
  baseUnit: BaseUnit;
  currentStockBase: number;
  minStockBase: number;
  avgUnitCostBase: number;
  defaultPourLossPercent: number;
  isKeg: boolean;
  isActive: boolean;
}

export interface PurchasePresentation {
  id: string;
  inventoryItemId: string;
  name: string; // e.g., "Barril 30L", "Botella 750ml", "Canasta x30"
  factorToBase: number; // e.g., 30000 ml, 750 ml, 30 unit
  lastPurchaseCost?: number | null;
  isDefault: boolean;
}

export interface AllyOperatingSchedule {
  /** ISO days of week: 1=Monday .. 7=Sunday. Null/empty = every day */
  daysOfWeek?: number[] | null;
  /** "HH:MM" in branch local time (supports overnight e.g. 18:00 -> 01:00) */
  openTime?: string | null;
  closeTime?: string | null;
}

export interface Ally {
  id: string;
  branchId: string;
  name: string;
  contactPhone?: string | null;
  operatingSchedule?: AllyOperatingSchedule | null;
  isTemporarilyClosed: boolean;
  isActive: boolean;
}

export interface MenuCategory {
  id: string;
  branchId: string;
  name: string;
  colorToken: string;
  sortOrder: number;
  isActive: boolean;
}

export interface MenuProduct {
  id: string;
  branchId: string;
  categoryId: string;
  name: string;
  shortLabel?: string | null;
  imageUrl?: string | null;
  productKind: ProductKind;
  allyId?: string | null;
  availableFrom?: string | null; // Optional "HH:MM"
  availableUntil?: string | null; // Optional "HH:MM"
  isAvailable: boolean;
  sortOrder: number;
}

export interface PresentationRecipeIngredient {
  id: string;
  presentationId: string;
  inventoryItemId: string;
  displayUnit: DisplayUnit;
  displayQuantity: number;
  quantityBase: number;
  /** Overrides default foam/pour loss for this specific presentation (e.g., 8% pinta vs 3% jirafa vs 0% botella). */
  pourLossPercent: number;
  fixedLossBase: number;
}

export interface ProductPresentation {
  id: string;
  branchId: string;
  menuProductId: string;
  name: string; // e.g. "Vaso 330ml", "Pinta 500ml", "Jirafa 3L", "Shot 1.5oz", "Combo Alitas"
  shortLabel?: string | null;
  presentationGroup: PresentationGroup;
  imageUrl?: string | null;
  salePrice: number;
  /** If this presentation includes or belongs to a third-party ally, exact payout owed to the ally per unit sold. */
  allyId?: string | null;
  allyPayoutAmount: number;
  isAvailable: boolean;
  sortOrder: number;
  recipes: PresentationRecipeIngredient[];
}

export interface Customer {
  id: string;
  branchId: string;
  fullName: string;
  nickname?: string | null;
  phone?: string | null;
  creditStatus: CreditStatus;
  creditLimit?: number | null;
  currentDebt: number;
  statusReason?: string | null;
}

export interface PaymentMethod {
  id: string;
  branchId: string;
  name: string;
  code: string;
  countsAsPhysicalCash: boolean;
  sortOrder: number;
  isActive: boolean;
}

export type PromotionRuleType = "bxgy" | "percentage_discount" | "fixed_discount" | "fixed_price";
export type PromotionScopeType = "category" | "product" | "presentation" | "order";

export interface PromotionRule {
  id: string;
  branchId: string;
  name: string;
  ruleType: PromotionRuleType;
  scopeType: PromotionScopeType;
  targetId?: string | null;
  /** ISO days: 1=Mon .. 7=Sun */
  daysOfWeek?: number[] | null;
  /** "HH:MM" local time */
  startTime?: string | null;
  endTime?: string | null;
  config: {
    buyQty?: number;
    payQty?: number;
    percent?: number;
    fixedAmount?: number;
    fixedUnitPrice?: number;
  };
  priority: number;
  isStackable: boolean;
  isActive: boolean;
}

export interface OrderItemLine {
  id: string;
  subAccountId: string;
  menuProductId: string;
  presentationId: string;
  categoryId: string;
  productNameSnap: string;
  presentationNameSnap: string;
  presentationGroupSnap: PresentationGroup;
  productKindSnap: ProductKind;
  quantity: number;
  unitPriceSnap: number;
  allyIdSnap?: string | null;
  allyPayoutSnap: number;
  promotionRuleId?: string | null;
  discountAmount: number;
  lineTotal: number;
  status: "active" | "voided";
}

export type SyncCommandType =
  | "OPEN_TABLE_SESSION"
  | "CREATE_SUB_ACCOUNT"
  | "ADD_ORDER_ITEM"
  | "VOID_ORDER_ITEM"
  | "MOVE_ORDER_ITEM"
  | "RECORD_PAYMENT"
  | "CHARGE_SUB_ACCOUNT_CREDIT"
  | "CLOSE_CASH_SHIFT";

export interface OfflineSyncCommand<TPayload = Record<string, unknown>> {
  idempotencyKey: string; // UUIDv7
  branchId: string;
  deviceId: string;
  userId: string;
  commandType: SyncCommandType;
  clientHlc: string; // ISO timestamptz
  payload: TPayload;
}

