import pg from "pg";

/**
 * Point the integration tests at a DEDICATED database and create it on demand.
 *
 * This runs as a vitest `setupFile`, before any test module imports `config.ts`
 * -- which freezes `DATABASE_URL` at module load, so rewriting it later would
 * have no effect.
 *
 * Why this exists: the integration suite TRUNCATEs every table. Pointed at a
 * development database it silently destroys real work, which is exactly what
 * happened before this guard was added. Tests must never be able to do that.
 */

const devUrl =
  process.env["DATABASE_URL"] ??
  "postgres://agentcorp:agentcorp@localhost:5433/agentcorp";

const parsed = new URL(devUrl);
const devName = parsed.pathname.replace(/^\//, "");
const testName = devName.endsWith("_test") ? devName : `${devName}_test`;

const adminUrl = new URL(devUrl);
adminUrl.pathname = "/postgres";

const testUrl = new URL(devUrl);
testUrl.pathname = `/${testName}`;

// Every test module that follows reads this.
process.env["DATABASE_URL"] = testUrl.toString();

const admin = new pg.Client({ connectionString: adminUrl.toString() });
try {
  await admin.connect();
  const { rowCount } = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [testName],
  );
  if (rowCount === 0) {
    // Identifier cannot be parameterised; testName is derived from our own URL
    // and matched against a strict pattern before interpolation.
    if (!/^[a-z0-9_]+$/.test(testName)) {
      throw new Error(`refusing to create database with unsafe name "${testName}"`);
    }
    await admin.query(`CREATE DATABASE "${testName}"`);
    console.info(`created test database "${testName}"`);
  }
} catch (error) {
  // No server reachable: the integration suite detects this and skips itself.
  console.warn(
    `test database setup skipped (${(error as Error).message}); ` +
      `integration tests will skip`,
  );
} finally {
  await admin.end().catch(() => undefined);
}
