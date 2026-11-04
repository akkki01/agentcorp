# Product Hunt draft

**Name:** AgentCorp

**Tagline** (60 chars):
> A 14-agent SaaS company runtime that tracks its own burn

**Description:**

AgentCorp is an open-source runtime for operating a SaaS company with AI agents.
Fourteen roles — from an idea scout to a compliance veto — coordinate through
typed tickets in Postgres, each with a dollar budget and an audit trail.

What makes it different from agent-swarm demos:

**Agents can't create work for themselves.** Enforced at the API boundary. It's
the rule that stops a multi-agent system from generating infinite plausible
busywork.

**Every model call is priced into a ledger.** Attributed per ticket and per
role, reconciled against Stripe revenue. You can answer "is this profitable"
with a SQL query. A hard monthly cap halts everything and can't be raised from
inside the system.

**A forecaster that gets graded.** Projects MRR ceiling, break-even month, and
funding needed from explicit assumptions — then gets scored against actuals,
because a confident wrong number is worse than no number.

**Human gates that aren't optional.** Production deploys, outbound to real
people, pricing, and terms all require approval. Agents propose; you approve.

Honest about what it isn't: a company that runs with no humans (bank accounts
need KYC), and the code-writing roles aren't wired up yet — they refuse to run
rather than bill you for work they can't do.

TypeScript, Postgres, MIT licensed, 119 tests.

**First comment:**

Maker here. I built this because every "autonomous AI company" demo I found was
a prompt asking a model to role-play a CEO, and none of them could tell you what
they cost to run.

So I built the boring parts: a ticket state machine, claim leases so a crashed
worker doesn't stall a queue, guardrails as pure functions, and a cost ledger
that prices cache reads at 0.1x so the margin number is actually true.

The part I'd most like feedback on is the forecaster. It projects how big an idea
could get and what it costs to find out, from seven assumptions that each need
stated provenance — and it has to label invented numbers as invented. Then it
gets graded against actuals. I'm not sure the calibration loop is tight enough
to be useful yet.

Happy to answer anything about the architecture.
