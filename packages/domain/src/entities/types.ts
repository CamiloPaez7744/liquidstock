import type { BaseUnit, DisplayUnit } from "../value-objects/units.js";

export type UserRole = "admin" | "waiter" | "cashier";

export type AppModuleId = "pos" | "inventory" | "cash" | "finance" | "kpis" | "settings" | "users";

export type ModuleAccessLevel = "none" | "view" | "edit";

export type RoleModulePermissions = Record<AppModuleId, ModuleAccessLevel>;

export type BranchRolePermissions = Record<UserRole, RoleModulePermissions>;

export const DEFAULT_BRANCH_ROLE_PERMISSIONS: BranchRolePermissions = {
  admin: {
    pos: "edit",
    inventory: "edit",
    cash: "edit",
    finance: "edit",
    kpis: "edit",
    settings: "edit",
    users: "edit",
  },
  cashier: {
    pos: "edit",
    inventory: "view",
    cash: "edit",
    finance: "none",
    kpis: "none",
    settings: "none",
    users: "none",
  },
  waiter: {
    pos: "edit",
    inventory: "view",
    cash: "edit",
    finance: "none",
    kpis: "none",
    settings: "none",
    users: "none",
  },
};

export function resolveBranchRolePermissions(
  raw?: Partial<Record<UserRole, Partial<RoleModulePermissions>>> | null,
): BranchRolePermissions {
  return {
    admin: { ...DEFAULT_BRANCH_ROLE_PERMISSIONS.admin },
    cashier: {
      ...DEFAULT_BRANCH_ROLE_PERMISSIONS.cashier,
      ...(raw?.cashier ?? {}),
    },
    waiter: {
      ...DEFAULT_BRANCH_ROLE_PERMISSIONS.waiter,
      ...(raw?.waiter ?? {}),
    },
  };
}

export function hasModuleAccess(
  permissions: RoleModulePermissions,
  moduleId: AppModuleId,
  required: "view" | "edit",
): boolean {
  const level = permissions[moduleId] ?? "none";
  if (required === "view") return level === "view" || level === "edit";
  return level === "edit";
}

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

export interface OperatingScheduleSlot {
  /** ISO days of week: 1=Mon .. 7=Sun */
  daysOfWeek: number[];
  /** "HH:MM" in branch local time (supports overnight e.g. 17:00 -> 03:00) */
  openTime: string;
  closeTime: string;
  /** Optional calendar range "YYYY-MM-DD" (for seasonal / holiday schedules) */
  validFrom?: string | null;
  validUntil?: string | null;
  label?: string | null;
}

export interface Branch {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  timezone: string;
  featureFlags: BranchFeatureFlags;
  rolePermissions?: BranchRolePermissions;
  operatingSchedules?: OperatingScheduleSlot[];
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
  operatingSchedules?: OperatingScheduleSlot[];
  isTemporarilyClosed: boolean;
  isActive: boolean;
}

export interface ComboFixedRecipeItem {
  inventoryItemId: string;
  displayUnit: DisplayUnit;
  displayQuantity: number;
  quantityBase: number;
  itemName?: string | null;
}

export interface ComboTemplate {
  id: string;
  branchId: string;
  name: string;
  shortLabel?: string | null;
  scopeType: "category" | "product";
  targetId: string;
  presentationGroup: PresentationGroup;
  /** Number of base drinks included in the combo (default 1, e.g. 2x Pinta + Salchipapa) */
  baseQuantity?: number;
  /** Whether the fixed companion is from a third-party ally, house stock, or both */
  companionType?: "ally" | "house" | "both";
  pricingMode: "fixed_price" | "add_on_price";
  priceValue: number;
  allyId?: string | null;
  allyPayoutAmount: number;
  /** Optional in-house fixed inventory items deducted alongside the chosen drink */
  fixedRecipes?: ComboFixedRecipeItem[];
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
  /** Optional seasonal/special edition badge shown in POS & Stock (e.g. "Temporada", "Edición Limitada") */
  editionTag?: string | null;
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
  isInternalVault?: boolean;
  sortOrder: number;
  isActive: boolean;
}

export type PromotionRuleType = "bxgy" | "percentage_discount" | "fixed_discount" | "fixed_price";
export type PromotionScopeType = "category" | "product" | "presentation" | "order";
export type PromotionApplicationMode = "automatic" | "manual_at_checkout";

export interface PromotionRule {
  id: string;
  branchId: string;
  name: string;
  ruleType: PromotionRuleType;
  scopeType: PromotionScopeType;
  applicationMode?: PromotionApplicationMode;
  targetId?: string | null;
  /** ISO days: 1=Mon .. 7=Sun */
  daysOfWeek?: number[] | null;
  /** "HH:MM" local time */
  startTime?: string | null;
  endTime?: string | null;
  /** Optional calendar date range "YYYY-MM-DD" (e.g. March Women's Month: 2026-03-01 .. 2026-03-31) */
  validFrom?: string | null;
  validUntil?: string | null;
  config: {
    buyQty?: number;
    payQty?: number;
    percent?: number;
    fixedAmount?: number;
    fixedUnitPrice?: number;
    minQuantity?: number;
    /** Optional filter by presentation group(s) (e.g. ["pinta"] or ["jirafa"]) across a category, product, or whole order */
    presentationGroups?: PresentationGroup[];
  };
  priority: number;
  isStackable: boolean;
  isActive: boolean;
}

export interface OrderItemLine {
  id: string;
  subAccountId: string;
  menuProductId?: string | null;
  presentationId?: string | null;
  categoryId?: string | null;
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
  adjustmentReason?: string | null;
  status: "active" | "voided";
}

export type SyncCommandType =
  | "OPEN_TABLE_SESSION"
  | "CREATE_SUB_ACCOUNT"
  | "UPDATE_SUB_ACCOUNT"
  | "DELETE_SUB_ACCOUNT"
  | "ADD_ORDER_ITEM"
  | "ADD_CUSTOM_CHARGE"
  | "VOID_ORDER_ITEM"
  | "MOVE_ORDER_ITEM"
  | "ADJUST_ORDER_ITEM_PRICE"
  | "APPLY_PROMOTION_TO_SUB_ACCOUNT"
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

