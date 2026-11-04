import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { closePool, getPool } from "../src/db/pool.js";
import { haltReason, readControls, setPaused } from "../src/guardrails/controls.js";
import {
  recordRoleFailure, recordRoleSuccess, isRoleTripped,
} from "../src/guardrails/controls.js";
import { captureIdea, promoteIdea, scoreIdea } from "../src/ideas/store.js";
import { recordActual, recordForecast } from "../src/forecast/store.js";
import { marginToDate, recordSpend, ticketSpend } from "../src/ledger/ledger.js";
import { claimNextTicket, reapExpiredLeases } from "../src/tickets/lease.js";
import {
  addArtifact, approveByHuman, insertTicket, transitionTicket,
} from "../src/tickets/store.js";
import { IllegalTransitionError } from "../src/tickets/transitions.js";

/**
 * Integration tests against a real Postgres. Skipped unless a database is
 * reachable, so `pnpm test` stays useful with nothing running.
 */
let live = false;

beforeAll(async () => {
  try {
    await getPool().query("SELECT 1");
    await migrate();
    live = true;
  } catch {
    live = false;
  }
});

afterAll(async () => {
  if (live) await closePool();
});

beforeEach(async () => {
  if (!live) return;
  // Order matters: forecasts and ledger rows reference ideas and tickets.
  await getPool().query(
    `TRUNCATE forecast_actuals, forecasts, ideas, cost_ledger, revenue_ledger,
              usage_events, ticket_events, tickets, wiki_entries, role_health
     RESTART IDENTITY CASCADE`,
  );
  await setPaused(false);
});

const it = (name: string, fn: () => Promise<void>) =>
  test(name, async () => {
    if (!live) {
      console.warn(`skipped (no database): ${name}`);
      return;
    }
    await fn();
  });

const build = async (over: Partial<Parameters<typeof insertTicket>[0]> = {}) =>
  insertTicket({
    type: "build",
    title: "implement the thing",
    body: "details",
    ownerRole: "engineer",
    createdBy: "pm",
    budgetUsd: 2,
    ...over,
  });

describe("ticket lifecycle", () => {
  it("carries a ticket from proposed to done", async () => {
    const t = await build();
    expect(t.state).toBe("proposed");
    await transitionTicket(t.id, "approved", "human");
    const claimed = await claimNextTicket("engineer", "w1");
    expect(claimed?.id).toBe(t.id);
    expect(claimed?.state).toBe("in_progress");
    await transitionTicket(t.id, "review", "engineer");
    const done = await transitionTicket(t.id, "done", "qa");
    expect(done.state).toBe("done");
    expect(done.closedAt).not.toBeNull();
    expect(done.claimedBy).toBeNull();
  });

  it("rejects an illegal transition at the database boundary", async () => {
    const t = await build();
    await expect(transitionTicket(t.id, "done", "engineer")).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it("refuses to close a human-gated ticket until a human approves", async () => {
    const t = await build({ requiresHuman: true, type: "deploy", ownerRole: "sre" });
    await transitionTicket(t.id, "approved", "human");
    await transitionTicket(t.id, "in_progress", "sre");
    await transitionTicket(t.id, "review", "sre");
    await expect(transitionTicket(t.id, "done", "sre")).rejects.toThrow(
      /requires human approval/,
    );
    await approveByHuman(t.id);
    const done = await transitionTicket(t.id, "done", "sre");
    expect(done.state).toBe("done");
  });

  it("records depth from the parent chain", async () => {
    const parent = await build();
    const child = await build({ parentId: parent.id });
    const grandchild = await build({ parentId: child.id });
    expect([parent.depth, child.depth, grandchild.depth]).toEqual([0, 1, 2]);
  });

  it("writes an append-only audit trail", async () => {
    const t = await build();
    await transitionTicket(t.id, "approved", "human");
    await addArtifact(t.id, "https://github.com/x/y/pull/1", "engineer");
    const { rows } = await getPool().query(
      "SELECT kind FROM ticket_events WHERE ticket_id = $1 ORDER BY id",
      [t.id],
    );
    expect(rows.map((r) => r.kind)).toEqual([
      "created", "state:approved", "artifact:added",
    ]);
  });
});

describe("claim leases", () => {
  it("gives two workers of the same role different tickets", async () => {
    const a = await build();
    const b = await build();
    await transitionTicket(a.id, "approved", "human");
    await transitionTicket(b.id, "approved", "human");
    const first = await claimNextTicket("engineer", "w1");
    const second = await claimNextTicket("engineer", "w2");
    expect(first?.id).not.toBe(second?.id);
    expect([first?.id, second?.id].sort()).toEqual([a.id, b.id].sort());
  });

  it("returns nothing when the queue is empty rather than blocking", async () => {
    expect(await claimNextTicket("engineer", "w1")).toBeUndefined();
  });

  it("returns an expired lease to the queue", async () => {
    const t = await build();
    await transitionTicket(t.id, "approved", "human");
    await claimNextTicket("engineer", "w1");
    // Simulate a crashed worker by expiring its lease.
    await getPool().query(
      "UPDATE tickets SET lease_expires_at = now() - interval '1 minute' WHERE id = $1",
      [t.id],
    );
    expect(await reapExpiredLeases()).toBe(1);
    const reclaimed = await claimNextTicket("engineer", "w2");
    expect(reclaimed?.id).toBe(t.id);
    expect(reclaimed?.claimedBy).toBe("w2");
  });
});

describe("cost ledger", () => {
  it("attributes spend to a ticket and prices it correctly", async () => {
    const t = await build();
    const cost = await recordSpend({
      ticketId: t.id,
      agentRole: "engineer",
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    // 1M in at $2 + 100k out at $10/M = $2 + $1 = $3.
    expect(cost).toBeCloseTo(3, 6);
    expect(await ticketSpend(t.id)).toBeCloseTo(3, 6);
  });

  it("reports no margin percentage when there is no revenue", async () => {
    await recordSpend({
      ticketId: null, agentRole: "scout", model: "claude-haiku-4-5",
      inputTokens: 1_000_000, outputTokens: 0,
    });
    const margin = await marginToDate();
    expect(margin.modelCostUsd).toBeCloseTo(1, 6);
    expect(margin.grossMarginUsd).toBeCloseTo(-1, 6);
    expect(margin.grossMarginPct).toBeNull();
  });

  it("computes gross margin against recorded revenue", async () => {
    await getPool().query(
      `INSERT INTO revenue_ledger (stripe_event_id, customer_ref, kind, amount_usd)
       VALUES ('evt_1', 'cus_1', 'invoice.paid', 100)`,
    );
    await recordSpend({
      ticketId: null, agentRole: "support", model: "claude-haiku-4-5",
      inputTokens: 10_000_000, outputTokens: 0,
    });
    const margin = await marginToDate();
    expect(margin.revenueUsd).toBeCloseTo(100, 2);
    expect(margin.grossMarginUsd).toBeCloseTo(90, 2);
    expect(margin.grossMarginPct).toBeCloseTo(90, 1);
  });
});

describe("company controls", () => {
  it("halts every loop when paused", async () => {
    await setPaused(true, "operator testing the brake");
    const halt = await haltReason();
    expect(halt?.kind).toBe("paused");
    await setPaused(false);
    expect(await haltReason()).toBeUndefined();
  });

  it("halts when month-to-date spend reaches the cap", async () => {
    const { monthlyUsdCap } = await readControls();
    await getPool().query(
      `INSERT INTO cost_ledger (agent_role, model, cost_usd)
       VALUES ('ceo', 'claude-opus-5', $1)`,
      [monthlyUsdCap],
    );
    const halt = await haltReason();
    expect(halt?.kind).toBe("monthly_cap");
  });

  it("trips a role after three consecutive failures and resets on success", async () => {
    expect(await recordRoleFailure("engineer", "boom")).toBe(false);
    expect(await recordRoleFailure("engineer", "boom")).toBe(false);
    expect(await recordRoleFailure("engineer", "boom")).toBe(true);
    expect(await isRoleTripped("engineer")).toBe(true);
    await recordRoleSuccess("engineer");
    expect(await isRoleTripped("engineer")).toBe(false);
  });
});

describe("the idea funnel", () => {
  const idea = {
    title: "Invoice line-item extraction for freight brokers",
    hypothesis: "Brokers hand-key invoices; three on a forum built scrapers.",
    niche: "logistics",
    sourceKind: "forum",
    sourceRef: "https://example.com/thread/1",
    evidence: ["three manual workarounds described"],
    foundBy: "scout",
  };

  it("captures an idea and collapses a reworded duplicate", async () => {
    const first = await captureIdea(idea);
    expect(first.isNew).toBe(true);
    const again = await captureIdea({
      ...idea,
      title: "invoice line-item extraction freight brokers",
    });
    expect(again.isNew).toBe(false);
    expect(again.idea.id).toBe(first.idea.id);
  });

  it("refuses an idea with no source", async () => {
    await expect(captureIdea({ ...idea, sourceRef: "  " })).rejects.toThrow(
      /opinion/,
    );
  });

  it("shortlists a strong idea and lets it promote into a pm prd", async () => {
    const { idea: captured } = await captureIdea(idea);
    const { verdict } = await scoreIdea(captured.id, {
      selfServe: 5, machineShaped: 5, supportable: 4,
      costKnowable: 4, demandEvidenced: 4,
    });
    expect(verdict.shortlisted).toBe(true);

    const { ticket } = await promoteIdea(captured.id, "analyst");
    expect(ticket.type).toBe("prd");
    expect(ticket.ownerRole).toBe("pm");
    expect(ticket.createdBy).toBe("analyst");
    expect(ticket.body).toContain("https://example.com/thread/1");
    expect(ticket.acceptance.length).toBeGreaterThan(0);
  });

  it("refuses to promote an idea that was never shortlisted", async () => {
    const { idea: captured } = await captureIdea(idea);
    await expect(promoteIdea(captured.id, "analyst")).rejects.toThrow(
      /only shortlisted ideas/,
    );
  });

  it("refuses to promote a vetoed idea however high its total", async () => {
    const { idea: captured } = await captureIdea(idea);
    await scoreIdea(captured.id, {
      selfServe: 1, machineShaped: 5, supportable: 5,
      costKnowable: 5, demandEvidenced: 5,
    });
    await expect(promoteIdea(captured.id, "analyst")).rejects.toThrow(
      /only shortlisted ideas/,
    );
  });
});

describe("forecasting", () => {
  const assumptions = {
    pricePerCustomerMonthUsd: 49,
    serveCostPerCustomerMonthUsd: 6,
    reachableCustomers: 400,
    monthsToLaunch: 3,
    monthsToHalfCeiling: 9,
    buildBudgetUsd: 4000,
    monthlyOpexUsd: 600,
    monthlyChurn: 0.04,
    horizonMonths: 24,
  };

  const newIdea = async () =>
    (
      await captureIdea({
        title: `idea ${Math.random()}`,
        hypothesis: "h", niche: "n",
        sourceKind: "forum", sourceRef: "https://example.com/x",
        foundBy: "scout",
      })
    ).idea;

  it("stores a projection with its headline numbers", async () => {
    const i = await newIdea();
    const f = await recordForecast({
      ideaId: i.id, assumptions, confidence: 0.6,
      reasoning: "price from competitor page; cost measured",
      forecastBy: "forecaster",
    });
    expect(f.revision).toBe(1);
    expect(f.projection.base.ceilingMrrUsd).toBeGreaterThan(0);
    expect(f.projection.base.monthsToFirstDollar).toBe(3);
  });

  it("revises rather than overwrites, so an old forecast cannot be rewritten", async () => {
    const i = await newIdea();
    const first = await recordForecast({
      ideaId: i.id, assumptions, confidence: 0.6,
      reasoning: "v1", forecastBy: "forecaster",
    });
    const second = await recordForecast({
      ideaId: i.id,
      assumptions: { ...assumptions, reachableCustomers: 50 },
      confidence: 0.3, reasoning: "v2 after evidence", forecastBy: "forecaster",
    });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(second.projection.base.ceilingMrrUsd).toBeLessThan(
      first.projection.base.ceilingMrrUsd,
    );
  });

  it("refuses a confidence outside 0-1", async () => {
    const i = await newIdea();
    await expect(
      recordForecast({
        ideaId: i.id, assumptions, confidence: 1.5,
        reasoning: "x", forecastBy: "forecaster",
      }),
    ).rejects.toThrow(/graded against outcomes/);
  });

  it("refuses to forecast growth on an inverted unit economic", async () => {
    const i = await newIdea();
    await expect(
      recordForecast({
        ideaId: i.id,
        assumptions: { ...assumptions, serveCostPerCustomerMonthUsd: 60 },
        confidence: 0.5, reasoning: "x", forecastBy: "forecaster",
      }),
    ).rejects.toThrow(/loses money on every customer/);
  });

  it("grades a forecast against actuals", async () => {
    const i = await newIdea();
    const f = await recordForecast({
      ideaId: i.id, assumptions, confidence: 0.8,
      reasoning: "optimistic", forecastBy: "forecaster",
    });
    const predicted = f.projection.base.months[12]!.mrrUsd;
    await recordActual({
      forecastId: f.id, monthIndex: 12,
      actualMrrUsd: predicted / 2, actualCostUsd: 600,
    });
    const { rows } = await getPool().query(
      "SELECT mean_abs_mrr_error_usd FROM forecast_calibration WHERE forecast_id = $1",
      [f.id],
    );
    expect(Number(rows[0].mean_abs_mrr_error_usd)).toBeCloseTo(predicted / 2, 0);
  });
});
