-- Single-row control table. The runner reads this before every agent turn, so
-- flipping paused to true stops the whole company within one turn.
CREATE TABLE company_controls (
  id                BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  paused            BOOLEAN NOT NULL DEFAULT false,
  pause_reason      TEXT,
  monthly_usd_cap   NUMERIC(10,2) NOT NULL DEFAULT 200.00,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO company_controls (id) VALUES (true);

-- Per-role circuit breaker. N consecutive failures trips the role offline until
-- a human or the CEO resets it.
CREATE TABLE role_health (
  role                 TEXT PRIMARY KEY,
  consecutive_failures INT NOT NULL DEFAULT 0,
  tripped              BOOLEAN NOT NULL DEFAULT false,
  last_error           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable shared memory. Agents read the wiki on wake and append on close;
-- this is what survives context loss between turns.
CREATE TABLE wiki_entries (
  id         BIGSERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  author     TEXT NOT NULL,
  ticket_id  BIGINT REFERENCES tickets(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wiki_kind ON wiki_entries (kind);
