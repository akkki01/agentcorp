-- Rubric v2: adds `errorTolerance` and `marketGap`, and retires every score
-- recorded under v1.
--
-- v1 scored five dimensions and shortlisted 11 of the first 14 real ideas,
-- three of which had to be rejected by hand. See src/ideas/scoring.ts for what
-- the two new dimensions are and why they can veto.
--
-- The honest part of this migration is what it does NOT do. A v1 `scores`
-- object has no `errorTolerance` and no `marketGap`, and there is no value we
-- could fill them with:
--
--   * Defaulting them to a passing score re-shortlists exactly the ideas v2
--     exists to reject -- including one where a wrong output is a failed audit.
--   * Defaulting them to a failing score silently discards ideas an analyst may
--     already have validated, and buries the fact that the rubric changed.
--
-- So v1 scores are preserved verbatim in `superseded_scores` (they are a record
-- of a judgement that was really made), `scores` is emptied so it only ever
-- holds a complete current-rubric object, and the idea goes back to `new` to be
-- re-scored. `rubric_version` makes a stale score detectable rather than
-- merely absent: `promoteIdea` refuses one with `StaleRubricError`.

ALTER TABLE ideas
  -- Which rubric the row in `scores` was produced under. Stamped by
  -- `scoreIdea` from RUBRIC_VERSION rather than defaulted here, so a future
  -- v3 cannot inherit a stale default from the schema.
  ADD COLUMN rubric_version INT NOT NULL DEFAULT 1,
  -- Scores from a retired rubric. Kept for audit: "this idea scored 26.5 under
  -- v1 and 31.5-but-vetoed under v2" is the evidence that the funnel changed.
  ADD COLUMN superseded_scores JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Anything already scored under v1 goes back to the scouts.
--
-- `rejected` rows are included, not spared. A v1 rejection was a total below
-- 17 of 27.5 on dimensions that no longer decide anything; an idea rejected for
-- thin demand evidence could legitimately clear v2 on a wide-open market and a
-- harmless failure mode. Re-scoring costs one cheap scout turn, whereas leaving
-- it rejected hides a decision the new rubric would reverse.
--
-- `promoted` ideas ARE spared: they are already prd tickets in the build loop,
-- and rewinding an idea whose ticket exists would orphan that ticket. Their
-- rubric_version stays 1, so `promoteIdea` cannot re-promote them and the
-- `ideas` listing flags them for a human to look at.
UPDATE ideas
   SET superseded_scores = scores,
       scores            = '{}'::jsonb,
       total_score        = NULL,
       state              = 'new',
       rejected_reason    = NULL,
       updated_at         = now()
 WHERE scores <> '{}'::jsonb
   AND state <> 'promoted';

-- New rows are scored under the current rubric; the column default above only
-- exists so the UPDATE above could run against pre-existing rows. Flip it so a
-- row inserted without an explicit version is not born stale.
ALTER TABLE ideas ALTER COLUMN rubric_version SET DEFAULT 2;

-- Finding ideas that still need re-scoring, for the CLI and for operators.
CREATE INDEX ideas_stale_rubric ON ideas (rubric_version, created_at DESC)
  WHERE rubric_version < 2;
