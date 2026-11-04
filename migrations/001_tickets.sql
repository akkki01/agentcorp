-- The ticket is the only unit of work in the company. Agents never talk to each
-- other in free-form prose; they create, claim, and close tickets.

CREATE TYPE ticket_state AS ENUM (
  'proposed', 'approved', 'in_progress', 'review', 'blocked', 'done', 'killed'
);

CREATE TYPE ticket_type AS ENUM (
  'research', 'prd', 'design', 'build', 'test', 'deploy',
  'content', 'outbound', 'support', 'finance', 'incident', 'decision'
);

CREATE TABLE tickets (
  id              BIGSERIAL PRIMARY KEY,
  parent_id       BIGINT REFERENCES tickets(id) ON DELETE SET NULL,
  depth           INT NOT NULL DEFAULT 0 CHECK (depth >= 0),

  type            ticket_type NOT NULL,
  state           ticket_state NOT NULL DEFAULT 'proposed',
  title           TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  body            TEXT NOT NULL DEFAULT '',

  -- Role that must do the work, and the role (or 'human') that asked for it.
  -- The authorship guardrail enforces owner_role <> created_by.
  owner_role      TEXT NOT NULL,
  created_by      TEXT NOT NULL,

  acceptance      JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifacts       JSONB NOT NULL DEFAULT '[]'::jsonb,

  budget_usd      NUMERIC(10,4) NOT NULL CHECK (budget_usd > 0),
  requires_human  BOOLEAN NOT NULL DEFAULT false,
  human_approved  BOOLEAN NOT NULL DEFAULT false,

  -- Claim lease. Both NULL when unclaimed.
  claimed_by      TEXT,
  lease_expires_at TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,

  CONSTRAINT lease_is_whole CHECK (
    (claimed_by IS NULL) = (lease_expires_at IS NULL)
  ),
  CONSTRAINT human_gate_respected CHECK (
    NOT (state = 'done' AND requires_human AND NOT human_approved)
  )
);

CREATE INDEX tickets_claimable ON tickets (owner_role, state)
  WHERE state IN ('approved', 'blocked');
CREATE INDEX tickets_lease ON tickets (lease_expires_at)
  WHERE claimed_by IS NOT NULL;
CREATE INDEX tickets_parent ON tickets (parent_id);

-- Append-only audit trail. Every state change and every agent action lands here.
CREATE TABLE ticket_events (
  id         BIGSERIAL PRIMARY KEY,
  ticket_id  BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ticket_events_ticket ON ticket_events (ticket_id, at);
