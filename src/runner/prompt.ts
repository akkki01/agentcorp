import { budgetPressure } from "../guardrails/budget.js";
import type { RoleDefinition } from "../roles/types.js";
import type { Ticket } from "../tickets/types.js";
import { allowedTransitions } from "../tickets/transitions.js";

/**
 * Builds the system prompt for one agent turn.
 *
 * Stable content first, volatile content last: the charter and company rules
 * never change between turns and sit at the front so the cached prefix holds,
 * while ticket state and budget pressure go in the user message. Putting the
 * ticket in the system prompt would invalidate the cache on every single turn.
 */

const COMPANY_RULES = `You are one role in a company staffed by agents. The
company runs on tickets: typed, budgeted units of work in a shared database.
These rules bind every role, including yours.

1. All work is a ticket. You act by creating, claiming, transitioning, and
   closing tickets -- never by free-form conversation with another agent.
2. You may not create work for yourself. A ticket you own must have been filed
   by someone else. File against another role, or escalate to ceo.
3. You have a dollar budget for this ticket. When it runs out the ticket blocks
   and a human or the ceo decides what happens -- it is not retried. Spend it
   on the work, not on re-reading context you already have.
4. If you delegate, you own collecting the result. Filing a subticket and
   stopping is an incomplete turn, not a completed one.
5. Decompose at most to the configured depth, then escalate. Depth is an
   outcome of difficulty, not a plan.
6. Disagreements resolve by escalation to ceo in one turn, never by
   negotiation between roles.
7. A ticket is done when its acceptance criteria are verified, not when the
   work feels finished. If a criterion is wrong or impossible, block the ticket
   and say which one and why. Never silently substitute an easier criterion.
8. Anything that leaves the company or commits it -- outbound messages, public
   claims, pricing, terms, production deploys -- passes a human or compliance
   gate. Do not look for a way around a gate; it exists because an agent's
   mistake reaches a real person.
9. Write what you learned to the wiki before you close. It is the only memory
   that survives your turn.
10. Report honestly. "No actionable signal", "the data does not support a
    conclusion", and "I could not verify this" are valid, useful answers. A
    confident guess presented as a finding is the most expensive thing you can
    produce.`;

export const buildSystemPrompt = (role: RoleDefinition): string =>
  [
    `# Your role: ${role.name}`,
    "",
    role.charter,
    "",
    `# Company rules`,
    "",
    COMPANY_RULES,
    "",
    `# Your remit`,
    "",
    `You own tickets of type: ${role.owns.join(", ") || "none"}.`,
    `You may file tickets of type: ${role.mayFile.join(", ") || "none"}.`,
    role.hasVeto === true
      ? `You hold a blocking veto. Use it, and state the specific objection and the smallest change that would clear it.`
      : `You do not hold a veto. If you believe something must not ship, escalate to ceo or compliance.`,
  ].join("\n");

const BUDGET_WARN_THRESHOLD = 0.6;
const BUDGET_URGENT_THRESHOLD = 0.85;

/** The volatile half: this ticket, right now. Never cached. */
export const buildTurnPrompt = (
  ticket: Ticket,
  spentUsd: number,
): string => {
  const pressure = budgetPressure(spentUsd, ticket.budgetUsd);
  const remaining = Math.max(0, ticket.budgetUsd - spentUsd);

  const budgetNote =
    pressure >= BUDGET_URGENT_THRESHOLD
      ? `BUDGET CRITICAL: $${remaining.toFixed(4)} left of $${ticket.budgetUsd.toFixed(2)}. ` +
        `Finish or block the ticket this turn. Do not start anything new.`
      : pressure >= BUDGET_WARN_THRESHOLD
        ? `Budget note: $${remaining.toFixed(4)} left of $${ticket.budgetUsd.toFixed(2)}. ` +
          `Prioritise closing over exploring.`
        : `Budget: $${remaining.toFixed(4)} of $${ticket.budgetUsd.toFixed(2)} remaining.`;

  const criteria =
    ticket.acceptance.length === 0
      ? "(none specified -- if this ticket needs criteria to be verifiable, say so and block it)"
      : ticket.acceptance
          .map(
            (c, i) =>
              `${i + 1}. [${c.verified ? "verified" : "unverified"}] ${c.statement}` +
              (c.check !== undefined ? `\n   check: \`${c.check}\`` : ""),
          )
          .join("\n");

  return [
    `## Ticket #${ticket.id} (${ticket.type}, ${ticket.state})`,
    `**${ticket.title}**`,
    "",
    ticket.body,
    "",
    `## Acceptance criteria`,
    criteria,
    "",
    `## State`,
    `Filed by: ${ticket.createdBy}`,
    `Depth: ${ticket.depth}`,
    `Legal next states: ${allowedTransitions(ticket.state).join(", ") || "none (terminal)"}`,
    ticket.requiresHuman
      ? `This ticket REQUIRES HUMAN APPROVAL before it can close.${ticket.humanApproved ? " (approved)" : " (not yet approved -- do the work, then leave it in review)"}`
      : "",
    ticket.artifacts.length > 0
      ? `Artifacts so far: ${ticket.artifacts.join(", ")}`
      : "",
    "",
    budgetNote,
    "",
    `Do the work. End your turn by transitioning the ticket -- to review when it is ` +
      `ready for the reviewing role, to blocked if you cannot proceed, or to done if ` +
      `you are the reviewing role and every criterion is verified.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
};
