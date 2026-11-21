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
  });
});
