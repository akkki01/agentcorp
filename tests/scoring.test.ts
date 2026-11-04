import { describe, expect, test } from "vitest";
import {
  assertScores, dedupeKey, InvalidScoreError, judge,
  RUBRIC_KEYS, SHORTLIST_THRESHOLD, weightedTotal,
} from "../src/ideas/scoring.js";
import type { IdeaScores } from "../src/ideas/scoring.js";

const scores = (fill: number, overrides: Partial<IdeaScores> = {}): IdeaScores =>
  ({
    ...Object.fromEntries(RUBRIC_KEYS.map((k) => [k, fill])),
    ...overrides,
  }) as IdeaScores;

describe("idea rubric", () => {
  test("weights demand evidence most heavily", () => {
    const withDemand = weightedTotal(scores(0, { demandEvidenced: 5 }));
    const withCost = weightedTotal(scores(0, { costKnowable: 5 }));
    expect(withDemand).toBeGreaterThan(withCost);
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
