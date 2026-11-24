import type { FastifyReply, FastifyRequest } from "fastify";
import {
  hasModuleAccess,
  resolveBranchRolePermissions,
  type AppModuleId,
  type BranchRolePermissions,
  type UserRole,
} from "@liquistock/domain";
import { db } from "../db/pool.js";
import { verifyAuthToken } from "./jwt.js";

export type AuthenticatedMembership = {
  organizationId: string;
  organizationName: string;
  organizationLogoUrl: string | null;
  branchId: string;
  branchName: string;
  branchCode: string;
  role: UserRole;
};

export interface AuthenticatedContext {
  userId: string;
  organizationId: string | null;
  email: string;
  fullName: string;
  isSuperAdmin: boolean;
  memberships: AuthenticatedMembership[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthenticatedContext;
  }
}

export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  const query = request.query as { token?: string } | undefined;
  if (query?.token) return query.token;
  return null;
}

export async function loadAuthContextFromToken(token: string): Promise<AuthenticatedContext | null> {
  const payload = verifyAuthToken(token);
  if (!payload) return null;

  const userRes = await db.query<{
    id: string;
    organization_id: string | null;
    email: string;
    full_name: string;
    is_super_admin: boolean;
    is_active: boolean;
  }>(
    `SELECT id, organization_id, email, full_name, is_super_admin, is_active
     FROM users
     WHERE id = $1`,
    [payload.sub],
  );
  const user = userRes.rows[0];
  if (!user || !user.is_active) return null;

  if (user.is_super_admin) {
    return {
      userId: user.id,
      organizationId: null,
      email: user.email,
      fullName: user.full_name,
      isSuperAdmin: true,
      memberships: [],
    };
  }

  // Only expose memberships belonging to APPROVED bars/restaurants
  const memRes = await db.query<AuthenticatedMembership>(
    `SELECT o.id AS "organizationId",
            o.name AS "organizationName",
            o.logo_url AS "organizationLogoUrl",
            bm.branch_id AS "branchId",
            b.name AS "branchName",
            b.code AS "branchCode",
            bm.role
     FROM branch_memberships bm
     JOIN branches b ON b.id = bm.branch_id
     JOIN organizations o ON o.id = b.organization_id
     WHERE bm.user_id = $1
       AND bm.is_active = true
       AND b.is_active = true
       AND o.approval_status = 'approved'
     ORDER BY o.created_at ASC, b.created_at ASC`,
    [user.id],
  );

  return {
    userId: user.id,
    organizationId: user.organization_id,
    email: user.email,
    fullName: user.full_name,
    isSuperAdmin: false,
    memberships: memRes.rows,
  };
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedContext | null> {
  const token = extractBearerToken(request);
  if (!token) {
    reply.status(401).send({ error: "UNAUTHORIZED", message: "Inicia sesión para continuar." });
    return null;
  }

  const ctx = await loadAuthContextFromToken(token);
  if (!ctx) {
    reply.status(401).send({
      error: "INVALID_OR_EXPIRED_TOKEN",
      message: "Sesión expirada o usuario desactivado.",
    });
    return null;
  }

  request.auth = ctx;
  return ctx;
}

export async function requireSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedContext | null> {
  const ctx = await requireAuth(request, reply);
  if (!ctx) return null;

  if (!ctx.isSuperAdmin) {
    reply.status(403).send({
      error: "SUPERADMIN_REQUIRED",
      message: "Esta sección es exclusiva del SuperAdmin de LiquiStock.",
    });
    return null;
  }

  return ctx;
}

export async function requireBranchRole(
  request: FastifyRequest,
  reply: FastifyReply,
  branchId: string,
  allowedRoles: UserRole[] = ["admin", "cashier", "waiter"],
): Promise<AuthenticatedContext | null> {
  const ctx = await requireAuth(request, reply);
  if (!ctx) return null;

  if (ctx.isSuperAdmin) {
    reply.status(403).send({
      error: "SUPERADMIN_CANNOT_OPERATE_BAR",
      message: "El SuperAdmin gestiona la plataforma y aprobaciones, no opera cajas de bares.",
    });
    return null;
  }

  const membership = ctx.memberships.find((m) => m.branchId === branchId);
  if (!membership) {
    reply.status(403).send({
      error: "BRANCH_ACCESS_DENIED",
      message: "No tienes acceso a esta sucursal o el bar no está aprobado.",
    });
    return null;
  }

  if (!allowedRoles.includes(membership.role)) {
    reply.status(403).send({
      error: "INSUFFICIENT_ROLE",
      message: "Esta acción requiere permisos de Administrador.",
    });
    return null;
  }

  return ctx;
}

export async function requireBranchModulePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  branchId: string,
  moduleId: AppModuleId,
  requiredLevel: "view" | "edit",
): Promise<AuthenticatedContext | null> {
  return requireBranchAnyModulePermission(request, reply, branchId, [
    { moduleId, requiredLevel },
  ]);
}

export async function requireBranchAnyModulePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  branchId: string,
  checks: ReadonlyArray<{ moduleId: AppModuleId; requiredLevel: "view" | "edit" }>,
): Promise<AuthenticatedContext | null> {
  const ctx = await requireAuth(request, reply);
  if (!ctx) return null;

  if (ctx.isSuperAdmin) {
    reply.status(403).send({
      error: "SUPERADMIN_CANNOT_OPERATE_BAR",
      message: "El SuperAdmin gestiona la plataforma y aprobaciones, no opera cajas de bares.",
    });
    return null;
  }

  const membership = ctx.memberships.find((m) => m.branchId === branchId);
  if (!membership) {
    reply.status(403).send({
      error: "BRANCH_ACCESS_DENIED",
      message: "No tienes acceso a esta sucursal o el bar no está aprobado.",
    });
    return null;
  }

  // Admins always hold full edit access on all modules
  if (membership.role === "admin") {
    return ctx;
  }

  const branchRes = await db.query<{ role_permissions: Partial<BranchRolePermissions> | null }>(
    `SELECT role_permissions FROM branches WHERE id = $1`,
    [branchId],
  );
  const resolved = resolveBranchRolePermissions(branchRes.rows[0]?.role_permissions ?? null);
  const rolePerms = resolved[membership.role];

  const allowed = checks.some((c) => hasModuleAccess(rolePerms, c.moduleId, c.requiredLevel));
  if (!allowed) {
    const wantsEdit = checks.every((c) => c.requiredLevel === "edit");
    reply.status(403).send({
      error: "INSUFFICIENT_MODULE_PERMISSION",
      message: wantsEdit
        ? "Tu rol está configurado como solo vista o sin acceso de edición en este módulo."
        : "Tu rol no tiene permiso para acceder a este módulo.",
    });
    return null;
  }

  return ctx;
}

export async function requireOrgAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  targetOrgId?: string,
): Promise<AuthenticatedContext | null> {
  const ctx = await requireAuth(request, reply);
  if (!ctx) return null;

  if (ctx.isSuperAdmin) {
    reply.status(403).send({
      error: "SUPERADMIN_CANNOT_OPERATE_BAR",
      message: "El SuperAdmin no actúa como administrador operativo de un bar.",
    });
    return null;
  }

  const adminOrgs = new Set(
    ctx.memberships.filter((m) => m.role === "admin").map((m) => m.organizationId),
  );
  if (adminOrgs.size === 0) {
    reply.status(403).send({
      error: "ADMIN_REQUIRED",
      message: "Solo un Administrador de bar aprobado puede realizar esta acción.",
    });
    return null;
  }

  if (targetOrgId && !adminOrgs.has(targetOrgId)) {
    reply.status(403).send({
      error: "ORG_ACCESS_DENIED",
      message: "No tienes permisos de Administrador sobre este bar.",
    });
    return null;
  }

  return ctx;
}
