import { config } from "../config.js";

/**
 * Rule: decompose at most `maxTicketDepth` levels, then escalate.
 *
 * Depth is an outcome, not a plan. An agent that cannot complete work within
 * the depth budget has misjudged the task, and the correct move is to hand it
 * back up rather than spawn another generation of subtickets.
 */
export class DepthExceededError extends Error {
  constructor(
    readonly depth: number,
    readonly max: number,
  ) {
    super(
      `ticket depth ${depth} exceeds the limit of ${max}; ` +
        `escalate to ceo instead of decomposing further`,
    );
    this.name = "DepthExceededError";
  }
}

export const exceedsDepth = (
  parentDepth: number,
  max: number = config.maxTicketDepth,
): boolean => parentDepth + 1 > max;

export const assertDepth = (
  parentDepth: number,
  max: number = config.maxTicketDepth,
): void => {
  if (exceedsDepth(parentDepth, max)) {
    throw new DepthExceededError(parentDepth + 1, max);
  }
};
