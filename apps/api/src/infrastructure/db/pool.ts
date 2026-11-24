import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

const { Pool } = pg;

export interface QueryResultLike<T extends Record<string, unknown> = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}

export interface DbClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResultLike<T>>;
  exec(sql: string): Promise<void>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.DATABASE_URL ?? "pglite://./data/pgdata";
const isPglite = databaseUrl.startsWith("pglite://");

let pgPool: pg.Pool | null = null;
let pgliteInstance: PGlite | null = null;
let pgliteTxQueue: Promise<unknown> = Promise.resolve();

function getPglite(): PGlite {
  if (!pgliteInstance) {
    const rawTarget = databaseUrl.replace(/^pglite:\/\//, "");
    if (rawTarget === "memory") {
      pgliteInstance = new PGlite();
    } else {
      const apiRoot = path.resolve(__dirname, "../../..");
      const dataDir = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(apiRoot, rawTarget);
      fs.mkdirSync(path.dirname(dataDir), { recursive: true });
      pgliteInstance = new PGlite(dataDir);
    }
  }
  return pgliteInstance;
}

function shouldUseSsl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes("sslmode=disable") || lower.includes("ssl=false")) {
    return false;
  }
  return (
    lower.includes("sslmode=require") ||
    lower.includes("sslmode=verify") ||
    lower.includes("ssl=true") ||
    lower.includes(".neon.tech") ||
    lower.includes(".render.com")
  );
}

function getPgPool(): pg.Pool {
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,
      ssl: shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
    // Prevent unhandled 'error' crashes when serverless Postgres (e.g. Neon) closes idle connections
    pgPool.on("error", (err) => {
      console.error("[pg-pool] idle client error:", err.message);
    });
  }
  return pgPool;
}

export const db: DbClient = {
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResultLike<T>> {
    if (isPglite) {
      const res = await getPglite().query<T>(sql, params);
      const count = res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0);
      return { rows: res.rows, rowCount: count };
    }
    const res = await getPgPool().query<T>(sql, params);
    return { rows: res.rows, rowCount: res.rowCount };
  },
  async exec(sql: string): Promise<void> {
    if (isPglite) {
      await getPglite().exec(sql);
      return;
    }
    await getPgPool().query(sql);
  },
};

export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  if (isPglite) {
    // Serialize transactions on embedded PGlite (single-connection engine)
    const run = async () => {
      const instance = getPglite();
      return instance.transaction(async (tx) => {
        const txClient: DbClient = {
          async query<R extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ): Promise<QueryResultLike<R>> {
            const res = await tx.query<R>(sql, params);
            const count = res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0);
            return { rows: res.rows, rowCount: count };
          },
          async exec(sql: string): Promise<void> {
            await tx.exec(sql);
          },
        };
        return fn(txClient);
      });
    };
    const next = pgliteTxQueue.then(run, run);
    pgliteTxQueue = next.catch(() => {});
    return next;
  }

  const client = await getPgPool().connect();
  const wrapped: DbClient = {
    async query<R extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResultLike<R>> {
      const res = await client.query<R>(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    },
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
  };

  try {
    await client.query("BEGIN");
    const result = await fn(wrapped);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (pgliteInstance) {
    await pgliteInstance.close();
    pgliteInstance = null;
  }
}

export const dbEngineLabel = isPglite ? "pglite (PostgreSQL 16 embedded)" : "postgresql";
