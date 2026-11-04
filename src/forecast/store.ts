import { getPool } from "../db/pool.js";
import { project, type Assumptions, type Projection } from "./model.js";

export interface StoredForecast {
  readonly id: number;
  readonly ideaId: number;
  readonly revision: number;
  readonly projection: Projection;
  readonly confidence: number;
  readonly reasoning: string;
  readonly forecastBy: string;
  readonly createdAt: Date;
}

export class InvalidConfidenceError extends Error {
  constructor(value: number) {
    super(
      `confidence must be in [0, 1], got ${value}; state how sure you are, ` +
        `it is graded against outcomes later`,
    );
    this.name = "InvalidConfidenceError";
  }
}

/**
 * Computes and stores a projection for an idea.
 *
 * Each call creates a new revision rather than overwriting, so a forecast that
 * was revised after the fact cannot quietly become the one that was "always"
 * predicted.
 */
export const recordForecast = async (input: {
  readonly ideaId: number;
  readonly assumptions: Assumptions;
  readonly confidence: number;
  readonly reasoning: string;
  readonly forecastBy: string;
}): Promise<StoredForecast> => {
  if (
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw new InvalidConfidenceError(input.confidence);
  }

  const projection = project(input.assumptions);
  const { base } = projection;

  const { rows } = await getPool().query<{
    id: number;
    revision: number;
    created_at: Date;
  }>(
    `INSERT INTO forecasts
       (idea_id, revision, assumptions, scenarios, ceiling_mrr_usd,
        months_to_first_dollar, months_to_break_even,
        budget_to_break_even_usd, confidence, reasoning, forecast_by)
     VALUES (
       $1,
       (SELECT COALESCE(MAX(revision), 0) + 1 FROM forecasts WHERE idea_id = $1),
       $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, $9, $10
     )
     RETURNING id, revision, created_at`,
    [
      input.ideaId,
      JSON.stringify(input.assumptions),
      JSON.stringify({
        low: projection.low.months,
        base: projection.base.months,
        high: projection.high.months,
      }),
      base.ceilingMrrUsd,
      base.monthsToFirstDollar,
      base.monthsToBreakEven,
      base.budgetToBreakEvenUsd,
      input.confidence,
      input.reasoning,
      input.forecastBy,
    ],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    ideaId: input.ideaId,
    revision: row.revision,
    projection,
    confidence: input.confidence,
    reasoning: input.reasoning,
    forecastBy: input.forecastBy,
    createdAt: row.created_at,
  };
};

/** Records what actually happened, so the forecast can be graded. */
export const recordActual = async (input: {
  readonly forecastId: number;
  readonly monthIndex: number;
  readonly actualMrrUsd: number;
  readonly actualCostUsd: number;
}): Promise<void> => {
  await getPool().query(
    `INSERT INTO forecast_actuals
       (forecast_id, month_index, actual_mrr_usd, actual_cost_usd)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (forecast_id, month_index) DO UPDATE
       SET actual_mrr_usd = $3, actual_cost_usd = $4`,
    [input.forecastId, input.monthIndex, input.actualMrrUsd, input.actualCostUsd],
  );
};

export interface Calibration {
  readonly forecastBy: string;
  readonly gradedMonths: number;
  readonly meanAbsMrrErrorUsd: number;
  readonly statedConfidence: number;
}

/**
 * How wrong this forecaster has been. The CEO loop reads this before weighting
 * a projection: a forecaster with high stated confidence and high error is
 * worse than no forecaster at all, because it launders a guess as a number.
 */
export const calibration = async (
  forecastBy?: string,
): Promise<Calibration[]> => {
  const { rows } = await getPool().query<{
    forecast_by: string;
    graded_months: number;
    mean_abs_mrr_error_usd: number | null;
    confidence: number;
  }>(
    `SELECT forecast_by,
            SUM(graded_months)::int AS graded_months,
            AVG(mean_abs_mrr_error_usd) AS mean_abs_mrr_error_usd,
            AVG(confidence) AS confidence
       FROM forecast_calibration
      WHERE ($1::text IS NULL OR forecast_by = $1)
      GROUP BY forecast_by`,
    [forecastBy ?? null],
  );
  return rows.map((r) => ({
    forecastBy: r.forecast_by,
    gradedMonths: r.graded_months,
    meanAbsMrrErrorUsd: r.mean_abs_mrr_error_usd ?? 0,
    statedConfidence: r.confidence,
  }));
};

export const latestForecast = async (
  ideaId: number,
): Promise<StoredForecast | undefined> => {
  const { rows } = await getPool().query<{
    id: number;
    revision: number;
    assumptions: Assumptions;
    confidence: number;
    reasoning: string;
    forecast_by: string;
    created_at: Date;
  }>(
    `SELECT id, revision, assumptions, confidence, reasoning, forecast_by, created_at
       FROM forecasts WHERE idea_id = $1
      ORDER BY revision DESC LIMIT 1`,
    [ideaId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    ideaId,
    revision: row.revision,
    // Recomputed from stored assumptions rather than read from the stored
    // series, so a change to the model is visible on old forecasts instead of
    // being hidden behind frozen numbers.
    projection: project(row.assumptions),
    confidence: row.confidence,
    reasoning: row.reasoning,
    forecastBy: row.forecast_by,
    createdAt: row.created_at,
  };
};
