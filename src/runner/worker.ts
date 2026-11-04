import { randomUUID } from "node:crypto";
import { publish } from "../events/bus.js";
import {
  haltReason, isRoleTripped, recordRoleFailure, recordRoleSuccess,
} from "../guardrails/controls.js";
import { ticketSpend } from "../ledger/ledger.js";
import { getRole } from "../roles/registry.js";
import { claimNextTicket, releaseTicket, renewLease } from "../tickets/lease.js";
import { recordEvent, transitionTicket } from "../tickets/store.js";
import { getPool } from "../db/pool.js";
import { runTurn } from "./harness.js";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt.js";

export type WorkOutcome =
  | { readonly kind: "halted"; readonly reason: string }
  | { readonly kind: "tripped" }
  | { readonly kind: "idle" }
  | { readonly kind: "worked"; readonly ticketId: number; readonly costUsd: number }
  | { readonly kind: "failed"; readonly ticketId: number; readonly error: string };

/**
 * Claims one ticket for `roleName` and runs a single agent turn against it.
 *
 * Returns rather than loops, so the caller owns the cadence and a supervisor can
 * interleave roles fairly instead of letting one role starve the others.
 */
export const workOnce = async (
  roleName: string,
  workerId = `${roleName}-${randomUUID().slice(0, 8)}`,
): Promise<WorkOutcome> => {
  // Checked before every turn, so flipping the pause flag stops the company
  // within one turn rather than at the end of a cycle.
  const halt = await haltReason();
  if (halt !== undefined) {
    return {
      kind: "halted",
      reason:
        halt.kind === "paused"
          ? halt.detail
          : `month-to-date spend $${halt.spentUsd.toFixed(2)} has reached the ` +
            `$${halt.capUsd.toFixed(2)} cap`,
    };
  }

  if (await isRoleTripped(roleName)) return { kind: "tripped" };

  const role = getRole(roleName);
  const ticket = await claimNextTicket(roleName, workerId);
  if (ticket === undefined) return { kind: "idle" };

  const spentBefore = await ticketSpend(ticket.id);
  const remaining = ticket.budgetUsd - spentBefore;

  if (remaining <= 0) {
    await transitionTicket(ticket.id, "blocked", "supervisor", {
      reason: "budget exhausted before turn started",
    });
    return { kind: "worked", ticketId: ticket.id, costUsd: 0 };
  }

  const heartbeat = setInterval(() => {
    void renewLease(ticket.id, workerId);
  }, 60_000);

  try {
    const result = await runTurn({
      role,
      systemPrompt: buildSystemPrompt(role),
      turnPrompt: buildTurnPrompt(ticket, spentBefore),
      ctx: { role: roleName, ticketId: ticket.id, workerId },
      remainingBudgetUsd: remaining,
    });

    await recordEvent(getPool(), ticket.id, roleName, "turn:complete", {
      costUsd: result.costUsd,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      hitIterationCap: result.hitIterationCap,
      summary: result.text.slice(0, 4000),
    });

    if (result.refusal !== undefined) {
      await transitionTicket(ticket.id, "blocked", roleName, {
        reason:
          `model declined the request ` +
          `(${result.refusal.category ?? "uncategorised"})` +
          `${result.refusal.explanation !== null ? `: ${result.refusal.explanation}` : ""}`,
      });
      await recordRoleSuccess(roleName);
      return { kind: "worked", ticketId: ticket.id, costUsd: result.costUsd };
    }

    // An agent that burned its whole turn without moving the ticket has not
    // done the work; blocking it surfaces that instead of silently re-queueing.
    const after = await claimedStateOf(ticket.id);
    if (after === "in_progress") {
      await transitionTicket(ticket.id, "blocked", "supervisor", {
        reason: result.hitIterationCap
          ? "agent hit the iteration cap without resolving the ticket"
          : "agent ended its turn without transitioning the ticket",
      });
    }

    await recordRoleSuccess(roleName);
    await publish({
      kind: "ticket:worked",
      ticketId: ticket.id,
      role: roleName,
      detail: { costUsd: result.costUsd },
    });
    return { kind: "worked", ticketId: ticket.id, costUsd: result.costUsd };
  } catch (error) {
    const message = (error as Error).message;
    await releaseTicket(ticket.id, workerId);
    await recordEvent(getPool(), ticket.id, roleName, "turn:failed", {
      error: message,
    });
    const tripped = await recordRoleFailure(roleName, message);
    if (tripped) {
      await publish({ kind: "role:tripped", role: roleName });
    }
    return { kind: "failed", ticketId: ticket.id, error: message };
  } finally {
    clearInterval(heartbeat);
  }
};

const claimedStateOf = async (ticketId: number): Promise<string | undefined> => {
  const { rows } = await getPool().query<{ state: string }>(
    "SELECT state FROM tickets WHERE id = $1",
    [ticketId],
  );
  return rows[0]?.state;
};
