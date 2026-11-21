import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../../data/pgdata");

async function reset() {
  await fs.rm(dataDir, { recursive: true, force: true });
  console.log(`[reset] Cleared local PGlite data at ${dataDir}`);
}

reset().catch((err) => {
  console.error("[reset] Failed:", err);
  process.exit(1);
});

