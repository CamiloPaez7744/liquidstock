-- Seasonal / Limited Edition badge tag for menu products (e.g. "Temporada", "Edición Limitada")
ALTER TABLE menu_products ADD COLUMN IF NOT EXISTS edition_tag TEXT;
