import { ALL_ROLES, rolesInLoop } from "../roles/registry.js";
import { reapExpiredLeases } from "../tickets/lease.js";
import { haltReason } from "../guardrails/controls.js";
import type { Loop } from "../roles/types.js";
import { workOnce, type WorkOutcome } from "./worker.js";

/**
 * Drives one pass over a set of roles.
 *
 * Roles are visited in declared order and each gets at most `concurrency`
 * claims per pass, which keeps a role with a deep queue from monopolising the
 * monthly budget. There is no preemption: a role that has nothing to do costs
 * one empty claim query.
 */

export interface PassReport {
  readonly halted: string | undefined;
  readonly reapedLeases: number;
  readonly outcomes: readonly { role: string; outcome: WorkOutcome }[];
  readonly totalCostUsd: number;
}

export const runPass = async (
  loop?: Loop,
): Promise<PassReport> => {
  const reapedLeases = await reapExpiredLeases();

  const halt = await haltReason();
  if (halt !== undefined) {
    return {
      halted:
        halt.kind === "paused"
          ? `paused: ${halt.detail}`
          : `monthly cap reached: $${halt.spentUsd.toFixed(2)} of $${halt.capUsd.toFixed(2)}`,
      reapedLeases,
      outcomes: [],
      totalCostUsd: 0,
    };
  }

  const roles = loop === undefined ? ALL_ROLES : rolesInLoop(loop);
  const outcomes: { role: string; outcome: WorkOutcome }[] = [];
  let totalCostUsd = 0;

  for (const role of roles) {
    for (let slot = 0; slot < role.concurrency; slot += 1) {
      const outcome = await workOnce(role.name);
      outcomes.push({ role: role.name, outcome });

      if (outcome.kind === "worked") totalCostUsd += outcome.costUsd;
      // Stop filling slots for a role with an empty queue, and abandon the pass
      // entirely if the company halted mid-way.
      if (outcome.kind === "idle" || outcome.kind === "tripped") break;
      if (outcome.kind === "halted") {
        return { halted: outcome.reason, reapedLeases, outcomes, totalCostUsd };
      }
    }
  }

  return { halted: undefined, reapedLeases, outcomes, totalCostUsd };
};
