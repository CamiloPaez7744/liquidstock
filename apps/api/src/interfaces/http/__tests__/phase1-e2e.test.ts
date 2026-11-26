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

    // === PHASE 3 E2E VERIFICATION ===
    // 1. Waiter is blocked from inventory ledger/movements (stock read-only enforcement)
    const waiterLedger = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/inventory/ledger`,
      headers: authHeader(waiterToken),
    });
    expect(waiterLedger.statusCode).toBe(403);

    // 2. Credit repayment reduces customer debt, adds to shift recovery, and logs immutable credit ledger
    const repayRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/customers/${custWhiteId}/repayments`,
      headers: authHeader(adminToken),
      payload: { paymentMethodId: cashMethodId, amount: 10000, notes: "Abono efectivo" },
    });
    expect(repayRes.statusCode).toBe(201);
    expect(repayRes.json().remainingDebt).toBe(18000);

    const custLedgerRes = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/customers/${custWhiteId}/ledger`,
      headers: authHeader(adminToken),
    });
    expect(custLedgerRes.statusCode).toBe(200);
    expect(custLedgerRes.json().entries).toHaveLength(2); // 1 charge + 1 repayment

    // 3. Ally settlements breakdown & settlement history
    const allySettleList = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/allies/settlements`,
      headers: authHeader(adminToken),
    });
    expect(allySettleList.statusCode).toBe(200);
    expect(allySettleList.json().pendingByAlly[0].totalPending).toBe(21000);

    const settleNow = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/allies/${allyId}/settle`,
      headers: authHeader(adminToken),
      payload: {},
    });
    expect(settleNow.statusCode).toBe(200);
    expect(settleNow.json().settledCount).toBe(1);

    // 4. Close shift and verify shift history records expected cash (200k float + 14k sale + 10k repayment = 224k)
    const closeShift = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/shifts/close`,
      headers: authHeader(adminToken),
      payload: { declaredPhysicalCash: 224000, notes: "Cierre cuadrado", openNextShiftFloat: 200000 },
    });
    expect(closeShift.statusCode).toBe(200);
    expect(closeShift.json().report.expectedPhysicalCash).toBe(224000);
    expect(closeShift.json().report.cashDiscrepancy).toBe(0);

    const historyRes = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/shifts/history`,
      headers: authHeader(adminToken),
    });
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.json().shifts).toHaveLength(1);

    // 5. Smart Alerts + Audit Log & Multi-Branch Consolidated KPIs
    const alertsRes = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/alerts-audit`,
      headers: authHeader(adminToken),
    });
    expect(alertsRes.statusCode).toBe(200);
    expect(Array.isArray(alertsRes.json().alerts)).toBe(true);
    expect(Array.isArray(alertsRes.json().auditLog)).toBe(true);

    const multiKpiRes = await app.inject({
      method: "GET",
      url: "/api/v1/kpis/multi-branch?period=monthly",
      headers: authHeader(adminToken),
    });
    expect(multiKpiRes.statusCode).toBe(200);
    expect(multiKpiRes.json().branches.length).toBeGreaterThanOrEqual(2);
    expect(multiKpiRes.json().consolidated.totalNetSales).toBe(42000);

    // 6. Admin CRUD for Dining Tables & Payment Methods (create -> edit -> safe delete)
    const addTable = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/tables`,
      headers: authHeader(adminToken),
      payload: { label: "Terraza VIP", zone: "Exterior" },
    });
    expect(addTable.statusCode).toBe(201);
    const newTableId = addTable.json().id as string;

    const editTable = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/tables/${newTableId}`,
      headers: authHeader(adminToken),
      payload: { label: "Terraza 1", zone: "Terraza" },
    });
    expect(editTable.statusCode).toBe(200);

    const delTable = await app.inject({
      method: "DELETE",
      url: `/api/v1/branches/${branchId}/tables/${newTableId}`,
      headers: authHeader(adminToken),
    });
    expect(delTable.statusCode).toBe(200);

    const addPm = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/payment-methods`,
      headers: authHeader(adminToken),
      payload: { name: "Bold", countsAsPhysicalCash: false },
    });
    expect(addPm.statusCode).toBe(201);
    const newPmId = addPm.json().id as string;

    const editPm = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/payment-methods/${newPmId}`,
      headers: authHeader(adminToken),
      payload: { name: "Datáfono Bold", countsAsPhysicalCash: false },
    });
    expect(editPm.statusCode).toBe(200);

    const delPm = await app.inject({
      method: "DELETE",
      url: `/api/v1/branches/${branchId}/payment-methods/${newPmId}`,
      headers: authHeader(adminToken),
    });
    expect(delPm.statusCode).toBe(200);

    // 7. Block A: Multi-format purchase presentations (Unidad x1, Six-pack x6, Canasta x30) + Composed Recipe (Carajillo = Coffee g + Liquor oz)
    const beerBottleRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/items`,
      headers: authHeader(adminToken),
      payload: {
        name: "Club Colombia Dorada",
        baseUnit: "unit",
        initialStockBase: 30,
        initialTotalCost: 96000,
        minStockBase: 10,
        purchasePresentations: [
          { name: "Canasta x30", factorToBase: 30, lastPurchaseCost: 96000, isDefault: true },
          { name: "Six-pack x6", factorToBase: 6 },
          { name: "Unidad x1", factorToBase: 1 },
        ],
        publishToMenu: {
          newCategoryName: "Cervezas Botella",
          productName: "Club Colombia Dorada",
          imageUrl: "icon:beer_bottle",
          presentations: [
            {
              name: "Botella 330ml",
              presentationGroup: "botella",
              salePrice: 7000,
              displayUnit: "unit",
              displayQuantity: 1,
            },
          ],
        },
      },
    });
    expect(beerBottleRes.statusCode).toBe(201);
    const beerItemId = beerBottleRes.json().id as string;

    // Add extra format dynamically ("Caja x24")
    const extraFormat = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/items/${beerItemId}/purchase-presentations`,
      headers: authHeader(adminToken),
      payload: { name: "Caja x24", factorToBase: 24 },
    });
    expect(extraFormat.statusCode).toBe(201);

    // Confirm bootstrap exposes all 4 purchase formats for the newly created beer item
    const bootFormats = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(adminToken),
    });
    const beerFormats = (
      bootFormats.json().purchasePresentations as Array<{ inventoryItemId: string; name: string }>
    ).filter((p) => p.inventoryItemId === beerItemId);
    expect(beerFormats).toHaveLength(4);

    // Create composed multi-ingredient coffee + liquor recipe (Carajillo) creating both ingredients inline
    const carajilloRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/recipes/composed`,
      headers: authHeader(adminToken),
      payload: {
        name: "Carajillo Especial",
        presentationName: "Copa",
        presentationGroup: "coctel",
        salePrice: 18000,
        newCategoryName: "Cafetería",
        imageUrl: "icon:coffee",
        ingredients: [
          {
            createIngredient: {
              name: "Café en Grano Origen",
              baseUnit: "g",
              initialStockBase: 1000,
              initialTotalCost: 52000,
              minStockBase: 200,
              purchasePresentations: [
                { name: "Libra (500g)", factorToBase: 500 },
                { name: "Kilo (1000g)", factorToBase: 1000 },
              ],
            },
            displayUnit: "g",
            displayQuantity: 18,
          },
          {
            createIngredient: {
              name: "Licor 43",
              baseUnit: "ml",
              initialStockBase: 750,
              initialTotalCost: 115000,
              minStockBase: 150,
              purchasePresentations: [{ name: "Botella 750ml", factorToBase: 750 }],
            },
            displayUnit: "oz",
            displayQuantity: 1.5,
          },
        ],
      },
    });
    expect(carajilloRes.statusCode).toBe(201);
    expect(carajilloRes.json().createdIngredientIds).toHaveLength(2);

    // 1-click Promo Quick Button E2E: add a 2x1 automatic promo and tap it twice (2 promos = 4 beers, pay 2)
    const bootNow = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(adminToken),
    });
    const bootJson = bootNow.json();
    const ipaPres = (
      bootJson.presentations as Array<{
        id: string;
        menuProductId: string;
        salePrice: number;
      }>
    ).find((p) => p.salePrice > 0)!;
    const ipaProd = (
      bootJson.menuProducts as Array<{ id: string; categoryId: string }>
    ).find((m) => m.id === ipaPres.menuProductId)!;

    const createQuickPromo = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/promotions`,
      headers: authHeader(adminToken),
      payload: {
        name: "Promo 2x1 Rápida",
        ruleType: "bxgy",
        scopeType: "presentation",
        applicationMode: "automatic",
        targetId: ipaPres.id,
        config: { buyQty: 2, payQty: 1 },
        priority: 1,
      },
    });
    expect(createQuickPromo.statusCode).toBe(201);
    const quickPromoId = createQuickPromo.json().id as string;

    const promoSessionId = generateUuidV7();
    const promoSubId = generateUuidV7();
    const item1Id = generateUuidV7();
    const item2Id = generateUuidV7();

    const baseTs = Date.now() + 100;
    const syncPromo = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(adminToken),
      payload: {
        branchId,
        deviceId: "test-device-promo",
        commands: [
          {
            idempotencyKey: generateUuidV7(baseTs + 1),
            branchId,
            deviceId: "test-device-promo",
            userId: adminUserId,
            commandType: "OPEN_TABLE_SESSION",
            clientHlc: new Date(baseTs + 1).toISOString(),
            payload: { tableSessionId: promoSessionId, diningTableId: null, subAccountId: promoSubId, label: "Cuenta Promo" },
          },
          {
            idempotencyKey: generateUuidV7(baseTs + 2),
            branchId,
            deviceId: "test-device-promo",
            userId: adminUserId,
            commandType: "ADD_ORDER_ITEM",
            clientHlc: new Date(baseTs + 2).toISOString(),
            payload: { orderItemId: item1Id, subAccountId: promoSubId, presentationId: ipaPres.id, quantity: 2, forcedPromotionRuleId: quickPromoId },
          },
          {
            idempotencyKey: generateUuidV7(baseTs + 3),
            branchId,
            deviceId: "test-device-promo",
            userId: adminUserId,
            commandType: "ADD_ORDER_ITEM",
            clientHlc: new Date(baseTs + 3).toISOString(),
            payload: { orderItemId: item2Id, subAccountId: promoSubId, presentationId: ipaPres.id, quantity: 2, forcedPromotionRuleId: quickPromoId },
          },
        ],
      },
    });
    expect(syncPromo.statusCode).toBe(200);
    expect(ipaProd.categoryId).toBeTruthy();

    const promoSubRow = await db.query<{
      subtotal_amount: string;
      discount_amount: string;
      total_amount: string;
    }>(
      `SELECT subtotal_amount::text, discount_amount::text, total_amount::text
       FROM sub_accounts WHERE id = $1`,
      [promoSubId],
    );
    const promoItems = await db.query<{
      id: string;
      quantity: number;
      promotion_rule_id: string | null;
      discount_amount: string;
      line_total: string;
    }>(
      `SELECT id, quantity, promotion_rule_id, discount_amount::text, line_total::text
       FROM order_items WHERE sub_account_id = $1 ORDER BY created_at ASC`,
      [promoSubId],
    );

    // 4 units gross, 2 units free = exact 50% discount across 2 separate promo lines, NO double-discounting!
    expect(Number(promoSubRow.rows[0]?.subtotal_amount)).toBe(ipaPres.salePrice * 4);
    expect(Number(promoSubRow.rows[0]?.discount_amount)).toBe(ipaPres.salePrice * 2);
    expect(Number(promoSubRow.rows[0]?.total_amount)).toBe(ipaPres.salePrice * 2);
    expect(promoItems.rows).toHaveLength(2);
    for (const row of promoItems.rows) {
      expect(row.quantity).toBe(2);
      expect(row.promotion_rule_id).toBe(quickPromoId);
      expect(Number(row.discount_amount)).toBe(ipaPres.salePrice);
      expect(Number(row.line_total)).toBe(ipaPres.salePrice);
    }

    // Category + presentationGroups filter E2E: promo only for "jirafa" in craft category must NOT apply to "pinta"
    const onlyJirafaPromo = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/promotions`,
      headers: authHeader(adminToken),
      payload: {
        name: "Solo Jirafas Artesanales -20%",
        ruleType: "percentage_discount",
        scopeType: "category",
        applicationMode: "automatic",
        targetId: ipaProd.categoryId,
        config: { percent: 20, minQuantity: 1, presentationGroups: ["jirafa"] },
        priority: 1,
      },
    });
    expect(onlyJirafaPromo.statusCode).toBe(201);
    const bootWithGroupPromo = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(adminToken),
    });
    const savedGroupPromo = (
      bootWithGroupPromo.json().promotionRules as Array<{
        id: string;
        config: { presentationGroups?: string[] };
      }>
    ).find((r) => r.id === onlyJirafaPromo.json().id);
    expect(savedGroupPromo?.config.presentationGroups).toEqual(["jirafa"]);

    // Split-account guard + DELETE_SUB_ACCOUNT + consolidate-and-disable-splits E2E
    const splitSub2Id = generateUuidV7();
    const splitSub3Id = generateUuidV7();
    const splitTs = Date.now() + 300;
    const createExtraSubs = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(adminToken),
      payload: {
        branchId,
        deviceId: "test-device-split",
        commands: [
          {
            idempotencyKey: generateUuidV7(splitTs + 1),
            branchId,
            deviceId: "test-device-split",
            userId: adminUserId,
            commandType: "CREATE_SUB_ACCOUNT",
            clientHlc: new Date(splitTs + 1).toISOString(),
            payload: { tableSessionId: promoSessionId, subAccountId: splitSub2Id, label: "Cuenta 2" },
          },
          {
            idempotencyKey: generateUuidV7(splitTs + 2),
            branchId,
            deviceId: "test-device-split",
            userId: adminUserId,
            commandType: "CREATE_SUB_ACCOUNT",
            clientHlc: new Date(splitTs + 2).toISOString(),
            payload: { tableSessionId: promoSessionId, subAccountId: splitSub3Id, label: "Cuenta 3" },
          },
        ],
      },
    });
    expect(createExtraSubs.statusCode).toBe(200);

    // 1) Trying to disable enableSplitAccounts while open split accounts exist MUST return 409 SPLIT_ACCOUNTS_OPEN
    const blockedSplitOff = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/settings`,
      headers: authHeader(adminToken),
      payload: { enableSplitAccounts: false },
    });
    expect(blockedSplitOff.statusCode).toBe(409);
    expect(blockedSplitOff.json().error).toBe("SPLIT_ACCOUNTS_OPEN");
    expect(blockedSplitOff.json().canAutoConsolidate).toBe(true);
    expect(blockedSplitOff.json().affectedTables).toHaveLength(1);

    // 2) Delete empty Cuenta 3 via DELETE_SUB_ACCOUNT sync command
    const delSub3 = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(adminToken),
      payload: {
        branchId,
        deviceId: "test-device-split",
        commands: [
          {
            idempotencyKey: generateUuidV7(splitTs + 3),
            branchId,
            deviceId: "test-device-split",
            userId: adminUserId,
            commandType: "DELETE_SUB_ACCOUNT",
            clientHlc: new Date(splitTs + 3).toISOString(),
            payload: { subAccountId: splitSub3Id, mode: "empty_only" },
          },
        ],
      },
    });
    expect(delSub3.statusCode).toBe(200);
    const sub3Row = await db.query<{ status: string }>(`SELECT status FROM sub_accounts WHERE id = $1`, [
      splitSub3Id,
    ]);
    expect(sub3Row.rows[0]?.status).toBe("voided");

    // 3) Consolidate remaining split accounts (Cuenta 2 -> Cuenta 1) and disable split mode atomically
    const consolidateRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/settings/consolidate-and-disable-splits`,
      headers: authHeader(adminToken),
    });
    expect(consolidateRes.statusCode).toBe(200);
    expect(consolidateRes.json().consolidatedSubAccounts).toBe(1);
    expect(consolidateRes.json().featureFlags.enableSplitAccounts).toBe(false);

    // Seasonal / Limited Edition beer tag + quick POS visibility toggle from Stock E2E
    const seasonalBeerRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/items`,
      headers: authHeader(adminToken),
      payload: {
        name: "Pumpkin Ale Otoño",
        baseUnit: "ml",
        initialStockBase: 30000,
        initialTotalCost: 350000,
        minStockBase: 5000,
        defaultPourLossPercent: 8,
        isKeg: true,
        purchasePresentations: [{ name: "Barril 30L", factorToBase: 30000, isDefault: true }],
        publishToMenu: {
          categoryId: ipaProd.categoryId,
          productName: "Pumpkin Ale Otoño",
          imageUrl: "icon:craft_beer",
          editionTag: "Temporada",
          presentations: [
            {
              name: "Pinta 500ml",
              presentationGroup: "pinta",
              salePrice: 16000,
              displayUnit: "ml",
              displayQuantity: 500,
              pourLossPercent: 8,
              fixedLossBase: 15,
            },
          ],
        },
      },
    });
    expect(seasonalBeerRes.statusCode).toBe(201);
    const seasonalProductId = seasonalBeerRes.json().createdProductId as string;
    expect(seasonalProductId).toBeTruthy();

    // Pause in POS & update badge to "Edición Limitada"
    const patchSeasonal = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/products/${seasonalProductId}`,
      headers: authHeader(adminToken),
      payload: { isAvailable: false, editionTag: "Edición Limitada" },
    });
    expect(patchSeasonal.statusCode).toBe(200);

    const bootSeasonal = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(adminToken),
    });
    const seasonalProd = (
      bootSeasonal.json().menuProducts as Array<{
        id: string;
        isAvailable: boolean;
        editionTag: string | null;
      }>
    ).find((p) => p.id === seasonalProductId);
    expect(seasonalProd?.isAvailable).toBe(false);
    expect(seasonalProd?.editionTag).toBe("Edición Limitada");

    // Parametric per-role module permissions E2E
    // 1) Non-admin cannot change role permissions (403)
    const waiterPatchPerms = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/role-permissions`,
      headers: authHeader(waiterToken),
      payload: { waiter: { kpis: "view" } },
    });
    expect(waiterPatchPerms.statusCode).toBe(403);

    // 2) Admin grants waiter KPIs "view" and sets POS to "view" (read-only)
    const adminPatchPerms = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/role-permissions`,
      headers: authHeader(adminToken),
      payload: { waiter: { kpis: "view", pos: "view" } },
    });
    expect(adminPatchPerms.statusCode).toBe(200);
    expect(adminPatchPerms.json().rolePermissions.waiter.kpis).toBe("view");
    expect(adminPatchPerms.json().rolePermissions.waiter.pos).toBe("view");
    expect(adminPatchPerms.json().rolePermissions.admin.settings).toBe("edit");

    // 3) Waiter can now read KPIs (200), but CANNOT push POS sync commands because pos is "view" (403)
    const waiterKpisAllowed = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/kpis?period=monthly`,
      headers: authHeader(waiterToken),
    });
    expect(waiterKpisAllowed.statusCode).toBe(200);

    const waiterPosBlocked = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(waiterToken),
      payload: {
        branchId,
        deviceId: "waiter-readonly-test",
        commands: [],
      },
    });
    expect(waiterPosBlocked.statusCode).toBe(403);
    expect(waiterPosBlocked.json().error).toBe("INSUFFICIENT_MODULE_PERMISSION");

    // Daily Cash Flow + Operating Expenses (servicios) + Role-scoped Period (Waiter=daily, Admin=monthly) E2E
    const expenseRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/cash-expenses`,
      headers: authHeader(waiterToken),
      payload: {
        paymentMethodId: cashMethodId,
        category: "servicios",
        description: "Pago recibo de luz",
        amount: 35000,
      },
    });
    expect(expenseRes.statusCode).toBe(201);

    // Waiter asking for period=monthly MUST still receive period="daily" (today only)
    const waiterCashFlow = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/cash-flow?period=monthly`,
      headers: authHeader(waiterToken),
    });
    expect(waiterCashFlow.statusCode).toBe(200);
    expect(waiterCashFlow.json().period).toBe("daily");
    expect(waiterCashFlow.json().isAdminScope).toBe(false);
    expect(waiterCashFlow.json().balance.totalOutflows).toBe(35000);
    expect(waiterCashFlow.json().expenses).toHaveLength(1);

    // Admin defaults to monthly and sees grouped movements by payment method
    const adminCashFlow = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/cash-flow`,
      headers: authHeader(adminToken),
    });
    expect(adminCashFlow.statusCode).toBe(200);
    expect(adminCashFlow.json().period).toBe("monthly");
    expect(adminCashFlow.json().isAdminScope).toBe(true);
    const cashBucket = (
      adminCashFlow.json().byPaymentMethod as Array<{
        paymentMethodId: string;
        expensesOut: number;
        movements: Array<{ kind: string }>;
      }>
    ).find((m) => m.paymentMethodId === cashMethodId);
    expect(cashBucket?.expensesOut).toBe(35000);
    expect(cashBucket?.movements.some((mv) => mv.kind === "expense")).toBe(true);

    // === NEW FEATURES E2E: POS Table Rename + Custom Extra Charge + Cash Box Extra Inflow ===
    // Restore waiter pos="edit" so waiter can rename table directly from POS
    const restorePosRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/role-permissions`,
      headers: authHeader(adminToken),
      payload: { waiter: { pos: "edit" } },
    });
    expect(restorePosRes.statusCode).toBe(200);

    // 1) Fetch an existing dining table and rename it directly from POS (allowed with pos:edit)
    const preRenameBoot = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(waiterToken),
    });
    expect(preRenameBoot.statusCode).toBe(200);
    const targetTableId = (preRenameBoot.json().diningTables as Array<{ id: string }>)[0]!.id;

    const renameFromPos = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/tables/${targetTableId}`,
      headers: authHeader(waiterToken),
      payload: { label: "Mesa Rockera 1" },
    });
    expect(renameFromPos.statusCode).toBe(200);
    expect(renameFromPos.json().label).toBe("Mesa Rockera 1");

    // 2) Add custom extra charge (e.g. broken glass $15.000) to an active POS account via sync/batch
    const extraSessionId = generateUuidV7();
    const extraSubId = generateUuidV7();
    const extraItemId = generateUuidV7();
    const [openKey, chargeKey] = [generateUuidV7(), generateUuidV7()].sort() as [string, string];
    const customChargeSync = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(waiterToken),
      payload: {
        branchId,
        deviceId: "pos-extra-test",
        commands: [
          {
            idempotencyKey: openKey,
            branchId,
            deviceId: "pos-extra-test",
            userId: adminUserId,
            commandType: "OPEN_TABLE_SESSION",
            clientHlc: new Date().toISOString(),
            payload: {
              tableSessionId: extraSessionId,
              diningTableId: targetTableId,
              subAccountId: extraSubId,
              label: "Cuenta 1",
            },
          },
          {
            idempotencyKey: chargeKey,
            branchId,
            deviceId: "pos-extra-test",
            userId: adminUserId,
            commandType: "ADD_CUSTOM_CHARGE",
            clientHlc: new Date().toISOString(),
            payload: {
              orderItemId: extraItemId,
              subAccountId: extraSubId,
              description: "Vaso pinta roto",
              categoryLabel: "Reposición / Daño",
              amount: 15000,
              quantity: 1,
            },
          },
        ],
      },
    });
    expect(customChargeSync.statusCode).toBe(200);
    expect(
      (customChargeSync.json().receipts as Array<{ status: string }>).every(
        (r) => r.status === "applied",
      ),
    ).toBe(true);

    // Verify bootstrap returns renamed table AND custom charge order item (LEFT JOIN menu_products)
    const bootstrapWithExtra = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(waiterToken),
    });
    expect(bootstrapWithExtra.statusCode).toBe(200);
    expect(
      (bootstrapWithExtra.json().diningTables as Array<{ id: string; label: string }>).find(
        (t) => t.id === targetTableId,
      )?.label,
    ).toBe("Mesa Rockera 1");
    const extraLine = (
      bootstrapWithExtra.json().openOrderItems as Array<{
        id: string;
        productNameSnap: string;
        lineTotal: number;
        presentationId: string | null;
      }>
    ).find((oi) => oi.id === extraItemId);
    expect(extraLine?.productNameSnap).toBe("Vaso pinta roto");
    expect(extraLine?.lineTotal).toBe(15000);
    expect(extraLine?.presentationId).toBeNull();

    // Verify KPIs include custom charge cleanly without breaking category aggregation
    const kpisWithExtra = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/kpis?period=monthly`,
      headers: authHeader(adminToken),
    });
    expect(kpisWithExtra.statusCode).toBe(200);

    // 3) Record misc extra inflow in cash box (cash_extras) and verify cash-flow balance + delete
    const cashExtraRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/cash-extras`,
      headers: authHeader(waiterToken),
      payload: {
        paymentMethodId: cashMethodId,
        category: "cover",
        description: "Cover entrada banda en vivo",
        amount: 50000,
      },
    });
    expect(cashExtraRes.statusCode).toBe(201);
    const cashExtraId = cashExtraRes.json().id as string;

    const cashFlowWithExtra = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/cash-flow`,
      headers: authHeader(adminToken),
    });
    expect(cashFlowWithExtra.statusCode).toBe(200);
    expect(cashFlowWithExtra.json().balance.totalExtraInflows).toBe(50000);
    expect(cashFlowWithExtra.json().extras).toHaveLength(1);
    const updatedCashBucket = (
      cashFlowWithExtra.json().byPaymentMethod as Array<{
        paymentMethodId: string;
        extrasIn: number;
        movements: Array<{ kind: string }>;
      }>
    ).find((m) => m.paymentMethodId === cashMethodId);
    expect(updatedCashBucket?.extrasIn).toBe(50000);
    expect(updatedCashBucket?.movements.some((mv) => mv.kind === "extra_income")).toBe(true);

    const delExtraRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/branches/${branchId}/cash-extras/${cashExtraId}`,
      headers: authHeader(waiterToken),
    });
    expect(delExtraRes.statusCode).toBe(200);
    expect(delExtraRes.json().deleted).toBe(true);

    // === SUPERADMIN GO-LIVE OPERATIONAL PURGE E2E ===
    // 1) Bar Admin (non-SuperAdmin) is strictly blocked (403)
    const adminBlockedPreview = await app.inject({
      method: "GET",
      url: `/api/v1/superadmin/branches/${branchId}/purge-preview`,
      headers: authHeader(adminToken),
    });
    expect(adminBlockedPreview.statusCode).toBe(403);

    // 2) SuperAdmin fetches preview and sees branch code + live test counts + preserved catalog counts
    const previewRes = await app.inject({
      method: "GET",
      url: `/api/v1/superadmin/branches/${branchId}/purge-preview`,
      headers: authHeader(superAdminToken),
    });
    expect(previewRes.statusCode).toBe(200);
    const previewData = previewRes.json() as {
      branch: { code: string };
      toDelete: {
        orderItems: number;
        payments: number;
        cashExpenses: number;
        inventoryLedgerEntries: number;
        itemsWithTestSales: number;
      };
      toPreserve: {
        menuProducts: number;
        inventoryItems: number;
        diningTables: number;
      };
    };
    const branchCodeForPurge = previewData.branch.code;
    expect(previewData.toDelete.orderItems).toBeGreaterThan(0);
    expect(previewData.toDelete.cashExpenses).toBe(1);
    expect(previewData.toDelete.itemsWithTestSales).toBeGreaterThan(0);
    expect(previewData.toPreserve.menuProducts).toBeGreaterThan(0);
    expect(previewData.toPreserve.inventoryItems).toBeGreaterThan(0);
    expect(previewData.toPreserve.diningTables).toBeGreaterThan(0);

    // 3) Safety guardrails: wrong confirmation code (400) & wrong SuperAdmin password (401)
    const wrongCodeRes = await app.inject({
      method: "POST",
      url: `/api/v1/superadmin/branches/${branchId}/purge-operations`,
      headers: authHeader(superAdminToken),
      payload: {
        confirmBranchCode: "WRONG-CODE",
        superAdminPassword: "SuperPassword123",
        stockMode: "restore_test_sales",
        openingFloat: 150000,
      },
    });
    expect(wrongCodeRes.statusCode).toBe(400);
    expect(wrongCodeRes.json().error).toBe("CONFIRMATION_MISMATCH");

    const wrongPwdRes = await app.inject({
      method: "POST",
      url: `/api/v1/superadmin/branches/${branchId}/purge-operations`,
      headers: authHeader(superAdminToken),
      payload: {
        confirmBranchCode: branchCodeForPurge,
        superAdminPassword: "WrongPassword999",
        stockMode: "restore_test_sales",
        openingFloat: 150000,
      },
    });
    expect(wrongPwdRes.statusCode).toBe(401);
    expect(wrongPwdRes.json().error).toBe("INVALID_SUPERADMIN_PASSWORD");

    // 4) Execute Go-Live purge with restore_test_sales + opening float $150,000
    const purgeRes = await app.inject({
      method: "POST",
      url: `/api/v1/superadmin/branches/${branchId}/purge-operations`,
      headers: authHeader(superAdminToken),
      payload: {
        confirmBranchCode: branchCodeForPurge,
        superAdminPassword: "SuperPassword123",
        stockMode: "restore_test_sales",
        openingFloat: 150000,
      },
    });
    expect(purgeRes.statusCode).toBe(200);
    expect(purgeRes.json().deletedOrderItems).toBeGreaterThan(0);
    expect(purgeRes.json().restoredItemsCount).toBeGreaterThan(0);
    expect(purgeRes.json().openingLedgerSnapshots).toBeGreaterThan(0);
    expect(purgeRes.json().operationalGoLiveAt).toBeTruthy();

    // 5) Verify post-purge state: sales/expenses/debts/open tables are 0, catalog & restored keg stock preserved!
    const postPurgeBoot = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(adminToken),
    });
    expect(postPurgeBoot.statusCode).toBe(200);
    expect(postPurgeBoot.json().openTableSessions).toHaveLength(0);
    expect(postPurgeBoot.json().openOrderItems).toHaveLength(0);
    expect(postPurgeBoot.json().menuProducts.length).toBe(previewData.toPreserve.menuProducts);
    expect(postPurgeBoot.json().diningTables.length).toBe(previewData.toPreserve.diningTables);
    expect(postPurgeBoot.json().activeShift?.openingFloat).toBe(150000);
    const restoredKeg = (
      postPurgeBoot.json().inventoryItems as Array<{ id: string; currentStockBase: number }>
    ).find((i) => i.id === kegId);
    expect(restoredKeg?.currentStockBase).toBe(30000); // Exact initial 30L keg restored!

    const postPurgeCash = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/cash-flow`,
      headers: authHeader(adminToken),
    });
    expect(postPurgeCash.statusCode).toBe(200);
    expect(postPurgeCash.json().salesSummary.netSales).toBe(0);
    expect(postPurgeCash.json().balance.totalOutflows).toBe(0);
    expect(postPurgeCash.json().pendingTotals.customerDebtsTotal).toBe(0);

    // 6) Immutability trigger MUST still block normal DELETE outside authorized purge transaction!
    await expect(
      db.query(`DELETE FROM inventory_ledger WHERE branch_id = $1`, [branchId]),
    ).rejects.toThrow(/append-only/i);

    // === PHASE 4 E2E: SHIFT LOCK, BODEGA VAULT, $0 TABLE CLEANUP, FINANCE LEDGER, STOCK PAYABLES, COMBO TEMPLATES & SCHEDULES ===
    // 1) Branch multi-slot operating schedules (weekdays + overnight weekend until 03:00 AM)
    const schedRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/operating-schedules`,
      headers: authHeader(adminToken),
      payload: {
        operatingSchedules: [
          { daysOfWeek: [1, 2, 3, 4], openTime: "16:00", closeTime: "23:30", label: "Entre semana" },
          { daysOfWeek: [5, 6], openTime: "16:00", closeTime: "03:00", label: "Fin de semana madrugada" },
        ],
      },
    });
    expect(schedRes.statusCode).toBe(200);
    expect(schedRes.json().operatingSchedules).toHaveLength(2);

    // 2) Create a category-wide dynamic combo template (e.g. Any Beer Pinta + Hot Dog Ally)
    const comboTplRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/combo-templates`,
      headers: authHeader(adminToken),
      payload: {
        name: "Perro Caliente",
        shortLabel: "Perro",
        scopeType: "category",
        targetId: catId,
        presentationGroup: "pinta",
        pricingMode: "fixed_price",
        priceValue: 22000,
        allyId,
        allyPayoutAmount: 10000,
      },
    });
    expect(comboTplRes.statusCode).toBe(201);
    const comboTplId = comboTplRes.json().id as string;

    // 3) Sell the dynamic combo on the IPA Pinta -> deducts exact IPA keg + records ally payout!
    const preComboBoot = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(adminToken),
    });
    const ipaPresId = (
      preComboBoot.json().presentations as Array<{ id: string; presentationGroup: string; name: string }>
    ).find((p) => p.presentationGroup === "pinta")!.id;
    const vaultId = (
      preComboBoot.json().treasuryAccounts as Array<{ id: string; isInternalVault: boolean }>
    ).find((a) => a.isInternalVault)!.id;
    expect(vaultId).toBeTruthy();

    const comboSessId = generateUuidV7();
    const comboSubId = generateUuidV7();
    const emptySessId = generateUuidV7();
    const emptySubId = generateUuidV7();
    const [k1, k2, k3] = [generateUuidV7(), generateUuidV7(), generateUuidV7()].sort() as [
      string,
      string,
      string,
    ];
    const comboSync = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(adminToken),
      payload: {
        branchId,
        deviceId: "phase4-pos",
        commands: [
          {
            idempotencyKey: k1,
            branchId,
            deviceId: "phase4-pos",
            userId: adminUserId,
            commandType: "OPEN_TABLE_SESSION",
            clientHlc: new Date().toISOString(),
            payload: { tableSessionId: comboSessId, diningTableId: null, subAccountId: comboSubId, label: "Combo 1" },
          },
          {
            idempotencyKey: k2,
            branchId,
            deviceId: "phase4-pos",
            userId: adminUserId,
            commandType: "ADD_ORDER_ITEM",
            clientHlc: new Date().toISOString(),
            payload: {
              orderItemId: generateUuidV7(),
              subAccountId: comboSubId,
              presentationId: ipaPresId,
              quantity: 1,
              comboTemplateId: comboTplId,
            },
          },
          // Also open an empty $0 table to verify auto-cleanup on shift closure!
          {
            idempotencyKey: k3,
            branchId,
            deviceId: "phase4-pos",
            userId: adminUserId,
            commandType: "OPEN_TABLE_SESSION",
            clientHlc: new Date().toISOString(),
            payload: { tableSessionId: emptySessId, diningTableId: targetTableId, subAccountId: emptySubId, label: "Mesa Vacia" },
          },
        ],
      },
    });
    expect(comboSync.statusCode).toBe(200);

    // Confirm IPA keg was deducted (30000 - 555ml = 29445ml) AND combo line priced at 22000
    const afterComboBoot = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(adminToken),
    });
    const ipaAfterCombo = (
      afterComboBoot.json().inventoryItems as Array<{ id: string; currentStockBase: number }>
    ).find((i) => i.id === kegId);
    expect(ipaAfterCombo?.currentStockBase).toBe(29445);
    const comboOrderLine = (
      afterComboBoot.json().openOrderItems as Array<{ subAccountId: string; lineTotal: number; productKindSnap: string }>
    ).find((oi) => oi.subAccountId === comboSubId);
    expect(comboOrderLine?.lineTotal).toBe(22000);
    expect(comboOrderLine?.productKindSnap).toBe("combo");

    // 4) Stock purchase with partial payment -> creates editable cash_expense + supplier_payable
    const stockBuy = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/movements`,
      headers: authHeader(adminToken),
      payload: {
        inventoryItemId: kegId,
        movementType: "purchase",
        quantityBase: 30000,
        totalCost: 300000,
        reason: "Barril IPA proveedor",
        paymentStatus: "partial",
        paymentMethodId: cashMethodId,
        paidAmount: 100000,
        supplierName: "Cervecería Artesanal S.A.S.",
      },
    });
    expect(stockBuy.statusCode).toBe(201);
    const stockExpenseId = stockBuy.json().cashExpenseId as string;
    const stockPayableId = stockBuy.json().supplierPayableId as string;
    expect(stockExpenseId).toBeTruthy();
    expect(stockPayableId).toBeTruthy();

    // Edit the auto-created stock expense in Finance Ledger (fix amount/account!)
    const editExp = await app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branchId}/cash-expenses/${stockExpenseId}`,
      headers: authHeader(adminToken),
      payload: { amount: 90000, description: "Compra stock corregida: Barril IPA" },
    });
    expect(editExp.statusCode).toBe(200);

    // Pay remaining supplier debt from Bodega / Cash
    const paySupplier = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/supplier-payables/${stockPayableId}/payments`,
      headers: authHeader(adminToken),
      payload: { paymentMethodId: vaultId, amount: 200000, notes: "Saldo cancelado desde Bodega" },
    });
    expect(paySupplier.statusCode).toBe(201);
    expect(paySupplier.json().status).toBe("paid");

    // 5) Close shift WITHOUT opening next shift + transfer $50,000 to Bodega + auto-clean empty $0 table!
    const closeAndVault = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/shifts/close`,
      headers: authHeader(adminToken),
      payload: {
        declaredPhysicalCash: 150000,
        transferToVaultAmount: 50000,
        notes: "Cierre noche con traslado a Bodega",
      },
    });
    expect(closeAndVault.statusCode).toBe(200);
    expect(closeAndVault.json().transferToVaultAmount).toBe(50000);
    expect(closeAndVault.json().closingCashLeft).toBe(100000);
    expect(closeAndVault.json().cleanedEmptyTablesCount).toBe(1); // Empty $0 table auto-cleaned!

    // 6) Verify POS sales are BLOCKED (409 SHIFT_REQUIRED) when no cash shift is open!
    const blockedSale = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(waiterToken),
      payload: {
        branchId,
        deviceId: "blocked-pos",
        commands: [
          {
            idempotencyKey: generateUuidV7(),
            branchId,
            deviceId: "blocked-pos",
            userId: adminUserId,
            commandType: "OPEN_TABLE_SESSION",
            clientHlc: new Date().toISOString(),
            payload: { tableSessionId: generateUuidV7(), diningTableId: null, subAccountId: generateUuidV7(), label: "Bloqueada" },
          },
        ],
      },
    });
    expect(blockedSale.statusCode).toBe(409);
    expect(blockedSale.json().error).toBe("SHIFT_REQUIRED");

    // 7) Re-open shift with $95,000 (expected $100,000 left) -> detects -$5,000 opening discrepancy!
    const reopenShift = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/shifts/open`,
      headers: authHeader(waiterToken),
      payload: { openingFloat: 95000, notes: "Apertura siguiente día" },
    });
    expect(reopenShift.statusCode).toBe(201);
    expect(reopenShift.json().expectedOpeningFloat).toBe(100000);
    expect(reopenShift.json().openingDiscrepancy).toBe(-5000);

    // 8) Verify Finance module permission separation (Waiter blocked 403, Admin allowed 200 with Bodega balance)
    const waiterFinanceBlocked = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/finance/ledger`,
      headers: authHeader(waiterToken),
    });
    expect(waiterFinanceBlocked.statusCode).toBe(403);

    const adminFinance = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/finance/ledger?period=daily`,
      headers: authHeader(adminToken),
    });
    expect(adminFinance.statusCode).toBe(200);
    const vaultAcc = (
      adminFinance.json().accountBalances as Array<{ id: string; name: string; isInternalVault: boolean }>
    ).find((a) => a.isInternalVault);
    expect(vaultAcc?.name).toBe("Bodega");

    // 9) Sub-account label + description (create with tag -> edit via UPDATE_SUB_ACCOUNT -> verify in bootstrap)
    const tagSessId = generateUuidV7();
    const tagSubId = generateUuidV7();
    const [tk1, tk2] = [generateUuidV7(), generateUuidV7()].sort() as [string, string];
    const tagSync = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(waiterToken),
      payload: {
        branchId,
        deviceId: "tag-pos",
        commands: [
          {
            idempotencyKey: tk1,
            branchId,
            deviceId: "tag-pos",
            userId: adminUserId,
            commandType: "OPEN_TABLE_SESSION",
            clientHlc: new Date().toISOString(),
            payload: {
              tableSessionId: tagSessId,
              diningTableId: targetTableId,
              subAccountId: tagSubId,
              label: "Camilo",
              description: "Camisa negra · terraza",
            },
          },
          {
            idempotencyKey: tk2,
            branchId,
            deviceId: "tag-pos",
            userId: adminUserId,
            commandType: "UPDATE_SUB_ACCOUNT",
            clientHlc: new Date().toISOString(),
            payload: {
              subAccountId: tagSubId,
              label: "Camilo VIP",
              description: "Paga con Nequi al final",
            },
          },
        ],
      },
    });
    expect(tagSync.statusCode).toBe(200);

    const tagBoot = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(waiterToken),
    });
    const taggedSub = (
      tagBoot.json().openSubAccounts as Array<{ id: string; label: string; description: string | null }>
    ).find((sa) => sa.id === tagSubId);
    expect(taggedSub?.label).toBe("Camilo VIP");
    expect(taggedSub?.description).toBe("Paga con Nequi al final");

    // 10) Admin password-protected physical stock reconciliation (Stock y Carta restructuring)
    // Non-admin (waiter) MUST be blocked with 403
    const waiterReconcile = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/items/${kegId}/reconcile`,
      headers: authHeader(waiterToken),
      payload: {
        targetStockBase: 50000,
        reason: "Intento de mesero",
        adminPassword: "PasswordSegura123",
      },
    });
    expect(waiterReconcile.statusCode).toBe(403);

    // Admin with wrong password MUST be blocked with 401 INVALID_ADMIN_PASSWORD
    const wrongPassReconcile = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/items/${kegId}/reconcile`,
      headers: authHeader(adminToken),
      payload: {
        targetStockBase: 50000,
        reason: "Conteo físico con clave mala",
        adminPassword: "WrongPassword999",
      },
    });
    expect(wrongPassReconcile.statusCode).toBe(401);
    expect(wrongPassReconcile.json().error).toBe("INVALID_ADMIN_PASSWORD");

    // Admin with valid password reconciles exact physical count -> updates stock & writes immutable manual_adjustment ledger row
    const validReconcile = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/items/${kegId}/reconcile`,
      headers: authHeader(adminToken),
      payload: {
        targetStockBase: 55000,
        reason: "Conteo físico nocturno de barriles",
        adminPassword: "PasswordSegura123",
      },
    });
    expect(validReconcile.statusCode).toBe(200);
    expect(validReconcile.json().previousStockBase).toBe(59445);
    expect(validReconcile.json().nextStockBase).toBe(55000);
    expect(validReconcile.json().deltaBase).toBe(-4445);

    const ledgerAfterReconcile = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/inventory/ledger?limit=5&itemId=${kegId}`,
      headers: authHeader(adminToken),
    });
    expect(ledgerAfterReconcile.statusCode).toBe(200);
    const latestReconcileRow = (
      ledgerAfterReconcile.json().entries as Array<{
        movementType: string;
        quantityDeltaBase: number;
        stockAfterBase: number;
        reason: string | null;
      }>
    )[0];
    expect(latestReconcileRow?.movementType).toBe("manual_adjustment");
    expect(latestReconcileRow?.quantityDeltaBase).toBe(-4445);
    expect(latestReconcileRow?.stockAfterBase).toBe(55000);
    expect(latestReconcileRow?.reason).toContain("Conteo físico nocturno de barriles");

    // Reconciling to the exact same stock returns 400 NO_STOCK_CHANGE
    const noopReconcile = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/items/${kegId}/reconcile`,
      headers: authHeader(adminToken),
      payload: {
        targetStockBase: 55000,
        reason: "Sin cambio",
        adminPassword: "PasswordSegura123",
      },
    });
    expect(noopReconcile.statusCode).toBe(400);
    expect(noopReconcile.json().error).toBe("NO_STOCK_CHANGE");

    // 11) Unified Dynamic + Fixed House Food Combo (2x Pinta of any Craft Beer + 3 Empanadas de la Casa)
    const empanadaRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/inventory/items`,
      headers: authHeader(adminToken),
      payload: {
        name: "Empanadas de la Casa",
        baseUnit: "unit",
        initialStockBase: 20,
        initialTotalCost: 40000,
        minStockBase: 5,
      },
    });
    expect(empanadaRes.statusCode).toBe(201);
    const empanadaId = empanadaRes.json().id as string;

    const unifiedComboRes = await app.inject({
      method: "POST",
      url: `/api/v1/branches/${branchId}/combo-templates`,
      headers: authHeader(adminToken),
      payload: {
        name: "3 Empanadas de la Casa",
        shortLabel: "Empanadas",
        scopeType: "category",
        targetId: ipaProd.categoryId,
        presentationGroup: "pinta",
        baseQuantity: 2,
        companionType: "house",
        pricingMode: "fixed_price",
        priceValue: 35000,
        fixedRecipes: [
          {
            inventoryItemId: empanadaId,
            displayUnit: "unit",
            displayQuantity: 3,
          },
        ],
      },
    });
    expect(unifiedComboRes.statusCode).toBe(201);
    const unifiedComboId = unifiedComboRes.json().id as string;

    const houseComboSessId = generateUuidV7();
    const houseComboSubId = generateUuidV7();
    const [hk1, hk2] = [generateUuidV7(), generateUuidV7()].sort() as [string, string];
    const houseComboSync = await app.inject({
      method: "POST",
      url: "/api/v1/sync/batch",
      headers: authHeader(waiterToken),
      payload: {
        branchId,
        deviceId: "unified-combo-pos",
        commands: [
          {
            idempotencyKey: hk1,
            branchId,
            deviceId: "unified-combo-pos",
            userId: adminUserId,
            commandType: "OPEN_TABLE_SESSION",
            clientHlc: new Date().toISOString(),
            payload: {
              tableSessionId: houseComboSessId,
              diningTableId: null,
              subAccountId: houseComboSubId,
              label: "Mesa Combo Casa",
            },
          },
          {
            idempotencyKey: hk2,
            branchId,
            deviceId: "unified-combo-pos",
            userId: adminUserId,
            commandType: "ADD_ORDER_ITEM",
            clientHlc: new Date().toISOString(),
            payload: {
              orderItemId: generateUuidV7(),
              subAccountId: houseComboSubId,
              presentationId: ipaPresId,
              quantity: 1,
              comboTemplateId: unifiedComboId,
            },
          },
        ],
      },
    });
    expect(houseComboSync.statusCode).toBe(200);

    const afterHouseComboBoot = await app.inject({
      method: "GET",
      url: `/api/v1/branches/${branchId}/bootstrap`,
      headers: authHeader(adminToken),
    });
    const bootInv = afterHouseComboBoot.json().inventoryItems as Array<{
      id: string;
      currentStockBase: number;
    }>;
    // Keg was 55,000ml; 2x Pinta (500ml + 8% foam + 15ml purge = 555ml each -> 1,110ml) => 53,890ml!
    expect(bootInv.find((i) => i.id === kegId)?.currentStockBase).toBe(53890);
    // Empanadas started at 20 units; 3 deducted atomically => 17 units!
    expect(bootInv.find((i) => i.id === empanadaId)?.currentStockBase).toBe(17);

    const houseComboLine = (
      afterHouseComboBoot.json().openOrderItems as Array<{
        subAccountId: string;
        lineTotal: number;
        presentationNameSnap: string;
      }>
    ).find((oi) => oi.subAccountId === houseComboSubId);
    expect(houseComboLine?.lineTotal).toBe(35000);
    expect(houseComboLine?.presentationNameSnap).toContain("2×");
    expect(houseComboLine?.presentationNameSnap).toContain("Empanadas");
  });
});
