import { describe, expect, test } from "vitest";
import {
  allowedTransitions, canTransition, IllegalTransitionError,
  isTerminal, assertTransition,
} from "../src/tickets/transitions.js";
import { TICKET_STATES } from "../src/tickets/types.js";

describe("ticket state machine", () => {
  test("advances a ticket along the happy path to done", () => {
    const path = ["proposed", "approved", "in_progress", "review", "done"] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  test("refuses to skip approval and go straight to in_progress", () => {
    expect(canTransition("proposed", "in_progress")).toBe(false);
  });

  test("refuses to reopen a done ticket", () => {
    expect(allowedTransitions("done")).toHaveLength(0);
    expect(() => assertTransition("done", "in_progress")).toThrow(
      IllegalTransitionError,
    );
  });

  test("allows review to send work back to in_progress", () => {
    expect(canTransition("review", "in_progress")).toBe(true);
  });

  test("allows a blocked ticket to resume or be killed, nothing else", () => {
    expect(allowedTransitions("blocked")).toEqual(["in_progress", "killed"]);
  });

  test("names the legal next states in the error message", () => {
    expect(() => assertTransition("proposed", "done")).toThrow(
      /legal next states are approved, killed/,
    );
  });

  test("marks done and killed as the only terminal states", () => {
    const terminal = TICKET_STATES.filter(isTerminal);
    expect(terminal).toEqual(["done", "killed"]);
  });

  test("every state has an explicit transition list", () => {
    for (const state of TICKET_STATES) {
      expect(Array.isArray(allowedTransitions(state))).toBe(true);
    }
  });
});
