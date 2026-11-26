-- ============================================================================
-- 010: Optional Description / Identification Note on POS Sub-Accounts
-- ============================================================================

ALTER TABLE sub_accounts
  ADD COLUMN IF NOT EXISTS description text;
