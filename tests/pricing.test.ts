import { describe, expect, test } from "vitest";
import {
  MODEL_PRICES, priceUsage, UnpricedModelError,
} from "../src/ledger/pricing.js";

describe("model pricing", () => {
  test("prices a plain Opus 5 call at the published rate", () => {
    // 1M input at $5 + 1M output at $25.
    expect(
      priceUsage("claude-opus-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(30, 6);
  });

  test("prices Sonnet 5 below Opus 5 for identical usage", () => {
    const usage = { inputTokens: 500_000, outputTokens: 100_000 };
    expect(priceUsage("claude-sonnet-5", usage)).toBeLessThan(
      priceUsage("claude-opus-5", usage),
    );
  });

  test("prices Haiku 4.5 at $1 in / $5 out per million", () => {
    expect(
      priceUsage("claude-haiku-4-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBeCloseTo(1, 6);
    expect(
      priceUsage("claude-haiku-4-5", {
        inputTokens: 0,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(5, 6);
  });

  test("bills cache reads at a tenth of base input", () => {
    const cached = priceUsage("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(cached).toBeCloseTo(0.5, 6);
  });

  test("bills cache writes at 1.25x base input", () => {
    const written = priceUsage("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(written).toBeCloseTo(6.25, 6);
  });

  test("refuses an unpriced model instead of recording zero cost", () => {
    expect(() =>
      priceUsage("some-unreleased-model", { inputTokens: 100, outputTokens: 100 }),
    ).toThrow(UnpricedModelError);
  });

  test("explains why an unpriced model is refused", () => {
    expect(() =>
      priceUsage("nope", { inputTokens: 1, outputTokens: 1 }),
    ).toThrow(/understate burn/);
  });

  test("every priced model charges more for output than input", () => {
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(price.outputPerMTok, model).toBeGreaterThan(price.inputPerMTok);
    }
  });
});
