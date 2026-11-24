-- Parametric per-role module access permissions (none | view | edit) configurable per branch
ALTER TABLE branches ADD COLUMN IF NOT EXISTS role_permissions jsonb NOT NULL DEFAULT '{}'::jsonb;
