-- Every model call is attributed to a ticket and a role. Without this the
-- company cannot tell whether it is profitable, which is the whole point.

CREATE TABLE cost_ledger (
  id                   BIGSERIAL PRIMARY KEY,
  ticket_id            BIGINT REFERENCES tickets(id) ON DELETE SET NULL,
  agent_role           TEXT NOT NULL,
  model                TEXT NOT NULL,

  input_tokens         INT NOT NULL DEFAULT 0,
  output_tokens        INT NOT NULL DEFAULT 0,
  cache_read_tokens    INT NOT NULL DEFAULT 0,
  cache_write_tokens   INT NOT NULL DEFAULT 0,

  cost_usd             NUMERIC(12,6) NOT NULL CHECK (cost_usd >= 0),
  at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cost_ledger_month ON cost_ledger (at);
CREATE INDEX cost_ledger_ticket ON cost_ledger (ticket_id);
CREATE INDEX cost_ledger_role ON cost_ledger (agent_role, at);

-- Revenue side, populated from Stripe webhooks.
CREATE TABLE revenue_ledger (
  id              BIGSERIAL PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  customer_ref    TEXT NOT NULL,
  kind            TEXT NOT NULL,
  amount_usd      NUMERIC(12,6) NOT NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX revenue_ledger_month ON revenue_ledger (at);

-- Metered usage of the SaaS product itself, per customer per period.
CREATE TABLE usage_events (
  id           BIGSERIAL PRIMARY KEY,
  customer_ref TEXT NOT NULL,
  units        INT NOT NULL CHECK (units > 0),
  cost_usd     NUMERIC(12,6) NOT NULL DEFAULT 0,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_customer ON usage_events (customer_ref, at);
