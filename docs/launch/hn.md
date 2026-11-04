# Show HN draft

**Title** (80 char limit — these fit):

> Show HN: AgentCorp – a 14-agent SaaS company runtime with a real cost ledger

Alternatives:
> Show HN: I built the boring parts of an AI-run company (tickets, budgets, margin)
> Show HN: AgentCorp – multi-agent company runtime that tracks its own burn rate

**Body:**

I kept seeing "autonomous AI company" demos that were a prompt asking a model to
role-play a CEO, so I built the parts those demos skip.

AgentCorp is 14 agent roles — scout, analyst, forecaster, pm, architect,
engineer, qa, sre, growth, outbound, support, compliance, finance, ceo — that
communicate only through typed tickets in Postgres. No agent-to-agent chat.
Three things I think are the actual hard parts:

**1. No agent may create work for itself.** Give a role the ability to both file
and own tickets and it generates an unbounded backlog of plausible busywork.
This is enforced at the API boundary, not suggested in a prompt. It's the single
rule that stopped my early version from spiralling.

**2. Every model call is priced into a ledger**, attributed to a ticket and a
role, with cache reads at 0.1x and writes at 1.25x. `agentcorp status` prints
month-to-date spend, revenue, and gross margin. An unpriced model throws rather
than recording zero — recording zero is how you find out your burn rate a month
late. There's a hard monthly cap that can't be raised from inside the system.

**3. A forecaster that gets graded.** It projects MRR ceiling, break-even month,
and funding needed from seven explicit assumptions, and must label invented
numbers as invented. Every forecast is stored with a stated confidence and
compared against actuals in a calibration view. A forecaster with high
confidence and high error is worse than none, because it launders a guess into a
budget decision.

Things I'll be upfront about:

- **It isn't a company that runs without humans.** Bank accounts and Stripe need
  KYC. The realistic shape is one human as the legal wrapper and approval gate.
  Production deploys, first-time outbound, and terms are hard-gated.
- **The code harness isn't implemented.** engineer/qa/sre need filesystem access
  and currently refuse to run rather than bill you for work they can't do. That's
  the obvious next piece and the best place to contribute.
- **It hasn't earned a dollar.** The substrate works and is tested; the product
  it would sell doesn't exist yet.

TypeScript, Postgres, MIT. 119 tests — the state machine, guardrails, pricing,
rubric, and projection maths are pure functions and test without a database.

Repo: https://github.com/akkki01/agentcorp

Happy to go into the budget-exhaustion-blocks-rather-than-retries decision, or
why I used Postgres LISTEN/NOTIFY instead of adding Redis.

---

## Notes for posting

- Tue–Thu, ~09:00 ET. Avoid Fri–Sun.
- Reply to every comment for the first 3 hours. This matters more than the title.
- Don't ask for stars, upvotes, or shares anywhere in the post.
- If someone says it's over-engineered, agree where they're right and say which
  part you'd cut. Defensiveness kills a Show HN faster than criticism does.
