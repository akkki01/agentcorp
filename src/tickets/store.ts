import { config } from "../config.js";
import { getPool, withTransaction, type Queryable } from "../db/pool.js";
import { assertTransition } from "./transitions.js";
import type { NewTicket, Ticket, TicketState } from "./types.js";

interface Row {
  id: number;
  parent_id: number | null;
  depth: number;
  type: Ticket["type"];
  state: TicketState;
  title: string;
  body: string;
  owner_role: string;
  created_by: string;
  acceptance: Ticket["acceptance"];
  artifacts: string[];
  budget_usd: number;
  requires_human: boolean;
  human_approved: boolean;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  closed_at: Date | null;
}

const toTicket = (row: Row): Ticket => ({
  id: row.id,
  parentId: row.parent_id,
  depth: row.depth,
  type: row.type,
  state: row.state,
  title: row.title,
  body: row.body,
  ownerRole: row.owner_role,
  createdBy: row.created_by,
  acceptance: row.acceptance,
  artifacts: row.artifacts,
  budgetUsd: row.budget_usd,
  requiresHuman: row.requires_human,
  humanApproved: row.human_approved,
  claimedBy: row.claimed_by,
  leaseExpiresAt: row.lease_expires_at,
  createdAt: row.created_at,
  closedAt: row.closed_at,
});

const SELECT = "SELECT * FROM tickets";

export const getTicket = async (
  id: number,
  db: Queryable = getPool(),
): Promise<Ticket | undefined> => {
  const { rows } = await db.query<Row>(`${SELECT} WHERE id = $1`, [id]);
  return rows[0] === undefined ? undefined : toTicket(rows[0]);
};

export const insertTicket = async (input: NewTicket): Promise<Ticket> =>
  withTransaction(async (tx) => {
    const parentDepth =
      input.parentId == null
        ? -1
        : ((
            await tx.query<{ depth: number }>(
              "SELECT depth FROM tickets WHERE id = $1",
              [input.parentId],
            )
          ).rows[0]?.depth ?? -1);

    const { rows } = await tx.query<Row>(
      `INSERT INTO tickets
         (parent_id, depth, type, title, body, owner_role, created_by,
          acceptance, budget_usd, requires_human)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING *`,
      [
        input.parentId ?? null,
        parentDepth + 1,
        input.type,
        input.title,
        input.body,
        input.ownerRole,
        input.createdBy,
        JSON.stringify(input.acceptance ?? []),
        input.budgetUsd ?? config.defaultTicketUsd,
        input.requiresHuman ?? false,
      ],
    );
    const ticket = toTicket(rows[0]!);
    await recordEvent(tx, ticket.id, input.createdBy, "created", {
      type: input.type,
      ownerRole: input.ownerRole,
    });
    return ticket;
  });

export const recordEvent = async (
  db: Queryable,
  ticketId: number,
  actor: string,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<void> => {
  await db.query(
    `INSERT INTO ticket_events (ticket_id, actor, kind, detail)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [ticketId, actor, kind, JSON.stringify(detail)],
  );
};

/**
 * Moves a ticket to `to`, validating the transition against the state machine
 * inside the same transaction that writes it, so two concurrent agents cannot
 * both read `in_progress` and both advance it.
 */
export const transitionTicket = async (
  ticketId: number,
  to: TicketState,
  actor: string,
  detail: Record<string, unknown> = {},
): Promise<Ticket> =>
  withTransaction(async (tx) => {
    const { rows } = await tx.query<Row>(
      `${SELECT} WHERE id = $1 FOR UPDATE`,
      [ticketId],
    );
    const current = rows[0];
    if (current === undefined) throw new Error(`ticket ${ticketId} not found`);

    assertTransition(current.state, to);

    if (to === "done" && current.requires_human && !current.human_approved) {
      throw new Error(
        `ticket ${ticketId} requires human approval before it can be closed`,
      );
    }

    const { rows: updated } = await tx.query<Row>(
      // $2 is cast explicitly on every use: without the casts Postgres sees it
      // assigned to a ticket_state column and compared to text literals in the
      // same statement, and refuses with "inconsistent types deduced".
      `UPDATE tickets
          SET state = $2::ticket_state,
              updated_at = now(),
              closed_at = CASE WHEN $2::ticket_state IN ('done','killed')
                            THEN now() ELSE closed_at END,
              claimed_by = CASE WHEN $2::ticket_state IN ('done','killed')
                            THEN NULL ELSE claimed_by END,
              lease_expires_at = CASE WHEN $2::ticket_state IN ('done','killed')
                            THEN NULL ELSE lease_expires_at END
        WHERE id = $1
      RETURNING *`,
      [ticketId, to],
    );
    await recordEvent(tx, ticketId, actor, `state:${to}`, {
      from: current.state,
      ...detail,
    });
    return toTicket(updated[0]!);
  });

export const approveByHuman = async (
  ticketId: number,
  who = "human",
): Promise<Ticket> =>
  withTransaction(async (tx) => {
    const { rows } = await tx.query<Row>(
      `UPDATE tickets SET human_approved = true, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [ticketId],
    );
    if (rows[0] === undefined) throw new Error(`ticket ${ticketId} not found`);
    await recordEvent(tx, ticketId, who, "human:approved");
    return toTicket(rows[0]);
  });

export const addArtifact = async (
  ticketId: number,
  artifact: string,
  actor: string,
): Promise<void> => {
  await getPool().query(
    `UPDATE tickets
        SET artifacts = artifacts || to_jsonb($2::text), updated_at = now()
      WHERE id = $1`,
    [ticketId, artifact],
  );
  await recordEvent(getPool(), ticketId, actor, "artifact:added", { artifact });
};

export const listTickets = async (filter: {
  state?: TicketState;
  ownerRole?: string;
  limit?: number;
}): Promise<Ticket[]> => {
  const { rows } = await getPool().query<Row>(
    `${SELECT}
      WHERE ($1::ticket_state IS NULL OR state = $1)
        AND ($2::text IS NULL OR owner_role = $2)
      ORDER BY id DESC
      LIMIT $3`,
    [filter.state ?? null, filter.ownerRole ?? null, filter.limit ?? 50],
  );
  return rows.map(toTicket);
};
