import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { closePool, getPool } from "./pool.js";

const MIGRATIONS_DIR = new URL("../../migrations", import.meta.url).pathname;

/** Applies every unapplied migration in filename order, each in its own transaction. */
export const migrate = async (): Promise<string[]> => {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  const applied = new Set(rows.map((r) => r.filename));

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      newlyApplied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const applied = await migrate();
  console.log(
    applied.length > 0
      ? `applied ${applied.length} migration(s):\n  ${applied.join("\n  ")}`
      : "schema already up to date",
  );
  await closePool();
}
