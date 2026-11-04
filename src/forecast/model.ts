/**
 * Growth projection maths.
 *
 * Pure functions, no I/O: this is the part that must be inspectable and
 * testable, because every downstream budget decision rests on it.
 *
 * The model is deliberately simple -- a bounded logistic adoption ramp against
 * a flat monthly opex -- and it is simple on purpose. A more elaborate model
 * does not make the assumptions less invented; it only makes a guess harder to
 * argue with. The honest output is a wide range plus the assumptions that
 * produced it.
 */

export interface Assumptions {
  /** What one customer pays per month, in USD. */
  readonly pricePerCustomerMonthUsd: number;
  /** Marginal cost to serve one customer per month (model + infra), in USD. */
  readonly serveCostPerCustomerMonthUsd: number;
  /** Realistic ceiling on paying customers for this niche. */
  readonly reachableCustomers: number;
  /** Months from start until the product can take its first payment. */
  readonly monthsToLaunch: number;
  /** Months from launch to reach half the reachable ceiling. */
  readonly monthsToHalfCeiling: number;
  /** One-off build spend before launch, in USD. */
  readonly buildBudgetUsd: number;
  /** Ongoing company opex per month (agent spend + infra), in USD. */
  readonly monthlyOpexUsd: number;
  /** Fraction of customers lost per month, 0-1. */
  readonly monthlyChurn: number;
  /** How many months to project. */
  readonly horizonMonths: number;
}

export interface MonthPoint {
  readonly monthIndex: number;
  readonly customers: number;
  readonly mrrUsd: number;
  readonly costUsd: number;
  readonly cumulativeProfitUsd: number;
}

export type ScenarioName = "low" | "base" | "high";

export interface Scenario {
  readonly name: ScenarioName;
  readonly months: readonly MonthPoint[];
  readonly ceilingMrrUsd: number;
  readonly monthsToFirstDollar: number | null;
  readonly monthsToBreakEven: number | null;
  /** Peak cumulative loss -- the cash the company must survive. */
  readonly maxDrawdownUsd: number;
  readonly budgetToBreakEvenUsd: number;
}

export class InvalidAssumptionError extends Error {
  constructor(field: string, reason: string) {
    super(`assumption "${field}" ${reason}`);
    this.name = "InvalidAssumptionError";
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const assertAssumptions = (a: Assumptions): void => {
  if (a.pricePerCustomerMonthUsd <= 0) {
    throw new InvalidAssumptionError("pricePerCustomerMonthUsd", "must be > 0");
  }
  if (a.serveCostPerCustomerMonthUsd >= a.pricePerCustomerMonthUsd) {
    throw new InvalidAssumptionError(
      "serveCostPerCustomerMonthUsd",
      "is at or above price, so the product loses money on every customer; " +
        "fix the price or the cost before forecasting growth",
    );
  }
  if (a.reachableCustomers <= 0) {
    throw new InvalidAssumptionError("reachableCustomers", "must be > 0");
  }
  if (a.monthsToHalfCeiling <= 0) {
    throw new InvalidAssumptionError("monthsToHalfCeiling", "must be > 0");
  }
  if (a.monthlyChurn < 0 || a.monthlyChurn >= 1) {
    throw new InvalidAssumptionError("monthlyChurn", "must be in [0, 1)");
  }
  if (a.horizonMonths < 1 || a.horizonMonths > 120) {
    throw new InvalidAssumptionError("horizonMonths", "must be 1-120");
  }
};

/**
 * Logistic adoption, shifted so month `monthsToLaunch` is the first month that
 * can earn anything, and damped by churn.
 *
 * Churn is applied as a reduction of the attainable ceiling rather than as a
 * decay on the stock. That keeps the curve monotonic and the arithmetic
 * legible; it understates volatility and overstates smoothness, which is the
 * right direction for a planning number.
 */
const customersAtMonth = (a: Assumptions, month: number): number => {
  const sinceLaunch = month - a.monthsToLaunch;
  if (sinceLaunch < 0) return 0;

  // Steepness chosen so the curve reaches ~half the ceiling at
  // monthsToHalfCeiling, matching the assumption's stated meaning.
  const steepness = Math.log(9) / a.monthsToHalfCeiling;
  const raw =
    a.reachableCustomers / (1 + Math.exp(-steepness * (sinceLaunch - a.monthsToHalfCeiling)));
  const churnDamped = raw * (1 - a.monthlyChurn);
  return Math.max(0, Math.floor(churnDamped));
};

/** Multipliers applied to the ceiling and the ramp to produce the three cases. */
const SCENARIO_SHAPE: Readonly<
  Record<ScenarioName, { ceiling: number; ramp: number }>
> = {
  // A 3x spread between low and high is not pessimism, it is the observed
  // spread of early-stage adoption forecasts. Narrowing it would be a lie.
  low: { ceiling: 0.3, ramp: 1.8 },
  base: { ceiling: 1.0, ramp: 1.0 },
  high: { ceiling: 1.8, ramp: 0.7 },
};

export const projectScenario = (
  base: Assumptions,
  name: ScenarioName,
): Scenario => {
  assertAssumptions(base);
  const shape = SCENARIO_SHAPE[name];
  const a: Assumptions = {
    ...base,
    reachableCustomers: Math.max(
      1,
      Math.round(base.reachableCustomers * shape.ceiling),
    ),
    monthsToHalfCeiling: Math.max(
      1,
      base.monthsToHalfCeiling * shape.ramp,
    ),
  };

  const months: MonthPoint[] = [];
  let cumulative = -a.buildBudgetUsd;
  let monthsToFirstDollar: number | null = null;
  let monthsToBreakEven: number | null = null;
  let maxDrawdown = Math.min(0, cumulative);

  for (let month = 0; month < a.horizonMonths; month += 1) {
    const customers = customersAtMonth(a, month);
    const mrrUsd = customers * a.pricePerCustomerMonthUsd;
    const costUsd =
      a.monthlyOpexUsd + customers * a.serveCostPerCustomerMonthUsd;

    cumulative += mrrUsd - costUsd;
    if (monthsToFirstDollar === null && mrrUsd > 0) monthsToFirstDollar = month;
    if (monthsToBreakEven === null && cumulative >= 0 && mrrUsd > 0) {
      monthsToBreakEven = month;
    }
    maxDrawdown = Math.min(maxDrawdown, cumulative);

    months.push({
      monthIndex: month,
      customers,
      mrrUsd: round2(mrrUsd),
      costUsd: round2(costUsd),
      cumulativeProfitUsd: round2(cumulative),
    });
  }

  const last = months.at(-1);
  return {
    name,
    months,
    ceilingMrrUsd: round2(last?.mrrUsd ?? 0),
    monthsToFirstDollar,
    monthsToBreakEven,
    maxDrawdownUsd: round2(Math.abs(maxDrawdown)),
    budgetToBreakEvenUsd: round2(Math.abs(maxDrawdown)),
  };
};

export interface Projection {
  readonly assumptions: Assumptions;
  readonly low: Scenario;
  readonly base: Scenario;
  readonly high: Scenario;
  /** Plain-language summary of the base case and the spread around it. */
  readonly headline: string;
}

const describeMonths = (m: number | null, horizon: number): string =>
  m === null ? `not within ${horizon} months` : `month ${m}`;

export const project = (assumptions: Assumptions): Projection => {
  const low = projectScenario(assumptions, "low");
  const base = projectScenario(assumptions, "base");
  const high = projectScenario(assumptions, "high");

  const headline =
    `Base case: $${base.ceilingMrrUsd.toLocaleString()} MRR by month ` +
    `${assumptions.horizonMonths - 1}, first dollar at ` +
    `${describeMonths(base.monthsToFirstDollar, assumptions.horizonMonths)}, ` +
    `break-even at ${describeMonths(base.monthsToBreakEven, assumptions.horizonMonths)}, ` +
    `needing $${base.budgetToBreakEvenUsd.toLocaleString()} of funding to get there. ` +
    `Range across scenarios: $${low.ceilingMrrUsd.toLocaleString()}-` +
    `$${high.ceilingMrrUsd.toLocaleString()} MRR, break-even ` +
    `${describeMonths(high.monthsToBreakEven, assumptions.horizonMonths)} to ` +
    `${describeMonths(low.monthsToBreakEven, assumptions.horizonMonths)}.`;

  return { assumptions, low, base, high, headline };
};
