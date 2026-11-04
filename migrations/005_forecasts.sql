-- Growth projections, one per idea per revision.
--
-- Forecasts are stored rather than computed on read for one reason: so that
-- `forecaster` can be scored later against what actually happened. A forecast
-- nobody grades is theatre, and the calibration view at the bottom is the only
-- thing that makes this table worth keeping.

CREATE TABLE forecasts (
  id            BIGSERIAL PRIMARY KEY,
  idea_id       BIGINT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  revision      INT NOT NULL DEFAULT 1,

  -- Everything the projection was derived from. Stored verbatim so a wrong
  -- forecast can be traced to the wrong assumption rather than re-argued.
  assumptions   JSONB NOT NULL,
  -- Monthly series per scenario: low / base / high.
  scenarios     JSONB NOT NULL,

  -- Headline numbers off the base scenario, denormalised for sorting.
  ceiling_mrr_usd        NUMERIC(12,2) NOT NULL,
  months_to_first_dollar INT,
  months_to_break_even   INT,
  budget_to_break_even_usd NUMERIC(12,2) NOT NULL,

  -- 0-1. The forecaster must state this; it is graded against outcomes.
  confidence    NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reasoning     TEXT NOT NULL,

  forecast_by   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (idea_id, revision)
);
CREATE INDEX forecasts_idea ON forecasts (idea_id, revision DESC);
CREATE INDEX forecasts_ceiling ON forecasts (ceiling_mrr_usd DESC);

-- Actuals, recorded as they land, against the forecast that predicted them.
CREATE TABLE forecast_actuals (
  id             BIGSERIAL PRIMARY KEY,
  forecast_id    BIGINT NOT NULL REFERENCES forecasts(id) ON DELETE CASCADE,
  month_index    INT NOT NULL CHECK (month_index >= 0),
  actual_mrr_usd NUMERIC(12,2) NOT NULL,
  actual_cost_usd NUMERIC(12,2) NOT NULL,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (forecast_id, month_index)
);

-- Calibration: how far off each graded forecast turned out to be. The CEO loop
-- reads this before trusting a forecast to allocate budget.
CREATE VIEW forecast_calibration AS
SELECT
  f.id               AS forecast_id,
  f.idea_id,
  f.forecast_by,
  f.confidence,
  COUNT(a.id)        AS graded_months,
  AVG(ABS(a.actual_mrr_usd - COALESCE(
    (f.scenarios -> 'base' -> a.month_index ->> 'mrrUsd')::numeric, 0
  ))) AS mean_abs_mrr_error_usd
FROM forecasts f
JOIN forecast_actuals a ON a.forecast_id = f.id
GROUP BY f.id, f.idea_id, f.forecast_by, f.confidence;
