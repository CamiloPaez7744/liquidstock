import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);
const KEY_LEN = 64;

/**
 * Hashes a password or quick PIN with Node.js native scrypt (memory-hard, per-secret 16-byte salt).
 * Format: scrypt$<saltHex>$<derivedKeyHex>
 */
export async function hashSecret(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await scryptAsync(plain, salt, KEY_LEN)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

/**
 * Constant-time verification using crypto.timingSafeEqual to prevent timing side-channels.
 */
export async function verifySecret(plain: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;

  const derived = (await scryptAsync(plain, salt, KEY_LEN)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

