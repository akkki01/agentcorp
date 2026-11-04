import type pg from "pg";
import { getPool } from "../db/pool.js";

/**
 * Event bus over Postgres LISTEN/NOTIFY.
 *
 * Postgres is already a hard dependency and NOTIFY gives at-most-once delivery
 * to live listeners, which is all the wake-up signal needs: the ticket table is
 * the durable queue, so a dropped notification costs one poll interval, not a
 * lost ticket. Swap in Redis Streams or NATS only when you actually need
 * replay or fan-out across many consumer groups.
 */

export const CHANNEL = "agentcorp_events";

export interface CompanyEvent {
  readonly kind: string;
  readonly ticketId?: number;
  readonly role?: string;
  readonly detail?: Record<string, unknown>;
}

/** NOTIFY payloads are capped at 8000 bytes; keep events to identifiers. */
const MAX_PAYLOAD_BYTES = 7000;

export const publish = async (event: CompanyEvent): Promise<void> => {
  const payload = JSON.stringify(event);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
    throw new Error(
      "event payload too large for NOTIFY; publish identifiers, not documents",
    );
  }
  await getPool().query(`SELECT pg_notify($1, $2)`, [CHANNEL, payload]);
};

export interface Subscription {
  readonly close: () => Promise<void>;
}

export const subscribe = async (
  handler: (event: CompanyEvent) => void | Promise<void>,
): Promise<Subscription> => {
  const client: pg.PoolClient = await getPool().connect();
  await client.query(`LISTEN ${CHANNEL}`);

  client.on("notification", (message) => {
    if (message.payload === undefined) return;
    let event: CompanyEvent;
    try {
      event = JSON.parse(message.payload) as CompanyEvent;
    } catch {
      // A malformed payload is a bug in a publisher, not a reason to tear down
      // every subscriber on this connection.
      console.error("dropping unparseable event payload");
      return;
    }
    void Promise.resolve(handler(event)).catch((error: unknown) => {
      console.error("event handler failed:", error);
    });
  });

  return {
    close: async () => {
      await client.query(`UNLISTEN ${CHANNEL}`);
      client.release();
    },
  };
};
