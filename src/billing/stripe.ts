import Stripe from "stripe";
import { config } from "../config.js";
import { getPool } from "../db/pool.js";

/**
 * Stripe is the revenue side of the ledger.
 *
 * Nothing here runs until a human has created a legal entity and a Stripe
 * account -- agents cannot complete KYC, and that is the real boundary of the
 * company's autonomy, not a limitation of this code.
 */

export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      "STRIPE_SECRET_KEY is not set; billing is inert until a human configures " +
        "a Stripe account against a registered legal entity",
    );
    this.name = "StripeNotConfiguredError";
  }
}

let stripe: Stripe | undefined;

export const getStripe = (): Stripe => {
  if (config.stripeSecretKey === "") throw new StripeNotConfiguredError();
  stripe ??= new Stripe(config.stripeSecretKey);
  return stripe;
};

export const isBillingConfigured = (): boolean =>
  config.stripeSecretKey !== "" && config.stripeWebhookSecret !== "";

const REVENUE_EVENTS = new Set([
  "invoice.paid",
  "checkout.session.completed",
  "charge.refunded",
]);

/**
 * Verifies and records a Stripe webhook.
 *
 * The signature check is not optional: an unverified webhook endpoint lets
 * anyone write revenue into the ledger, which would make every margin decision
 * the company takes worthless.
 */
export const handleWebhook = async (
  rawBody: string | Buffer,
  signature: string,
): Promise<{ recorded: boolean; eventId: string }> => {
  if (config.stripeWebhookSecret === "") {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set; refusing to trust webhooks");
  }

  const event = getStripe().webhooks.constructEvent(
    rawBody,
    signature,
    config.stripeWebhookSecret,
  );

  if (!REVENUE_EVENTS.has(event.type)) {
    return { recorded: false, eventId: event.id };
  }

  const object = event.data.object as {
    customer?: string | null;
    amount_paid?: number;
    amount_total?: number;
    amount_refunded?: number;
  };

  const cents =
    object.amount_paid ??
    object.amount_total ??
    (object.amount_refunded !== undefined ? -object.amount_refunded : 0);

  await getPool().query(
    `INSERT INTO revenue_ledger (stripe_event_id, customer_ref, kind, amount_usd)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [event.id, object.customer ?? "unknown", event.type, cents / 100],
  );

  return { recorded: true, eventId: event.id };
};
