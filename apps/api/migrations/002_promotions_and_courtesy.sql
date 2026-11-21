-- ============================================================================
-- MIGRACIÓN 002: PROMOCIONES AVANZADAS (FECHAS / MODO MANUAL) Y CORTESÍAS AUDITADAS
-- ============================================================================

ALTER TABLE promotion_rules
    ADD COLUMN IF NOT EXISTS valid_from date,
    ADD COLUMN IF NOT EXISTS valid_until date,
    ADD COLUMN IF NOT EXISTS application_mode text NOT NULL DEFAULT 'automatic'
        CHECK (application_mode IN ('automatic', 'manual_at_checkout'));

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS adjustment_reason text,
    ADD COLUMN IF NOT EXISTS adjusted_by uuid REFERENCES users(id);

