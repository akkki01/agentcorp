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

/** Postgres duplicate_database (42P04), or the unique index on pg_database. */
const isAlreadyExists = (error: unknown): boolean => {
  const code = (error as { code?: string }).code;
  if (code === "42P04") return true;
  return /already exists|pg_database_datname_index/i.test(
    (error as Error).message ?? "",
  );
};

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
    try {
      await admin.query(`CREATE DATABASE "${testName}"`);
      console.info(`created test database "${testName}"`);
    } catch (error) {
      // Vitest runs this setup file once per worker, so workers race between
      // the existence check above and CREATE DATABASE. One wins; the rest get
      // "already exists", which is success for our purposes.
      //
      // Treating that race as a failure is actively dangerous: it logged
      // "integration tests will skip" while the suite was in fact runnable,
      // so a scheduling change could silently skip 24 tests with CI still
      // green -- the exact failure the Postgres service exists to prevent.
      if (!isAlreadyExists(error)) throw error;
    }
  }
} catch (error) {
  // No server reachable. The integration suite independently refuses to run
  // against any database not named *_test, so this is a skip, not a risk.
  console.warn(
    `no test database available (${(error as Error).message}); ` +
      `integration tests will skip`,
  );
} finally {
  await admin.end().catch(() => undefined);
}
