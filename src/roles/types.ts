import type { TicketType } from "../tickets/types.js";

/**
 * Which harness executes a role's turn.
 *
 * `api`  - the Anthropic SDK tool runner, with the company tools in this repo.
 *          Right for roles whose work is reasoning over company state.
 * `code` - a coding harness with filesystem and shell access (e.g. the Claude
 *          Agent SDK, a separate product). Right for roles that edit the repo.
 *
 * The substrate does not care which; `runner/harness.ts` dispatches on it.
 */
export type Harness = "api" | "code";

export type Loop = "strategy" | "build" | "revenue";

export interface RoleDefinition {
  readonly name: string;
  readonly loop: Loop;
  readonly harness: Harness;
  readonly model: string;
  /** Effort maps to output_config.effort; low for cheap roles, high for judgement. */
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly charter: string;
  /** Ticket types this role is allowed to own. */
  readonly owns: readonly TicketType[];
  /** Ticket types this role may file against other roles. */
  readonly mayFile: readonly TicketType[];
  /** Tool names from the company toolset this role may call. */
  readonly tools: readonly string[];
  /** Default ticket budget in USD for work this role files. */
  readonly defaultBudgetUsd: number;
  /** A blocking reviewer: its veto stops a ticket regardless of state. */
  readonly hasVeto?: boolean;
  /** How many workers of this role the supervisor should run. */
  readonly concurrency: number;
}
