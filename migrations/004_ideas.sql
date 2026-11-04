-- The idea funnel. `scout` writes here in breadth; `analyst` validates in depth
-- and promotes survivors into prd tickets. Keeping ideas out of the ticket
-- table matters: an unvalidated idea is not work, and letting scouts file
-- tickets directly would flood the backlog.

CREATE TYPE idea_state AS ENUM (
  'new', 'scored', 'shortlisted', 'promoted', 'rejected', 'duplicate'
);

CREATE TABLE ideas (
  id            BIGSERIAL PRIMARY KEY,
  state         idea_state NOT NULL DEFAULT 'new',

  title         TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  hypothesis    TEXT NOT NULL,
  niche         TEXT NOT NULL,

  -- Where the signal came from, and enough to re-find it. An idea with no
  -- source is an opinion, and `scoreIdea` refuses to score one.
  source_kind   TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Operability rubric, 0-5 each. See src/ideas/scoring.ts for what each means.
  scores        JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_score   NUMERIC(5,2),

  -- Set when promoted, so we can trace revenue back to the idea that caused it.
  promoted_ticket_id BIGINT REFERENCES tickets(id) ON DELETE SET NULL,
  rejected_reason    TEXT,

  found_by      TEXT NOT NULL,
  -- Cheap near-duplicate guard: normalised title, unique.
  dedupe_key    TEXT NOT NULL UNIQUE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ideas_shortlist ON ideas (total_score DESC) WHERE state = 'scored';
CREATE INDEX ideas_state ON ideas (state, created_at DESC);
CREATE INDEX ideas_niche ON ideas (niche);
