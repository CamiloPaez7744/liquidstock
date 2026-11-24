-- Daily cash outflows / operating expense payments (utilities, ice, supplies, staff, etc.)
-- plus per-payment-method reconciliation breakdown on shift closure
CREATE TABLE IF NOT EXISTS cash_expenses (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  cash_shift_id uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
  payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
  category text NOT NULL DEFAULT 'otro',
  description text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_expenses_branch_created
  ON cash_expenses (branch_id, created_at DESC);

ALTER TABLE cash_shifts
  ADD COLUMN IF NOT EXISTS declared_by_method jsonb NOT NULL DEFAULT '{}'::jsonb;
