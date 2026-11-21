import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, db, dbEngineLabel, withTransaction } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../../migrations");

async function runMigrations() {
  const files = (await fs.readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const filename of files) {
    const existing = await db.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename],
    );
    if (existing.rows.length > 0) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, filename), "utf8");
    await withTransaction(async (client) => {
      await client.exec(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    });
    console.log(`[migrate] Applied ${filename} on ${dbEngineLabel}`);
  }

  await closeDb();
  console.log("[migrate] All migrations up to date.");
}

runMigrations().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exit(1);
});
