# AgentCorp

**A multi-agent operating system for running a SaaS company.** Fourteen agent
roles, typed tickets, dollar budgets per unit of work, and a cost ledger that
reconciles LLM spend against revenue — so you can tell whether the company is
actually profitable.

```
scout ──► analyst ──► forecaster ──► pm ──► architect ──► engineer ──► qa ──► sre
 │                         │                                                   │
 │ finds ideas in breadth  │ projects ceiling, timeline, funding needed        │ deploys
 │ (cheap, runs often)     │ and is graded against actuals later               │ (human gate)
 │                                                                             ▼
 └──────────── support ◄── customers ◄── growth ◄── compliance (veto) ◄────────┘
                  │
                  └──► files the build tickets that close the loop
```

---

## Why this exists

Most "AI company" demos are a prompt that asks a model to role-play a CEO. They
fall over for three reasons, and this repo is built around fixing them:

1. **Agents generate work for each other forever.** Give a role the ability to
   both file and own tickets and it will produce an unbounded backlog of
   plausible busywork. Here, *no agent may create work for itself* — enforced
   at the API boundary, not suggested in a prompt.
2. **Nobody knows what it cost.** Every model call is priced and attributed to
   a ticket and a role. `agentcorp status` tells you month-to-date spend,
   revenue, and gross margin. An unpriced model is refused rather than silently
   recorded as free.
3. **Agents report success they did not achieve.** A ticket closes when its
   acceptance criteria are verified, not when the work feels done. An agent
   that burns its turn without moving the ticket gets blocked, not re-queued.

## What it is honestly not

- **Not a company that runs with no humans.** A bank account, Stripe account,
  tax registration, and signatures need a human or a registered entity with
  KYC. The realistic target is *one human as the legal wrapper and approval
  gate*, with agents doing the operating work. The human gates are listed below
  and are not optional.
- **Not autonomous revenue.** Billing is wired, but inert until you supply
  Stripe keys against a real entity.
- **Not finished.** The `code` harness (engineer, qa, sre — the roles that edit
  the repo) is an adapter interface, not an implementation. Those three roles
  refuse to run rather than bill you for work they cannot do. See
  [Status](#status).

---

## Quick start

```bash
pnpm install
pnpm db:up          # Postgres 17 in Docker on port 5433
pnpm db:migrate
pnpm test           # 119 tests; DB-backed ones skip if no database is up

cp .env.example .env   # set ANTHROPIC_API_KEY (loaded automatically), or `ant auth login`

npx tsx src/cli/main.ts roles     # the org chart
npx tsx src/cli/main.ts status    # spend, revenue, margin, pause state
```

Run one agent turn:

```bash
npx tsx src/cli/main.ts file research scout "sweep logistics forums"
npx tsx src/cli/main.ts work scout       # claims it, runs one turn, costs real money
npx tsx src/cli/main.ts ideas            # what it found
npx tsx src/cli/main.ts spend            # what that cost
```

> Every `work` and `pass` command spends real money against your API account.
> The monthly cap in `.env` defaults to **$200** and cannot be raised from
> inside the system — by design.

---

## The org chart

Three loops, fourteen roles. Each has its own model, effort level, tool
allowlist, and default budget.

### Strategy loop — weekly, expensive models

| Role | Owns | Model |
|---|---|---|
| `ceo` | Budget allocation, dispute arbitration, kill decisions | Opus 5 |
| `forecaster` | Growth projections: ceiling, timeline, funding needed | Opus 5 |
| `analyst` | Validates demand signals, promotes ideas to PRDs | Opus 5 |
| `finance` | Unit economics, cost attribution, can pause the company | Opus 5 |

### Build loop — event-driven

| Role | Owns | Model |
|---|---|---|
| `pm` | PRDs with machine-checkable acceptance criteria | Sonnet 5 |
| `architect` | Schemas, interfaces, ADRs | Opus 5 |
| `engineer` ×3 | Implementation, PRs — your throughput knob | Sonnet 5 |
| `qa` ×2 | Release gate; verifies criteria by running them | Sonnet 5 |
| `sre` | Deploys (human-gated), monitoring, incidents | Sonnet 5 |

### Revenue loop — daily, cheap models

| Role | Owns | Model |
|---|---|---|
| `scout` ×2 | **Finds ideas in breadth**, scores them against the rubric | Haiku 4.5 |
| `growth` | Landing pages, docs, changelog, launch posts | Sonnet 5 |
| `outbound` | Lead lists and sequences (human-gated) | Haiku 4.5 |
| `support` ×2 | Customer answers; files the build tickets that close the loop | Haiku 4.5 |
| `compliance` | **Blocking veto** on anything outbound, legal, or financial | Opus 5 |

`scout` runs on the cheapest model because it runs widest; `compliance` and
`forecaster` run on the most capable because a bad veto and a bad number are
the two most expensive mistakes in the system.

---

## The idea funnel

A dedicated two-stage funnel keeps idea generation from flooding the backlog:

```
scout            breadth, cheap, runs often
  │ capture_idea     every idea needs a real source_ref — no source, no score
  │ score_idea       5-dimension operability rubric, 0-5 each
  ▼
ideas table      state: new → scored → shortlisted → promoted
  │
  │ scout CANNOT file tickets at all, and CANNOT promote its own ideas
  ▼
analyst          depth, expensive, validates the shortlist
  │ promote_idea     only shortlisted ideas may promote
  ▼
pm               receives a prd ticket with the evidence attached
```

The rubric scores **operability, not appeal** — "can a company staffed by
agents actually run this":

| Dimension | Weight | Question |
|---|---|---|
| `demandEvidenced` | 1.5 | Does someone already *pay* to solve this? |
| `selfServe` | 1.2 | Can a stranger pay with no human in the path? |
| `machineShaped` | 1.0 | Data in, data out — no GUI to eyeball? |
| `supportable` | 1.0 | Can docs answer >80% of tickets? |
| `costKnowable` | 0.8 | Is cost per request calculable up front? |

**Any dimension scoring ≤1 vetoes the idea regardless of total.** A product
that scores 5 everywhere but can't be sold self-serve isn't a cheap fix — it's
a different company.

## The forecaster

`forecaster` turns a shortlisted idea into a growth projection: how big it could
get, how long that takes, and what it costs to find out.

```
$ agentcorp forecast 1

Base case: $24,095 MRR by month 23, first dollar at month 2, break-even at
month 4, needing $4,400 of funding to get there.
Range across scenarios: $4,582-$46,689 MRR, break-even month 3 to month 10.

low   ceiling     $4582.00 MRR   first $ month 2   break-even month 10   funding $4400.00
base  ceiling    $24095.00 MRR   first $ month 2   break-even month  4   funding $4400.00
high  ceiling    $46689.00 MRR   first $ month 2   break-even month  3   funding $4400.00
```

Three things make this more than a spreadsheet:

- **The assumptions are the deliverable.** Seven inputs, each requiring stated
  provenance. Invented numbers must be labelled as invented — the example above
  says *"Reachable customers is INVENTED: no broker census found."*
- **Forecasts are graded.** Every projection is stored with a stated confidence
  and compared against actuals in the `forecast_calibration` view. A forecaster
  with high confidence and high error is worse than none, because it launders a
  guess into a budget decision. `ceo` reads calibration before trusting a number.
- **It refuses inverted unit economics.** If serve cost ≥ price, it won't
  project growth. Growth maths on a loss-making unit is malpractice, not
  optimism.

Revisions never overwrite, so a forecast revised after the fact can't quietly
become the one that was "always" predicted.

---

## The rules that keep it from collapsing

Everything moves through one typed object — the ticket. No free-form agent chat;
it degrades into politeness loops and context bloat.

1. **All work is a ticket.** Typed, budgeted, audited.
2. **No agent creates work for itself.** The single most important rule.
   Enforced in `guardrails/authorship.ts` and re-checked at every tool call.
3. **Every ticket has a dollar budget.** Exhausting it *blocks* the ticket. A
   retry on budget exhaustion is how a $2 ticket becomes a $200 one.
4. **Delegation requires collection.** Filing a subticket and stopping is an
   incomplete turn.
5. **Depth cap of 3**, then escalate. Depth is an outcome, not a plan.
6. **Disagreements escalate to `ceo` in one turn.** Never a negotiation.
7. **Claim-and-lease** with `FOR UPDATE SKIP LOCKED`. A crashed worker costs one
   lease interval, not a stuck ticket.
8. **Unknown tool = startup error.** A typo'd tool name used to silently vanish
   from the schema, leaving an agent told to do a job without the means.

## Human gates — not optional

Agents propose; you approve. Hard-coded:

- Company registration, bank account, Stripe, tax setup
- **Every production deploy**
- Any spend above the per-ticket threshold, and the monthly cap
- Any first-time outbound sequence to real people
- Anything `compliance` vetoes
- Terms of service, privacy policy, customer contracts

**Kill switches:** a `paused` flag checked before every agent turn; a hard
monthly dollar ceiling that halts all loops and cannot be raised from inside;
a per-role circuit breaker that trips after 3 consecutive failures.

```bash
agentcorp pause "something looks wrong"   # stops everything within one turn
agentcorp resume
```

---

## Architecture

```
Postgres 17 ── tickets, ideas, forecasts, cost ledger, wiki, controls
    │          (single source of truth; LISTEN/NOTIFY as the event bus)
    ▼
supervisor ── runPass(loop) visits roles in order, capped by concurrency
    │
    ▼
worker ─────── claims a ticket, checks halt + breaker + budget, runs one turn
    │
    ▼
harness ────── manual tool-use loop against the Messages API
               prices every call into the ledger between iterations
```

The manual tool-use loop is deliberate rather than the SDK tool runner: the
company must price and record every model call into the ledger between
iterations and stop the instant a budget is exhausted. Owning the loop is what
makes that enforceable.

Postgres `LISTEN/NOTIFY` is the event bus because Postgres is already a hard
dependency, and the ticket table is the durable queue — a dropped notification
costs one poll interval, not a lost ticket. Reach for Redis Streams or NATS when
you actually need replay or many consumer groups.

Per-model details that matter and are easy to get wrong:

- Opus 5 / Sonnet 5 take `thinking: {type: "adaptive"}`; **Haiku 4.5 still takes
  `budget_tokens`**. Sending the wrong one is a 400.
- `web_search` has two tool types — the `_20260209` dynamic-filtering variant
  isn't available on Haiku 4.5, so `scout` gets the basic variant.
- Refusals arrive as **HTTP 200** with `stop_reason: "refusal"`. The harness
  checks `stop_reason` before reading content and blocks the ticket; treating a
  refusal as an empty response looks like an agent with nothing to say.
- Role charters are cached with `cache_control` (they're identical every turn);
  ticket state goes in the user message so it never invalidates the prefix.

## Status

| Component | State |
|---|---|
| Ticket substrate, state machine, leases | Working, 24 integration tests |
| Guardrails (authorship, depth, budget, pause, breaker) | Working |
| Cost ledger + margin reporting | Working |
| Idea funnel (scout → rubric → promote) | Working |
| Forecaster + calibration | Working |
| API-harness roles (9 of 14) | Working |
| **Code-harness roles** (engineer, qa, sre) | **Adapter not implemented — they refuse to run** |
| Stripe billing | Wired, inert without keys |
| Product (the actual SaaS being sold) | Not built — this is the company, not the product |

Wiring the code harness is the highest-value contribution. The intended adapter
is the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), which is a
separate product from the Messages API this repo calls directly.

## Development

```bash
pnpm typecheck
pnpm test
pnpm db:reset     # nuke and rebuild the database
```

119 tests. Pure logic (state machine, guardrails, pricing, rubric, projection
maths, path sandbox) runs with no database; 24 integration tests skip
automatically if Postgres isn't up.

## License

MIT — see [LICENSE](LICENSE).
