import { describe, expect, test } from "vitest";
import {
  assertAuthorship, SelfAssignmentError, violatesAuthorship,
} from "../src/guardrails/authorship.js";
import { assertDepth, DepthExceededError, exceedsDepth } from "../src/guardrails/depth.js";
import {
  assertBudget, budgetPressure, BudgetExhaustedError, isExhausted,
} from "../src/guardrails/budget.js";
import type { NewTicket } from "../src/tickets/types.js";

const ticket = (createdBy: string, ownerRole: string): NewTicket => ({
  type: "build",
  title: "do a thing",
  body: "",
  createdBy,
  ownerRole,
});

describe("authorship guardrail -- no agent creates work for itself", () => {
  test("blocks a role filing a ticket it would also own", () => {
    expect(violatesAuthorship(ticket("engineer", "engineer"))).toBe(true);
    expect(() => assertAuthorship(ticket("engineer", "engineer"))).toThrow(
      SelfAssignmentError,
    );
  });

  test("allows a role filing against a different role", () => {
    expect(violatesAuthorship(ticket("pm", "engineer"))).toBe(false);
  });

  test("exempts the human operator, who is the system's entry point", () => {
    expect(violatesAuthorship(ticket("human", "human"))).toBe(false);
  });

  test("exempts the supervisor, which re-files its own reaped work", () => {
    expect(violatesAuthorship(ticket("supervisor", "supervisor"))).toBe(false);
  });

  test("tells the caller what to do instead of just refusing", () => {
    expect(() => assertAuthorship(ticket("qa", "qa"))).toThrow(/escalate to ceo/);
  });
});

describe("depth guardrail", () => {
  test("permits decomposition up to the limit", () => {
    expect(exceedsDepth(0, 3)).toBe(false);
    expect(exceedsDepth(2, 3)).toBe(false);
  });

  test("blocks the generation that would exceed the limit", () => {
    expect(exceedsDepth(3, 3)).toBe(true);
    expect(() => assertDepth(3, 3)).toThrow(DepthExceededError);
  });

  test("directs the caller to escalate rather than decompose", () => {
    expect(() => assertDepth(5, 3)).toThrow(/escalate to ceo/);
  });
});

describe("budget guardrail", () => {
  test("treats spend equal to budget as exhausted, not as room to spare", () => {
    expect(isExhausted(2, 2)).toBe(true);
  });

  test("leaves a ticket under budget alone", () => {
    expect(isExhausted(1.99, 2)).toBe(false);
    expect(() => assertBudget(1, 1.99, 2)).not.toThrow();
  });

  test("throws with the dollar figures a human needs to decide", () => {
    expect(() => assertBudget(7, 2.5, 2)).toThrow(BudgetExhaustedError);
    expect(() => assertBudget(7, 2.5, 2)).toThrow(/\$2\.5000 of its \$2\.00/);
  });

  test("reports pressure as a clamped fraction", () => {
    expect(budgetPressure(0, 2)).toBe(0);
    expect(budgetPressure(1, 2)).toBe(0.5);
    expect(budgetPressure(5, 2)).toBe(1);
  });

  test("treats a zero budget as fully consumed rather than dividing by zero", () => {
    expect(budgetPressure(0, 0)).toBe(1);
  });
});
