import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateUuidV7, type UserRole } from "@liquistock/domain";
import {
  loadAuthContextFromToken,
  requireAuth,
  requireOrgAdmin,
  requireSuperAdmin,
} from "../../../infrastructure/auth/auth-guard.js";
import { hashSecret, verifySecret } from "../../../infrastructure/auth/crypto.js";
import { signAuthToken } from "../../../infrastructure/auth/jwt.js";
import { db, withTransaction } from "../../../infrastructure/db/pool.js";

// Lightweight in-memory brute-force protection for login endpoints (10 failures / 5 min per key)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + WINDOW_MS });
    return true;
  }
  return entry.count < MAX_ATTEMPTS;
}

function recordFailedAttempt(key: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearAttempts(key: string): void {
  loginAttempts.delete(key);
}

const socialLinksSchema = z
  .object({
    instagram: z.string().max(160).optional().or(z.literal("")),
    facebook: z.string().max(160).optional().or(z.literal("")),
    tiktok: z.string().max(160).optional().or(z.literal("")),
    whatsapp: z.string().max(60).optional().or(z.literal("")),
    website: z.string().max(200).optional().or(z.literal("")),
  })
  .default({});

const superAdminSetupSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
});

const registerBarSchema = z.object({
  barName: z.string().min(2).max(120),
  businessType: z.enum(["bar", "restaurant", "brewery", "pub", "cafe", "other"]).default("bar"),
  legalName: z.string().min(2).max(180),
  taxId: z.string().max(40).optional().or(z.literal("")),
  contactPhone: z.string().max(40).optional().or(z.literal("")),
  city: z.string().max(80).optional().or(z.literal("")),
  address: z.string().max(180).optional().or(z.literal("")),
  currency: z.enum(["COP", "USD", "MXN", "PEN", "EUR"]).default("COP"),
  socialLinks: socialLinksSchema.optional(),
  adminFullName: z.string().min(2).max(120),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
  adminPin: z.string().regex(/^\d{4,6}$/, "El PIN debe tener entre 4 y 6 dígitos").optional().or(z.literal("")),
  branchName: z.string().min(2).max(100).default("Sede Principal"),
  branchCode: z.string().min(2).max(24).default("SEDE1"),
  tableCount: z.number().int().min(0).max(60).default(6),
  openingFloat: z.number().min(0).default(0),
});

const addOrgByAdminSchema = z.object({
  barName: z.string().min(2).max(120),
  businessType: z.enum(["bar", "restaurant", "brewery", "pub", "cafe", "other"]).default("bar"),
  legalName: z.string().min(2).max(180),
  taxId: z.string().max(40).optional().or(z.literal("")),
  contactPhone: z.string().max(40).optional().or(z.literal("")),
  city: z.string().max(80).optional().or(z.literal("")),
  address: z.string().max(180).optional().or(z.literal("")),
  currency: z.enum(["COP", "USD", "MXN", "PEN", "EUR"]).default("COP"),
  socialLinks: socialLinksSchema.optional(),
  branchName: z.string().min(2).max(100).default("Sede Principal"),
  branchCode: z.string().min(2).max(24).default("SEDE1"),
  tableCount: z.number().int().min(0).max(60).default(6),
});

const updateOrgProfileSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  businessType: z.enum(["bar", "restaurant", "brewery", "pub", "cafe", "other"]).optional(),
  legalName: z.string().max(180).optional().nullable(),
  taxId: z.string().max(40).optional().nullable(),
  logoUrl: z.string().max(500).optional().nullable(),
  contactPhone: z.string().max(40).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  address: z.string().max(180).optional().nullable(),
  socialLinks: socialLinksSchema.optional(),
});

const barApprovalStatusSchema = z.object({
  status: z.enum(["approved", "rejected", "suspended"]),
  notes: z.string().max(300).optional().nullable(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const pinLoginSchema = z.object({
  branchCode: z.string().min(1),
  pin: z.string().regex(/^\d{4,6}$/),
});

const createUserSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
  quickPin: z.string().regex(/^\d{4,6}$/).optional().or(z.literal("")),
  assignments: z
    .array(
      z.object({
        branchId: z.string().uuid(),
        role: z.enum(["admin", "cashier", "waiter"]),
      }),
    )
    .min(1),
});

const patchUserSchema = z.object({
  fullName: z.string().min(2).max(120).optional(),
  password: z.string().min(8).optional(),
  quickPin: z.string().regex(/^\d{4,6}$/).optional().nullable(),
  isActive: z.boolean().optional(),
  assignments: z
    .array(
      z.object({
        branchId: z.string().uuid(),
        role: z.enum(["admin", "cashier", "waiter"]),
      }),
    )
    .min(1)
    .optional(),
});

const createBranchSchema = z.object({
  organizationId: z.string().uuid().optional(),
  name: z.string().min(2).max(100),
  code: z.string().min(2).max(24),
  tableCount: z.number().int().min(0).max(60).default(6),
  openingFloat: z.number().min(0).default(0),
});

function buildRolePermissions(role: UserRole) {
  return role === "admin"
    ? { canCollect: true, canDiscount: true, canVoid: true, canApproveCredit: true }
    : role === "cashier"
      ? { canCollect: true, canDiscount: true, canVoid: true, canApproveCredit: false }
      : { canCollect: true, canDiscount: false, canVoid: false, canApproveCredit: false };
}

export async function registerAuthAndUsersRoutes(app: FastifyInstance) {
  // 1. Public platform status: checks if SuperAdmin has been configured
  app.get("/api/v1/auth/status", async () => {
    const res = await db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM users WHERE is_super_admin = true`,
    );
    const hasSuperAdmin = Number(res.rows[0]?.cnt ?? "0") > 0;
    return { hasSuperAdmin, initialized: hasSuperAdmin };
  });

  // 2. First-run SuperAdmin setup (ONLY allowed when zero SuperAdmins exist)
  app.post("/api/v1/auth/superadmin-setup", async (request, reply) => {
    const existing = await db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM users WHERE is_super_admin = true`,
    );
    if (Number(existing.rows[0]?.cnt ?? "0") > 0) {
      return reply.status(403).send({
        error: "SUPERADMIN_ALREADY_EXISTS",
        message: "El SuperAdmin de la plataforma ya fue configurado.",
      });
    }

    const parsed = superAdminSetupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_SUPERADMIN_SETUP",
        message: parsed.error.issues[0]?.message ?? "Datos inválidos",
        issues: parsed.error.issues,
      });
    }

    const d = parsed.data;
    const emailNormalized = d.email.trim().toLowerCase();
    const dup = await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [emailNormalized]);
    if (dup.rows.length > 0) {
      return reply.status(409).send({
        error: "EMAIL_ALREADY_EXISTS",
        message: "Ese correo ya está registrado.",
      });
    }

    const superAdminId = generateUuidV7();
    const passwordHash = await hashSecret(d.password);

    await db.query(
      `INSERT INTO users (id, organization_id, full_name, email, password_hash, is_super_admin, is_active)
       VALUES ($1, NULL, $2, $3, $4, true, true)`,
      [superAdminId, d.fullName.trim(), emailNormalized, passwordHash],
    );

    const token = signAuthToken({
      sub: superAdminId,
      orgId: null,
      email: emailNormalized,
      fullName: d.fullName.trim(),
      isSuperAdmin: true,
    });
    const session = await loadAuthContextFromToken(token);

    return reply.status(201).send({
      token,
      user: session,
      defaultBranchId: null,
    });
  });

  // 3. Public Bar/Restaurant Registration (creates bar in 'pending_approval' for SuperAdmin review)
  app.post("/api/v1/auth/register-bar", async (request, reply) => {
    const parsed = registerBarSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_REGISTRATION",
        message: parsed.error.issues[0]?.message ?? "Revisa los campos del formulario.",
        issues: parsed.error.issues,
      });
    }

    const d = parsed.data;
    const emailNormalized = d.adminEmail.trim().toLowerCase();
    const dup = await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [emailNormalized]);
    if (dup.rows.length > 0) {
      return reply.status(409).send({
        error: "EMAIL_ALREADY_EXISTS",
        message: "Ya existe una cuenta registrada con ese correo electrónico.",
      });
    }

    const passwordHash = await hashSecret(d.adminPassword);
    const pinHash = d.adminPin ? await hashSecret(d.adminPin) : null;

    const orgId = generateUuidV7();
    const adminId = generateUuidV7();
    const branchId = generateUuidV7();
    const cleanCode =
      d.branchCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "") || "SEDE1";

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO organizations (
           id, name, currency, business_type, legal_name, tax_id,
           contact_phone, city, address, social_links, approval_status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending_approval')`,
        [
          orgId,
          d.barName.trim(),
          d.currency,
          d.businessType,
          d.legalName.trim(),
          d.taxId?.trim() || null,
          d.contactPhone?.trim() || null,
          d.city?.trim() || null,
          d.address?.trim() || null,
          JSON.stringify(d.socialLinks ?? {}),
        ],
      );

      await client.query(
        `INSERT INTO users (id, organization_id, full_name, email, password_hash, quick_pin_hash, is_super_admin, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, false, true)`,
        [adminId, orgId, d.adminFullName.trim(), emailNormalized, passwordHash, pinHash],
      );

      await client.query(`UPDATE organizations SET owner_user_id = $2 WHERE id = $1`, [
        orgId,
        adminId,
      ]);

      await client.query(
        `INSERT INTO branches (id, organization_id, name, code, timezone)
         VALUES ($1, $2, $3, $4, 'America/Bogota')`,
        [branchId, orgId, d.branchName.trim(), cleanCode],
      );

      await client.query(
        `INSERT INTO branch_memberships (id, branch_id, user_id, role, permissions)
         VALUES ($1, $2, $3, 'admin', $4::jsonb)`,
        [generateUuidV7(), branchId, adminId, JSON.stringify(buildRolePermissions("admin"))],
      );

      for (let i = 1; i <= d.tableCount; i += 1) {
        await client.query(
          `INSERT INTO dining_tables (id, branch_id, label, zone, sort_order)
           VALUES ($1, $2, $3, 'Salón', $4)`,
          [generateUuidV7(), branchId, `Mesa ${i}`, i],
        );
      }

      const defaultPms = [
        ["Efectivo", "CASH", true, 1],
        ["Nequi", "NEQUI", false, 2],
        ["Datáfono", "CARD", false, 3],
      ] as const;
      for (const [name, code, isCash, sort] of defaultPms) {
        await client.query(
          `INSERT INTO payment_methods (id, branch_id, name, code, counts_as_physical_cash, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [generateUuidV7(), branchId, name, code, isCash, sort],
        );
      }

      await client.query(
        `INSERT INTO cash_shifts (id, branch_id, opened_by, status, opening_float)
         VALUES ($1, $2, $3, 'open', $4)`,
        [generateUuidV7(), branchId, adminId, d.openingFloat],
      );
    });

    return reply.status(201).send({
      status: "pending_approval",
      organizationId: orgId,
      message:
        "Solicitud enviada. Podrás iniciar sesión tan pronto tu bar/restaurante sea aprobado.",
    });
  });

  // 4. Email + Password Login (SuperAdmin OR Approved Bar Users)
  app.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_CREDENTIALS_FORMAT" });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const rateKey = `login:${request.ip}:${email}`;
    if (!checkRateLimit(rateKey)) {
      return reply.status(429).send({
        error: "TOO_MANY_ATTEMPTS",
        message: "Demasiados intentos fallidos. Espera 5 minutos e intenta de nuevo.",
      });
    }

    const userRes = await db.query<{
      id: string;
      organization_id: string | null;
      full_name: string;
      email: string;
      password_hash: string | null;
      is_super_admin: boolean;
      is_active: boolean;
    }>(
      `SELECT id, organization_id, full_name, email, password_hash, is_super_admin, is_active
       FROM users WHERE lower(email) = $1`,
      [email],
    );

    const user = userRes.rows[0];
    const ok =
      user && user.is_active && (await verifySecret(parsed.data.password, user.password_hash));
    if (!ok || !user) {
      recordFailedAttempt(rateKey);
      return reply.status(401).send({
        error: "INVALID_CREDENTIALS",
        message: "Correo o contraseña incorrectos.",
      });
    }

    clearAttempts(rateKey);

    if (user.is_super_admin) {
      const token = signAuthToken({
        sub: user.id,
        orgId: null,
        email: user.email,
        fullName: user.full_name,
        isSuperAdmin: true,
      });
      const session = await loadAuthContextFromToken(token);
      return { token, user: session, defaultBranchId: null };
    }

    // Verify at least one bar/organization for this user is APPROVED
    const orgsRes = await db.query<{
      id: string;
      name: string;
      approval_status: "pending_approval" | "approved" | "rejected" | "suspended";
      approval_notes: string | null;
    }>(
      `SELECT DISTINCT o.id, o.name, o.approval_status, o.approval_notes
       FROM organizations o
       LEFT JOIN branches b ON b.organization_id = o.id
       LEFT JOIN branch_memberships bm ON bm.branch_id = b.id AND bm.user_id = $1 AND bm.is_active = true
       WHERE o.id = $2 OR o.owner_user_id = $1 OR bm.user_id = $1`,
      [user.id, user.organization_id],
    );

    const hasApproved = orgsRes.rows.some((o) => o.approval_status === "approved");
    if (!hasApproved) {
      const pending = orgsRes.rows.find((o) => o.approval_status === "pending_approval");
      if (pending) {
        return reply.status(403).send({
          error: "ORG_PENDING_APPROVAL",
          message: `Tu solicitud para "${pending.name}" aún está en revisión.`,
        });
      }
      const rejected = orgsRes.rows.find((o) => o.approval_status === "rejected");
      if (rejected) {
        return reply.status(403).send({
          error: "ORG_REJECTED",
          message: `La solicitud para "${rejected.name}" fue rechazada.${rejected.approval_notes ? ` Motivo: ${rejected.approval_notes}` : ""}`,
        });
      }
      const suspended = orgsRes.rows.find((o) => o.approval_status === "suspended");
      if (suspended) {
        return reply.status(403).send({
          error: "ORG_SUSPENDED",
          message: `"${suspended.name}" se encuentra suspendido temporalmente.${suspended.approval_notes ? ` Motivo: ${suspended.approval_notes}` : ""}`,
        });
      }
      return reply.status(403).send({
        error: "NO_ACTIVE_BAR",
        message: "Tu usuario no tiene bares o sucursales activas asignadas.",
      });
    }

    const token = signAuthToken({
      sub: user.id,
      orgId: user.organization_id,
      email: user.email,
      fullName: user.full_name,
      isSuperAdmin: false,
    });
    const session = await loadAuthContextFromToken(token);
    if (!session || session.memberships.length === 0) {
      return reply.status(403).send({
        error: "NO_BRANCH_ACCESS",
        message: "Tu usuario no tiene sucursales activas en un bar aprobado.",
      });
    }

    return {
      token,
      user: session,
      defaultBranchId: session.memberships[0]?.branchId ?? null,
    };
  });

  // 5. Quick PIN Login for shared bar tablets/phones (ONLY approved bars!)
  app.post("/api/v1/auth/pin-login", async (request, reply) => {
    const parsed = pinLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_PIN_FORMAT" });
    }

    const branchCode = parsed.data.branchCode.trim().toUpperCase();
    const rateKey = `pin:${request.ip}:${branchCode}`;
    if (!checkRateLimit(rateKey)) {
      return reply.status(429).send({
        error: "TOO_MANY_ATTEMPTS",
        message: "Demasiados intentos de PIN. Espera 5 minutos.",
      });
    }

    const candidates = await db.query<{
      id: string;
      organization_id: string;
      full_name: string;
      email: string;
      quick_pin_hash: string | null;
      branch_id: string;
    }>(
      `SELECT u.id, u.organization_id, u.full_name, u.email, u.quick_pin_hash, b.id AS branch_id
       FROM users u
       JOIN branch_memberships bm ON bm.user_id = u.id
       JOIN branches b ON b.id = bm.branch_id
       JOIN organizations o ON o.id = b.organization_id
       WHERE upper(b.code) = $1
         AND u.is_active = true
         AND u.is_super_admin = false
         AND bm.is_active = true
         AND b.is_active = true
         AND o.approval_status = 'approved'
         AND u.quick_pin_hash IS NOT NULL`,
      [branchCode],
    );

    let matched: (typeof candidates.rows)[number] | null = null;
    for (const c of candidates.rows) {
      if (await verifySecret(parsed.data.pin, c.quick_pin_hash)) {
        matched = c;
        break;
      }
    }

    if (!matched) {
      recordFailedAttempt(rateKey);
      return reply.status(401).send({
        error: "INVALID_PIN",
        message: "Código de sucursal o PIN incorrecto (o el bar aún no está aprobado).",
      });
    }

    clearAttempts(rateKey);
    const token = signAuthToken({
      sub: matched.id,
      orgId: matched.organization_id,
      email: matched.email,
      fullName: matched.full_name,
      isSuperAdmin: false,
    });
    const session = await loadAuthContextFromToken(token);

    return {
      token,
      user: session,
      defaultBranchId: matched.branch_id,
    };
  });

  // 6. Current authenticated user + organization profile(s)
  app.get("/api/v1/auth/me", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    if (auth.isSuperAdmin) {
      return { user: auth, organizations: [] };
    }

    const orgIds = Array.from(new Set(auth.memberships.map((m) => m.organizationId)));
    const orgRes = await db.query<{
      id: string;
      name: string;
      currency: string;
      businessType: string;
      legalName: string | null;
      taxId: string | null;
      logoUrl: string | null;
      contactPhone: string | null;
      city: string | null;
      address: string | null;
      socialLinks: Record<string, string>;
      approvalStatus: string;
      approvalNotes: string | null;
    }>(
      `SELECT id, name, currency,
              business_type AS "businessType",
              legal_name AS "legalName",
              tax_id AS "taxId",
              logo_url AS "logoUrl",
              contact_phone AS "contactPhone",
              city, address,
              social_links AS "socialLinks",
              approval_status AS "approvalStatus",
              approval_notes AS "approvalNotes"
       FROM organizations
       WHERE owner_user_id = $1 OR id = ANY($2::uuid[])
       ORDER BY created_at ASC`,
      [auth.userId, orgIds],
    );

    return {
      user: auth,
      organizations: orgRes.rows,
    };
  });

  // ============================================================================
  // SUPERADMIN PLATFORM ROUTES (View all bars & approve / reject / suspend)
  // ============================================================================
  app.get("/api/v1/superadmin/bars", async (request, reply) => {
    const auth = await requireSuperAdmin(request, reply);
    if (!auth) return;

    const barsRes = await db.query<{
      id: string;
      name: string;
      businessType: string;
      legalName: string | null;
      taxId: string | null;
      logoUrl: string | null;
      contactPhone: string | null;
      city: string | null;
      address: string | null;
      currency: string;
      socialLinks: Record<string, string>;
      approvalStatus: "pending_approval" | "approved" | "rejected" | "suspended";
      approvalNotes: string | null;
      approvedAt: string | null;
      createdAt: string;
      ownerName: string | null;
      ownerEmail: string | null;
      branchCount: number;
      userCount: number;
    }>(
      `SELECT o.id, o.name, o.business_type AS "businessType",
              o.legal_name AS "legalName", o.tax_id AS "taxId",
              o.logo_url AS "logoUrl", o.contact_phone AS "contactPhone",
              o.city, o.address, o.currency, o.social_links AS "socialLinks",
              o.approval_status AS "approvalStatus", o.approval_notes AS "approvalNotes",
              o.approved_at AS "approvedAt", o.created_at AS "createdAt",
              owner.full_name AS "ownerName", owner.email AS "ownerEmail",
              (SELECT COUNT(*)::int FROM branches b WHERE b.organization_id = o.id AND b.is_active = true) AS "branchCount",
              (SELECT COUNT(DISTINCT bm.user_id)::int
               FROM branch_memberships bm
               JOIN branches b ON b.id = bm.branch_id
               WHERE b.organization_id = o.id AND bm.is_active = true) AS "userCount"
       FROM organizations o
       LEFT JOIN users owner ON owner.id = o.owner_user_id
       ORDER BY
         CASE o.approval_status
           WHEN 'pending_approval' THEN 0
           WHEN 'approved' THEN 1
           WHEN 'suspended' THEN 2
           ELSE 3
         END,
         o.created_at DESC`,
    );

    const bars = barsRes.rows;
    const counts = {
      pending: bars.filter((b) => b.approvalStatus === "pending_approval").length,
      approved: bars.filter((b) => b.approvalStatus === "approved").length,
      rejected: bars.filter((b) => b.approvalStatus === "rejected").length,
      suspended: bars.filter((b) => b.approvalStatus === "suspended").length,
      totalBranches: bars.reduce((acc, b) => acc + Number(b.branchCount || 0), 0),
      totalUsers: bars.reduce((acc, b) => acc + Number(b.userCount || 0), 0),
    };

    return { bars, counts };
  });

  app.patch("/api/v1/superadmin/bars/:orgId/status", async (request, reply) => {
    const auth = await requireSuperAdmin(request, reply);
    if (!auth) return;

    const { orgId } = request.params as { orgId: string };
    const parsed = barApprovalStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_STATUS", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const res = await db.query<{ id: string; name: string; approval_status: string }>(
      `UPDATE organizations
       SET approval_status = $2,
           approval_notes = $3,
           approved_by = $4,
           approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END
       WHERE id = $1
       RETURNING id, name, approval_status`,
      [orgId, d.status, d.notes?.trim() || null, auth.userId],
    );

    if (res.rows.length === 0) {
      return reply.status(404).send({ error: "BAR_NOT_FOUND" });
    }

    return {
      id: res.rows[0]!.id,
      name: res.rows[0]!.name,
      approvalStatus: res.rows[0]!.approval_status,
    };
  });

  // ============================================================================
  // BAR ADMIN ROUTES: Bar Profile (Logo, Razón Social, Redes), Additional Bars,
  // Branches & Users
  // ============================================================================
  app.patch("/api/v1/organizations/:orgId/profile", async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const auth = await requireOrgAdmin(request, reply, orgId);
    if (!auth) return;

    const parsed = updateOrgProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_PROFILE", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const res = await db.query(
      `UPDATE organizations
       SET name = COALESCE($2, name),
           business_type = COALESCE($3, business_type),
           legal_name = CASE WHEN $4::boolean THEN $5 ELSE legal_name END,
           tax_id = CASE WHEN $6::boolean THEN $7 ELSE tax_id END,
           logo_url = CASE WHEN $8::boolean THEN $9 ELSE logo_url END,
           contact_phone = CASE WHEN $10::boolean THEN $11 ELSE contact_phone END,
           city = CASE WHEN $12::boolean THEN $13 ELSE city END,
           address = CASE WHEN $14::boolean THEN $15 ELSE address END,
           social_links = COALESCE($16::jsonb, social_links)
       WHERE id = $1
       RETURNING id, name, business_type AS "businessType", legal_name AS "legalName",
                 tax_id AS "taxId", logo_url AS "logoUrl", contact_phone AS "contactPhone",
                 city, address, social_links AS "socialLinks", approval_status AS "approvalStatus"`,
      [
        orgId,
        d.name?.trim() ?? null,
        d.businessType ?? null,
        d.legalName !== undefined,
        d.legalName?.trim() || null,
        d.taxId !== undefined,
        d.taxId?.trim() || null,
        d.logoUrl !== undefined,
        d.logoUrl || null,
        d.contactPhone !== undefined,
        d.contactPhone?.trim() || null,
        d.city !== undefined,
        d.city?.trim() || null,
        d.address !== undefined,
        d.address?.trim() || null,
        d.socialLinks !== undefined ? JSON.stringify(d.socialLinks) : null,
      ],
    );

    return { organization: res.rows[0] };
  });

  // Admin can register an additional Bar/Restaurant (goes to SuperAdmin approval queue)
  app.post("/api/v1/organizations", async (request, reply) => {
    const auth = await requireOrgAdmin(request, reply);
    if (!auth) return;

    const parsed = addOrgByAdminSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_ORGANIZATION",
        message: parsed.error.issues[0]?.message ?? "Datos del bar inválidos",
        issues: parsed.error.issues,
      });
    }

    const d = parsed.data;
    const orgId = generateUuidV7();
    const branchId = generateUuidV7();
    const cleanCode =
      d.branchCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "") || "SEDE1";

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO organizations (
           id, name, currency, business_type, legal_name, tax_id,
           contact_phone, city, address, social_links, approval_status, owner_user_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending_approval', $11)`,
        [
          orgId,
          d.barName.trim(),
          d.currency,
          d.businessType,
          d.legalName.trim(),
          d.taxId?.trim() || null,
          d.contactPhone?.trim() || null,
          d.city?.trim() || null,
          d.address?.trim() || null,
          JSON.stringify(d.socialLinks ?? {}),
          auth.userId,
        ],
      );

      await client.query(
        `INSERT INTO branches (id, organization_id, name, code, timezone)
         VALUES ($1, $2, $3, $4, 'America/Bogota')`,
        [branchId, orgId, d.branchName.trim(), cleanCode],
      );

      await client.query(
        `INSERT INTO branch_memberships (id, branch_id, user_id, role, permissions)
         VALUES ($1, $2, $3, 'admin', $4::jsonb)`,
        [generateUuidV7(), branchId, auth.userId, JSON.stringify(buildRolePermissions("admin"))],
      );

      for (let i = 1; i <= d.tableCount; i += 1) {
        await client.query(
          `INSERT INTO dining_tables (id, branch_id, label, zone, sort_order)
           VALUES ($1, $2, $3, 'Salón', $4)`,
          [generateUuidV7(), branchId, `Mesa ${i}`, i],
        );
      }

      const defaultPms = [
        ["Efectivo", "CASH", true, 1],
        ["Nequi", "NEQUI", false, 2],
        ["Datáfono", "CARD", false, 3],
      ] as const;
      for (const [name, code, isCash, sort] of defaultPms) {
        await client.query(
          `INSERT INTO payment_methods (id, branch_id, name, code, counts_as_physical_cash, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [generateUuidV7(), branchId, name, code, isCash, sort],
        );
      }

      await client.query(
        `INSERT INTO cash_shifts (id, branch_id, opened_by, status, opening_float)
         VALUES ($1, $2, $3, 'open', 0)`,
        [generateUuidV7(), branchId, auth.userId],
      );
    });

    return reply.status(201).send({
      id: orgId,
      approvalStatus: "pending_approval",
      message: "Solicitud enviada para aprobación.",
    });
  });

  // === ADMIN: MULTI-BRANCH CREATION ===
  app.post("/api/v1/branches", async (request, reply) => {
    const parsed = createBranchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_BRANCH", issues: parsed.error.issues });
    }

    const d = parsed.data;
    const auth = await requireOrgAdmin(request, reply, d.organizationId);
    if (!auth) return;

    const targetOrgId =
      d.organizationId ??
      auth.memberships.find((m) => m.role === "admin")?.organizationId ??
      auth.organizationId;
    if (!targetOrgId) {
      return reply.status(400).send({ error: "ORGANIZATION_REQUIRED" });
    }

    const branchId = generateUuidV7();
    const cleanCode = d.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO branches (id, organization_id, name, code, timezone)
         VALUES ($1, $2, $3, $4, 'America/Bogota')`,
        [branchId, targetOrgId, d.name.trim(), cleanCode],
      );

      await client.query(
        `INSERT INTO branch_memberships (id, branch_id, user_id, role, permissions)
         VALUES ($1, $2, $3, 'admin', $4::jsonb)`,
        [generateUuidV7(), branchId, auth.userId, JSON.stringify(buildRolePermissions("admin"))],
      );

      for (let i = 1; i <= d.tableCount; i += 1) {
        await client.query(
          `INSERT INTO dining_tables (id, branch_id, label, zone, sort_order)
           VALUES ($1, $2, $3, 'Salón', $4)`,
          [generateUuidV7(), branchId, `Mesa ${i}`, i],
        );
      }

      const defaultPms = [
        ["Efectivo", "CASH", true, 1],
        ["Nequi", "NEQUI", false, 2],
        ["Datáfono", "CARD", false, 3],
      ] as const;
      for (const [name, code, isCash, sort] of defaultPms) {
        await client.query(
          `INSERT INTO payment_methods (id, branch_id, name, code, counts_as_physical_cash, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [generateUuidV7(), branchId, name, code, isCash, sort],
        );
      }

      await client.query(
        `INSERT INTO cash_shifts (id, branch_id, opened_by, status, opening_float)
         VALUES ($1, $2, $3, 'open', $4)`,
        [generateUuidV7(), branchId, auth.userId, d.openingFloat],
      );
    });

    return reply.status(201).send({ id: branchId, name: d.name.trim(), code: cleanCode });
  });

  // === ADMIN: USER MANAGEMENT MODULE ===
  app.get("/api/v1/users", async (request, reply) => {
    const auth = await requireOrgAdmin(request, reply);
    if (!auth) return;

    const adminOrgIds = Array.from(
      new Set(auth.memberships.filter((m) => m.role === "admin").map((m) => m.organizationId)),
    );

    const [usersRes, memsRes] = await Promise.all([
      db.query<{
        id: string;
        fullName: string;
        email: string;
        hasPin: boolean;
        isActive: boolean;
        createdAt: string;
      }>(
        `SELECT DISTINCT u.id, u.full_name AS "fullName", u.email,
                (u.quick_pin_hash IS NOT NULL) AS "hasPin",
                u.is_active AS "isActive", u.created_at AS "createdAt"
         FROM users u
         LEFT JOIN branch_memberships bm ON bm.user_id = u.id
         LEFT JOIN branches b ON b.id = bm.branch_id
         WHERE u.is_super_admin = false
           AND (u.organization_id = ANY($1::uuid[]) OR b.organization_id = ANY($1::uuid[]))
         ORDER BY u.created_at ASC`,
        [adminOrgIds],
      ),
      db.query<{
        userId: string;
        branchId: string;
        branchName: string;
        role: UserRole;
      }>(
        `SELECT bm.user_id AS "userId", bm.branch_id AS "branchId",
                b.name AS "branchName", bm.role
         FROM branch_memberships bm
         JOIN branches b ON b.id = bm.branch_id
         WHERE b.organization_id = ANY($1::uuid[]) AND bm.is_active = true`,
        [adminOrgIds],
      ),
    ]);

    const memsByUser = new Map<string, Array<{ branchId: string; branchName: string; role: UserRole }>>();
    for (const m of memsRes.rows) {
      const list = memsByUser.get(m.userId) ?? [];
      list.push({ branchId: m.branchId, branchName: m.branchName, role: m.role });
      memsByUser.set(m.userId, list);
    }

    return {
      users: usersRes.rows.map((u) => ({
        ...u,
        assignments: memsByUser.get(u.id) ?? [],
      })),
    };
  });

  app.post("/api/v1/users", async (request, reply) => {
    const auth = await requireOrgAdmin(request, reply);
    if (!auth) return;

    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_USER",
        message: parsed.error.issues[0]?.message ?? "Datos de usuario inválidos",
        issues: parsed.error.issues,
      });
    }

    const d = parsed.data;
    const emailNormalized = d.email.trim().toLowerCase();

    const dup = await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [emailNormalized]);
    if (dup.rows.length > 0) {
      return reply.status(409).send({
        error: "EMAIL_ALREADY_EXISTS",
        message: "Ya existe un usuario con ese correo electrónico.",
      });
    }

    const adminOrgIds = new Set(
      auth.memberships.filter((m) => m.role === "admin").map((m) => m.organizationId),
    );
    const firstBranch = auth.memberships.find((m) => m.branchId === d.assignments[0]?.branchId);
    const primaryOrgId = firstBranch?.organizationId ?? auth.organizationId;

    const userId = generateUuidV7();
    const passwordHash = await hashSecret(d.password);
    const pinHash = d.quickPin ? await hashSecret(d.quickPin) : null;

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, organization_id, full_name, email, password_hash, quick_pin_hash, is_super_admin, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, false, true)`,
        [userId, primaryOrgId, d.fullName.trim(), emailNormalized, passwordHash, pinHash],
      );

      for (const a of d.assignments) {
        const branchOwn = await client.query<{ organization_id: string }>(
          `SELECT organization_id FROM branches WHERE id = $1`,
          [a.branchId],
        );
        const bOrg = branchOwn.rows[0]?.organization_id;
        if (!bOrg || !adminOrgIds.has(bOrg)) {
          throw new Error("INVALID_BRANCH_ASSIGNMENT");
        }

        await client.query(
          `INSERT INTO branch_memberships (id, branch_id, user_id, role, permissions)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [generateUuidV7(), a.branchId, userId, a.role, JSON.stringify(buildRolePermissions(a.role))],
        );
      }
    });

    return reply.status(201).send({ id: userId });
  });

  app.patch("/api/v1/users/:userId", async (request, reply) => {
    const auth = await requireOrgAdmin(request, reply);
    if (!auth) return;

    const { userId } = request.params as { userId: string };
    const parsed = patchUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_USER_PATCH", issues: parsed.error.issues });
    }

    const d = parsed.data;
    if (userId === auth.userId && d.isActive === false) {
      return reply.status(400).send({
        error: "CANNOT_DISABLE_SELF",
        message: "No puedes desactivar tu propia cuenta de Administrador.",
      });
    }

    const adminOrgIds = Array.from(
      new Set(auth.memberships.filter((m) => m.role === "admin").map((m) => m.organizationId)),
    );
    const adminOrgSet = new Set(adminOrgIds);

    const nextPasswordHash = d.password ? await hashSecret(d.password) : null;
    const nextPinHash =
      d.quickPin === undefined ? undefined : d.quickPin ? await hashSecret(d.quickPin) : null;

    await withTransaction(async (client) => {
      const check = await client.query(
        `SELECT DISTINCT u.id
         FROM users u
         LEFT JOIN branch_memberships bm ON bm.user_id = u.id
         LEFT JOIN branches b ON b.id = bm.branch_id
         WHERE u.id = $1 AND u.is_super_admin = false
           AND (u.organization_id = ANY($2::uuid[]) OR b.organization_id = ANY($2::uuid[]))`,
        [userId, adminOrgIds],
      );
      if (check.rows.length === 0) {
        throw new Error("USER_NOT_FOUND");
      }

      if (d.fullName !== undefined) {
        await client.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [
          userId,
          d.fullName.trim(),
        ]);
      }
      if (nextPasswordHash) {
        await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
          userId,
          nextPasswordHash,
        ]);
      }
      if (nextPinHash !== undefined) {
        await client.query(`UPDATE users SET quick_pin_hash = $2 WHERE id = $1`, [
          userId,
          nextPinHash,
        ]);
      }
      if (d.isActive !== undefined) {
        await client.query(`UPDATE users SET is_active = $2 WHERE id = $1`, [userId, d.isActive]);
      }

      if (d.assignments) {
        await client.query(`DELETE FROM branch_memberships WHERE user_id = $1`, [userId]);
        for (const a of d.assignments) {
          const branchOwn = await client.query<{ organization_id: string }>(
            `SELECT organization_id FROM branches WHERE id = $1`,
            [a.branchId],
          );
          const bOrg = branchOwn.rows[0]?.organization_id;
          if (!bOrg || !adminOrgSet.has(bOrg)) {
            throw new Error("INVALID_BRANCH_ASSIGNMENT");
          }
          await client.query(
            `INSERT INTO branch_memberships (id, branch_id, user_id, role, permissions)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [generateUuidV7(), a.branchId, userId, a.role, JSON.stringify(buildRolePermissions(a.role))],
          );
        }
      }
    });

    return { id: userId };
  });
}
