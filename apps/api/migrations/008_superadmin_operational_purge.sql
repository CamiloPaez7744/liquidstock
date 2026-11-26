-- ============================================================================
-- 008: SuperAdmin Operational Purge (Go-Live Reset) & Ledger Guard Support
-- ============================================================================

-- Track when a branch officially completed its Go-Live test-data purge
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS operational_go_live_at timestamptz;

-- Preserve strict append-only immutability for all normal traffic, while allowing
-- transaction-local authorized SuperAdmin Go-Live purges via set_config(..., true).
CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('liquistock.allow_superadmin_purge', true) = 'true' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Ledger table % is append-only; use a compensating entry instead.', TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;
