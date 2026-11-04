import type { TicketState } from "./types.js";

/**
 * The ticket state machine. Transitions are deliberately narrow: an agent that
 * wants to move a ticket somewhere this table disallows has to escalate rather
 * than route around the process.
 */
const ALLOWED: Readonly<Record<TicketState, readonly TicketState[]>> = {
  proposed: ["approved", "killed"],
  approved: ["in_progress", "killed"],
  in_progress: ["review", "blocked", "killed"],
  review: ["done", "in_progress", "blocked"],
  blocked: ["in_progress", "killed"],
  done: [],
  killed: [],
};

export const TERMINAL_STATES: readonly TicketState[] = ["done", "killed"];

export const isTerminal = (state: TicketState): boolean =>
  TERMINAL_STATES.includes(state);

export const canTransition = (from: TicketState, to: TicketState): boolean =>
  ALLOWED[from].includes(to);

export const allowedTransitions = (
  from: TicketState,
): readonly TicketState[] => ALLOWED[from];

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TicketState,
    readonly to: TicketState,
  ) {
    const legal = ALLOWED[from];
    super(
      `cannot move ticket from "${from}" to "${to}"; ` +
        (legal.length > 0
          ? `legal next states are ${legal.join(", ")}`
          : `"${from}" is terminal`),
    );
    this.name = "IllegalTransitionError";
  }
}

/** Throws unless the transition is permitted. */
export const assertTransition = (from: TicketState, to: TicketState): void => {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
};
