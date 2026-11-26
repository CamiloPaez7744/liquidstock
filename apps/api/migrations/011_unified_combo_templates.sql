-- 011_unified_combo_templates.sql
-- Unifies dynamic category/product combos with fixed companions (third-party ally food AND/OR in-house stock items)
-- and supports multi-drink combos (e.g. 2 Pintas of any Craft Beer + Salchipapa / Empanadas de la casa).

ALTER TABLE combo_templates
  ADD COLUMN IF NOT EXISTS base_quantity integer NOT NULL DEFAULT 1 CHECK (base_quantity >= 1);

ALTER TABLE combo_templates
  ADD COLUMN IF NOT EXISTS companion_type text NOT NULL DEFAULT 'ally'
    CHECK (companion_type IN ('ally', 'house', 'both'));

ALTER TABLE combo_templates
  ADD COLUMN IF NOT EXISTS fixed_recipes jsonb NOT NULL DEFAULT '[]'::jsonb;
