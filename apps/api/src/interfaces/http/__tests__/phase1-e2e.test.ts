import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUuidV7 } from "@liquistock/domain";

// Isolate integration test in an in-memory real PostgreSQL 16 (PGlite) database
process.env.DATABASE_URL = "pglite://memory";

const { closeDb, db } = await import("../../../infrastructure/db/pool.js");
const { buildServer } = await import("../server.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../../../migrations");

describe("LiquiStock End-to-End Integration (SuperAdmin Approval, Multi-Tenant Bars, Auth/RBAC, POS & KPIs)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  let superAdminToken = "";
  let adminToken = "";
  let waiterToken = "";
  let orgId = "";
  let branchId = "";
  let adminUserId = "";
  let cashMethodId = "";

  const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const sql = await fs.readFile(path.join(migrationsDir, f), "utf8");
      await db.exec(sql);
    }
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("enforces SuperAdmin setup, public bar registration pending approval, SuperAdmin review, bar profile (logo/legal/socials), multi-branch & strict RBAC", async () => {
    // 1. Clean database starts without SuperAdmin
    const statusBefore = await app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.json().hasSuperAdmin).toBe(false);

    // 2. Create platform SuperAdmin
    const saSetup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/superadmin-setup",
      payload: {
        fullName: "SuperAdmin LiquiStock",
        email: "superadmin@liquistock.co",
        password: "SuperPassword123",
      },
    });
    expect(saSetup.statusCode).toBe(201);
    superAdminToken = saSetup.json().token as string;
    expect(saSetup.json().user.isSuperAdmin).toBe(true);

    // 3. Second SuperAdmin setup is locked (403)
    const saDup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/superadmin-setup",
      payload: {
        fullName: "Otro SA",
        email: "otro@liquistock.co",
        password: "SuperPassword123",
      },
    });
    expect(saDup.statusCode).toBe(403);

    // 4. Public Bar Registration submits request in 'pending_approval'
    const regBar = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register-bar",
      payload: {
        barName: "La Cervecería Test",
        businessType: "brewery",
        legalName: "La Cervecería Test S.A.S.",
        taxId: "900.123.456-7",
        city: "Bogotá",
        contactPhone: "3001234567",
        currency: "COP",
        socialLinks: { instagram: "@lacerveceriatest" },
        adminFullName: "Admin Principal",
        adminEmail: "admin@cerveceria.co",
        adminPassword: "PasswordSegura123",
        adminPin: "4321",
        branchName: "Sede Norte",
        branchCode: "NORTE",
        tableCount: 4,
        openingFloat: 200000,
      },
    });
    expect(regBar.statusCode).toBe(201);
    expect(regBar.json().status).toBe("pending_approval");
    orgId = regBar.json().organizationId as string;

    // 5. Pending Bar Admin CANNOT log in until SuperAdmin approves!
    const loginPending = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@cerveceria.co", password: "PasswordSegura123" },
    });
    expect(loginPending.statusCode).toBe(403);
    expect(loginPending.json().error).toBe("ORG_PENDING_APPROVAL");

    const pinPending = await app.inject({
      method: "POST",
      url: "/api/v1/auth/pin-login",
      payload: { branchCode: "NORTE", pin: "4321" },
    });
    expect(pinPending.statusCode).toBe(401);

    // 6. SuperAdmin lists all bars and sees the pending request
    const listBars = await app.inject({
      method: "GET",
      url: "/api/v1/superadmin/bars",
      headers: authHeader(superAdminToken),
    });
    expect(listBars.statusCode).toBe(200);
    expect(listBars.json().counts.pending).toBe(1);
    expect(listBars.json().bars[0].legalName).toBe("La Cervecería Test S.A.S.");

    // 7. SuperAdmin approves the bar
    const approveBar = await app.inject({
      method: "PATCH",
      url: `/api/v1/superadmin/bars/${orgId}/status`,
      headers: authHeader(superAdminToken),
      payload: { status: "approved", notes: "Verificado NIT y contacto" },
    });
    expect(approveBar.statusCode).toBe(200);
    expect(approveBar.json().approvalStatus).toBe("approved");

    // 8. Now Bar Admin logs in successfully (Email+Password & PIN)
    const badLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@cerveceria.co", password: "WrongPassword" },
    });
    expect(badLogin.statusCode).toBe(401);

    const goodLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@cerveceria.co", password: "PasswordSegura123" },
    });
    expect(goodLogin.statusCode).toBe(200);
    adminToken = goodLogin.json().token as string;
    branchId = goodLogin.json().defaultBranchId as string;
    adminUserId = goodLogin.json().user.userId as string;

    // Verify scrypt hashes in DB (never plaintext)
    const userSecretRow = await db.query<{ password_hash: string; quick_pin_hash: string }>(
      `SELECT password_hash, quick_pin_hash FROM users WHERE id = $1`,
      [adminUserId],
    );
    expect(userSecretRow.rows[0]?.password_hash).toMatch(/^scrypt\$/);
    expect(userSecretRow.rows[0]?.quick_pin_hash).toMatch(/^scrypt\$/);

    // SuperAdmin CANNOT operate a bar's POS/bootstrap (platform-only role)
    const saBarAttempt = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(superAdminToken),
    });
    expect(saBarAttempt.statusCode).toBe(403);

    // Bar Admin CANNOT access SuperAdmin endpoints
    const adminSaAttempt = await app.inject({
      method: "GET",
      url: "/api/v1/superadmin/bars",
      headers: authHeader(adminToken),
    });
    expect(adminSaAttempt.statusCode).toBe(403);

    const pinLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/pin-login",
      payload: { branchCode: "NORTE", pin: "4321" },
    });
    expect(pinLogin.statusCode).toBe(200);
    expect(pinLogin.json().defaultBranchId).toBe(branchId);

    // 9. Bar Admin updates Logo, Razón Social and Social Networks
    const updateProfile = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgId}/profile`,
      headers: authHeader(adminToken),
      payload: {
        name: "La Cervecería Artesanal",
        legalName: "La Cervecería Artesanal S.A.S.",
        logoUrl: "/uploads/logo-bar.png",
        socialLinks: {
          instagram: "@lacerveceria_oficial",
          tiktok: "@lacerveceria",
          website: "https://lacerveceria.co",
        },
      },
    });
    expect(updateProfile.statusCode).toBe(200);
    expect(updateProfile.json().organization.logoUrl).toBe("/uploads/logo-bar.png");
    expect(updateProfile.json().organization.socialLinks.instagram).toBe("@lacerveceria_oficial");

    // 10. Bar Admin adds a 2nd Bar (enters SuperAdmin queue), a 2nd Branch, and a Waiter
    const secondBar = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: authHeader(adminToken),
      payload: {
        barName: "Terraza Pub",
        legalName: "Terraza Pub S.A.S.",
        businessType: "pub",
        branchName: "Sede Centro",
        branchCode: "CENTRO",
        tableCount: 5,
      },
    });
    expect(secondBar.statusCode).toBe(201);
    expect(secondBar.json().approvalStatus).toBe("pending_approval");

    const branch2Res = await app.inject({
      method: "POST",
      url: "/api/v1/branches",
      headers: authHeader(adminToken),
      payload: { organizationId: orgId, name: "Sede Sur", code: "SUR", tableCount: 3, openingFloat: 100000 },
    });
    expect(branch2Res.statusCode).toBe(201);

    const createWaiter = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: authHeader(adminToken),
      payload: {
        fullName: "Carlos Mesero",
        email: "mesero@cerveceria.co",
        password: "MeseroPassword123",
        quickPin: "1122",
        assignments: [{ branchId, role: "waiter" }],
      },
    });
    expect(createWaiter.statusCode).toBe(201);

    const waiterLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "mesero@cerveceria.co", password: "MeseroPassword123" },
    });
    expect(waiterLogin.statusCode).toBe(200);
    waiterToken = waiterLogin.json().token as string;

    // 11. RBAC: Waiter CAN read branch bootstrap, but is blocked (403) from Admin & SuperAdmin endpoints
    const waiterBoot = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(waiterToken),
    });
    expect(waiterBoot.statusCode).toBe(200);
    const bootData = waiterBoot.json() as {
      paymentMethods: Array<{ id: string; code: string }>;
      diningTables: Array<{ id: string }>;
    };
    expect(bootData.diningTables).toHaveLength(4);
    cashMethodId = bootData.paymentMethods.find((pm) => pm.code === "CASH")?.id ?? "";
    expect(cashMethodId).toBeTruthy();

    const waiterUsers = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      headers: authHeader(waiterToken),
    });
    expect(waiterUsers.statusCode).toBe(403);

    const waiterKpis = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/kpis?period=monthly`,
      headers: authHeader(waiterToken),
    });
    expect(waiterKpis.statusCode).toBe(403);

    const waiterSettings = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/settings`,
      headers: authHeader(waiterToken),
      payload: { hideOutOfStockInPos: true },
    });
    expect(waiterSettings.statusCode).toBe(403);
  });

  it("runs full POS lifecycle: keg foam deduction, immutable ledger, split accounts, blacklist block, cash closure, combos, courtesy, promos, and KPIs", async () => {
    const allyRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/allies`,
      headers: authHeader(adminToken),
      payload: { name: "El Vecino", openTime: "11:00", closeTime: "23:30" },
    });
    expect(allyRes.statusCode).toBe(201);
    const allyId = allyRes.json().id as string;

    const kegRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/items`,
      headers: authHeader(adminToken),
      payload: {
        name: "Barril IPA",
        baseUnit: "ml",
        initialStockBase: 30000,
        initialTotalCost: 345000,
        minStockBase: 3000,
        defaultPourLossPercent: 8,
        isKeg: true,
        userId: adminUserId,
        purchasePresentation: { name: "Barril 30L", factorToBase: 30000, lastPurchaseCost: 345000 },
        publishToMenu: {
          newCategoryName: "Cervezas",
          productName: "IPA Artesanal",
          presentations: [
            {
              name: "Pinta 500ml",
              presentationGroup: "pinta",
              salePrice: 14000,
              displayUnit: "ml",
              displayQuantity: 500,
              pourLossPercent: 8,
              fixedLossBase: 15,
            },
          ],
        },
      },
    });
    expect(kegRes.statusCode).toBe(201);
    const kegBody = kegRes.json() as { id: string; createdCategoryId: string };
    const kegId = kegBody.id;
    const catId = kegBody.createdCategoryId;

    const burgerRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/combos`,
      headers: authHeader(adminToken),
      payload: {
        name: "Hamburguesa Aliado",
        presentationLabel: "Burger Clásica",
        categoryId: catId,
        salePrice: 28000,
        allyId,
        allyPayoutAmount: 21000,
        recipes: [],
      },
    });
    expect(burgerRes.statusCode).toBe(201);

    const custWhiteRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/customers`,
      headers: authHeader(adminToken),
      payload: { fullName: "Carlos Lista Blanca", creditStatus: "whitelist_credit", creditLimit: 200000 },
    });
    const custWhiteId = custWhiteRes.json().id as string;

    const custBlackRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/customers`,
      headers: authHeader(adminToken),
      payload: { fullName: "Pedro Lista Negra", creditStatus: "blacklist_blocked", statusReason: "Moroso" },
    });
    const custBlackId = custBlackRes.json().id as string;

    const boot = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(adminToken),
    });
    const presentations = boot.json().presentations as Array<{ id: string; name: string }>;
    const presPintaId = presentations.find((p) => p.name === "Pinta 500ml")?.id ?? "";
    const presBurgerId = presentations.find((p) => p.name === "Burger Clásica")?.id ?? "";

    const sessionId = generateUuidV7();
    const sub1Id = generateUuidV7();
    const sub2Id = generateUuidV7();
    const itemPintaId = generateUuidV7();
    const itemBurgerId = generateUuidV7();

    const commands = [
      {
        idempotencyKey: generateUuidV7(Date.now() + 1),
        branchId,
        deviceId: "tablet-e2e",
        userId: adminUserId,
        commandType: "OPEN_TABLE_SESSION",
        clientHlc: new Date().toISOString(),
        payload: { tableSessionId: sessionId, subAccountId: sub1Id, label: "Cuenta 1" },
      },
      {
        idempotencyKey: generateUuidV7(Date.now() + 2),
        branchId,
        deviceId: "tablet-e2e",
        userId: adminUserId,
        commandType: "CREATE_SUB_ACCOUNT",
        clientHlc: new Date().toISOString(),
        payload: { tableSessionId: sessionId, subAccountId: sub2Id, label: "Cuenta 2" },
      },
      {
        idempotencyKey: generateUuidV7(Date.now() + 3),
        branchId,
        deviceId: "tablet-e2e",
        userId: adminUserId,
        commandType: "ADD_ORDER_ITEM",
        clientHlc: new Date().toISOString(),
        payload: { orderItemId: itemPintaId, subAccountId: sub1Id, presentationId: presPintaId, quantity: 1 },
      },
      {
        idempotencyKey: generateUuidV7(Date.now() + 4),
        branchId,
        deviceId: "tablet-e2e",
        userId: adminUserId,
        commandType: "ADD_ORDER_ITEM",
        clientHlc: new Date().toISOString(),
        payload: { orderItemId: itemBurgerId, subAccountId: sub1Id, presentationId: presBurgerId, quantity: 1 },
      },
      {
        idempotencyKey: generateUuidV7(Date.now() + 5),
        branchId,
        deviceId: "tablet-e2e",
        userId: adminUserId,
        commandType: "MOVE_ORDER_ITEM",
        clientHlc: new Date().toISOString(),
        payload: { orderItemId: itemBurgerId, toSubAccountId: sub2Id },
      },
      {
        idempotencyKey: generateUuidV7(Date.now() + 6),
        branchId,
        deviceId: "tablet-e2e",
        userId: adminUserId,
        commandType: "RECORD_PAYMENT",
        clientHlc: new Date().toISOString(),
        payload: { subAccountId: sub1Id, paymentMethodId: cashMethodId, amount: 14000 },
      },
      {
        idempotencyKey: generateUuidV7(Date.now() + 7),
        branchId,
        deviceId: "tablet-e2e",
        userId: adminUserId,
        commandType: "CHARGE_SUB_ACCOUNT_CREDIT",
        clientHlc: new Date().toISOString(),
        payload: { subAccountId: sub2Id, customerId: custWhiteId, amount: 28000 },
      },
    ];

    const syncRes = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(adminToken),
      payload: { branchId, deviceId: "tablet-e2e", commands },
    });
    expect(syncRes.statusCode).toBe(200);
    expect((syncRes.json() as { receipts: Array<{ status: string }> }).receipts.every((r) => r.status === "applied")).toBe(true);

    const retryRes = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(adminToken),
      payload: { branchId, deviceId: "tablet-e2e", commands },
    });
    expect(retryRes.statusCode).toBe(200);
    expect((retryRes.json() as { receipts: Array<{ status: string }> }).receipts.every((r) => r.status === "already_processed")).toBe(true);

    const kegRow = await db.query<{ current_stock_base: string }>(
      `SELECT current_stock_base::text FROM inventory_items WHERE id = $1`,
      [kegId],
    );
    expect(Number(kegRow.rows[0]?.current_stock_base)).toBe(29445);

    await expect(
      db.query(`UPDATE inventory_ledger SET quantity_delta_base = -1 WHERE inventory_item_id = $1`, [kegId]),
    ).rejects.toThrow(/append-only/i);

    const blackRes = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(adminToken),
      payload: {
        branchId,
        deviceId: "tablet-e2e",
        commands: [
          {
            idempotencyKey: generateUuidV7(Date.now() + 99),
            branchId,
            deviceId: "tablet-e2e",
            userId: adminUserId,
            commandType: "CHARGE_SUB_ACCOUNT_CREDIT",
            clientHlc: new Date().toISOString(),
            payload: { subAccountId: sub2Id, customerId: custBlackId, amount: 10000, adminOverride: true },
          },
        ],
      },
    });
    expect(blackRes.statusCode).toBe(500);

    const shiftRes = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/shifts/current`,
      headers: authHeader(adminToken),
    });
    expect(shiftRes.statusCode).toBe(200);
    const shift = shiftRes.json().activeShift;
    expect(shift.report.totalNetSales).toBe(42000);
    expect(shift.report.totalCollectedFromSales).toBe(14000);
    expect(shift.report.totalAllyPayable).toBe(21000);
    expect(shift.report.totalCreditIssued).toBe(28000);
    expect(shift.report.expectedPhysicalCash).toBe(214000);

    const kpiRes = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/kpis?period=monthly`,
      headers: authHeader(adminToken),
    });
    expect(kpiRes.statusCode).toBe(200);
    expect(kpiRes.json().summary.totalNetSales).toBe(42000);
    expect(kpiRes.json().foamAnalytics.totalFoamLossBase).toBe(55);

    const corsPreflight = await app.inject({
      method: "OPTIONS",
      url: `/api/v1/branches/${branchId}/settings`,
      headers: {
        origin: "http://localhost:5174",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(corsPreflight.statusCode).toBe(204);

    const createPromo = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/promotions`,
      headers: authHeader(adminToken),
      payload: {
        name: "Mes de la Mujer 3x2",
        ruleType: "bxgy",
        scopeType: "category",
        applicationMode: "manual_at_checkout",
        targetId: catId,
        validFrom: "2026-03-01",
        validUntil: "2026-03-31",
        config: { buyQty: 3, payQty: 2 },
      },
    });
    expect(createPromo.statusCode).toBe(201);
    const promoId = createPromo.json().id as string;

    const deletePromo = await app.inject({
      method: "DELETE",
      url: `/api/v1/branches/${branchId}/promotions/${promoId}`,
      headers: authHeader(adminToken),
    });
    expect(deletePromo.statusCode).toBe(200);
    expect(deletePromo.json().deleted).toBe(true);
  });
});
