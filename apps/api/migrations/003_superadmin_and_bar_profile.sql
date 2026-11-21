-- ============================================================================
-- LIQUISTOCK — MIGRACIÓN 003: SUPERADMIN DE PLATAFORMA, APROBACIÓN DE BARES
-- Y PERFIL COMPLETO DEL BAR (LOGO, RAZÓN SOCIAL, REDES SOCIALES)
-- ============================================================================

-- 1. SuperAdmin a nivel de plataforma (no pertenece a un bar específico)
ALTER TABLE users ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS users_super_admin_idx
  ON users (id)
  WHERE is_super_admin = true;

-- 2. Perfil completo del Bar / Restaurante + flujo de aprobación por SuperAdmin
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS business_type text NOT NULL DEFAULT 'bar'
    CHECK (business_type IN ('bar', 'restaurant', 'brewery', 'pub', 'cafe', 'other')),
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS tax_id text,
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS social_links jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending_approval'
    CHECK (approval_status IN ('pending_approval', 'approved', 'rejected', 'suspended')),
  ADD COLUMN IF NOT EXISTS approval_notes text,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS organizations_approval_status_idx
  ON organizations (approval_status, created_at DESC);

CREATE INDEX IF NOT EXISTS organizations_owner_idx
  ON organizations (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

