import { describe, expect, test } from "vitest";
import {
  assertScores, dedupeKey, InvalidScoreError, isCurrentRubric, judge,
  MAX_WEIGHTED_TOTAL, RUBRIC, RUBRIC_KEYS, RUBRIC_VERSION,
  SHORTLIST_THRESHOLD, weightedTotal,
} from "../src/ideas/scoring.js";
import type { IdeaScores } from "../src/ideas/scoring.js";

const scores = (fill: number, overrides: Partial<IdeaScores> = {}): IdeaScores =>
  ({
    ...Object.fromEntries(RUBRIC_KEYS.map((k) => [k, fill])),
    ...overrides,
  }) as IdeaScores;

describe("idea rubric", () => {
  test("weights cost-of-error above every other dimension", () => {
    // v1 made demandEvidenced the heaviest dimension, which is how a saturated
    // market bought the top score in its cohort. errorTolerance now outweighs
    // it, and demandEvidenced no longer outweighs market gap.
    const heaviest = RUBRIC_KEYS.reduce((a, b) =>
      RUBRIC[a].weight >= RUBRIC[b].weight ? a : b,
    );
    expect(heaviest).toBe("errorTolerance");
    expect(RUBRIC.marketGap.weight).toBeGreaterThan(
      RUBRIC.demandEvidenced.weight,
    );
    expect(weightedTotal(scores(0, { demandEvidenced: 5 }))).toBeGreaterThan(
      weightedTotal(scores(0, { costKnowable: 5 })),
    );
  });

  test("shortlists an idea that scores well across the board", () => {
    const verdict = judge(scores(4));
    expect(verdict.shortlisted).toBe(true);
    expect(verdict.vetoedBy).toHaveLength(0);
  });

  test("rejects a middling idea without vetoing it", () => {
    const verdict = judge(scores(3));
    expect(verdict.shortlisted).toBe(false);
    expect(verdict.vetoedBy).toHaveLength(0);
    expect(verdict.rationale).toMatch(/below the .* bar/);
  });

  test("a veto beats an otherwise perfect score", () => {
    // Perfect everywhere except self-serve: structurally the wrong company.
    const verdict = judge(scores(5, { selfServe: 1 }));
    expect(verdict.total).toBeGreaterThan(SHORTLIST_THRESHOLD);
    expect(verdict.shortlisted).toBe(false);
    expect(verdict.vetoedBy).toEqual(["selfServe"]);
    expect(verdict.rationale).toMatch(/structural, not fixable by effort/);
  });

  test("reports every vetoed dimension, not just the first", () => {
    const verdict = judge(scores(5, { selfServe: 0, supportable: 1 }));
    expect(verdict.vetoedBy).toEqual(["selfServe", "supportable"]);
  });

  test("rejects a non-integer score instead of rounding it", () => {
    expect(() => assertScores(scores(3, { selfServe: 3.5 }))).toThrow(
      InvalidScoreError,
    );
  });

  test("rejects a score outside 0-5", () => {
    expect(() => assertScores(scores(3, { selfServe: 6 }))).toThrow(InvalidScoreError);
    expect(() => assertScores(scores(3, { selfServe: -1 }))).toThrow(InvalidScoreError);
  });

  test("rejects a missing dimension rather than defaulting it to zero", () => {
    const partial = { selfServe: 3, machineShaped: 3 };
    expect(() => assertScores(partial)).toThrow(/supportable/);
  });
});

describe("rubric v2 -- the defects it exists to fix", () => {
  test("rejects an idea that is perfect except that being wrong is catastrophic", () => {
    // THE original defect. Certificate-of-insurance tracking scored 18.8 under
    // v1 and shortlisted, even though a missed lapsed certificate is a failed
    // audit -- so a licensed human has to review every output, which removes
    // self-serve delivery entirely. v1 had no dimension that could say so.
    const verdict = judge(scores(5, { errorTolerance: 0 }));
    expect(verdict.total).toBeGreaterThan(SHORTLIST_THRESHOLD);
    expect(verdict.shortlisted).toBe(false);
    expect(verdict.vetoedBy).toEqual(["errorTolerance"]);
    expect(verdict.rationale).toMatch(/structural, not fixable by effort/);
  });

  test("a legally hazardous idea cannot buy its way past the veto with evidence", () => {
    // The specific failure mode: strong demand evidence is exactly what a
    // regulated niche produces, because the penalty is why people pay.
    const verdict = judge(
      scores(3, { errorTolerance: 1, demandEvidenced: 5, selfServe: 5 }),
    );
    expect(verdict.shortlisted).toBe(false);
    expect(verdict.vetoedBy).toContain("errorTolerance");
  });

  test("a saturated market cannot outrank an unserved one", () => {
    // "Bank statement PDF to CSV" scored 26.5 -- the TOP score of 14 ideas --
    // with four vendors owning the first page of results. Saturation raised
    // demandEvidenced while destroying the business, so the crowded idea beat
    // genuinely unserved ones. It must now lose to them on identical scores.
    const saturated = judge(scores(4, { marketGap: 2, demandEvidenced: 5 }));
    const unserved = judge(scores(4, { marketGap: 5, demandEvidenced: 3 }));
    expect(saturated.total).toBeLessThan(unserved.total);
    expect(unserved.shortlisted).toBe(true);
  });

  test("a free incumbent vetoes, because nothing prices below free", () => {
    // Indian eCourts case tracking scored 24.0 and shortlisted with seven
    // competitors whose market leader is free to individual users. It had to
    // be rejected by hand.
    const verdict = judge(scores(5, { marketGap: 0 }));
    expect(verdict.total).toBeGreaterThan(SHORTLIST_THRESHOLD);
    expect(verdict.shortlisted).toBe(false);
    expect(verdict.vetoedBy).toEqual(["marketGap"]);
  });

  test("the threshold sits between a straight-4 idea and a straight-3 one", () => {
    // The justification for 28, asserted rather than left in a comment: solid
    // everywhere passes, unproven everywhere does not, and the gap between
    // them absorbs two soft dimensions but not three heavy ones.
    expect(MAX_WEIGHTED_TOTAL).toBe(39);
    expect(weightedTotal(scores(4))).toBe(31.2);
    expect(weightedTotal(scores(3))).toBe(23.4);
    expect(judge(scores(4)).shortlisted).toBe(true);
    expect(judge(scores(3)).shortlisted).toBe(false);

    const twoSoftSpots = judge(scores(4, { supportable: 3, costKnowable: 3 }));
    expect(twoSoftSpots.shortlisted).toBe(true);
    const threeHeavySoftSpots = judge(
      scores(4, { errorTolerance: 3, marketGap: 3, selfServe: 3 }),
    );
    expect(threeHeavySoftSpots.shortlisted).toBe(false);
  });
});

describe("rubric v2 against the 14 historical ideas", () => {
  /**
   * The 13 ideas from the live session whose v1 totals were recorded (the 14th
   * was never scored), with their v2 scores. v1 shortlisted 11 of the 14 and
   * three of those had to be rejected by hand; this table is what stops those
   * three passing again.
   *
   * The five v1 dimensions are the reconstruction that reproduces each recorded
   * v1 total (exactly for 9 of 13, within 0.4 where the recorded figure does
   * not sit on the integer-times-weight grid); errorTolerance and marketGap are
   * scored from the facts recorded about each idea at the time.
   */
  const HISTORY: readonly {
    readonly name: string;
    readonly v1Total: number;
    readonly scores: IdeaScores;
  }[] = [
    { name: "bank statement PDF to CSV", v1Total: 26.5,
      scores: scores(0, { selfServe: 5, machineShaped: 5, supportable: 4, costKnowable: 5, demandEvidenced: 5, errorTolerance: 4, marketGap: 1 }) },
    { name: "Merchant Center disapproval fixer", v1Total: 25.5,
      scores: scores(0, { selfServe: 4, machineShaped: 5, supportable: 5, costKnowable: 4, demandEvidenced: 5, errorTolerance: 4, marketGap: 3 }) },
    { name: "citation verifier for hallucinated case law", v1Total: 25.3,
      scores: scores(0, { selfServe: 5, machineShaped: 5, supportable: 5, costKnowable: 4, demandEvidenced: 4, errorTolerance: 2, marketGap: 4 }) },
    { name: "regulatory change monitoring", v1Total: 24.2,
      scores: scores(0, { selfServe: 5, machineShaped: 5, supportable: 4, costKnowable: 4, demandEvidenced: 4, errorTolerance: 1, marketGap: 2 }) },
    { name: "Shopify product health", v1Total: 24.0,
      scores: scores(0, { selfServe: 5, machineShaped: 4, supportable: 4, costKnowable: 5, demandEvidenced: 4, errorTolerance: 5, marketGap: 2 }) },
    { name: "India eCourts case tracking", v1Total: 24.0,
      scores: scores(0, { selfServe: 5, machineShaped: 4, supportable: 4, costKnowable: 5, demandEvidenced: 4, errorTolerance: 2, marketGap: 0 }) },
    { name: "EDI for small suppliers", v1Total: 23.1,
      scores: scores(0, { selfServe: 4, machineShaped: 5, supportable: 5, costKnowable: 3, demandEvidenced: 4, errorTolerance: 2, marketGap: 3 }) },
    { name: "trademark watch", v1Total: 22.7,
      scores: scores(0, { selfServe: 5, machineShaped: 5, supportable: 4, costKnowable: 4, demandEvidenced: 3, errorTolerance: 1, marketGap: 2 }) },
    { name: "outside counsel invoice audit", v1Total: 22.6,
      scores: scores(0, { selfServe: 4, machineShaped: 5, supportable: 4, costKnowable: 4, demandEvidenced: 4, errorTolerance: 3, marketGap: 3 }) },
    { name: "pay-transparency checker", v1Total: 20.8,
      scores: scores(0, { selfServe: 4, machineShaped: 5, supportable: 4, costKnowable: 5, demandEvidenced: 2, errorTolerance: 1, marketGap: 3 }) },
    { name: "lawyer platform", v1Total: 19.1,
      scores: scores(0, { selfServe: 3, machineShaped: 4, supportable: 3, costKnowable: 3, demandEvidenced: 4, errorTolerance: 2, marketGap: 2 }) },
    { name: "COI tracking", v1Total: 18.8,
      scores: scores(0, { selfServe: 4, machineShaped: 4, supportable: 4, costKnowable: 4, demandEvidenced: 2, errorTolerance: 0, marketGap: 3 }) },
    { name: "AI legal drafting", v1Total: 16.9,
      scores: scores(0, { selfServe: 2, machineShaped: 4, supportable: 3, costKnowable: 4, demandEvidenced: 3, errorTolerance: 0, marketGap: 1 }) },
  ];

  const byName = (name: string): IdeaScores => {
    const found = HISTORY.find((h) => h.name === name);
    if (found === undefined) throw new Error(`no historical idea "${name}"`);
    return found.scores;
  };

  test("rejects the three that v1 shortlisted and a human had to overturn", () => {
    // Each of these cost a human an intervention the funnel should have made.
    for (const name of [
      "COI tracking",               // human sign-off on every output
      "bank statement PDF to CSV",  // four vendors own the first page
      "India eCourts case tracking", // market leader is free to individuals
    ]) {
      const verdict = judge(byName(name));
      expect(verdict.shortlisted, `${name} must not shortlist`).toBe(false);
      expect(verdict.vetoedBy.length, `${name} must veto, not merely miss the bar`)
        .toBeGreaterThan(0);
    }
  });

  test("the top-scoring v1 idea is now vetoed rather than ranked first", () => {
    const saturated = judge(byName("bank statement PDF to CSV"));
    const survivors = HISTORY.map((h) => judge(h.scores)).filter(
      (v) => v.shortlisted,
    );
    expect(saturated.shortlisted).toBe(false);
    // It still scores well on total -- which is exactly why a veto rather than
    // a weight adjustment was needed.
    expect(saturated.total).toBeGreaterThan(SHORTLIST_THRESHOLD);
    expect(survivors.length).toBeGreaterThan(0);
  });

  test("cuts the funnel from almost-everything to a demanding handful", () => {
    // The v1 bar was 17 of a possible 27.5, so every recorded total above 17
    // shortlisted. Only "AI legal drafting" (16.9) failed it.
    const V1_THRESHOLD = 17;
    const v1Pass = HISTORY.filter((h) => h.v1Total >= V1_THRESHOLD).length;
    const v2Pass = HISTORY.filter((h) => judge(h.scores).shortlisted).length;
    expect(v1Pass).toBe(12);
    expect(v2Pass).toBe(4);
    // A funnel that passes a third is a funnel; one that passes nine tenths is
    // a conveyor belt. Pinned as a range so re-tuning a weight has to be a
    // deliberate decision rather than a silent drift back to v1 behaviour.
    expect(v2Pass / HISTORY.length).toBeLessThan(0.4);
  });

  test("most rejections are structural vetoes, not near misses", () => {
    const vetoed = HISTORY.filter((h) => judge(h.scores).vetoedBy.length > 0);
    expect(vetoed).toHaveLength(7);
    for (const h of vetoed) {
      // Every veto must come from one of the two new dimensions: if an old
      // dimension were doing this work, v1 would already have caught these.
      expect(
        judge(h.scores).vetoedBy.some(
          (k) => k === "errorTolerance" || k === "marketGap",
        ),
        `${h.name} should be vetoed by a v2 dimension`,
      ).toBe(true);
    }
  });
});

describe("retired rubric versions", () => {
  const v1Scores = {
    selfServe: 4, machineShaped: 4, supportable: 4,
    costKnowable: 4, demandEvidenced: 2,
  };

  test("refuses to read a v1 score set rather than defaulting the new dimensions", () => {
    // The dangerous shortcut: filling errorTolerance and marketGap with a
    // passing value would re-shortlist the ideas v2 exists to reject.
    expect(() => assertScores(v1Scores)).toThrow(InvalidScoreError);
    expect(() => assertScores(v1Scores)).toThrow(/errorTolerance/);
  });

  test("treats a complete v1 score set as not current", () => {
    expect(isCurrentRubric(v1Scores, 1)).toBe(false);
    expect(isCurrentRubric(scores(4), 1)).toBe(false);
    expect(isCurrentRubric(v1Scores, RUBRIC_VERSION)).toBe(false);
    expect(isCurrentRubric(scores(4), RUBRIC_VERSION)).toBe(true);
  });
});

describe("idea deduplication", () => {
  test("collapses the same idea written two ways", () => {
    expect(dedupeKey("Invoice parsing for freight brokers", "logistics")).toBe(
      dedupeKey("invoice parsing freight brokers", "logistics"),
    );
  });

  test("ignores filler words and punctuation that do not change the idea", () => {
    expect(dedupeKey("A tool for parsing invoices", "fintech")).toBe(
      dedupeKey("The tool -- parsing, invoices!", "fintech"),
    );
  });

  test("does NOT collapse morphological variants, by design", () => {
    // "parse" and "parsing" survive as distinct keys. Stemming would catch
    // more duplicates but would also collide genuinely different ideas, and a
    // false collision silently discards a real find. The analyst is the
    // backstop for near-duplicates that get this far.
    expect(dedupeKey("invoice parsing", "fintech")).not.toBe(
      dedupeKey("invoice parse", "fintech"),
    );
  });

  test("keeps genuinely different ideas apart", () => {
    expect(dedupeKey("invoice parsing", "logistics")).not.toBe(
      dedupeKey("invoice parsing", "healthcare"),
    );
  });

  test("strips accents so unicode variants collide", () => {
    expect(dedupeKey("resume parsing", "hr")).toBe(dedupeKey("résumé parsing", "hr"));
  });

  test("produces a bounded key regardless of input length", () => {
    expect(dedupeKey("x".repeat(500), "niche").length).toBeLessThanOrEqual(120);
  });
});
