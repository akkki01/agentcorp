/**
 * The operability rubric.
 *
 * These seven dimensions are not "is this a good business" -- they are "can a
 * company staffed by agents actually run this". A brilliant idea that needs
 * sales calls and a design team scores zero here and should be rejected, which
 * is the entire point of scoring before promoting.
 *
 * ## Rubric v2 -- why it changed
 *
 * v1 had five dimensions and shortlisted 11 of the first 14 real ideas. A
 * funnel that passes nearly everything is not a funnel. Three of those 11 had
 * to be rejected by hand, and each failure was a dimension the rubric could
 * not express:
 *
 * 1. Certificate-of-insurance tracking scored 18.8 and shortlisted. A missed
 *    lapsed certificate is a failed audit, so a licensed human must review
 *    every output -- which breaks self-serve delivery outright. v1 had no way
 *    to say "being wrong is expensive", so `errorTolerance` was added. The
 *    scout charter already told scouts to reject those ideas; the rubric
 *    disagreed with the charter, and the rubric is what the funnel obeys.
 * 2. "Bank statement PDF to CSV" scored 26.5 -- the TOP score -- with four
 *    vendors owning the first page of search results. Saturation *raises*
 *    `demandEvidenced` (lots of people visibly pay for it) while destroying
 *    the business. `marketGap` was added to price that in, and
 *    `demandEvidenced` was demoted from 1.5 to 1.2 so saturation can no
 *    longer buy the single heaviest dimension.
 * 3. Indian eCourts case tracking scored 24.0 against seven competitors whose
 *    market leader is free to individuals. You cannot undercut free; a free
 *    incumbent is a `marketGap` of 0-1 and therefore a veto.
 *
 * Both new dimensions are veto-capable under the same `VETO_THRESHOLD` rule as
 * the rest, and that is the point rather than a side effect -- see `judge`.
 */
export const RUBRIC = {
  /**
   * Veto-capable by design. A low score here is not a discount to be weighed
   * against a high total: it means a licensed human has to sign off on every
   * output, which removes self-serve delivery and turns an agent-run product
   * into a staffed service. Scoring it as a mere deduction is exactly how COI
   * tracking got shortlisted.
   */
  errorTolerance: {
    weight: 1.5,
    question:
      "If the product is wrong, what does it cost the customer? 5 = a glance " +
      "or an hour of rework; 0 = a lawsuit, regulatory penalty, failed audit, " +
      "or medical or financial harm.",
  },
  /**
   * Veto-capable by design. Demand evidence and saturation are the same
   * observation read two ways -- a crowded market is proof people pay AND
   * proof you cannot charge them. A credible free incumbent scores 0-1 here
   * and vetoes, because there is no pricing move below free.
   */
  marketGap: {
    weight: 1.3,
    question:
      "Is this already well served? 5 = a real unmet need with no credible " +
      "incumbent; 0 = many incumbents, or any credible competitor offering it " +
      "free.",
  },
  selfServe: {
    weight: 1.2,
    question:
      "Can a stranger pay and be provisioned with no human in the purchase path?",
  },
  // Demoted from 1.5 in v1. It stays heavy -- already-paying is still the best
  // signal we have -- but it must not outweigh `errorTolerance`, because the
  // strongest demand signals in our own history came from markets that were
  // either saturated or legally hazardous.
  demandEvidenced: {
    weight: 1.2,
    question:
      "Is there evidence someone already pays to solve this, rather than a guess that they would?",
  },
  machineShaped: {
    weight: 1.0,
    question:
      "Is the product data-in/data-out, so agents can build and debug it without eyes on a GUI?",
  },
  // Demoted from 1.0: with `errorTolerance` scored separately, support load is
  // largely a consequence of it rather than an independent risk, and leaving
  // both at full weight double-counted the same fact.
  supportable: {
    weight: 0.8,
    question:
      "Can >80% of support tickets be answered from documentation alone?",
  },
  costKnowable: {
    weight: 0.8,
    question:
      "Is cost per request calculable up front, so it can be priced above cost?",
  },
} as const;

export type RubricKey = keyof typeof RUBRIC;
export const RUBRIC_KEYS = Object.keys(RUBRIC) as RubricKey[];

export type IdeaScores = Readonly<Record<RubricKey, number>>;

const MIN = 0;
const MAX = 5;

/**
 * Bumped whenever a dimension is added, removed, or re-weighted.
 *
 * Stored alongside every set of scores so an idea scored under an older rubric
 * is identifiable instead of silently comparable. Rows scored under v1 hold
 * five of the seven keys; `assertScores` refuses to read them and migration
 * 006 moves them back to `new` for re-scoring. Defaulting the two missing
 * dimensions to anything passing would reintroduce the exact bug v2 fixes.
 */
export const RUBRIC_VERSION = 2;

/** Any single dimension at or below this vetoes the idea regardless of total. */
export const VETO_THRESHOLD = 1;

/** The best a flawless idea could score: every dimension at 5. */
export const MAX_WEIGHTED_TOTAL = RUBRIC_KEYS.reduce(
  (sum, key) => sum + MAX * RUBRIC[key].weight,
  0,
);

/**
 * Weighted total must clear this to be shortlisted.
 *
 * 28 of a possible 39 (72%, against v1's 17 of 27.5 = 62%). Derived from two
 * anchors rather than picked to admit a particular idea:
 *
 * - A straight-4 idea -- solid on every dimension, exceptional on none --
 *   scores 31.2 and must pass. That is the profile of a product this company
 *   can actually operate.
 * - A straight-3 idea scores 23.4 and must fail. "Fine everywhere" is how the
 *   v1 funnel justified 11 shortlists; a 3 means unproven, and seven unproven
 *   dimensions is a guess, not a shortlist.
 *
 * 28 sits above the midpoint of those two, which buys a specific behaviour:
 * from a straight-4 idea you can drop two mid-weight dimensions to a 3 (29.6,
 * still passes) but not three of the heavy ones (27.2, fails). Two soft spots
 * is something the analyst can validate; three is a different product.
 *
 * Against the 14 ideas from the live session this shortlists 4 and rejects 9
 * (the 14th was never scored), where v1 shortlisted 11. Seven of the nine
 * rejections are vetoes on `errorTolerance` or `marketGap` -- structural, which
 * is the honest reason they were being rejected by hand anyway.
 * `tests/scoring.test.ts` pins the three v1 got wrong so they cannot pass again.
 */
export const SHORTLIST_THRESHOLD = 28;

export class InvalidScoreError extends Error {
  constructor(key: string, value: unknown) {
    super(
      `score "${key}" must be an integer ${MIN}-${MAX}, got ${String(value)}; ` +
        `all ${RUBRIC_KEYS.length} rubric v${RUBRIC_VERSION} dimensions are ` +
        `required (${RUBRIC_KEYS.join(", ")}) -- score the idea or leave it ` +
        `unscored, do not guess a dimension`,
    );
    this.name = "InvalidScoreError";
  }
}

/**
 * Raised when an idea carries scores from an older rubric.
 *
 * Separate from `InvalidScoreError` because the remedy is different: the scores
 * are not malformed, they are complete under a rubric that no longer decides
 * anything. Re-score the idea; do not patch the missing dimensions in.
 */
export class StaleRubricError extends Error {
  constructor(ideaId: number, storedVersion: number) {
    super(
      `idea ${ideaId} was scored under rubric v${storedVersion}, current is ` +
        `v${RUBRIC_VERSION}; re-score it with score_idea before promoting. It ` +
        `has no errorTolerance or marketGap score, and inventing one is how an ` +
        `idea that needs human sign-off reaches the build loop`,
    );
    this.name = "StaleRubricError";
  }
}

export const assertScores = (scores: Partial<IdeaScores>): IdeaScores => {
  for (const key of RUBRIC_KEYS) {
    const value = scores[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < MIN ||
      value > MAX
    ) {
      throw new InvalidScoreError(key, value);
    }
  }
  return scores as IdeaScores;
};

/**
 * True only for a complete set of scores under the CURRENT rubric.
 *
 * Deliberately a predicate rather than a coercion: there is no safe value to
 * fill a missing dimension with. A passing default would shortlist the ideas
 * v2 exists to reject, and a failing default would silently discard work the
 * analyst already validated. Callers must re-score, not repair.
 */
export const isCurrentRubric = (
  scores: Partial<IdeaScores>,
  storedVersion: number,
): boolean =>
  storedVersion === RUBRIC_VERSION &&
  RUBRIC_KEYS.every((key) => typeof scores[key] === "number");

export const weightedTotal = (scores: IdeaScores): number => {
  const total = RUBRIC_KEYS.reduce(
    (sum, key) => sum + scores[key] * RUBRIC[key].weight,
    0,
  );
  // Two decimals: the scale is coarse, and false precision invites arguing
  // about tenths of a point instead of about the evidence.
  return Math.round(total * 100) / 100;
};

export interface Verdict {
  readonly total: number;
  readonly shortlisted: boolean;
  /** Dimensions that vetoed the idea, if any. */
  readonly vetoedBy: readonly RubricKey[];
  readonly rationale: string;
}

/**
 * A veto beats a high total on purpose. An idea that scores 5 everywhere but
 * cannot be sold self-serve is not a cheap fix -- it is a different company.
 *
 * The same reasoning is what makes `errorTolerance` and `marketGap`
 * veto-capable rather than merely heavy. Both describe conditions no amount of
 * engineering removes: a regulator who penalises a wrong answer will not stop
 * because the product improved, and a free incumbent cannot be undercut.
 * Weighting them highly but letting a strong total outvote them is precisely
 * how v1 shortlisted an idea that needed a human to sign off on every output.
 */
export const judge = (scores: IdeaScores): Verdict => {
  const total = weightedTotal(scores);
  const vetoedBy = RUBRIC_KEYS.filter((key) => scores[key] <= VETO_THRESHOLD);

  if (vetoedBy.length > 0) {
    return {
      total,
      shortlisted: false,
      vetoedBy,
      rationale:
        `vetoed on ${vetoedBy.join(", ")} (scored <= ${VETO_THRESHOLD}); ` +
        `a weak dimension here is structural, not fixable by effort`,
    };
  }
  const shortlisted = total >= SHORTLIST_THRESHOLD;
  return {
    total,
    shortlisted,
    vetoedBy: [],
    rationale: shortlisted
      ? `total ${total} clears the ${SHORTLIST_THRESHOLD} bar with no vetoed dimension`
      : `total ${total} is below the ${SHORTLIST_THRESHOLD} bar; needs stronger evidence to promote`,
  };
};

/**
 * Normalises a title for duplicate detection. Scouts run in breadth and will
 * rediscover the same idea with different wording, and a duplicate that slips
 * through costs an analyst's full validation budget.
 *
 * Case, accents, punctuation, and filler words are collapsed. Morphological
 * variants ("parse" vs "parsing") are deliberately NOT: stemming would catch
 * more duplicates but would also collide genuinely different ideas, and a
 * false collision silently discards a real find. The analyst's validation pass
 * is the backstop for near-duplicates that reach it.
 */
export const dedupeKey = (title: string, niche: string): string =>
  `${niche}:${title}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(a|an|the|for|to|of|with|using|based)\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
