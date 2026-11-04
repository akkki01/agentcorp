/** Process configuration, read once at startup and frozen. */

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number, got "${raw}"`);
  }
  return parsed;
};

const str = (key: string, fallback: string): string => {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? fallback : raw;
};

export const config = Object.freeze({
  databaseUrl: str(
    "DATABASE_URL",
    "postgres://agentcorp:agentcorp@localhost:5433/agentcorp",
  ),
  monthlyUsdCap: num("AGENTCORP_MONTHLY_USD_CAP", 200),
  defaultTicketUsd: num("AGENTCORP_DEFAULT_TICKET_USD", 2),
  maxTicketDepth: num("AGENTCORP_MAX_TICKET_DEPTH", 3),
  leaseMinutes: num("AGENTCORP_LEASE_MINUTES", 20),
  stripeSecretKey: process.env["STRIPE_SECRET_KEY"] ?? "",
  stripeWebhookSecret: process.env["STRIPE_WEBHOOK_SECRET"] ?? "",
});

export type Config = typeof config;
