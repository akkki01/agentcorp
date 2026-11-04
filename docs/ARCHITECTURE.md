# Architecture

## The one decision everything follows from

**Agents communicate only through typed tickets in a database.** There is no
message-passing between agents, no shared chat transcript, no agent calling
another agent.

Free-form agent-to-agent conversation fails in a specific, repeatable way: two
agents spend turns agreeing with each other, each one's context fills with the
other's prose, and neither produces an artifact. Routing everything through a
typed row with a budget and an audit trail makes the work inspectable and makes
"did anything happen" a SQL query rather than a reading exercise.

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ cli/main.ts          operator surface: status, pause, work   │
├─────────────────────────────────────────────────────────────┤
│ runner/supervisor    one pass over roles, capped per role    │
│ runner/worker        claim → guard → turn → transition       │
│ runner/harness       Messages API loop; prices every call    │
│ runner/tools         company toolset, permission-checked     │
│ runner/repo          read-only sandboxed repo access         │
├─────────────────────────────────────────────────────────────┤
│ roles/*              14 charters: model, effort, tools, $    │
├─────────────────────────────────────────────────────────────┤
│ guardrails/*         authorship, depth, budget, pause, trip  │
├─────────────────────────────────────────────────────────────┤
│ tickets/* ideas/* forecast/* ledger/* billing/*              │
├─────────────────────────────────────────────────────────────┤
│ Postgres 17          durable state + LISTEN/NOTIFY bus       │
└─────────────────────────────────────────────────────────────┘
```

## Why these choices

### Postgres LISTEN/NOTIFY instead of Redis or NATS

Postgres is already a hard dependency, and the ticket table is the durable
queue. A notification is only a wake-up signal, so a dropped one costs one poll
interval rather than a lost ticket. Adding Redis for this would add an operational
dependency to deliver something the database already delivers.

Switch when you genuinely need event replay, consumer groups, or fan-out beyond
one process group — not before.

### A manual tool-use loop instead of the SDK tool runner

The company must price every model call into the ledger *between* loop
iterations and stop the instant a ticket's budget is exhausted. The SDK tool
runner owns the loop; here, the loop must be interruptible on a dollar
threshold. Owning it is what makes the budget guardrail real rather than
advisory.

### `FOR UPDATE SKIP LOCKED` for claims

This is what makes `concurrency: 3` on the engineer role safe. Three workers
polling simultaneously each get a different ticket instead of contending on the
same row. Without it, horizontal scaling of a role is a race.

### Leases rather than locks

A claimed ticket carries an expiry. A crashed or hung worker therefore costs one
lease interval of latency; the supervisor's `reapExpiredLeases()` returns the
ticket to the queue. A plain lock would leave the ticket stuck until manual
intervention — the failure mode that makes agent systems look mysteriously
stalled.

### Depth stored on the row, not derived

`depth` is written at insert time from the parent's depth. Deriving it would
need a recursive CTE on every guardrail check, and the guardrail runs on every
ticket creation.

### Rubric versioning, and why old scores are not converted

`ideas.scores` holds one object per idea and `assertScores` requires every
dimension of the *current* rubric. When the rubric gained `errorTolerance` and
`marketGap`, every stored score became incomplete — and there is no value that
can be filled in for a dimension nobody judged:

- A passing default re-shortlists precisely the ideas the new dimensions exist
  to reject, including one where a wrong output is a failed audit. That is the
  original bug, reintroduced by the migration meant to fix it.
- A failing default silently discards ideas an analyst may already have
  validated, and hides the fact that the rubric changed at all.

So rows carry a `rubric_version` alongside their scores, migration `006` moves
v1 scores into `superseded_scores` and rewinds the idea to `new`, and
`promoteIdea` refuses a stale-rubric idea with `StaleRubricError` rather than
trusting its state column. The `agentcorp ideas` listing prints a stale total as
`--`, not as its old number: showing it next to current totals invites comparing
two numbers produced by different rubrics, which is the mistake the version
column exists to prevent.

Re-scoring costs one cheap scout turn per idea. That is the price of the funnel
having only one meaning at a time.

### Forecasts recomputed from stored assumptions

`latestForecast` recomputes the projection from the stored assumptions rather
than reading back the stored series. A change to the projection model is then
visible on old forecasts instead of hidden behind frozen numbers — you find out
that the model changed, rather than silently comparing incompatible forecasts.

## The ticket state machine

```
proposed ──► approved ──► in_progress ──► review ──► done
    │            │             │            │
    │            │             ├──► blocked ─┘
    │            │             │        │
    └────────────┴─────────────┴────────┴──► killed
```

Transitions are validated inside the same transaction that writes them, with
`SELECT ... FOR UPDATE` on the row. Two agents cannot both read `in_progress`
and both advance it.

`done` and `killed` are terminal. There is deliberately no path out of `done`:
reopening work hides the fact that it was closed wrongly. File a new ticket.

## Guardrail placement

Each guardrail is a pure function with its own error type, separate from the
code that stores things. That is what lets them be tested without a database and
reused at two enforcement points:

| Guardrail | Enforced at |
|---|---|
| Authorship (no self-assigned work) | `file_ticket` tool + `insertTicket` |
| Depth cap | `file_ticket` tool, against parent depth |
| Ticket budget | Before the turn, and between harness iterations |
| Global pause | Before every agent turn |
| Monthly cap | Before every agent turn, from the ledger |
| Role circuit breaker | Before every agent turn |
| Tool permission | Schema filter **and** re-checked in `callTool` |
| Path sandbox | `safeResolve` on every repo read |

The tool permission check is deliberately doubled. Filtering the schema is not
enough: a model can emit a call for a tool it was never given, and the handler
must refuse it rather than assume the schema was the only gate.

## Cost attribution

Every model call writes a `cost_ledger` row tagged with `ticket_id`,
`agent_role`, and `model`, priced from a table of published per-token rates.

Two deliberate choices:

- **An unpriced model throws.** Recording a zero cost for a model missing from
  the table is how a company discovers its burn rate a month late.
- **Cache reads and writes are priced separately** (0.1× and 1.25× base input).
  Role charters are cached, so cache reads are most of the input volume in
  steady state; pricing them at full rate would overstate burn by multiples.

Revenue arrives separately from Stripe webhooks into `revenue_ledger`, keyed by
Stripe event id so a replayed webhook cannot double-count. `marginToDate()`
joins the two — the one number the company is actually steered by.

`grossMarginPct` is `null` rather than `0` when there is no revenue. A ratio
against zero is not zero percent, and rendering it as 0% invites the wrong
conclusion.

## Context and caching

The system prompt holds the role charter and the company rules — byte-identical
on every turn of that role — and carries a `cache_control` breakpoint. Ticket
state, budget pressure, and acceptance criteria go in the user message.

Putting the ticket in the system prompt would invalidate the cached prefix on
every single turn, which is the most common and most expensive caching mistake
in agent systems. Verify with `usage.cache_read_input_tokens`: if it is zero
across repeated turns of the same role, something upstream is varying.

## Known gaps

- **The code harness is not implemented.** `engineer`, `qa`, and `sre` throw
  `CodeHarnessNotImplementedError` rather than run with a degraded toolset.
  Running them without repo access would produce confident nothing and bill for
  it.
- **No infra cost in the ledger.** Only model spend is tracked. `record_infra_cost`
  is declared for `sre` but belongs to the unimplemented harness, so margin
  currently understates true cost.
- **Churn is modelled as a ceiling reduction**, not a decay on the stock. This
  keeps the adoption curve monotonic and legible; it understates volatility,
  which is the right direction for a planning number but wrong for a cohort
  analysis.
- **Idea dedupe does not stem.** "parse" and "parsing" produce distinct keys.
  Stemming would catch more duplicates but collide genuinely different ideas,
  and a false collision silently discards a real find.
- **The rubric cannot see cost of error or market saturation.** — **CLOSED by
  rubric v2.** For the record of what the gap was: the five v1 dimensions had
  no way to express "if we are wrong, the customer fails an audit", so an idea
  needing a licensed human on every output scored 18.8 and shortlisted; and
  saturation *raised* `demandEvidenced`, so the most crowded idea in a cohort
  of 14 scored highest. v1 shortlisted 11 of 14 and three had to be overturned
  by hand. `errorTolerance` and `marketGap` close it; both can veto, and the
  threshold moved from 17 of 27.5 to 28 of 39. See
  [Rubric versioning](#rubric-versioning-and-why-old-scores-are-not-converted).
- **`marketGap` is scored from a search, not from data we hold.** A scout
  judging saturation is reading a results page, which is a snapshot and is
  geographically skewed by whoever is asking. It is still the best signal
  available at scout cost, but it is the dimension most likely to be scored
  wrong, and the one worth sampling when auditing a scout's calibration.
- **Nothing grades the rubric itself.** `forecast_calibration` grades
  forecasters against actuals; there is no equivalent for the funnel, so
  "shortlisted ideas that survived the analyst" is a number an operator has to
  compute by hand. Until it exists, a threshold change is argued from the 14
  historical ideas rather than measured.
