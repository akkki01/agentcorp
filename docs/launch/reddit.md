# Reddit drafts

**Read each subreddit's self-promotion rules before posting.** Several remove
link posts from accounts without comment history. Space posts several days apart
and vary the text — identical cross-posts get domain-filtered.

---

## r/LocalLLaMA / r/ClaudeAI

**Title:** What it actually costs to run a 14-agent "company" — with the ledger

I built a multi-agent system where 14 roles operate a SaaS company through typed
tickets, and the part I found most interesting wasn't the agents — it was that
almost nobody publishes what these systems cost to run.

So the cost ledger is the centrepiece. Every model call is priced and attributed
to a ticket and a role, cache reads at 0.1x and writes at 1.25x base input.
Model tiers by job: Opus 5 for the roles where a wrong answer is expensive
(compliance veto, forecasting, budget allocation), Sonnet 5 for build work,
Haiku 4.5 for the roles that run widest and cheapest.

The idea scout runs on Haiku specifically *because* it runs widest — it sweeps
for product ideas, scores them against a 5-dimension rubric, and physically
cannot file tickets or promote its own ideas. Breadth is cheap; letting breadth
reach the backlog is not.

Two findings that surprised me:

- **Budget exhaustion must block, not retry.** A retry on exhaustion is how a $2
  ticket becomes a $200 one. Blocking surfaces the misjudgement instead.
- **Caching placement is most of the cost.** Role charters are byte-identical
  every turn, so they carry the cache breakpoint; ticket state goes in the user
  message. Putting ticket state in the system prompt — which feels natural —
  invalidates the prefix on every turn.

MIT, TypeScript, Postgres: https://github.com/akkki01/agentcorp

The code harness (the roles that edit the repo) isn't implemented yet; those
three roles refuse to run rather than bill for work they can't do.

---

## r/SaaS

**Title:** I built the ops layer for an agent-run SaaS company. The hard part wasn't the agents.

Fourteen agent roles operating a company through typed tickets. What I expected
to be hard: the agents. What was actually hard: stopping them from generating
infinite work for each other, and knowing whether any of it was profitable.

The rule that fixed the first problem is one line of enforcement — *no agent may
create work for itself*. Without it, any role that can both file and own tickets
produces an unbounded backlog of plausible busywork.

The second needed a real double-entry-ish setup: model spend attributed per
ticket and per role on one side, Stripe revenue keyed by event id on the other,
gross margin as the number the system is steered by. `finance` has standing
authority to pause the company when spend exceeds return.

There's also a forecaster that projects MRR ceiling, break-even month, and
funding needed — and gets **graded against actuals**, because a confident wrong
forecast is worse than no forecast.

Honest limits: it needs a human for the legal entity, Stripe, and every
production deploy. Agents can't do KYC. It hasn't earned revenue — the substrate
works, the product it would sell doesn't exist yet.

MIT: https://github.com/akkki01/agentcorp
