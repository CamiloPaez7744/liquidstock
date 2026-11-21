import "dotenv/config";
import { convertToBaseUnit } from "@liquistock/domain";
import { closeDb, withTransaction } from "./pool.js";

// Deterministic UUIDv7-shaped seed IDs so seed is 100% idempotent and predictable for local testing
export const SEED_IDS = {
  org: "01950000-0000-7000-8000-000000000000",
  branchNorth: "01950000-0000-7000-8000-000000000001",
  branchCenter: "01950000-0000-7000-8000-000000000002",
  userAdmin: "01950000-0000-7000-8000-000000000010",
  userWaiter: "01950000-0000-7000-8000-000000000011",
  shiftOpen: "01950000-0000-7000-8000-000000000020",
  allyVecino: "01950000-0000-7000-8000-000000000030",
  catCraftBeer: "01950000-0000-7000-8000-000000000040",
  catLiquors: "01950000-0000-7000-8000-000000000041",
  catCocktails: "01950000-0000-7000-8000-000000000042",
  catAllies: "01950000-0000-7000-8000-000000000043",
  invKegIpa: "01950000-0000-7000-8000-000000000050",
  invKegDorada: "01950000-0000-7000-8000-000000000051",
  invTequila: "01950000-0000-7000-8000-000000000052",
  invRon: "01950000-0000-7000-8000-000000000053",
  invCola: "01950000-0000-7000-8000-000000000054",
  invClubCol: "01950000-0000-7000-8000-000000000055",
  pmCash: "01950000-0000-7000-8000-000000000060",
  pmNequi: "01950000-0000-7000-8000-000000000061",
  pmDaviplata: "01950000-0000-7000-8000-000000000062",
  pmCard: "01950000-0000-7000-8000-000000000063",
  custWhitelist: "01950000-0000-7000-8000-000000000070",
  custBlacklist: "01950000-0000-7000-8000-000000000071",
  custStandard: "01950000-0000-7000-8000-000000000072",
} as const;

async function seed() {
  await withTransaction(async (client) => {
    // 1. Organization & Branches
    await client.query(
      `INSERT INTO organizations (id, name, currency)
       VALUES ($1, 'LiquiStock Craft Bar', 'COP')
       ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.org],
    );

    await client.query(
      `INSERT INTO branches (id, organization_id, name, code, timezone)
       VALUES
         ($1, $3, 'Sucursal Norte (Craft Lab)', 'NORTE', 'America/Bogota'),
         ($2, $3, 'Sucursal Centro', 'CENTRO', 'America/Bogota')
       ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.branchNorth, SEED_IDS.branchCenter, SEED_IDS.org],
    );

    // 2. Users & Branch Memberships
    await client.query(
      `INSERT INTO users (id, organization_id, full_name, email, quick_pin_hash)
       VALUES
         ($1, $3, 'Camilo Admin', 'admin@liquistock.local', '1234'),
         ($2, $3, 'Ana Mesera', 'ana@liquistock.local', '0000')
       ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.userAdmin, SEED_IDS.userWaiter, SEED_IDS.org],
    );

    await client.query(
      `INSERT INTO branch_memberships (id, branch_id, user_id, role, permissions)
       VALUES
         ('01950000-0000-7000-8000-000000000015', $1, $2, 'admin', '{"canCollect":true,"canDiscount":true,"canVoid":true,"canApproveCredit":true}'::jsonb),
         ('01950000-0000-7000-8000-000000000016', $1, $3, 'waiter', '{"canCollect":true,"canDiscount":false,"canVoid":false,"canApproveCredit":false}'::jsonb)
       ON CONFLICT (branch_id, user_id) DO NOTHING`,
      [SEED_IDS.branchNorth, SEED_IDS.userAdmin, SEED_IDS.userWaiter],
    );

    // 3. Payment Methods
    await client.query(
      `INSERT INTO payment_methods (id, branch_id, name, code, counts_as_physical_cash, sort_order)
       VALUES
         ($1, $5, 'Efectivo', 'CASH', true, 1),
         ($2, $5, 'Nequi', 'NEQUI', false, 2),
         ($3, $5, 'Daviplata', 'DAVIPLATA', false, 3),
         ($4, $5, 'Datáfono', 'CARD', false, 4)
       ON CONFLICT (id) DO NOTHING`,
      [
        SEED_IDS.pmCash,
        SEED_IDS.pmNequi,
        SEED_IDS.pmDaviplata,
        SEED_IDS.pmCard,
        SEED_IDS.branchNorth,
      ],
    );

    // 4. Dining Tables
    const tables = [
      ["01950000-0000-7000-8000-000000000081", "Mesa 1", "Salón", 1],
      ["01950000-0000-7000-8000-000000000082", "Mesa 2", "Salón", 2],
      ["01950000-0000-7000-8000-000000000083", "Mesa 3", "Salón", 3],
      ["01950000-0000-7000-8000-000000000084", "Mesa 4", "Terraza", 4],
      ["01950000-0000-7000-8000-000000000085", "Barra 1", "Barra", 5],
      ["01950000-0000-7000-8000-000000000086", "VIP 1", "VIP", 6],
    ] as const;
    for (const [id, label, zone, sort] of tables) {
      await client.query(
        `INSERT INTO dining_tables (id, branch_id, label, zone, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [id, SEED_IDS.branchNorth, label, zone, sort],
      );
    }

    // 5. Inventory Items (Craft Beer Kegs + Liquors + Bottled Beer)
    const inventoryItems = [
      [SEED_IDS.invKegIpa, "KEG-IPA", "Barril IPA Artesanal", "ml", 30000, 4000, 11.5, 8, true],
      [SEED_IDS.invKegDorada, "KEG-DOR", "Barril Dorada Artesanal", "ml", 20000, 3500, 9.5, 7, true],
      [SEED_IDS.invTequila, "LIQ-TEQ", "Tequila Reposado", "ml", 1500, 300, 120, 2, false],
      [SEED_IDS.invRon, "LIQ-RON", "Ron Viejo de Caldas", "ml", 1500, 300, 75, 2, false],
      [SEED_IDS.invCola, "MIX-COL", "Coca-Cola Mezclador", "ml", 4000, 1000, 3.5, 0, false],
      [SEED_IDS.invClubCol, "BOT-CLB", "Club Colombia Dorada 330ml", "unit", 48, 12, 3400, 0, false],
    ] as const;

    for (const [id, sku, name, unit, stock, minStock, cost, lossPct, isKeg] of inventoryItems) {
      const inserted = await client.query(
        `INSERT INTO inventory_items
          (id, branch_id, sku, name, base_unit, current_stock_base, min_stock_base, avg_unit_cost_base, default_pour_loss_pct, is_keg)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [id, SEED_IDS.branchNorth, sku, name, unit, stock, minStock, cost, lossPct, isKeg],
      );

      // Initial ledger entry if newly created
      if (inserted.rowCount && inserted.rowCount > 0) {
        const ledgerId = id.replace("00000000005", "00000000055");
        await client.query(
          `INSERT INTO inventory_ledger
            (id, branch_id, inventory_item_id, movement_type, quantity_delta_base, nominal_qty_base, pour_loss_qty_base, stock_after_base, unit_cost_base, reference_type, reason, created_by, idempotency_key)
           VALUES ($1, $2, $3, 'purchase', $4, $4, 0, $4, $5, 'initial_seed', 'Inventario inicial de bar', $6, $1)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [ledgerId, SEED_IDS.branchNorth, id, stock, cost, SEED_IDS.userAdmin],
        );
      }
    }

    // 6. Purchase Presentations (Kegs 20L/30L/50L, Bottles 750ml/1L, Cases x30)
    const purchasePres = [
      ["01950000-0000-7000-8000-000000000091", SEED_IDS.invKegIpa, "Barril 30L", 30000, 345000, true],
      ["01950000-0000-7000-8000-000000000092", SEED_IDS.invKegIpa, "Barril 50L", 50000, 550000, false],
      ["01950000-0000-7000-8000-000000000093", SEED_IDS.invKegDorada, "Barril 20L", 20000, 190000, true],
      ["01950000-0000-7000-8000-000000000094", SEED_IDS.invKegDorada, "Barril 30L", 30000, 275000, false],
      ["01950000-0000-7000-8000-000000000095", SEED_IDS.invTequila, "Botella 750ml", 750, 90000, true],
      ["01950000-0000-7000-8000-000000000096", SEED_IDS.invTequila, "Litro 1000ml", 1000, 115000, false],
      ["01950000-0000-7000-8000-000000000097", SEED_IDS.invRon, "Botella 750ml", 750, 56000, true],
      ["01950000-0000-7000-8000-000000000098", SEED_IDS.invCola, "Botella 2L", 2000, 7000, true],
      ["01950000-0000-7000-8000-000000000099", SEED_IDS.invClubCol, "Canasta x30", 30, 102000, true],
    ] as const;

    for (const [id, itemId, name, factor, cost, isDefault] of purchasePres) {
      await client.query(
        `INSERT INTO purchase_presentations (id, inventory_item_id, name, factor_to_base, last_purchase_cost, is_default)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, itemId, name, factor, cost, isDefault],
      );
    }

    // 7. Ally with Operating Hours (closes at 23:00 — can also be toggled closed live!)
    await client.query(
      `INSERT INTO allies (id, branch_id, name, contact_phone, operating_days, open_time, close_time, is_temporarily_closed)
       VALUES ($1, $2, 'Hamburguesas El Vecino', '3005551234', ARRAY[1,2,3,4,5,6,7], '11:00', '23:30', false)
       ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.allyVecino, SEED_IDS.branchNorth],
    );

    // 8. Categories
    const categories = [
      [SEED_IDS.catCraftBeer, "Cervezas Artesanales", "amber", 1],
      [SEED_IDS.catLiquors, "Licores & Shots", "cyan", 2],
      [SEED_IDS.catCocktails, "Cócteles", "magenta", 3],
      [SEED_IDS.catAllies, "Comida & Combos Aliados", "emerald", 4],
    ] as const;
    for (const [id, name, color, sort] of categories) {
      await client.query(
        `INSERT INTO categories (id, branch_id, name, color_token, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [id, SEED_IDS.branchNorth, name, color, sort],
      );
    }

    // 9. Menu Products
    const products = [
      ["01950000-0000-7000-8000-000000000101", SEED_IDS.catCraftBeer, "IPA Artesanal", "IPA", "standard", null, 1],
      ["01950000-0000-7000-8000-000000000102", SEED_IDS.catCraftBeer, "Dorada Artesanal", "Dorada", "standard", null, 2],
      ["01950000-0000-7000-8000-000000000103", SEED_IDS.catCraftBeer, "Club Colombia", "Club Col.", "standard", null, 3],
      ["01950000-0000-7000-8000-000000000104", SEED_IDS.catLiquors, "Tequila Reposado", "Tequila", "standard", null, 4],
      ["01950000-0000-7000-8000-000000000105", SEED_IDS.catCocktails, "Cuba Libre", "Cuba Libre", "standard", null, 5],
      ["01950000-0000-7000-8000-000000000106", SEED_IDS.catAllies, "Hamburguesa Artesanal", "Burger Aliado", "third_party_ally", SEED_IDS.allyVecino, 6],
      ["01950000-0000-7000-8000-000000000107", SEED_IDS.catAllies, "Combo Jirafa IPA + Alitas", "Combo Jirafa", "combo", SEED_IDS.allyVecino, 7],
    ] as const;

    for (const [id, catId, name, shortLabel, kind, allyId, sort] of products) {
      await client.query(
        `INSERT INTO menu_products (id, branch_id, category_id, name, short_label, product_kind, ally_id, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [id, SEED_IDS.branchNorth, catId, name, shortLabel, kind, allyId, sort],
      );
    }

    // 10. Product Presentations (Vaso, Pinta, Jirafa 3L, Shot 1oz/1.5oz, Botella, Combo)
    const presentations = [
      // IPA Artesanal
      ["01950000-0000-7000-8000-000000000201", "01950000-0000-7000-8000-000000000101", "Vaso 330ml", "330ml", "vaso", 10000, null, 0, 1],
      ["01950000-0000-7000-8000-000000000202", "01950000-0000-7000-8000-000000000101", "Pinta 500ml", "Pinta", "pinta", 14000, null, 0, 2],
      ["01950000-0000-7000-8000-000000000203", "01950000-0000-7000-8000-000000000101", "Jirafa 3 Litros", "Jirafa 3L", "jirafa", 72000, null, 0, 3],
      // Dorada Artesanal
      ["01950000-0000-7000-8000-000000000204", "01950000-0000-7000-8000-000000000102", "Vaso 330ml", "330ml", "vaso", 9000, null, 0, 1],
      ["01950000-0000-7000-8000-000000000205", "01950000-0000-7000-8000-000000000102", "Pinta 500ml", "Pinta", "pinta", 12500, null, 0, 2],
      ["01950000-0000-7000-8000-000000000206", "01950000-0000-7000-8000-000000000102", "Jirafa 2.5 Litros", "Jirafa 2.5L", "jirafa", 56000, null, 0, 3],
      // Club Colombia
      ["01950000-0000-7000-8000-000000000207", "01950000-0000-7000-8000-000000000103", "Botella 330ml", "Botella", "botella", 8000, null, 0, 1],
      // Tequila Reposado
      ["01950000-0000-7000-8000-000000000208", "01950000-0000-7000-8000-000000000104", "Shot 1 oz", "Shot 1oz", "shot", 14000, null, 0, 1],
      ["01950000-0000-7000-8000-000000000209", "01950000-0000-7000-8000-000000000104", "Shot 1.5 oz", "Shot 1.5oz", "shot", 19000, null, 0, 2],
      ["01950000-0000-7000-8000-000000000210", "01950000-0000-7000-8000-000000000104", "Botella 750ml", "Botella", "botella", 185000, null, 0, 3],
      // Cuba Libre
      ["01950000-0000-7000-8000-000000000211", "01950000-0000-7000-8000-000000000105", "Trago 2 oz", "Cóctel", "coctel", 22000, null, 0, 1],
      // Aliado puro
      ["01950000-0000-7000-8000-000000000212", "01950000-0000-7000-8000-000000000106", "Combo Clásico + Papas", "Burger", "comida", 28000, SEED_IDS.allyVecino, 21000, 1],
      // Combo mixto (Jirafa IPA 3L del bar + Alitas del aliado)
      ["01950000-0000-7000-8000-000000000213", "01950000-0000-7000-8000-000000000107", "Jirafa 3L + 12 Alitas", "Jirafa+Alitas", "combo", 96000, SEED_IDS.allyVecino, 26000, 1],
    ] as const;

    for (const [id, prodId, name, shortLabel, group, price, allyId, allyPayout, sort] of presentations) {
      await client.query(
        `INSERT INTO product_presentations
          (id, branch_id, menu_product_id, name, short_label, presentation_group, sale_price, ally_id, ally_payout_amount, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [id, SEED_IDS.branchNorth, prodId, name, shortLabel, group, price, allyId, allyPayout, sort],
      );
    }

    // 11. Presentation Recipes (with Foam Loss % & Fixed Purge ml!)
    const recipes: Array<[string, string, string, "ml" | "oz" | "L" | "unit", number, "ml" | "unit", number, number]> = [
      // IPA Keg presentations
      ["01950000-0000-7000-8000-000000000301", "01950000-0000-7000-8000-000000000201", SEED_IDS.invKegIpa, "ml", 330, "ml", 8, 10],
      ["01950000-0000-7000-8000-000000000302", "01950000-0000-7000-8000-000000000202", SEED_IDS.invKegIpa, "ml", 500, "ml", 8, 15],
      ["01950000-0000-7000-8000-000000000303", "01950000-0000-7000-8000-000000000203", SEED_IDS.invKegIpa, "L", 3, "ml", 3, 25],
      // Dorada Keg presentations
      ["01950000-0000-7000-8000-000000000304", "01950000-0000-7000-8000-000000000204", SEED_IDS.invKegDorada, "ml", 330, "ml", 7, 10],
      ["01950000-0000-7000-8000-000000000305", "01950000-0000-7000-8000-000000000205", SEED_IDS.invKegDorada, "ml", 500, "ml", 7, 15],
      ["01950000-0000-7000-8000-000000000306", "01950000-0000-7000-8000-000000000206", SEED_IDS.invKegDorada, "L", 2.5, "ml", 3, 20],
      // Club Colombia (closed bottle -> 0% foam)
      ["01950000-0000-7000-8000-000000000307", "01950000-0000-7000-8000-000000000207", SEED_IDS.invClubCol, "unit", 1, "unit", 0, 0],
      // Tequila shots (oz) + closed bottle
      ["01950000-0000-7000-8000-000000000308", "01950000-0000-7000-8000-000000000208", SEED_IDS.invTequila, "oz", 1, "ml", 2, 0],
      ["01950000-0000-7000-8000-000000000309", "01950000-0000-7000-8000-000000000209", SEED_IDS.invTequila, "oz", 1.5, "ml", 2, 0],
      ["01950000-0000-7000-8000-000000000310", "01950000-0000-7000-8000-000000000210", SEED_IDS.invTequila, "ml", 750, "ml", 0, 0],
      // Cuba Libre composite recipe (2 oz Ron + 150 ml Cola)
      ["01950000-0000-7000-8000-000000000311", "01950000-0000-7000-8000-000000000211", SEED_IDS.invRon, "oz", 2, "ml", 2, 0],
      ["01950000-0000-7000-8000-000000000312", "01950000-0000-7000-8000-000000000211", SEED_IDS.invCola, "ml", 150, "ml", 0, 0],
      // Mixed Combo (deducts 3L IPA keg with 3% foam + 25ml purge; wings go to ally settlement!)
      ["01950000-0000-7000-8000-000000000313", "01950000-0000-7000-8000-000000000213", SEED_IDS.invKegIpa, "L", 3, "ml", 3, 25],
    ];

    for (const [id, presId, invId, dispUnit, dispQty, baseUnit, lossPct, fixedLoss] of recipes) {
      const qtyBase = convertToBaseUnit(dispQty, dispUnit, baseUnit);
      await client.query(
        `INSERT INTO presentation_recipes
          (id, presentation_id, inventory_item_id, display_unit, display_quantity, quantity_base, pour_loss_percent, fixed_loss_base)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (presentation_id, inventory_item_id) DO NOTHING`,
        [id, presId, invId, dispUnit, dispQty, qtyBase, lossPct, fixedLoss],
      );
    }

    // 12. Customers (Lista Blanca / Lista Negra / Estándar)
    await client.query(
      `INSERT INTO customers (id, branch_id, full_name, nickname, phone, credit_status, credit_limit, current_debt, status_reason)
       VALUES
         ($1, $4, 'Carlos Mendoza', 'El Profe', '3102223344', 'whitelist_credit', 200000, 40000, 'Cliente frecuente autorizado'),
         ($2, $4, 'Pedro Gómez', 'El Flaco', '3119998877', 'blacklist_blocked', 0, 180000, 'Deuda vencida > 45 días'),
         ($3, $4, 'Laura Torres', 'Lau', '3204445566', 'standard', NULL, 0, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.custWhitelist, SEED_IDS.custBlacklist, SEED_IDS.custStandard, SEED_IDS.branchNorth],
    );

    // 13. Modular Promotions (2x1 Cócteles + Happy Hour Pintas)
    await client.query(
      `INSERT INTO promotion_rules (id, branch_id, name, rule_type, scope_type, target_id, days_of_week, start_time, end_time, config, priority, is_active)
       VALUES
         ('01950000-0000-7000-8000-000000000401', $1, '2x1 Cócteles de la Casa', 'bxgy', 'category', $2, ARRAY[1,2,3,4,5,6,7], '17:00', '23:59', '{"buyQty":2,"payQty":1}'::jsonb, 10, true),
         ('01950000-0000-7000-8000-000000000402', $1, 'Happy Hour Pintas IPA -15%', 'percentage_discount', 'presentation', '01950000-0000-7000-8000-000000000202', ARRAY[1,2,3,4,5], '16:00', '20:00', '{"percent":15}'::jsonb, 20, true)
       ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.branchNorth, SEED_IDS.catCocktails],
    );

    // 14. Open Cash Shift if none is open
    const openShift = await client.query(
      `SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open'`,
      [SEED_IDS.branchNorth],
    );
    if (openShift.rowCount === 0) {
      await client.query(
        `INSERT INTO cash_shifts (id, branch_id, opened_by, status, opening_float)
         VALUES ($1, $2, $3, 'open', 200000)
         ON CONFLICT (id) DO NOTHING`,
        [SEED_IDS.shiftOpen, SEED_IDS.branchNorth, SEED_IDS.userAdmin],
      );
    }
  });

  console.log("[seed] LiquiStock Craft Bar demo data ready.");
}

seed()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[seed] Failed:", err);
    await closeDb();
    process.exit(1);
  });
