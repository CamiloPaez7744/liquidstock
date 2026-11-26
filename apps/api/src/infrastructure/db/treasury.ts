import { generateUuidV7 } from "@liquistock/domain";
import { type DbClient, db } from "./pool.js";

export type BranchVaultAccount = {
  id: string;
  branchId: string;
  name: string;
  code: string;
  countsAsPhysicalCash: boolean;
  isInternalVault: boolean;
  sortOrder: number;
  isActive: boolean;
};

/**
 * Ensures every active branch has a dedicated internal "Bodega" treasury account
 * (hidden from POS customer checkout, available in Cash Closure, Finance Ledger & Stock purchases).
 */
export async function ensureBranchVaultAccount(
  branchId: string,
  client: DbClient = db,
): Promise<BranchVaultAccount> {
  const existing = await client.query<BranchVaultAccount>(
    `SELECT id, branch_id AS "branchId", name, code,
            counts_as_physical_cash AS "countsAsPhysicalCash",
            is_internal_vault AS "isInternalVault",
            sort_order AS "sortOrder",
            is_active AS "isActive"
     FROM payment_methods
     WHERE branch_id = $1 AND (is_internal_vault = true OR code = 'VAULT')
     ORDER BY is_internal_vault DESC
     LIMIT 1`,
    [branchId],
  );
  if (existing.rows[0]) {
    if (!existing.rows[0].isInternalVault || !existing.rows[0].isActive) {
      await client.query(
        `UPDATE payment_methods
         SET is_internal_vault = true, counts_as_physical_cash = false, is_active = true
         WHERE id = $1`,
        [existing.rows[0].id],
      );
    }
    return {
      ...existing.rows[0],
      isInternalVault: true,
      countsAsPhysicalCash: false,
      isActive: true,
    };
  }

  const id = generateUuidV7();
  await client.query(
    `INSERT INTO payment_methods
       (id, branch_id, name, code, counts_as_physical_cash, is_internal_vault, sort_order, is_active)
     VALUES ($1, $2, 'Bodega', 'VAULT', false, true, 999, true)
     ON CONFLICT (branch_id, code) DO UPDATE
       SET is_internal_vault = true, counts_as_physical_cash = false, is_active = true`,
    [id, branchId],
  );

  const created = await client.query<BranchVaultAccount>(
    `SELECT id, branch_id AS "branchId", name, code,
            counts_as_physical_cash AS "countsAsPhysicalCash",
            is_internal_vault AS "isInternalVault",
            sort_order AS "sortOrder",
            is_active AS "isActive"
     FROM payment_methods
     WHERE branch_id = $1 AND code = 'VAULT'
     LIMIT 1`,
    [branchId],
  );
  return created.rows[0]!;
}

export interface OpenShiftStatus {
  shift: {
    id: string;
    branchId: string;
    status: string;
    openedAt: string;
    openingFloat: number;
    expectedOpeningFloat: number;
    openingDiscrepancy: number;
  } | null;
  hoursOpen: number;
  isExpired24h: boolean;
  lastClosedCashLeft: number;
}

export async function getBranchOpenShiftStatus(
  branchId: string,
  client: DbClient = db,
): Promise<OpenShiftStatus> {
  const [openRes, lastClosedRes] = await Promise.all([
    client.query<{
      id: string;
      branchId: string;
      status: string;
      openedAt: string;
      openingFloat: number;
      expectedOpeningFloat: number;
      openingDiscrepancy: number;
    }>(
      `SELECT id, branch_id AS "branchId", status, opened_at AS "openedAt",
              opening_float::float8 AS "openingFloat",
              COALESCE(expected_opening_float, 0)::float8 AS "expectedOpeningFloat",
              COALESCE(opening_discrepancy, 0)::float8 AS "openingDiscrepancy"
       FROM cash_shifts
       WHERE branch_id = $1 AND status = 'open'
       LIMIT 1`,
      [branchId],
    ),
    client.query<{ cash_left: number }>(
      `SELECT COALESCE(
                closing_cash_left,
                GREATEST(0, COALESCE(declared_physical_cash, 0) - COALESCE(transfer_to_vault_amount, 0))
              )::float8 AS cash_left
       FROM cash_shifts
       WHERE branch_id = $1 AND status = 'closed'
       ORDER BY closed_at DESC NULLS LAST
       LIMIT 1`,
      [branchId],
    ),
  ]);

  const shift = openRes.rows[0] ?? null;
  const lastClosedCashLeft = Number(lastClosedRes.rows[0]?.cash_left ?? 0);
  if (!shift) {
    return { shift: null, hoursOpen: 0, isExpired24h: false, lastClosedCashLeft };
  }

  const hoursOpen = Math.max(0, (Date.now() - new Date(shift.openedAt).getTime()) / (1000 * 60 * 60));
  const isExpired24h = hoursOpen > 24;

  return {
    shift,
    hoursOpen: Math.round(hoursOpen * 10) / 10,
    isExpired24h,
    lastClosedCashLeft,
  };
}
