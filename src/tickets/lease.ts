import { config } from "../config.js";
import { getPool, withTransaction } from "../db/pool.js";
import { getTicket, recordEvent } from "./store.js";
import type { Ticket } from "./types.js";

/**
 * Atomically claims one claimable ticket for `role` and leases it.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes horizontal scaling of a role safe:
 * ten engineer workers polling at once each get a different ticket instead of
 * contending on the same row.
 */
export const claimNextTicket = async (
  role: string,
  workerId: string,
): Promise<Ticket | undefined> =>
  withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      `SELECT id FROM tickets
        WHERE owner_role = $1
          AND state IN ('approved', 'blocked')
          AND claimed_by IS NULL
        ORDER BY (state = 'blocked') DESC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [role],
    );
    const claimed = rows[0];
    if (claimed === undefined) return undefined;

    await tx.query(
      `UPDATE tickets
          SET claimed_by = $2,
              lease_expires_at = now() + make_interval(mins => $3::int),
              state = 'in_progress',
              updated_at = now()
        WHERE id = $1`,
      [claimed.id, workerId, config.leaseMinutes],
    );
    await recordEvent(tx, claimed.id, workerId, "claimed", { role });
    return await getTicket(claimed.id, tx);
  });

/** Extends the lease on a ticket the worker still holds. */
export const renewLease = async (
  ticketId: number,
  workerId: string,
): Promise<boolean> => {
  const { rowCount } = await getPool().query(
    `UPDATE tickets
        SET lease_expires_at = now() + make_interval(mins => $3::int)
      WHERE id = $1 AND claimed_by = $2`,
    [ticketId, workerId, config.leaseMinutes],
  );
  return (rowCount ?? 0) > 0;
};

export const releaseTicket = async (
  ticketId: number,
  workerId: string,
): Promise<void> => {
  await getPool().query(
    `UPDATE tickets
        SET claimed_by = NULL, lease_expires_at = NULL,
            state = CASE WHEN state = 'in_progress' THEN 'approved' ELSE state END,
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2`,
    [ticketId, workerId],
  );
};

/**
 * Returns expired leases to the queue. A crashed worker therefore costs one
 * lease interval of latency rather than a permanently stuck ticket. Run this on
 * a short interval from the supervisor.
 */
export const reapExpiredLeases = async (): Promise<number> => {
  const { rows } = await getPool().query<{ id: number }>(
    `UPDATE tickets
        SET claimed_by = NULL, lease_expires_at = NULL,
            state = 'approved', updated_at = now()
      WHERE claimed_by IS NOT NULL
        AND lease_expires_at < now()
        AND state = 'in_progress'
      RETURNING id`,
  );
  for (const row of rows) {
    await recordEvent(getPool(), row.id, "supervisor", "lease:expired");
  }
  return rows.length;
};
