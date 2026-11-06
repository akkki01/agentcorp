import { getPool } from "../db/pool.js";

/**
 * Record spend whose cost was reported authoritatively by the tool that ran it.
 *
 * `recordSpend` prices tokens from our own table, which is right for direct
 * Messages API calls. But the Claude Code CLI reports `total_cost_usd` and a
 * per-model breakdown for the turn it just ran -- that figure is the actual
 * billed cost, including effects our table does not model. Re-deriving it from
 * tokens would be strictly less accurate, and would also throw on any model id
 * missing from MODEL_PRICES (the CLI reports ids like "claude-opus-5-5").
 *
 * So: when the runner is told the cost, store the cost.
 */
export interface ReportedSpend {
  readonly ticketId: number | null;
  readonly agentRole: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

export class NegativeCostError extends Error {
  constructor(costUsd: number) {
    super(`reported cost must be >= 0, got ${costUsd}`);
    this.name = "NegativeCostError";
  }
}

export const recordReportedSpend = async (
  record: ReportedSpend,
): Promise<number> => {
  if (!Number.isFinite(record.costUsd) || record.costUsd < 0) {
    throw new NegativeCostError(record.costUsd);
  }
  await getPool().query(
    `INSERT INTO cost_ledger
       (ticket_id, agent_role, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      record.ticketId, record.agentRole, record.model,
      record.inputTokens, record.outputTokens,
      record.cacheReadTokens, record.cacheWriteTokens, record.costUsd,
    ],
  );
  return record.costUsd;
};
