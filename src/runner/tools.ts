import type Anthropic from "@anthropic-ai/sdk";
import { assertAuthorship } from "../guardrails/authorship.js";
import { assertDepth } from "../guardrails/depth.js";
import { setPaused } from "../guardrails/controls.js";
import { recordForecast, latestForecast, calibration } from "../forecast/store.js";
import { captureIdea, listIdeas, scoreIdea, promoteIdea } from "../ideas/store.js";
import { marginToDate, spendByRole } from "../ledger/ledger.js";
import { getRole, mayFile } from "../roles/registry.js";
import {
  addArtifact, getTicket, insertTicket, listTickets, transitionTicket,
} from "../tickets/store.js";
import { getPool } from "../db/pool.js";
import { listRepo, readRepoFile } from "./repo.js";
import type { TicketState, TicketType } from "../tickets/types.js";

/**
 * The company toolset.
 *
 * Every tool is permission-checked against the calling role's declared remit at
 * call time, not just filtered out of the schema. A role that talks its way
 * into asking for a tool it was not given still cannot use it.
 */

export interface ToolContext {
  readonly role: string;
  readonly ticketId: number | null;
  readonly workerId: string;
}

type Handler = (
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

interface CompanyTool {
  readonly definition: Anthropic.Tool;
  readonly handler: Handler;
}

const str = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
  return value;
};

const int = (input: Record<string, unknown>, key: string): number => {
  const value = Number(input[key]);
  if (!Number.isInteger(value)) {
    throw new Error(`"${key}" is required and must be an integer`);
  }
  return value;
};

const TOOLS: Record<string, CompanyTool> = {
  list_tickets: {
    definition: {
      name: "list_tickets",
      description:
        "List tickets, newest first. Use this to see the backlog before filing anything new.",
      input_schema: {
        type: "object",
        properties: {
          state: { type: "string", description: "Optional state filter." },
          owner_role: { type: "string", description: "Optional role filter." },
          limit: { type: "integer", description: "Max rows, default 20." },
        },
        additionalProperties: false,
      },
    },
    handler: async (input) =>
      listTickets({
        ...(typeof input["state"] === "string"
          ? { state: input["state"] as TicketState }
          : {}),
        ...(typeof input["owner_role"] === "string"
          ? { ownerRole: input["owner_role"] }
          : {}),
        limit: Number(input["limit"] ?? 20),
      }),
  },

  read_ticket: {
    definition: {
      name: "read_ticket",
      description: "Read one ticket in full, including acceptance criteria and artifacts.",
      input_schema: {
        type: "object",
        properties: { ticket_id: { type: "integer" } },
        required: ["ticket_id"],
        additionalProperties: false,
      },
    },
    handler: async (input) => {
      const ticket = await getTicket(int(input, "ticket_id"));
      if (ticket === undefined) throw new Error("ticket not found");
      return ticket;
    },
  },

  file_ticket: {
    definition: {
      name: "file_ticket",
      description:
        "File a ticket against ANOTHER role. You may not file work you own yourself " +
        "-- that is enforced and will fail. Acceptance criteria should be machine-checkable.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          owner_role: { type: "string" },
          parent_id: { type: "integer" },
          budget_usd: { type: "number" },
          requires_human: { type: "boolean" },
          acceptance: {
            type: "array",
            items: {
              type: "object",
              properties: {
                statement: { type: "string" },
                check: { type: "string" },
              },
              required: ["statement"],
              additionalProperties: false,
            },
          },
        },
        required: ["type", "title", "body", "owner_role"],
        additionalProperties: false,
      },
    },
    handler: async (input, ctx) => {
      const type = str(input, "type") as TicketType;
      if (!mayFile(ctx.role, type)) {
        throw new Error(
          `role "${ctx.role}" may not file tickets of type "${type}"; ` +
            `permitted: ${getRole(ctx.role).mayFile.join(", ") || "none"}`,
        );
      }
      const parentId =
        input["parent_id"] === undefined ? null : int(input, "parent_id");
      if (parentId !== null) {
        const parent = await getTicket(parentId);
        if (parent === undefined) throw new Error("parent ticket not found");
        assertDepth(parent.depth);
      }

      const acceptance = Array.isArray(input["acceptance"])
        ? (input["acceptance"] as { statement: string; check?: string }[]).map(
            (c) => ({ ...c, verified: false }),
          )
        : [];

      const draft = {
        type,
        title: str(input, "title"),
        body: str(input, "body"),
        ownerRole: str(input, "owner_role"),
        createdBy: ctx.role,
        parentId,
        acceptance,
        ...(input["budget_usd"] !== undefined
          ? { budgetUsd: Number(input["budget_usd"]) }
          : { budgetUsd: getRole(ctx.role).defaultBudgetUsd }),
        requiresHuman: input["requires_human"] === true,
      };
      assertAuthorship(draft);
      return await insertTicket(draft);
    },
  },

  transition_ticket: {
    definition: {
      name: "transition_ticket",
      description:
        "Move a ticket to a new state. Illegal transitions fail; escalate instead of retrying. " +
        "Closing a ticket that requires human approval will fail until a human approves it.",
      input_schema: {
        type: "object",
        properties: {
          ticket_id: { type: "integer" },
          to: { type: "string" },
          note: { type: "string", description: "Why. Recorded in the audit log." },
        },
        required: ["ticket_id", "to"],
        additionalProperties: false,
      },
    },
    handler: async (input, ctx) =>
      transitionTicket(
        int(input, "ticket_id"),
        str(input, "to") as TicketState,
        ctx.role,
        { note: input["note"] ?? "" },
      ),
  },

  add_artifact: {
    definition: {
      name: "add_artifact",
      description: "Attach a PR url, file path, or document id to a ticket as evidence of work.",
      input_schema: {
        type: "object",
        properties: {
          ticket_id: { type: "integer" },
          artifact: { type: "string" },
        },
        required: ["ticket_id", "artifact"],
        additionalProperties: false,
      },
    },
    handler: async (input, ctx) => {
      await addArtifact(int(input, "ticket_id"), str(input, "artifact"), ctx.role);
      return { ok: true };
    },
  },

  read_repo: {
    definition: {
      name: "read_repo",
      description:
        "Read the company's own repository, read-only and sandboxed. Omit `path` or " +
        "pass a directory to list it; pass a file to read it. Use this before making " +
        "a design decision or claiming a capability publicly -- do not assume what " +
        "shipped.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repo-relative path. Defaults to the repo root.",
          },
        },
        additionalProperties: false,
      },
    },
    handler: async (input) => {
      const path = typeof input["path"] === "string" ? input["path"] : ".";
      // A directory listing and a file read are the same intent from the
      // agent's side ("show me this"), so dispatch on what the path is rather
      // than making the model pick the right tool and fail half the time.
      const entries = await listRepo(path).catch(() => undefined);
      if (entries !== undefined) return { kind: "dir", path, entries };
      return { kind: "file", ...(await readRepoFile(path)) };
    },
  },

  capture_idea: {
    definition: {
      name: "capture_idea",
      description:
        "Record a product idea you found. A real source_ref is required -- an idea with " +
        "no source cannot be scored. Duplicates are collapsed automatically and cost nothing.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Specific, not a category." },
          hypothesis: { type: "string", description: "Who pays, for what, and why now." },
          niche: { type: "string" },
          source_kind: {
            type: "string",
            description: "support_ticket | churn | forum | review | competitor | usage",
          },
          source_ref: { type: "string", description: "URL, ticket id, or quoted complaint." },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["title", "hypothesis", "niche", "source_kind", "source_ref"],
        additionalProperties: false,
      },
    },
    handler: async (input, ctx) =>
      captureIdea({
        title: str(input, "title"),
        hypothesis: str(input, "hypothesis"),
        niche: str(input, "niche"),
        sourceKind: str(input, "source_kind"),
        sourceRef: str(input, "source_ref"),
        evidence: Array.isArray(input["evidence"])
          ? (input["evidence"] as string[])
          : [],
        foundBy: ctx.role,
      }),
  },

  score_idea: {
    definition: {
      name: "score_idea",
      description:
        "Score an idea 0-5 on each rubric dimension. Any dimension at or below 1 vetoes " +
        "the idea outright. Score harshly: you are measured on survival rate, not volume.",
      input_schema: {
        type: "object",
        properties: {
          idea_id: { type: "integer" },
          selfServe: { type: "integer", description: "Can a stranger pay with no human involved?" },
          machineShaped: { type: "integer", description: "Data in, data out, no GUI needed?" },
          supportable: { type: "integer", description: "Can docs answer most tickets?" },
          costKnowable: { type: "integer", description: "Is cost per request calculable?" },
          demandEvidenced: { type: "integer", description: "Does someone already pay to solve this?" },
        },
        required: [
          "idea_id", "selfServe", "machineShaped",
          "supportable", "costKnowable", "demandEvidenced",
        ],
        additionalProperties: false,
      },
    },
    handler: async (input) =>
      scoreIdea(int(input, "idea_id"), {
        selfServe: int(input, "selfServe"),
        machineShaped: int(input, "machineShaped"),
        supportable: int(input, "supportable"),
        costKnowable: int(input, "costKnowable"),
        demandEvidenced: int(input, "demandEvidenced"),
      }),
  },

  list_ideas: {
    definition: {
      name: "list_ideas",
      description: "List ideas, highest score first. Filter by state to see the shortlist.",
      input_schema: {
        type: "object",
        properties: {
          state: { type: "string" },
          limit: { type: "integer" },
        },
        additionalProperties: false,
      },
    },
    handler: async (input) =>
      listIdeas({
        ...(typeof input["state"] === "string"
          ? { state: input["state"] as "shortlisted" }
          : {}),
        limit: Number(input["limit"] ?? 20),
      }),
  },

  read_idea: {
    definition: {
      name: "read_idea",
      description: "Read one idea with its scores and evidence.",
      input_schema: {
        type: "object",
        properties: { idea_id: { type: "integer" } },
        required: ["idea_id"],
        additionalProperties: false,
      },
    },
    handler: async (input) => {
      const ideas = await listIdeas({ limit: 500 });
      const found = ideas.find((i) => i.id === int(input, "idea_id"));
      if (found === undefined) throw new Error("idea not found");
      return found;
    },
  },

  promote_idea: {
    definition: {
      name: "promote_idea",
      description:
        "Promote a SHORTLISTED idea into a prd ticket owned by pm. Only shortlisted " +
        "ideas may be promoted.",
      input_schema: {
        type: "object",
        properties: { idea_id: { type: "integer" } },
        required: ["idea_id"],
        additionalProperties: false,
      },
    },
    handler: async (input, ctx) => promoteIdea(int(input, "idea_id"), ctx.role),
  },

  record_forecast: {
    definition: {
      name: "record_forecast",
      description:
        "Compute and store a growth projection for an idea from explicit assumptions. " +
        "Returns low/base/high scenarios, break-even month, and the funding needed to " +
        "get there. Refuses if serve cost is at or above price.",
      input_schema: {
        type: "object",
        properties: {
          idea_id: { type: "integer" },
          price_per_customer_month_usd: { type: "number" },
          serve_cost_per_customer_month_usd: { type: "number" },
          reachable_customers: { type: "integer" },
          months_to_launch: { type: "integer" },
          months_to_half_ceiling: { type: "number" },
          build_budget_usd: { type: "number" },
          monthly_opex_usd: { type: "number" },
          monthly_churn: { type: "number", description: "0-1" },
          horizon_months: { type: "integer", description: "1-120, typically 24." },
          confidence: { type: "number", description: "0-1. Graded against actuals." },
          reasoning: {
            type: "string",
            description: "Provenance for each assumption. Label invented numbers as invented.",
          },
        },
        required: [
          "idea_id", "price_per_customer_month_usd",
          "serve_cost_per_customer_month_usd", "reachable_customers",
          "months_to_launch", "months_to_half_ceiling", "build_budget_usd",
          "monthly_opex_usd", "monthly_churn", "horizon_months",
          "confidence", "reasoning",
        ],
        additionalProperties: false,
      },
    },
    handler: async (input, ctx) =>
      recordForecast({
        ideaId: int(input, "idea_id"),
        assumptions: {
          pricePerCustomerMonthUsd: Number(input["price_per_customer_month_usd"]),
          serveCostPerCustomerMonthUsd: Number(
            input["serve_cost_per_customer_month_usd"],
          ),
          reachableCustomers: int(input, "reachable_customers"),
          monthsToLaunch: int(input, "months_to_launch"),
          monthsToHalfCeiling: Number(input["months_to_half_ceiling"]),
          buildBudgetUsd: Number(input["build_budget_usd"]),
          monthlyOpexUsd: Number(input["monthly_opex_usd"]),
          monthlyChurn: Number(input["monthly_churn"]),
          horizonMonths: int(input, "horizon_months"),
        },
        confidence: Number(input["confidence"]),
        reasoning: str(input, "reasoning"),
        forecastBy: ctx.role,
      }),
  },

  read_forecast: {
    definition: {
      name: "read_forecast",
      description: "Read the latest growth projection for an idea.",
      input_schema: {
        type: "object",
        properties: { idea_id: { type: "integer" } },
        required: ["idea_id"],
        additionalProperties: false,
      },
    },
    handler: async (input) => {
      const found = await latestForecast(int(input, "idea_id"));
      if (found === undefined) throw new Error("no forecast for that idea yet");
      return found;
    },
  },

  read_calibration: {
    definition: {
      name: "read_calibration",
      description:
        "How wrong past forecasts turned out to be, by forecaster. Read this before " +
        "trusting a projection to allocate budget.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => calibration(),
  },

  read_margin: {
    definition: {
      name: "read_margin",
      description: "Month-to-date revenue, model cost, and gross margin in USD.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => marginToDate(),
  },

  spend_by_role: {
    definition: {
      name: "spend_by_role",
      description: "Month-to-date model spend broken down by agent role.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => spendByRole(),
  },

  query_usage: {
    definition: {
      name: "query_usage",
      description: "Aggregate product usage per customer for the current month.",
      input_schema: {
        type: "object",
        properties: { limit: { type: "integer" } },
        additionalProperties: false,
      },
    },
    handler: async (input) => {
      const { rows } = await getPool().query(
        `SELECT customer_ref, SUM(units)::int AS units, SUM(cost_usd) AS cost_usd
           FROM usage_events
          WHERE at >= date_trunc('month', now())
          GROUP BY customer_ref
          ORDER BY units DESC
          LIMIT $1`,
        [Number(input["limit"] ?? 50)],
      );
      return rows;
    },
  },

  read_wiki: {
    definition: {
      name: "read_wiki",
      description:
        "Read the company wiki -- ADRs, runbooks, postmortems, decisions. Read this " +
        "before acting; it is the memory that survives between turns.",
      input_schema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          kind: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    handler: async (input) => {
      const { rows } = await getPool().query(
        `SELECT slug, kind, title, body, author, updated_at
           FROM wiki_entries
          WHERE ($1::text IS NULL OR slug = $1)
            AND ($2::text IS NULL OR kind = $2)
          ORDER BY updated_at DESC LIMIT 25`,
        [input["slug"] ?? null, input["kind"] ?? null],
      );
      return rows;
    },
  },

  write_wiki: {
    definition: {
      name: "write_wiki",
      description:
        "Write or update a wiki entry. Use kind 'adr' for decisions (include the " +
        "rejected alternative), 'runbook', 'postmortem', or 'note'.",
      input_schema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          kind: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["slug", "kind", "title", "body"],
        additionalProperties: false,
      },
    },
    handler: async (input, ctx) => {
      await getPool().query(
        `INSERT INTO wiki_entries (slug, kind, title, body, author, ticket_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO UPDATE
           SET kind = $2, title = $3, body = $4, author = $5, updated_at = now()`,
        [
          str(input, "slug"), str(input, "kind"), str(input, "title"),
          str(input, "body"), ctx.role, ctx.ticketId,
        ],
      );
      return { ok: true };
    },
  },

  pause_company: {
    definition: {
      name: "pause_company",
      description:
        "Halt every loop. Available to finance only, for when spend exceeds return. " +
        "This does not raise the monthly cap -- nothing can.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
        additionalProperties: false,
      },
    },
    handler: async (input, ctx) => {
      await setPaused(true, `${ctx.role}: ${str(input, "reason")}`);
      return { paused: true };
    },
  },
};

export class ToolNotPermittedError extends Error {
  constructor(role: string, tool: string) {
    super(
      `role "${role}" is not permitted to call "${tool}"; ` +
        `its toolset is ${getRole(role).tools.join(", ")}`,
    );
    this.name = "ToolNotPermittedError";
  }
}

/** Tool schemas for a role, in the order the role declared them. */
export const toolsForRole = (roleName: string): Anthropic.Tool[] =>
  getRole(roleName)
    .tools.map((name) => TOOLS[name]?.definition)
    .filter((d): d is Anthropic.Tool => d !== undefined);

/**
 * Executes a tool call. Re-checks permission here rather than trusting that the
 * schema filter was the only gate.
 */
export const callTool = async (
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> => {
  if (!getRole(ctx.role).tools.includes(name)) {
    throw new ToolNotPermittedError(ctx.role, name);
  }
  const tool = TOOLS[name];
  if (tool === undefined) throw new Error(`no such tool "${name}"`);
  return await tool.handler(input, ctx);
};

export const TOOL_NAMES = Object.keys(TOOLS);
