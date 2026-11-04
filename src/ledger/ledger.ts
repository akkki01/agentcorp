import { getPool } from "../db/pool.js";
import { priceUsage, type TokenUsage } from "./pricing.js";

export interface SpendRecord extends TokenUsage {
  readonly ticketId: number | null;
  readonly agentRole: string;
  readonly model: string;
}

/** Prices and records one model call. Returns the cost in USD. */
export const recordSpend = async (record: SpendRecord): Promise<number> => {
  const costUsd = priceUsage(record.model, record);
  await getPool().query(
    `INSERT INTO cost_ledger
       (ticket_id, agent_role, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      record.ticketId,
      record.agentRole,
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens ?? 0,
      record.cacheWriteTokens ?? 0,
      costUsd,
    ],
  );
  return costUsd;
};

export const ticketSpend = async (ticketId: number): Promise<number> => {
  const { rows } = await getPool().query<{ total: number | null }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM cost_ledger WHERE ticket_id = $1`,
    [ticketId],
  );
  return rows[0]?.total ?? 0;
};

export const monthToDateSpend = async (): Promise<number> => {
  const { rows } = await getPool().query<{ total: number | null }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM cost_ledger
      WHERE at >= date_trunc('month', now())`,
  );
  return rows[0]?.total ?? 0;
};

export interface MarginReport {
  readonly revenueUsd: number;
  readonly modelCostUsd: number;
  readonly grossMarginUsd: number;
  /** Null when there is no revenue yet -- a ratio against zero is not 0%. */
  readonly grossMarginPct: number | null;
}

/**
 * The number the company is actually steered by. Revenue comes from Stripe
 * webhooks; cost comes from the ledger. Infrastructure cost is not modelled
 * here -- add it as a `cost_ledger` row with role 'infra' if you want it in.
 */
export const marginToDate = async (): Promise<MarginReport> => {
  const { rows } = await getPool().query<{
    revenue: number | null;
    cost: number | null;
  }>(
    `SELECT
       (SELECT COALESCE(SUM(amount_usd), 0) FROM revenue_ledger
         WHERE at >= date_trunc('month', now())) AS revenue,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM cost_ledger
         WHERE at >= date_trunc('month', now())) AS cost`,
  );
  const revenueUsd = rows[0]?.revenue ?? 0;
  const modelCostUsd = rows[0]?.cost ?? 0;
  const grossMarginUsd = revenueUsd - modelCostUsd;
  return {
    revenueUsd,
    modelCostUsd,
    grossMarginUsd,
    grossMarginPct:
      revenueUsd === 0 ? null : (grossMarginUsd / revenueUsd) * 100,
  };
};

export interface RoleSpend {
  readonly agentRole: string;
  readonly costUsd: number;
  readonly calls: number;
}

export const spendByRole = async (): Promise<RoleSpend[]> => {
  const { rows } = await getPool().query<{
    agent_role: string;
    cost_usd: number;
    calls: number;
  }>(
    `SELECT agent_role, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
       FROM cost_ledger
      WHERE at >= date_trunc('month', now())
      GROUP BY agent_role
      ORDER BY cost_usd DESC`,
  );
  return rows.map((r) => ({
    agentRole: r.agent_role,
    costUsd: r.cost_usd,
    calls: r.calls,
  }));
};
