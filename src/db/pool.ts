import pg from "pg";
import { config } from "../config.js";

/**
 * NUMERIC columns arrive as strings by default so that large values survive the
 * round trip. Every NUMERIC in this schema is money or a token count well
 * inside Number.MAX_SAFE_INTEGER, so parsing to float is safe and saves every
 * caller a conversion.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

let pool: pg.Pool | undefined;

export const getPool = (): pg.Pool => {
  pool ??= new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  return pool;
};

export const closePool = async (): Promise<void> => {
  await pool?.end();
  pool = undefined;
};

export type Queryable = Pick<pg.Pool, "query">;

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export const withTransaction = async <T>(
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
