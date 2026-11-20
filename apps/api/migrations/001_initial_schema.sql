-- ============================================================================
-- LIQUISTOCK — MIGRACIÓN INICIAL POSTGRESQL 16
-- Clean Architecture + Offline-First + Multi-Sucursal + Barriles/Espuma + Ledger
-- ============================================================================

-- 1. MULTI-SUCURSAL, CONFIGURACIÓN MODULAR Y ROLES
CREATE TABLE IF NOT EXISTS organizations (
    id          uuid PRIMARY KEY,
    name        text NOT NULL,
    currency    text NOT NULL DEFAULT 'COP',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
    id              uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id),
    name            text NOT NULL,
    code            text NOT NULL,
    timezone        text NOT NULL DEFAULT 'America/Bogota',
    -- Configuración modular por bar: cada local enciende solo lo que necesita
    feature_flags   jsonb NOT NULL DEFAULT '{
        "enableTables": true,
        "enableSplitAccounts": true,
        "enableCreditAccounts": true,
        "enableAllies": true,
        "enablePromotions": true,
        "enableFoamLossFormula": true,
        "hideOutOfStockInPos": false,
        "autoHideClosedAllies": true,
        "allowCloseShiftWithOpenTables": true
    }'::jsonb,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS branches_org_idx ON branches (organization_id);

CREATE TABLE IF NOT EXISTS users (
    id              uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id),
    full_name       text NOT NULL,
    email           text UNIQUE,
    password_hash   text,
    quick_pin_hash  text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_org_idx ON users (organization_id);

CREATE TABLE IF NOT EXISTS branch_memberships (
    id          uuid PRIMARY KEY,
    branch_id   uuid NOT NULL REFERENCES branches(id),
    user_id     uuid NOT NULL REFERENCES users(id),
    role        text NOT NULL CHECK (role IN ('admin', 'waiter', 'cashier')),
    permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (branch_id, user_id)
);
CREATE INDEX IF NOT EXISTS branch_memberships_user_idx ON branch_memberships (user_id);

-- 2. INVENTARIO INTELIGENTE (UNIDAD BASE), BARRILES Y PRESENTACIONES DE COMPRA
CREATE TABLE IF NOT EXISTS inventory_items (
    id                       uuid PRIMARY KEY,
    branch_id                uuid NOT NULL REFERENCES branches(id),
    sku                      text,
    name                     text NOT NULL,
    base_unit                text NOT NULL CHECK (base_unit IN ('ml', 'g', 'unit')),
    current_stock_base       numeric(14, 3) NOT NULL DEFAULT 0,
    min_stock_base           numeric(14, 3) NOT NULL DEFAULT 0,
    avg_unit_cost_base       numeric(12, 6) NOT NULL DEFAULT 0,
    default_pour_loss_pct    numeric(5, 2) NOT NULL DEFAULT 0 CHECK (default_pour_loss_pct >= 0),
    is_keg                   boolean NOT NULL DEFAULT false,
    is_active                boolean NOT NULL DEFAULT true,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_items_branch_active_idx ON inventory_items (branch_id, name) WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_branch_sku_uq ON inventory_items (branch_id, sku) WHERE sku IS NOT NULL;

CREATE TABLE IF NOT EXISTS purchase_presentations (
    id                  uuid PRIMARY KEY,
    inventory_item_id   uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    name                text NOT NULL, -- ej. "Barril 30L", "Barril 50L", "Botella 750ml", "Canasta x30"
    barcode             text,
    factor_to_base      numeric(14, 3) NOT NULL CHECK (factor_to_base > 0),
    last_purchase_cost  numeric(12, 2),
    is_default          boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_presentations_item_idx ON purchase_presentations (inventory_item_id);

-- 3. ALIADOS (CON HORARIO DE CIERRE AUTOMÁTICO), CATÁLOGO, PRESENTACIONES Y RECETAS
CREATE TABLE IF NOT EXISTS allies (
    id                    uuid PRIMARY KEY,
    branch_id             uuid NOT NULL REFERENCES branches(id),
    name                  text NOT NULL,
    contact_phone         text,
    -- Horario operativo para ocultar combos automáticamente al cerrar el aliado
    operating_days        smallint[], -- ISO 1=Lun..7=Dom; NULL = todos los días
    open_time             time,
    close_time            time,
    is_temporarily_closed boolean NOT NULL DEFAULT false,
    settlement_notes      text,
    is_active             boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS allies_branch_active_idx ON allies (branch_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS categories (
    id          uuid PRIMARY KEY,
    branch_id   uuid NOT NULL REFERENCES branches(id),
    name        text NOT NULL,
    color_token text NOT NULL DEFAULT 'cyan',
    sort_order  integer NOT NULL DEFAULT 0,
    is_active   boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS categories_branch_sort_idx ON categories (branch_id, sort_order) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS menu_products (
    id              uuid PRIMARY KEY,
    branch_id       uuid NOT NULL REFERENCES branches(id),
    category_id     uuid NOT NULL REFERENCES categories(id),
    name            text NOT NULL, -- ej. "IPA Artesanal", "Tequila Don Julio", "Combo Jirafa + Alitas"
    short_label     text,
    image_url       text,          -- Imagen configurable por el admin (cacheada offline en PWA)
    product_kind    text NOT NULL CHECK (product_kind IN ('standard', 'combo', 'third_party_ally')),
    ally_id         uuid REFERENCES allies(id),
    available_from  time,          -- Ventana horaria opcional
    available_until time,
    is_available    boolean NOT NULL DEFAULT true,
    sort_order      integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS menu_products_branch_cat_idx ON menu_products (branch_id, category_id, sort_order) WHERE is_available = true;
CREATE INDEX IF NOT EXISTS menu_products_ally_idx ON menu_products (ally_id) WHERE ally_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_presentations (
    id                  uuid PRIMARY KEY,
    branch_id           uuid NOT NULL REFERENCES branches(id),
    menu_product_id     uuid NOT NULL REFERENCES menu_products(id) ON DELETE CASCADE,
    name                text NOT NULL, -- ej. "Vaso 330ml", "Pinta 500ml", "Jirafa 3L", "Shot 1.5oz", "Botella 750ml"
    short_label         text,
    presentation_group  text NOT NULL DEFAULT 'otro' CHECK (
        presentation_group IN ('vaso', 'pinta', 'jarra', 'jirafa', 'shot', 'trago', 'coctel', 'botella', 'lata', 'combo', 'comida', 'otro')
    ),
    image_url           text,
    sale_price          numeric(12, 2) NOT NULL CHECK (sale_price >= 0),
    ally_id             uuid REFERENCES allies(id),
    ally_payout_amount  numeric(12, 2) NOT NULL DEFAULT 0 CHECK (ally_payout_amount >= 0),
    is_available        boolean NOT NULL DEFAULT true,
    sort_order          integer NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_presentations_product_idx ON product_presentations (menu_product_id, sort_order) WHERE is_available = true;
CREATE INDEX IF NOT EXISTS product_presentations_branch_group_idx ON product_presentations (branch_id, presentation_group);
CREATE INDEX IF NOT EXISTS product_presentations_ally_idx ON product_presentations (ally_id) WHERE ally_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS presentation_recipes (
    id                  uuid PRIMARY KEY,
    presentation_id     uuid NOT NULL REFERENCES product_presentations(id) ON DELETE CASCADE,
    inventory_item_id   uuid NOT NULL REFERENCES inventory_items(id),
    display_unit        text NOT NULL CHECK (display_unit IN ('ml', 'oz', 'L', 'g', 'kg', 'unit')),
    display_quantity    numeric(12, 3) NOT NULL CHECK (display_quantity > 0),
    quantity_base       numeric(14, 3) NOT NULL CHECK (quantity_base > 0),
    -- Fórmula de merma por espuma / purga configurable por presentación (ej. 8% pinta vs 3% jirafa vs 0% botella)
    pour_loss_percent   numeric(5, 2) NOT NULL DEFAULT 0 CHECK (pour_loss_percent >= 0),
    fixed_loss_base     numeric(12, 3) NOT NULL DEFAULT 0 CHECK (fixed_loss_base >= 0),
    UNIQUE (presentation_id, inventory_item_id)
);
CREATE INDEX IF NOT EXISTS presentation_recipes_item_idx ON presentation_recipes (inventory_item_id);

-- 4. CLIENTES (LISTA BLANCA / LISTA NEGRA) Y CARTERA
CREATE TABLE IF NOT EXISTS customers (
    id              uuid PRIMARY KEY,
    branch_id       uuid NOT NULL REFERENCES branches(id),
    full_name       text NOT NULL,
    nickname        text,
    phone           text,
    document_number text,
    credit_status   text NOT NULL DEFAULT 'standard' CHECK (credit_status IN ('standard', 'whitelist_credit', 'blacklist_blocked')),
    credit_limit    numeric(12, 2) CHECK (credit_limit IS NULL OR credit_limit >= 0),
    current_debt    numeric(12, 2) NOT NULL DEFAULT 0 CHECK (current_debt >= 0),
    status_reason   text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_branch_status_idx ON customers (branch_id, credit_status);
CREATE INDEX IF NOT EXISTS customers_branch_name_idx ON customers (branch_id, full_name);

-- 5. MEDIOS DE PAGO, PROMOCIONES MODULARES Y TURNOS DE CAJA
CREATE TABLE IF NOT EXISTS payment_methods (
    id                      uuid PRIMARY KEY,
    branch_id               uuid NOT NULL REFERENCES branches(id),
    name                    text NOT NULL,
    code                    text NOT NULL,
    counts_as_physical_cash boolean NOT NULL DEFAULT false,
    sort_order              integer NOT NULL DEFAULT 0,
    is_active               boolean NOT NULL DEFAULT true,
    UNIQUE (branch_id, code)
);
CREATE INDEX IF NOT EXISTS payment_methods_branch_idx ON payment_methods (branch_id, sort_order) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS promotion_rules (
    id          uuid PRIMARY KEY,
    branch_id   uuid NOT NULL REFERENCES branches(id),
    name        text NOT NULL,
    rule_type   text NOT NULL CHECK (rule_type IN ('bxgy', 'percentage_discount', 'fixed_discount', 'fixed_price')),
    scope_type  text NOT NULL CHECK (scope_type IN ('category', 'product', 'presentation', 'order')),
    target_id   uuid,
    days_of_week smallint[],
    start_time  time,
    end_time    time,
    config      jsonb NOT NULL DEFAULT '{}'::jsonb,
    priority    integer NOT NULL DEFAULT 100,
    is_stackable boolean NOT NULL DEFAULT false,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotion_rules_branch_active_idx ON promotion_rules (branch_id, priority) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS cash_shifts (
    id                      uuid PRIMARY KEY,
    branch_id               uuid NOT NULL REFERENCES branches(id),
    opened_by               uuid NOT NULL REFERENCES users(id),
    closed_by               uuid REFERENCES users(id),
    status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_at               timestamptz NOT NULL DEFAULT now(),
    closed_at               timestamptz,
    opening_float           numeric(12, 2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
    total_gross_sales       numeric(12, 2) NOT NULL DEFAULT 0,
    total_discounts         numeric(12, 2) NOT NULL DEFAULT 0,
    total_net_sales         numeric(12, 2) NOT NULL DEFAULT 0,
    total_collected         numeric(12, 2) NOT NULL DEFAULT 0,
    total_credit_issued     numeric(12, 2) NOT NULL DEFAULT 0,
    total_credit_recovered  numeric(12, 2) NOT NULL DEFAULT 0,
    total_ally_payable      numeric(12, 2) NOT NULL DEFAULT 0,
    expected_physical_cash  numeric(12, 2),
    declared_physical_cash  numeric(12, 2),
    cash_discrepancy        numeric(12, 2),
    notes                   text
);
CREATE INDEX IF NOT EXISTS cash_shifts_branch_time_idx ON cash_shifts (branch_id, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cash_shifts_one_open_per_branch_uq ON cash_shifts (branch_id) WHERE status = 'open';

-- 6. MESAS, SUB-CUENTAS DIVIDIDAS Y ÓRDENES
CREATE TABLE IF NOT EXISTS dining_tables (
    id          uuid PRIMARY KEY,
    branch_id   uuid NOT NULL REFERENCES branches(id),
    label       text NOT NULL,
    zone        text NOT NULL DEFAULT 'Salón',
    sort_order  integer NOT NULL DEFAULT 0,
    is_active   boolean NOT NULL DEFAULT true,
    UNIQUE (branch_id, label)
);
CREATE INDEX IF NOT EXISTS dining_tables_branch_idx ON dining_tables (branch_id, sort_order) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS table_sessions (
    id              uuid PRIMARY KEY,
    branch_id       uuid NOT NULL REFERENCES branches(id),
    dining_table_id uuid REFERENCES dining_tables(id),
    cash_shift_id   uuid NOT NULL REFERENCES cash_shifts(id),
    opened_by       uuid NOT NULL REFERENCES users(id),
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'voided')),
    opened_at       timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz,
    device_id       text NOT NULL
);
CREATE INDEX IF NOT EXISTS table_sessions_branch_open_idx ON table_sessions (branch_id, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS table_sessions_shift_idx ON table_sessions (cash_shift_id);
CREATE INDEX IF NOT EXISTS table_sessions_table_idx ON table_sessions (dining_table_id);

CREATE TABLE IF NOT EXISTS sub_accounts (
    id                  uuid PRIMARY KEY,
    branch_id           uuid NOT NULL REFERENCES branches(id),
    table_session_id    uuid NOT NULL REFERENCES table_sessions(id),
    label               text NOT NULL DEFAULT 'Cuenta 1',
    customer_id         uuid REFERENCES customers(id),
    status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'credit', 'partial_credit', 'voided')),
    subtotal_amount     numeric(12, 2) NOT NULL DEFAULT 0,
    discount_amount     numeric(12, 2) NOT NULL DEFAULT 0,
    total_amount        numeric(12, 2) NOT NULL DEFAULT 0,
    paid_amount         numeric(12, 2) NOT NULL DEFAULT 0,
    credit_amount       numeric(12, 2) NOT NULL DEFAULT 0,
    version             integer NOT NULL DEFAULT 1,
    closed_at           timestamptz,
    closed_in_shift_id  uuid REFERENCES cash_shifts(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sub_accounts_session_idx ON sub_accounts (table_session_id);
CREATE INDEX IF NOT EXISTS sub_accounts_branch_open_idx ON sub_accounts (branch_id, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS sub_accounts_customer_idx ON sub_accounts (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sub_accounts_closed_shift_idx ON sub_accounts (closed_in_shift_id) WHERE closed_in_shift_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_items (
    id                      uuid PRIMARY KEY,
    branch_id               uuid NOT NULL REFERENCES branches(id),
    sub_account_id          uuid NOT NULL REFERENCES sub_accounts(id),
    menu_product_id         uuid NOT NULL REFERENCES menu_products(id),
    presentation_id         uuid NOT NULL REFERENCES product_presentations(id),
    added_by                uuid NOT NULL REFERENCES users(id),
    quantity                integer NOT NULL CHECK (quantity > 0),
    product_name_snap       text NOT NULL,
    presentation_name_snap  text NOT NULL,
    presentation_group_snap text NOT NULL,
    product_kind_snap       text NOT NULL CHECK (product_kind_snap IN ('standard', 'combo', 'third_party_ally')),
    unit_price_snap         numeric(12, 2) NOT NULL CHECK (unit_price_snap >= 0),
    ally_id_snap            uuid REFERENCES allies(id),
    ally_payout_snap        numeric(12, 2) NOT NULL DEFAULT 0,
    promotion_rule_id       uuid REFERENCES promotion_rules(id),
    discount_amount         numeric(12, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    line_total              numeric(12, 2) NOT NULL CHECK (line_total >= 0),
    status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
    void_reason             text,
    voided_by               uuid REFERENCES users(id),
    idempotency_key         uuid NOT NULL UNIQUE,
    device_id               text NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_items_sub_account_idx ON order_items (sub_account_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS order_items_kpi_product_idx ON order_items (branch_id, created_at DESC, menu_product_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS order_items_kpi_pres_idx ON order_items (branch_id, created_at DESC, presentation_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS order_item_transfers (
    id                  uuid PRIMARY KEY,
    order_item_id       uuid NOT NULL REFERENCES order_items(id),
    from_sub_account_id uuid NOT NULL REFERENCES sub_accounts(id),
    to_sub_account_id   uuid NOT NULL REFERENCES sub_accounts(id),
    moved_by            uuid NOT NULL REFERENCES users(id),
    moved_at            timestamptz NOT NULL DEFAULT now(),
    idempotency_key     uuid NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS order_item_transfers_item_idx ON order_item_transfers (order_item_id);

-- 7. PAGOS, CARTERA Y LIQUIDACIÓN DE ALIADOS
CREATE TABLE IF NOT EXISTS payments (
    id                  uuid PRIMARY KEY,
    branch_id           uuid NOT NULL REFERENCES branches(id),
    cash_shift_id       uuid NOT NULL REFERENCES cash_shifts(id),
    sub_account_id      uuid REFERENCES sub_accounts(id),
    customer_id         uuid REFERENCES customers(id),
    payment_method_id   uuid NOT NULL REFERENCES payment_methods(id),
    payment_purpose     text NOT NULL CHECK (payment_purpose IN ('sale_payment', 'credit_repayment')),
    amount              numeric(12, 2) NOT NULL CHECK (amount > 0),
    received_by         uuid NOT NULL REFERENCES users(id),
    reference_code      text,
    idempotency_key     uuid NOT NULL UNIQUE,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_shift_method_idx ON payments (cash_shift_id, payment_method_id);
CREATE INDEX IF NOT EXISTS payments_sub_account_idx ON payments (sub_account_id) WHERE sub_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_customer_idx ON payments (customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_credit_ledger (
    id              uuid PRIMARY KEY,
    branch_id       uuid NOT NULL REFERENCES branches(id),
    customer_id     uuid NOT NULL REFERENCES customers(id),
    cash_shift_id   uuid NOT NULL REFERENCES cash_shifts(id),
    sub_account_id  uuid REFERENCES sub_accounts(id),
    payment_id      uuid REFERENCES payments(id),
    entry_type      text NOT NULL CHECK (entry_type IN ('charge', 'repayment', 'adjustment')),
    amount_delta    numeric(12, 2) NOT NULL CHECK (amount_delta <> 0),
    balance_after   numeric(12, 2) NOT NULL CHECK (balance_after >= 0),
    notes           text,
    created_by      uuid NOT NULL REFERENCES users(id),
    idempotency_key uuid NOT NULL UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_credit_ledger_cust_idx ON customer_credit_ledger (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_credit_ledger_shift_idx ON customer_credit_ledger (cash_shift_id);

CREATE TABLE IF NOT EXISTS ally_settlement_entries (
    id              uuid PRIMARY KEY,
    branch_id       uuid NOT NULL REFERENCES branches(id),
    ally_id         uuid NOT NULL REFERENCES allies(id),
    cash_shift_id   uuid NOT NULL REFERENCES cash_shifts(id),
    order_item_id   uuid NOT NULL REFERENCES order_items(id),
    amount_payable  numeric(12, 2) NOT NULL CHECK (amount_payable >= 0),
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'voided')),
    settled_at      timestamptz,
    settled_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_item_id)
);
CREATE INDEX IF NOT EXISTS ally_settlement_branch_pending_idx ON ally_settlement_entries (branch_id, ally_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ally_settlement_shift_idx ON ally_settlement_entries (cash_shift_id);

-- 8. LIBRO MAYOR INMUTABLE DE INVENTARIO (CON TRAZABILIDAD DE MERMA POR ESPUMA)
CREATE TABLE IF NOT EXISTS inventory_ledger (
    id                  uuid PRIMARY KEY,
    branch_id           uuid NOT NULL REFERENCES branches(id),
    inventory_item_id   uuid NOT NULL REFERENCES inventory_items(id),
    movement_type       text NOT NULL CHECK (
        movement_type IN ('purchase', 'sale', 'sale_void_reversal', 'waste', 'manual_adjustment', 'transfer_in', 'transfer_out')
    ),
    -- Total delta aplicado al stock (negativo = salida; incluye nominal + espuma)
    quantity_delta_base numeric(14, 3) NOT NULL CHECK (quantity_delta_base <> 0),
    -- Desglose auditable para barriles y licores: volumen facturado vs merma estimada por espuma/purga
    nominal_qty_base    numeric(14, 3) NOT NULL DEFAULT 0,
    pour_loss_qty_base  numeric(14, 3) NOT NULL DEFAULT 0,
    stock_after_base    numeric(14, 3) NOT NULL,
    unit_cost_base      numeric(12, 6) NOT NULL DEFAULT 0,
    reference_type      text NOT NULL,
    reference_id        uuid,
    presentation_id     uuid REFERENCES purchase_presentations(id),
    reason              text,
    created_by          uuid NOT NULL REFERENCES users(id),
    idempotency_key     uuid NOT NULL UNIQUE,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_ledger_item_time_idx ON inventory_ledger (inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_ledger_branch_type_idx ON inventory_ledger (branch_id, movement_type, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_ledger_ref_idx ON inventory_ledger (reference_type, reference_id) WHERE reference_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Ledger table % is append-only; use a compensating entry instead.', TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_ledger_immutable ON inventory_ledger;
CREATE TRIGGER trg_inventory_ledger_immutable
    BEFORE UPDATE OR DELETE ON inventory_ledger
    FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

DROP TRIGGER IF EXISTS trg_credit_ledger_immutable ON customer_credit_ledger;
CREATE TRIGGER trg_credit_ledger_immutable
    BEFORE UPDATE OR DELETE ON customer_credit_ledger
    FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

-- 9. ALERTAS CONFIGURABLES Y LOG DE SINCRONIZACIÓN IDEMPOTENTE
CREATE TABLE IF NOT EXISTS alert_rules (
    id               uuid PRIMARY KEY,
    branch_id        uuid NOT NULL REFERENCES branches(id),
    alert_type       text NOT NULL CHECK (
        alert_type IN ('low_stock', 'discount_anomaly', 'void_anomaly', 'credit_limit_warning', 'cash_discrepancy', 'foam_loss_high')
    ),
    threshold_config jsonb NOT NULL DEFAULT '{}'::jsonb,
    severity         text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_rules_branch_idx ON alert_rules (branch_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS alert_events (
    id            uuid PRIMARY KEY,
    branch_id     uuid NOT NULL REFERENCES branches(id),
    alert_rule_id uuid REFERENCES alert_rules(id),
    alert_type    text NOT NULL,
    severity      text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    title         text NOT NULL,
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        text NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'acknowledged', 'resolved')),
    resolved_by   uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz
);
CREATE INDEX IF NOT EXISTS alert_events_branch_unread_idx ON alert_events (branch_id, created_at DESC) WHERE status <> 'resolved';

CREATE TABLE IF NOT EXISTS sync_processed_events (
    idempotency_key uuid PRIMARY KEY,
    branch_id       uuid NOT NULL REFERENCES branches(id),
    device_id       text NOT NULL,
    command_type    text NOT NULL,
    client_hlc      timestamptz NOT NULL,
    processed_at    timestamptz NOT NULL DEFAULT now(),
    result_status   text NOT NULL CHECK (result_status IN ('applied', 'conflict_flagged'))
);
CREATE INDEX IF NOT EXISTS sync_processed_branch_time_idx ON sync_processed_events (branch_id, processed_at DESC);

