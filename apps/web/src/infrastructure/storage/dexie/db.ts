import Dexie, { type Table } from "dexie";
import {
  generateUuidV7,
  type Ally,
  type Branch,
  type Customer,
  type InventoryItem,
  type MenuCategory,
  type MenuProduct,
  type OfflineSyncCommand,
  type OrderItemLine,
  type PaymentMethod,
  type ProductPresentation,
  type PromotionRule,
  type PurchasePresentation,
  type SyncCommandType,
} from "@liquistock/domain";

export interface OutboxRecord extends OfflineSyncCommand {
  syncStatus: "pending" | "syncing" | "synced" | "conflict";
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export interface LocalBranchUser {
  id: string;
  fullName: string;
  role: "admin" | "waiter" | "cashier";
  quickPin?: string | null;
}

export interface LocalDiningTable {
  id: string;
  branchId: string;
  label: string;
  zone: string;
  sortOrder: number;
}

export interface LocalTableSession {
  id: string;
  branchId: string;
  diningTableId: string | null;
  cashShiftId: string;
  status: "open" | "closed" | "voided";
  openedAt: string;
}

export interface LocalSubAccount {
  id: string;
  branchId: string;
  tableSessionId: string;
  label: string;
  customerId?: string | null;
  status: "open" | "paid" | "credit" | "partial_credit" | "voided";
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  paidAmount: number;
  creditAmount: number;
  version: number;
  updatedAt: string;
}

export interface SyncMetaRecord {
  key: string;
  value: string;
}

export class LiquiStockLocalDb extends Dexie {
  branches!: Table<Branch, string>;
  branchUsers!: Table<LocalBranchUser, string>;
  diningTables!: Table<LocalDiningTable, string>;
  categories!: Table<MenuCategory, string>;
  menuProducts!: Table<MenuProduct, string>;
  presentations!: Table<ProductPresentation, string>;
  inventoryItems!: Table<InventoryItem, string>;
  purchasePresentations!: Table<PurchasePresentation, string>;
  allies!: Table<Ally, string>;
  customers!: Table<Customer, string>;
  paymentMethods!: Table<PaymentMethod, string>;
  promotionRules!: Table<PromotionRule, string>;
  tableSessions!: Table<LocalTableSession, string>;
  subAccounts!: Table<LocalSubAccount, string>;
  orderItems!: Table<OrderItemLine, string>;
  syncOutbox!: Table<OutboxRecord, string>;
  syncMeta!: Table<SyncMetaRecord, string>;

  constructor() {
    super("LiquiStockLocalDB");
    this.version(2).stores({
      branches: "id",
      branchUsers: "id, role",
      diningTables: "id, branchId, sortOrder",
      categories: "id, branchId, sortOrder",
      menuProducts: "id, branchId, categoryId, allyId, isAvailable",
      presentations: "id, branchId, menuProductId, presentationGroup, allyId",
      inventoryItems: "id, branchId, isKeg, isActive",
      purchasePresentations: "id, inventoryItemId",
      allies: "id, branchId, isActive",
      customers: "id, branchId, creditStatus, fullName",
      paymentMethods: "id, branchId, sortOrder",
      promotionRules: "id, branchId, isActive, priority",
      tableSessions: "id, branchId, diningTableId, status",
      subAccounts: "id, branchId, tableSessionId, status",
      orderItems: "id, subAccountId, status",
      syncOutbox: "idempotencyKey, [branchId+syncStatus], syncStatus, createdAt",
      syncMeta: "key",
    });
  }
}

export const localDb = new LiquiStockLocalDb();

export function getOrCreateDeviceId(): string {
  const storageKey = "liquistock_device_id";
  const existing = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null;
  if (existing) return existing;
  const fresh = `dev_${generateUuidV7()}`;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(storageKey, fresh);
  }
  return fresh;
}

export async function enqueueOfflineCommand<TPayload extends Record<string, unknown>>(params: {
  branchId: string;
  userId: string;
  commandType: SyncCommandType;
  payload: TPayload;
}): Promise<OutboxRecord> {
  const nowIso = new Date().toISOString();
  const record: OutboxRecord = {
    idempotencyKey: generateUuidV7(),
    branchId: params.branchId,
    deviceId: getOrCreateDeviceId(),
    userId: params.userId,
    commandType: params.commandType,
    clientHlc: nowIso,
    payload: params.payload,
    syncStatus: "pending",
    attempts: 0,
    createdAt: nowIso,
  };

  await localDb.syncOutbox.put(record);
  return record;
}
