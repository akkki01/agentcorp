import { describe, expect, test } from "vitest";
import {
  assertAssumptions, InvalidAssumptionError, project, projectScenario,
  type Assumptions,
} from "../src/forecast/model.js";

const base: Assumptions = {
  pricePerCustomerMonthUsd: 49,
  serveCostPerCustomerMonthUsd: 6,
  reachableCustomers: 400,
  monthsToLaunch: 3,
  monthsToHalfCeiling: 9,
  buildBudgetUsd: 4_000,
  monthlyOpexUsd: 600,
  monthlyChurn: 0.04,
  horizonMonths: 24,
};

describe("growth projection", () => {
  test("earns nothing before launch", () => {
    const { months } = projectScenario(base, "base");
    for (const m of months.slice(0, base.monthsToLaunch)) {
      expect(m.mrrUsd).toBe(0);
      expect(m.customers).toBe(0);
    }
  });

  test("reports first dollar at the launch month", () => {
    const scenario = projectScenario(base, "base");
    expect(scenario.monthsToFirstDollar).toBe(base.monthsToLaunch);
  });

  test("approaches roughly half the ceiling at monthsToHalfCeiling", () => {
    const { months } = projectScenario(base, "base");
    const atHalf = months[base.monthsToLaunch + base.monthsToHalfCeiling]!;
    const expectedHalf = (base.reachableCustomers * (1 - base.monthlyChurn)) / 2;
    expect(atHalf.customers).toBeGreaterThan(expectedHalf * 0.8);
    expect(atHalf.customers).toBeLessThan(expectedHalf * 1.2);
  });

  test("never exceeds the reachable ceiling", () => {
    const { months } = projectScenario(base, "base");
    for (const m of months) {
      expect(m.customers).toBeLessThanOrEqual(base.reachableCustomers);
    }
  });

  test("grows customers monotonically", () => {
    const { months } = projectScenario(base, "base");
    for (let i = 1; i < months.length; i += 1) {
      expect(months[i]!.customers).toBeGreaterThanOrEqual(months[i - 1]!.customers);
    }
  });

  test("starts cumulative profit at a loss equal to the build budget", () => {
    const { months } = projectScenario(base, "base");
    expect(months[0]!.cumulativeProfitUsd).toBeCloseTo(
      -(base.buildBudgetUsd + base.monthlyOpexUsd),
      2,
    );
  });

  test("reports funding needed as the peak cumulative loss", () => {
    const scenario = projectScenario(base, "base");
    const worst = Math.min(...scenario.months.map((m) => m.cumulativeProfitUsd));
    expect(scenario.budgetToBreakEvenUsd).toBeCloseTo(Math.abs(worst), 2);
  });

  test("breaks even later in the low case than the high case", () => {
    const low = projectScenario(base, "low");
    const high = projectScenario(base, "high");
    expect(high.monthsToBreakEven).not.toBeNull();
    if (low.monthsToBreakEven !== null && high.monthsToBreakEven !== null) {
      expect(high.monthsToBreakEven).toBeLessThanOrEqual(low.monthsToBreakEven);
    }
  });

  test("orders the three scenarios by ceiling", () => {
    const p = project(base);
    expect(p.low.ceilingMrrUsd).toBeLessThan(p.base.ceilingMrrUsd);
    expect(p.base.ceilingMrrUsd).toBeLessThan(p.high.ceilingMrrUsd);
  });

  test("never breaks even when opex exceeds the ceiling's gross profit", () => {
    const doomed = projectScenario(
      { ...base, monthlyOpexUsd: 500_000, horizonMonths: 24 },
      "base",
    );
    expect(doomed.monthsToBreakEven).toBeNull();
  });

  test("summarises the base case and the spread in the headline", () => {
    const { headline } = project(base);
    expect(headline).toMatch(/Base case/);
    expect(headline).toMatch(/break-even/);
    expect(headline).toMatch(/Range across scenarios/);
  });
});

describe("assumption validation", () => {
  test("refuses a product that loses money on every customer", () => {
    expect(() =>
      assertAssumptions({ ...base, serveCostPerCustomerMonthUsd: 49 }),
    ).toThrow(InvalidAssumptionError);
    expect(() =>
      assertAssumptions({ ...base, serveCostPerCustomerMonthUsd: 60 }),
    ).toThrow(/loses money on every customer/);
  });

  test("refuses a zero or negative price", () => {
    expect(() =>
      assertAssumptions({ ...base, pricePerCustomerMonthUsd: 0 }),
    ).toThrow(/must be > 0/);
  });

  test("refuses churn at or above 100%", () => {
    expect(() => assertAssumptions({ ...base, monthlyChurn: 1 })).toThrow(
      /\[0, 1\)/,
    );
  });

  test("refuses an unreasonable horizon", () => {
    expect(() => assertAssumptions({ ...base, horizonMonths: 0 })).toThrow(/1-120/);
    expect(() => assertAssumptions({ ...base, horizonMonths: 500 })).toThrow(/1-120/);
  });

  test("accepts the baseline assumptions", () => {
    expect(() => assertAssumptions(base)).not.toThrow();
  });
});
