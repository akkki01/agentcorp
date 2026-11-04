import { getPool, withTransaction } from "../db/pool.js";
import { insertTicket } from "../tickets/store.js";
import type { Ticket } from "../tickets/types.js";
import {
  assertScores, dedupeKey, judge, isCurrentRubric,
  RUBRIC_VERSION, StaleRubricError,
  type IdeaScores, type Verdict,
} from "./scoring.js";

export type IdeaState =
  | "new" | "scored" | "shortlisted" | "promoted" | "rejected" | "duplicate";

export interface Idea {
  readonly id: number;
  readonly state: IdeaState;
  readonly title: string;
  readonly hypothesis: string;
  readonly niche: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly evidence: readonly string[];
  readonly scores: Partial<IdeaScores>;
  readonly totalScore: number | null;
  /** Which rubric version `scores` was produced under. */
  readonly rubricVersion: number;
  /**
   * Scores from a retired rubric, kept for audit. Never merged into `scores`:
   * an incomplete score set must stay visibly incomplete.
   */
  readonly supersededScores: Partial<IdeaScores>;
  /**
   * True when this idea's scores do not decide anything any more -- the rubric
   * gained or lost a dimension since they were recorded. It must be re-scored
   * before it can promote; `promoteIdea` enforces that.
   */
  readonly needsRescore: boolean;
  readonly promotedTicketId: number | null;
  readonly rejectedReason: string | null;
  readonly foundBy: string;
  readonly createdAt: Date;
}

interface Row {
  id: number;
  state: IdeaState;
  title: string;
  hypothesis: string;
  niche: string;
  source_kind: string;
  source_ref: string;
  evidence: string[];
  scores: Partial<IdeaScores>;
  total_score: number | null;
  rubric_version: number;
  superseded_scores: Partial<IdeaScores>;
  promoted_ticket_id: number | null;
  rejected_reason: string | null;
  found_by: string;
  created_at: Date;
}

/**
 * An idea needs re-scoring when a judgement was recorded for it but not under
 * the rubric in force now.
 *
 * Checked against the stored version rather than inferred from which keys are
 * present, because a future rubric could re-weight dimensions without changing
 * the key set -- and a re-weighted total is just as incomparable as a missing
 * dimension. An idea nobody has scored yet is not stale, it is just new.
 */
const staleRubric = (row: Row): boolean => {
  const wasJudged =
    Object.keys(row.scores).length > 0 ||
    Object.keys(row.superseded_scores).length > 0;
  return wasJudged && !isCurrentRubric(row.scores, row.rubric_version);
};

const toIdea = (row: Row): Idea => ({
  id: row.id,
  state: row.state,
  title: row.title,
  hypothesis: row.hypothesis,
  niche: row.niche,
  sourceKind: row.source_kind,
  sourceRef: row.source_ref,
  evidence: row.evidence,
  scores: row.scores,
  totalScore: row.total_score,
  rubricVersion: row.rubric_version,
  supersededScores: row.superseded_scores,
  needsRescore: staleRubric(row),
  promotedTicketId: row.promoted_ticket_id,
  rejectedReason: row.rejected_reason,
  foundBy: row.found_by,
  createdAt: row.created_at,
});

export interface NewIdea {
  readonly title: string;
  readonly hypothesis: string;
  readonly niche: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly evidence?: readonly string[];
  readonly foundBy: string;
}

export class UnsourcedIdeaError extends Error {
  constructor(title: string) {
    super(
      `idea "${title}" has no source reference; an idea with no source is an ` +
        `opinion and cannot be scored on demandEvidenced`,
    );
    this.name = "UnsourcedIdeaError";
  }
}

export interface CaptureResult {
  readonly idea: Idea;
  /** False when an equivalent idea already existed; nothing was written. */
  readonly isNew: boolean;
}

/**
 * Records a found idea, collapsing duplicates instead of erroring.
 *
 * Scouts run wide and will rediscover the same idea repeatedly; a thrown error
 * on a duplicate would make a scout's turn fail on what is actually the normal
 * case, so the duplicate returns the existing row and burns nothing further.
 */
export const captureIdea = async (input: NewIdea): Promise<CaptureResult> => {
  if (input.sourceRef.trim() === "") throw new UnsourcedIdeaError(input.title);

  const key = dedupeKey(input.title, input.niche);
  const { rows } = await getPool().query<Row>(
    // rubric_version is written explicitly rather than left to the column
    // default: the default exists only so migration 006 could backfill old
    // rows, and a stale schema default is how a new idea would be born
    // carrying a retired rubric's version number.
    `INSERT INTO ideas
       (title, hypothesis, niche, source_kind, source_ref, evidence,
        found_by, dedupe_key, rubric_version)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING *`,
    [
      input.title, input.hypothesis, input.niche, input.sourceKind,
      input.sourceRef, JSON.stringify(input.evidence ?? []),
      input.foundBy, key, RUBRIC_VERSION,
    ],
  );

  const inserted = rows[0];
  if (inserted !== undefined) return { idea: toIdea(inserted), isNew: true };

  const { rows: existing } = await getPool().query<Row>(
    "SELECT * FROM ideas WHERE dedupe_key = $1",
    [key],
  );
  return { idea: toIdea(existing[0]!), isNew: false };
};

export interface ScoreResult {
  readonly idea: Idea;
  readonly verdict: Verdict;
}

/**
 * Applies the rubric and moves the idea to scored or shortlisted.
 *
 * `assertScores` requires every dimension of the current rubric, so a caller
 * that knows only the old five dimensions fails loudly here rather than being
 * topped up with defaults. Re-scoring an idea that already carries v1 scores is
 * the supported path out of that: it overwrites `scores` and stamps the current
 * version, which is what clears `needsRescore`.
 */
export const scoreIdea = async (
  ideaId: number,
  rawScores: Partial<IdeaScores>,
): Promise<ScoreResult> => {
  const scores = assertScores(rawScores);
  const verdict = judge(scores);

  const { rows } = await getPool().query<Row>(
    `UPDATE ideas
        SET scores = $2::jsonb,
            total_score = $3,
            state = $4,
            rejected_reason = $5,
            rubric_version = $6,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      ideaId,
      JSON.stringify(scores),
      verdict.total,
      verdict.vetoedBy.length > 0
        ? "rejected"
        : verdict.shortlisted
          ? "shortlisted"
          : "scored",
      verdict.vetoedBy.length > 0 ? verdict.rationale : null,
      RUBRIC_VERSION,
    ],
  );
  if (rows[0] === undefined) throw new Error(`idea ${ideaId} not found`);
  return { idea: toIdea(rows[0]), verdict };
};

/**
 * Turns a shortlisted idea into a prd ticket owned by pm.
 *
 * Only shortlisted ideas may promote: this is the chokepoint that keeps scout
 * breadth from reaching the build loop without passing validation.
 *
 * A stale-rubric score is refused here as well as at the state check. Migration
 * 006 rewinds v1-scored ideas to `new`, so in practice the state check catches
 * them -- but `promoted` rows were deliberately left at v1, and an operator who
 * hand-sets a state should not be able to walk an unjudged idea into the build
 * loop. A dimension that was never scored is not a zero and not a five.
 */
export const promoteIdea = async (
  ideaId: number,
  promotedBy: string,
): Promise<{ idea: Idea; ticket: Ticket }> =>
  withTransaction(async (tx) => {
    const { rows } = await tx.query<Row>(
      "SELECT * FROM ideas WHERE id = $1 FOR UPDATE",
      [ideaId],
    );
    const idea = rows[0];
    if (idea === undefined) throw new Error(`idea ${ideaId} not found`);
    if (idea.state !== "shortlisted") {
      throw new Error(
        `idea ${ideaId} is "${idea.state}"; only shortlisted ideas may be ` +
          `promoted -- score it first`,
      );
    }
    if (!isCurrentRubric(idea.scores, idea.rubric_version)) {
      throw new StaleRubricError(ideaId, idea.rubric_version);
    }

    const ticket = await insertTicket({
      type: "prd",
      title: `Validate and scope: ${idea.title}`,
      body: [
        `## Hypothesis`, idea.hypothesis, "",
        `## Niche`, idea.niche, "",
        `## Source`, `${idea.source_kind}: ${idea.source_ref}`, "",
        `## Evidence`,
        ...idea.evidence.map((e) => `- ${e}`),
        "",
        `## Rubric score`,
        `${idea.total_score ?? "unscored"} on rubric v${idea.rubric_version} ` +
          `(found by ${idea.found_by})`,
      ].join("\n"),
      ownerRole: "pm",
      createdBy: promotedBy,
      acceptance: [
        {
          statement: "PRD defines acceptance criteria that are machine-checkable",
          verified: false,
        },
        {
          statement: "Cost per request is estimated and priced above cost",
          verified: false,
        },
      ],
    });

    const { rows: updated } = await tx.query<Row>(
      `UPDATE ideas
          SET state = 'promoted', promoted_ticket_id = $2, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [ideaId, ticket.id],
    );
    return { idea: toIdea(updated[0]!), ticket };
  });

export const rejectIdea = async (
  ideaId: number,
  reason: string,
): Promise<void> => {
  await getPool().query(
    `UPDATE ideas SET state = 'rejected', rejected_reason = $2, updated_at = now()
      WHERE id = $1`,
    [ideaId, reason],
  );
};

export const listIdeas = async (filter: {
  state?: IdeaState;
  limit?: number;
}): Promise<Idea[]> => {
  const { rows } = await getPool().query<Row>(
    `SELECT * FROM ideas
      WHERE ($1::idea_state IS NULL OR state = $1)
      ORDER BY COALESCE(total_score, -1) DESC, created_at DESC
      LIMIT $2`,
    [filter.state ?? null, filter.limit ?? 50],
  );
  return rows.map(toIdea);
};

/** The queue `analyst` works from: highest-scoring validated ideas first. */
export const shortlist = async (limit = 10): Promise<Idea[]> =>
  listIdeas({ state: "shortlisted", limit });

/**
 * Ideas carrying scores from a retired rubric.
 *
 * Surfaced in the CLI (`agentcorp ideas`) so a rubric change is visible work
 * rather than a silent backlog of numbers that no longer mean anything. The
 * cheap fix is to let `scout` re-score them; the expensive mistake is to assume
 * an old total is still comparable to a new one.
 */
export const staleRubricIdeas = async (limit = 50): Promise<Idea[]> => {
  const { rows } = await getPool().query<Row>(
    `SELECT * FROM ideas
      WHERE rubric_version <> $1
        AND (scores <> '{}'::jsonb OR superseded_scores <> '{}'::jsonb)
      ORDER BY created_at DESC
      LIMIT $2`,
    [RUBRIC_VERSION, limit],
  );
  return rows.map(toIdea);
};
