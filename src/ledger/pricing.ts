/**
 * Per-token pricing in USD per million tokens, as published by Anthropic.
 * Verified 2026-06-24. Cache writes bill at 1.25x base input; cache reads at
 * 0.1x base input.
 *
 * If a model is missing here the ledger refuses the call rather than silently
 * recording a zero cost -- an unpriced model is how a company discovers its
 * burn rate a month late.
 */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;
const PER_MILLION = 1_000_000;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export class UnpricedModelError extends Error {
  constructor(model: string) {
    super(
      `no price on file for model "${model}"; add it to MODEL_PRICES before ` +
        `spending against it, or the cost ledger will understate burn`,
    );
    this.name = "UnpricedModelError";
  }
}

export const priceUsage = (model: string, usage: TokenUsage): number => {
  const price = MODEL_PRICES[model];
  if (price === undefined) throw new UnpricedModelError(model);

  const { inputPerMTok, outputPerMTok } = price;
  const billable =
    usage.inputTokens * inputPerMTok +
    usage.outputTokens * outputPerMTok +
    (usage.cacheWriteTokens ?? 0) * inputPerMTok * CACHE_WRITE_MULTIPLIER +
    (usage.cacheReadTokens ?? 0) * inputPerMTok * CACHE_READ_MULTIPLIER;

  return billable / PER_MILLION;
};
