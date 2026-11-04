# Contributing

## The highest-value contribution

**Wire the code harness.** `engineer`, `qa`, and `sre` currently refuse to run:
they need filesystem and shell access, which the Messages API loop in
`src/runner/harness.ts` does not provide. The intended adapter is the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) — a separate
product from the Messages API this repo calls directly.

The contract to satisfy:

- Price every model call into `cost_ledger` with the ticket id, as the API
  harness does. Untracked spend defeats the point of the project.
- Honour the ticket budget — stop when it is exhausted rather than retrying.
- Never push to `main`; branch per ticket and open a PR.
- Return a `TurnResult` so `worker.ts` needs no special-casing.

## Ground rules

1. **Guardrails stay pure.** Anything in `src/guardrails/` must be testable with
   no database. That is what makes them cheap to test and safe to reuse at two
   enforcement points.
2. **An unpriced model must throw.** Never default a cost to zero.
3. **New tools need a permission check in `callTool`**, not just a schema entry.
   The schema filter is not a security boundary.
4. **New roles must satisfy `validateRoles()`** and the separation-of-duties
   tests in `tests/roles.test.ts` — in particular, a role must not be the only
   owner of a type it may also file.
5. **Tests describe behaviour, not implementation.** `returns null margin when
   there is no revenue`, not `test marginToDate`.

## Setup

```bash
pnpm install
pnpm db:up && pnpm db:migrate
pnpm typecheck && pnpm test
```

Integration tests skip automatically when no database is reachable, so
`pnpm test` is useful without Docker running.

## Adding a role

1. Add the definition to `src/roles/{strategy,build,revenue}.ts`.
2. Write a charter that says what the role must **refuse** to do, not only what
   it does. The refusals are what keep a role in its lane.
3. Give it the narrowest tool allowlist that lets it finish its job.
4. Check `pnpm test` — the registry self-validates at module load, and the
   separation-of-duties tests will catch an overlap that makes a permission dead.

## Commit messages

Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.

## What will not be merged

- Anything that makes the monthly spend cap raisable from inside the system.
- Anything that lets an agent bypass a human gate (deploys, outbound, terms).
- Anything that records model spend as zero.
- Star-inflation, follow-for-follow, or engagement-bot tooling. It violates
  GitHub's Terms of Service and gets repositories delisted.
