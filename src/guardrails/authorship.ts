import type { NewTicket } from "../tickets/types.js";

/**
 * Rule: no agent may create work for itself.
 *
 * This is the single most important guardrail in the system. Without it, a role
 * that can both file and own tickets will generate an unbounded backlog of
 * plausible-looking self-assigned work and burn the monthly cap on busywork
 * that nobody asked for. Humans and the supervisor are exempt because they are
 * the system's entry points.
 */
export const EXEMPT_AUTHORS: readonly string[] = ["human", "supervisor"];

export class SelfAssignmentError extends Error {
  constructor(role: string) {
    super(
      `role "${role}" may not create tickets it also owns; ` +
        `file it against another role or escalate to ceo`,
    );
    this.name = "SelfAssignmentError";
  }
}

export const violatesAuthorship = (ticket: NewTicket): boolean =>
  !EXEMPT_AUTHORS.includes(ticket.createdBy) &&
  ticket.createdBy === ticket.ownerRole;

export const assertAuthorship = (ticket: NewTicket): void => {
  if (violatesAuthorship(ticket)) throw new SelfAssignmentError(ticket.ownerRole);
};
