-- ============================================================================
-- 007: Custom Extra Charges in POS Accounts & Misc Extra Inflows in Cash Box
-- ============================================================================

-- Allow custom charges on order_items without tying to a catalog menu product / presentation
ALTER TABLE order_items
  ALTER COLUMN menu_product_id DROP NOT NULL,
  ALTER COLUMN presentation_id DROP NOT NULL;

-- Track misc / additional cash or bank inflows (cover, glass breakage, rental, tips, adjustments)
CREATE TABLE IF NOT EXISTS cash_extras (
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  cash_shift_id     uuid REFERENCES cash_shifts(id) ON DELETE SET NULL,
  payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
  category          text NOT NULL DEFAULT 'otro',
  description       text NOT NULL,
  amount            numeric(14,2) NOT NULL CHECK (amount > 0),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_extras_branch_created
  ON cash_extras (branch_id, created_at DESC);
