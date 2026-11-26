-- ============================================================================
-- 009: Treasury Vault (Bodega), Cash Transfers, Supplier Payables,
--      Category/Product Combo Templates & Multi-Slot Operating Schedules
-- ============================================================================

-- 1. Mark internal treasury accounts (like "Bodega") so they never show as POS checkout methods
ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS is_internal_vault boolean NOT NULL DEFAULT false;

-- 2. Multi-slot operating schedules (weekdays vs late-night weekends + optional date ranges)
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS operating_schedules jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE allies
  ADD COLUMN IF NOT EXISTS operating_schedules jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 3. Day-to-day shift opening carryover audit & vault transfers at shift closure
ALTER TABLE cash_shifts
  ADD COLUMN IF NOT EXISTS expected_opening_float numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_discrepancy numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transfer_to_vault_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS closing_cash_left numeric(12,2);

-- 4. Link editable cash expenses to stock purchases / supplier payments
ALTER TABLE cash_expenses
  ADD COLUMN IF NOT EXISTS reference_type text,
  ADD COLUMN IF NOT EXISTS reference_id uuid;

-- 5. Internal treasury transfers (e.g. Efectivo Caja -> Bodega, Bodega -> Nequi)
CREATE TABLE IF NOT EXISTS cash_transfers (
  id                     uuid PRIMARY KEY,
  branch_id              uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  cash_shift_id          uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
  from_payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
  to_payment_method_id   uuid NOT NULL REFERENCES payment_methods(id),
  amount                 numeric(14,2) NOT NULL CHECK (amount > 0),
  notes                  text,
  created_by             uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_transfers_branch_created
  ON cash_transfers (branch_id, created_at DESC);

-- 6. Supplier Accounts Payable ("Debemos" side of dual credit/receivables)
CREATE TABLE IF NOT EXISTS supplier_payables (
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  supplier_name     text NOT NULL,
  description       text NOT NULL,
  inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  total_amount      numeric(14,2) NOT NULL CHECK (total_amount > 0),
  paid_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid')),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_payables_branch
  ON supplier_payables (branch_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id                  uuid PRIMARY KEY,
  branch_id           uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  supplier_payable_id uuid NOT NULL REFERENCES supplier_payables(id) ON DELETE CASCADE,
  payment_method_id   uuid NOT NULL REFERENCES payment_methods(id),
  cash_expense_id     uuid REFERENCES cash_expenses(id) ON DELETE SET NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  notes               text,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_payable
  ON supplier_payments (supplier_payable_id, created_at DESC);

-- 7. Dynamic Category / Product Combo Templates (e.g. Any Craft Beer 330ml + Hot Dog Ally)
CREATE TABLE IF NOT EXISTS combo_templates (
  id                 uuid PRIMARY KEY,
  branch_id          uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name               text NOT NULL,
  short_label        text,
  scope_type         text NOT NULL CHECK (scope_type IN ('category', 'product')),
  target_id          uuid NOT NULL,
  presentation_group text NOT NULL,
  pricing_mode       text NOT NULL DEFAULT 'fixed_price' CHECK (pricing_mode IN ('fixed_price', 'add_on_price')),
  price_value        numeric(12,2) NOT NULL CHECK (price_value >= 0),
  ally_id            uuid REFERENCES allies(id) ON DELETE SET NULL,
  ally_payout_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (ally_payout_amount >= 0),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_combo_templates_branch
  ON combo_templates (branch_id, is_active);
