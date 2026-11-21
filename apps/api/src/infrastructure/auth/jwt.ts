import crypto from "node:crypto";

export interface AuthTokenPayload {
  sub: string; // userId
  orgId: string | null;
  email: string;
  fullName: string;
  isSuperAdmin?: boolean;
  iat: number;
  exp: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 12; // 12h covers a full bar night shift

function getJwtSecret(): string {
  return process.env.JWT_SECRET || "liquistock-dev-jwt-secret-change-in-prod";
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64").toString("utf8");
}

export function signAuthToken(
  claims: Omit<AuthTokenPayload, "iat" | "exp">,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthTokenPayload = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
  };

  const headerPart = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerPart}.${payloadPart}`;
  const sig = crypto.createHmac("sha256", getJwtSecret()).update(data).digest();
  return `${data}.${base64UrlEncode(sig)}`;
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, sigPart] = parts;
    if (!headerPart || !payloadPart || !sigPart) return null;

    const data = `${headerPart}.${payloadPart}`;
    const expectedSig = base64UrlEncode(
      crypto.createHmac("sha256", getJwtSecret()).update(data).digest(),
    );

    const a = Buffer.from(sigPart);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(payloadPart)) as AuthTokenPayload;
    if (!payload.sub || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
