#!/usr/bin/env node
import { migrate } from "../db/migrate.js";
import { closePool } from "../db/pool.js";
import { readControls, setPaused } from "../guardrails/controls.js";
import { listIdeas, shortlist, staleRubricIdeas } from "../ideas/store.js";
import { RUBRIC_VERSION } from "../ideas/scoring.js";
import { latestForecast } from "../forecast/store.js";
import { marginToDate, monthToDateSpend, spendByRole } from "../ledger/ledger.js";
import { ALL_ROLES, getRole } from "../roles/registry.js";
import { runPass } from "../runner/supervisor.js";
import { runScoutSweep } from "../runner/scout.js";
import { workOnce } from "../runner/worker.js";
import {
  approveByHuman, insertTicket, listTickets, transitionTicket,
} from "../tickets/store.js";
import type { Loop } from "../roles/types.js";
import type { TicketState, TicketType } from "../tickets/types.js";

const usd = (n: number): string => `$${n.toFixed(2)}`;

const USAGE = `agentcorp -- a multi-agent company runtime

  migrate                        Apply database migrations
  roles                          List every role, its loop, model, and budget
  status                         Controls, month-to-date spend, and margin
  tickets [state]                List tickets
  file <type> <role> <title>     File a ticket as the human operator
  move <ticket-id> <state>       Move a ticket (proposed -> approved queues it)
  approve <ticket-id>            Grant human approval to a gated ticket
  pause <reason> | resume        Halt or restart every loop
  work <role>                    Run one turn for one role
  pass [strategy|build|revenue]  Run one supervisor pass
  scout "<brief>"                Run a scout sweep via the Claude Code CLI
  ideas [state]                  List ideas, best first
  shortlist                      Ideas that cleared the rubric
  forecast <idea-id>             Show the growth projection for an idea
  spend                          Month-to-date model spend by role
`;

const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;

  switch (command) {
    case "migrate": {
      const applied = await migrate();
      console.log(
        applied.length > 0
          ? `applied: ${applied.join(", ")}`
          : "schema already up to date",
      );
      return 0;
    }

    case "roles": {
      for (const role of ALL_ROLES) {
        console.log(
          `${role.name.padEnd(12)} ${role.loop.padEnd(9)} ${role.harness.padEnd(5)} ` +
            `${role.model.padEnd(18)} effort=${role.effort.padEnd(6)} ` +
            `budget=${usd(role.defaultBudgetUsd).padEnd(7)} x${role.concurrency}` +
            (role.hasVeto === true ? "  [VETO]" : ""),
        );
      }
      console.log(`\n${ALL_ROLES.length} roles`);
      return 0;
    }

    case "status": {
      const [controls, spent, margin] = await Promise.all([
        readControls(),
        monthToDateSpend(),
        marginToDate(),
      ]);
      console.log(`paused:        ${controls.paused}${controls.pauseReason !== null ? ` (${controls.pauseReason})` : ""}`);
      console.log(`monthly cap:   ${usd(controls.monthlyUsdCap)}`);
      console.log(`spent MTD:     ${usd(spent)} (${((spent / controls.monthlyUsdCap) * 100).toFixed(1)}% of cap)`);
      console.log(`revenue MTD:   ${usd(margin.revenueUsd)}`);
      console.log(
        `gross margin:  ${usd(margin.grossMarginUsd)}` +
          (margin.grossMarginPct === null
            ? "  (no revenue yet)"
            : ` (${margin.grossMarginPct.toFixed(1)}%)`),
      );
      return 0;
    }

    case "tickets": {
      const tickets = await listTickets(
        rest[0] !== undefined
          ? { state: rest[0] as never, limit: 40 }
          : { limit: 40 },
      );
      if (tickets.length === 0) {
        console.log("no tickets");
        return 0;
      }
      for (const t of tickets) {
        console.log(
          `#${String(t.id).padEnd(5)} ${t.state.padEnd(12)} ${t.type.padEnd(9)} ` +
            `${t.ownerRole.padEnd(11)} ${usd(t.budgetUsd).padEnd(7)} ` +
            `${t.requiresHuman && !t.humanApproved ? "[needs human] " : ""}${t.title}`,
        );
      }
      return 0;
    }

    case "file": {
      const [type, role, ...titleParts] = rest;
      if (type === undefined || role === undefined || titleParts.length === 0) {
        console.error("usage: file <type> <owner-role> <title>");
        return 1;
      }
      getRole(role);
      const ticket = await insertTicket({
        type: type as TicketType,
        title: titleParts.join(" "),
        body: "Filed by the human operator from the CLI.",
        ownerRole: role,
        createdBy: "human",
      });
      console.log(`filed #${ticket.id} -> ${role} (${usd(ticket.budgetUsd)})`);
      console.log(
        `it is "proposed" and not yet claimable; queue it with:\n` +
          `  agentcorp move ${ticket.id} approved`,
      );
      return 0;
    }

    case "move": {
      const id = Number(rest[0]);
      const to = rest[1];
      if (!Number.isInteger(id) || to === undefined) {
        console.error("usage: move <ticket-id> <state>");
        return 1;
      }
      const ticket = await transitionTicket(id, to as TicketState, "human", {
        note: "moved by the human operator from the CLI",
      });
      console.log(`#${ticket.id} -> ${ticket.state}`);
      if (ticket.state === "approved") {
        console.log(`claimable now by ${ticket.ownerRole}: agentcorp work ${ticket.ownerRole}`);
      }
      return 0;
    }

    case "approve": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) {
        console.error("usage: approve <ticket-id>");
        return 1;
      }
      const ticket = await approveByHuman(id);
      console.log(`#${ticket.id} human-approved`);
      return 0;
    }

    case "pause": {
      const reason = rest.join(" ");
      if (reason === "") {
        console.error("usage: pause <reason>");
        return 1;
      }
      await setPaused(true, reason);
      console.log(`company paused: ${reason}`);
      return 0;
    }

    case "resume": {
      await setPaused(false);
      console.log("company resumed");
      return 0;
    }

    case "work": {
      const role = rest[0];
      if (role === undefined) {
        console.error("usage: work <role>");
        return 1;
      }
      const outcome = await workOnce(role);
      console.log(JSON.stringify(outcome, null, 2));
      return outcome.kind === "failed" ? 1 : 0;
    }

    case "pass": {
      const report = await runPass(rest[0] as Loop | undefined);
      if (report.halted !== undefined) {
        console.log(`HALTED: ${report.halted}`);
        return 0;
      }
      console.log(`reaped ${report.reapedLeases} expired lease(s)`);
      for (const { role, outcome } of report.outcomes) {
        if (outcome.kind === "idle") continue;
        console.log(`${role.padEnd(12)} ${outcome.kind}` +
          (outcome.kind === "worked" ? ` #${outcome.ticketId} ${usd(outcome.costUsd)}` : "") +
          (outcome.kind === "failed" ? ` #${outcome.ticketId} ${outcome.error}` : ""));
      }
      console.log(`pass cost: ${usd(report.totalCostUsd)}`);
      return 0;
    }

    case "scout": {
      const brief = rest.join(" ");
      if (brief === "") {
        console.error('usage: scout "<what to sweep for>"');
        return 1;
      }
      console.log("running scout via the Claude Code CLI harness (no API key needed)...\n");
      const r = await runScoutSweep(brief);
      console.log(r.rows.join("\n"));
      if (r.skipped.length > 0) {
        console.log(`\nskipped ${r.skipped.length}:`);
        for (const s of r.skipped) console.log(`  - ${s}`);
      }
      console.log(
        `\ncaptured ${r.captured} | new ${r.fresh} | shortlisted ${r.shortlisted} ` +
          `| vetoed ${r.rejected} | cost ${usd(r.costUsd)}`,
      );
      return 0;
    }

    case "ideas": {
      const ideas = await listIdeas(
        rest[0] !== undefined
          ? { state: rest[0] as never, limit: 30 }
          : { limit: 30 },
      );
      if (ideas.length === 0) {
        console.log("no ideas yet -- run: agentcorp work scout");
        return 0;
      }
      for (const i of ideas) {
        console.log(
          `#${String(i.id).padEnd(5)} ${i.state.padEnd(12)} ` +
            // A stale score prints as "--" rather than its old number. Showing
            // the v1 total next to v2 totals invites comparing them, which is
            // the whole mistake: it was produced by a rubric that could not ask
            // what being wrong costs.
            `${(i.needsRescore ? "--" : i.totalScore?.toFixed(1) ?? "--").padStart(5)}  ` +
            `${i.niche.padEnd(22)} ${i.title}` +
            (i.needsRescore ? `  [rubric v${i.rubricVersion}, needs re-score]` : ""),
        );
      }
      const stale = await staleRubricIdeas();
      if (stale.length > 0) {
        console.log(
          `\n${stale.length} idea(s) scored under an older rubric ` +
            `(current is v${RUBRIC_VERSION}) and cannot be promoted until ` +
            `re-scored -- run: agentcorp work scout`,
        );
      }
      return 0;
    }

    case "shortlist": {
      const ideas = await shortlist();
      if (ideas.length === 0) {
        console.log("nothing shortlisted");
        return 0;
      }
      for (const i of ideas) {
        console.log(`#${i.id} [${i.totalScore?.toFixed(1)}] ${i.title}`);
        console.log(`      ${i.hypothesis}`);
        console.log(`      source: ${i.sourceKind} ${i.sourceRef}`);
      }
      return 0;
    }

    case "forecast": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) {
        console.error("usage: forecast <idea-id>");
        return 1;
      }
      const found = await latestForecast(id);
      if (found === undefined) {
        console.log(`no forecast for idea ${id} -- run: agentcorp work forecaster`);
        return 0;
      }
      const { projection } = found;
      console.log(`forecast r${found.revision} by ${found.forecastBy}, confidence ${found.confidence}`);
      console.log(`\n${projection.headline}\n`);
      for (const s of [projection.low, projection.base, projection.high]) {
        console.log(
          `${s.name.padEnd(5)} ceiling ${usd(s.ceilingMrrUsd).padStart(12)} MRR   ` +
            `first $ month ${String(s.monthsToFirstDollar ?? "--").padStart(3)}   ` +
            `break-even month ${String(s.monthsToBreakEven ?? "never").padStart(5)}   ` +
            `funding ${usd(s.budgetToBreakEvenUsd).padStart(11)}`,
        );
      }
      console.log(`\nreasoning: ${found.reasoning}`);
      return 0;
    }

    case "spend": {
      const rows = await spendByRole();
      if (rows.length === 0) {
        console.log("no spend recorded this month");
        return 0;
      }
      for (const r of rows) {
        console.log(`${r.agentRole.padEnd(12)} ${usd(r.costUsd).padStart(9)}  ${r.calls} calls`);
      }
      return 0;
    }

    default:
      console.log(USAGE);
      return command === undefined || command === "help" ? 0 : 1;
  }
};

const code = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  return 1;
});
await closePool();
process.exit(code);
