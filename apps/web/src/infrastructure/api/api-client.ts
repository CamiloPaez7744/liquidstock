import type { UserRole } from "@liquistock/domain";

function resolveDefaultOrigin(protocol: "http" | "ws"): string {
  if (typeof window !== "undefined" && window.location.hostname) {
    return `${protocol}://${window.location.hostname}:3001`;
  }
  return `${protocol}://localhost:3001`;
}

export const API_BASE_URL = import.meta.env.VITE_API_URL || resolveDefaultOrigin("http");
export const WS_BASE_URL = import.meta.env.VITE_WS_URL || resolveDefaultOrigin("ws");

const SESSION_STORAGE_KEY = "liquistock_auth_session_v2";

export interface OrganizationSocialLinks {
  instagram?: string;
  facebook?: string;
  tiktok?: string;
  whatsapp?: string;
  website?: string;
}

export interface OrganizationProfile {
  id: string;
  name: string;
  currency: string;
  businessType: "bar" | "restaurant" | "brewery" | "pub" | "cafe" | "other";
  legalName: string | null;
  taxId: string | null;
  logoUrl: string | null;
  contactPhone: string | null;
  city: string | null;
  address: string | null;
  socialLinks: OrganizationSocialLinks;
  approvalStatus: "pending_approval" | "approved" | "rejected" | "suspended";
  approvalNotes: string | null;
}

export interface StoredBranchMembership {
  organizationId: string;
  organizationName: string;
  organizationLogoUrl: string | null;
  branchId: string;
  branchName: string;
  branchCode: string;
  role: UserRole;
}

export interface StoredAuthUser {
  userId: string;
  organizationId: string | null;
  email: string;
  fullName: string;
  isSuperAdmin: boolean;
  memberships: StoredBranchMembership[];
}

export interface StoredAuthSession {
  token: string;
  user: StoredAuthUser;
  activeBranchId: string | null;
}

export function getStoredSession(): StoredAuthSession | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuthSession;
    if (!parsed?.token || !parsed?.user?.userId) return null;
    if (!parsed.user.isSuperAdmin && !parsed.activeBranchId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredSession(session: StoredAuthSession): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }
}

export function clearStoredSession(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

export function getAuthToken(): string | null {
  return getStoredSession()?.token ?? null;
}

export function resolveImageUrl(imageUrl?: string | null): string | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://") || imageUrl.startsWith("data:")) {
    return imageUrl;
  }
  return `${API_BASE_URL}${imageUrl}`;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined && !(init.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const token = getAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401 && !path.startsWith("/api/v1/auth/")) {
    clearStoredSession();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("liquistock:unauthorized"));
    }
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      message = data.message || data.error || message;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) message = text;
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}
