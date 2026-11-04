/**
 * The operability rubric.
 *
 * These five dimensions are not "is this a good business" -- they are "can a
 * company staffed by agents actually run this". A brilliant idea that needs
 * sales calls and a design team scores zero here and should be rejected, which
 * is the entire point of scoring before promoting.
 */
export const RUBRIC = {
  selfServe: {
    weight: 1.2,
    question:
      "Can a stranger pay and be provisioned with no human in the purchase path?",
  },
  machineShaped: {
    weight: 1.0,
    question:
      "Is the product data-in/data-out, so agents can build and debug it without eyes on a GUI?",
  },
  supportable: {
    weight: 1.0,
    question:
      "Can >80% of support tickets be answered from documentation alone?",
  },
  costKnowable: {
    weight: 0.8,
    question:
      "Is cost per request calculable up front, so it can be priced above cost?",
  },
  demandEvidenced: {
    weight: 1.5,
    question:
      "Is there evidence someone already pays to solve this, rather than a guess that they would?",
  },
} as const;

export type RubricKey = keyof typeof RUBRIC;
export const RUBRIC_KEYS = Object.keys(RUBRIC) as RubricKey[];

export type IdeaScores = Readonly<Record<RubricKey, number>>;

const MIN = 0;
const MAX = 5;

/** Any single dimension at or below this vetoes the idea regardless of total. */
export const VETO_THRESHOLD = 1;

/** Weighted total must clear this to be shortlisted. Tuned to be demanding. */
export const SHORTLIST_THRESHOLD = 17;

export class InvalidScoreError extends Error {
  constructor(key: string, value: unknown) {
    super(`score "${key}" must be an integer ${MIN}-${MAX}, got ${String(value)}`);
    this.name = "InvalidScoreError";
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
