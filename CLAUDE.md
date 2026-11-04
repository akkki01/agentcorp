# AgentCorp — notes for Claude Code

## What this project is

A multi-agent runtime for operating a SaaS company: typed tickets, budgeted
agent turns, a cost ledger, an idea funnel, and growth forecasting. TypeScript,
ESM, Postgres 17, Vitest.

## Before changing anything

```bash
pnpm typecheck && pnpm test
```

136 tests. Pure-logic tests run without a database; 30 integration tests skip if
Postgres is not reachable. Bring it up with `pnpm db:up && pnpm db:migrate`.

## Invariants — do not break these

- **`src/guardrails/` must stay free of I/O.** Pure functions, own error types.
- **`priceUsage` throws on an unknown model.** Never return 0 for unpriced spend.
- **Tool permissions are re-checked in `callTool`.** The schema filter is not a
  security boundary; a model can emit a call for a tool it was never given.
- **The monthly cap is not raisable from inside the system.** No tool, no role,
  no config path.
- **Human gates are not bypassable**: production deploys, first-time outbound,
  terms, pricing.
- **`src/runner/repo.ts` is read-only and sandboxed.** Resolve-then-compare
  against the repo root; never string-match for `..`.
- **`assertScores` requires every rubric dimension and defaults none.** A
  missing `errorTolerance` or `marketGap` is a failed tool call, not a 0 and not
  a 5. Scores from a retired rubric are refused (`StaleRubricError`), never
  topped up — that silent default is the bug rubric v2 exists to fix.
- **`errorTolerance` and `marketGap` are veto-capable, not just heavy.** A high
  total must not be able to outvote them. See `src/ideas/scoring.ts`.

## Model-specific gotchas already handled — do not "simplify" these away

- Opus 5 / Sonnet 5 use `thinking: {type: "adaptive"}`. **Haiku 4.5 uses
  `budget_tokens`.** Unifying them causes a 400.
- `web_search` has two tool types; the `_20260209` variant is not available on
  Haiku 4.5, so `scout` gets `web_search_20250305`.
- Refusals are **HTTP 200** with `stop_reason: "refusal"`. Check `stop_reason`
  before reading `content`.
- Role charters carry the `cache_control` breakpoint; ticket state goes in the
  user message. Moving ticket state into the system prompt destroys cache hits.
- Enum parameters in SQL need explicit casts (`$2::ticket_state`) when the same
  parameter is both assigned and compared — otherwise Postgres errors with
  "inconsistent types deduced".

## Layout

```
src/
  config.ts        frozen env config
  db/              pool, migrations
  tickets/         types, state machine (pure), store, leases
  ideas/           scoring rubric (pure), store
  forecast/        projection maths (pure), store + calibration
  ledger/          pricing table (pure), cost/revenue/margin
  guardrails/      authorship, depth, budget, controls — all pure or thin
  roles/           14 role definitions + self-validating registry
  runner/          supervisor, worker, harness, tools, repo sandbox
  billing/         metering, Stripe webhooks
  cli/main.ts      operator CLI
```

## Conventions

- ESM with `.js` extensions in relative imports (required by `verbatimModuleSyntax`).
- `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — use
  conditional spreads for optional properties, not `undefined` assignment.
- Named error classes with actionable messages that say what to do instead.
- Files under ~400 lines; split by domain, not by type.
- Comments explain *why*, especially where a simpler-looking approach is wrong.
