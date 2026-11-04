/**
 * Rule: every ticket carries a dollar budget, and exhausting it blocks the
 * ticket rather than triggering a retry.
 *
 * A retry on budget exhaustion is how a stuck agent turns a $2 ticket into a
 * $200 one. Blocking surfaces the misjudgement to the CEO loop instead.
 */
export class BudgetExhaustedError extends Error {
  constructor(
    readonly ticketId: number,
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `ticket ${ticketId} has spent $${spentUsd.toFixed(4)} of its ` +
        `$${budgetUsd.toFixed(2)} budget; blocking for ceo review`,
    );
    this.name = "BudgetExhaustedError";
  }
}

export const isExhausted = (spentUsd: number, budgetUsd: number): boolean =>
  spentUsd >= budgetUsd;

/**
 * Fraction of budget consumed, clamped to [0, 1]. The runner uses this to warn
 * an agent in-prompt that it is running out of room, which measurably reduces
 * the rate at which agents get cut off mid-task.
 */
export const budgetPressure = (spentUsd: number, budgetUsd: number): number => {
  if (budgetUsd <= 0) return 1;
  return Math.min(1, Math.max(0, spentUsd / budgetUsd));
};

export const assertBudget = (
  ticketId: number,
  spentUsd: number,
  budgetUsd: number,
): void => {
  if (isExhausted(spentUsd, budgetUsd)) {
    throw new BudgetExhaustedError(ticketId, spentUsd, budgetUsd);
  }
};
