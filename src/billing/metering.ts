import { getPool } from "../db/pool.js";

/**
 * Product-side metering. Separate from the cost ledger on purpose: this is what
 * the customer is billed for, while the cost ledger is what serving them costs.
 * Keeping both lets `finance` find customers who cost more than they pay.
 */

export interface UsageRecord {
  readonly customerRef: string;
  readonly units: number;
  /** Marginal cost of serving these units, if known. */
  readonly costUsd?: number;
}

export const recordUsage = async (record: UsageRecord): Promise<void> => {
  if (!Number.isInteger(record.units) || record.units <= 0) {
    throw new Error(`units must be a positive integer, got ${record.units}`);
  }
  await getPool().query(
    `INSERT INTO usage_events (customer_ref, units, cost_usd)
     VALUES ($1, $2, $3)`,
    [record.customerRef, record.units, record.costUsd ?? 0],
  );
};

export interface CustomerEconomics {
  readonly customerRef: string;
  readonly units: number;
  readonly revenueUsd: number;
  readonly serveCostUsd: number;
  readonly marginUsd: number;
}

/**
 * Per-customer margin for the current month. A negative margin here is the
 * signal `finance` acts on -- either reprice, cap usage, or drop the customer.
 */
export const customerEconomics = async (): Promise<CustomerEconomics[]> => {
  const { rows } = await getPool().query<{
    customer_ref: string;
    units: number;
    serve_cost_usd: number;
    revenue_usd: number;
  }>(
    `SELECT u.customer_ref,
            SUM(u.units)::int AS units,
            SUM(u.cost_usd) AS serve_cost_usd,
            COALESCE((
              SELECT SUM(r.amount_usd) FROM revenue_ledger r
               WHERE r.customer_ref = u.customer_ref
                 AND r.at >= date_trunc('month', now())
            ), 0) AS revenue_usd
       FROM usage_events u
      WHERE u.at >= date_trunc('month', now())
      GROUP BY u.customer_ref
      ORDER BY revenue_usd - SUM(u.cost_usd) ASC`,
  );
  return rows.map((r) => ({
    customerRef: r.customer_ref,
    units: r.units,
    revenueUsd: r.revenue_usd,
    serveCostUsd: r.serve_cost_usd,
    marginUsd: r.revenue_usd - r.serve_cost_usd,
  }));
};
