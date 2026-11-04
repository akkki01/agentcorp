import { getPool } from "../db/pool.js";
import { monthToDateSpend } from "../ledger/ledger.js";

export interface ControlState {
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly monthlyUsdCap: number;
}

export const readControls = async (): Promise<ControlState> => {
  const { rows } = await getPool().query<{
    paused: boolean;
    pause_reason: string | null;
    monthly_usd_cap: number;
  }>("SELECT paused, pause_reason, monthly_usd_cap FROM company_controls");
  const row = rows[0];
  if (row === undefined) throw new Error("company_controls row is missing");
  return {
    paused: row.paused,
    pauseReason: row.pause_reason,
    monthlyUsdCap: row.monthly_usd_cap,
  };
};

export const setPaused = async (
  paused: boolean,
  reason?: string,
): Promise<void> => {
  await getPool().query(
    `UPDATE company_controls
        SET paused = $1, pause_reason = $2, updated_at = now()`,
    [paused, reason ?? null],
  );
};

export type HaltReason =
  | { readonly kind: "paused"; readonly detail: string }
  | { readonly kind: "monthly_cap"; readonly spentUsd: number; readonly capUsd: number };

/**
 * Checked before every agent turn. Returns the reason to stop, or undefined to
 * proceed. The monthly cap is deliberately not overridable from inside the
 * system: an agent that could raise its own ceiling does not have a ceiling.
 */
export const haltReason = async (): Promise<HaltReason | undefined> => {
  const controls = await readControls();
  if (controls.paused) {
    return { kind: "paused", detail: controls.pauseReason ?? "paused by operator" };
  }
  const spentUsd = await monthToDateSpend();
  if (spentUsd >= controls.monthlyUsdCap) {
    return { kind: "monthly_cap", spentUsd, capUsd: controls.monthlyUsdCap };
  }
  return undefined;
};

const FAILURE_TRIP_THRESHOLD = 3;

/** Per-role circuit breaker: three consecutive failures takes a role offline. */
export const recordRoleFailure = async (
  role: string,
  error: string,
): Promise<boolean> => {
  const { rows } = await getPool().query<{ tripped: boolean }>(
    `INSERT INTO role_health (role, consecutive_failures, last_error)
       VALUES ($1, 1, $2)
     ON CONFLICT (role) DO UPDATE
       SET consecutive_failures = role_health.consecutive_failures + 1,
           tripped = role_health.consecutive_failures + 1 >= $3,
           last_error = $2,
           updated_at = now()
     RETURNING tripped`,
    [role, error.slice(0, 2000), FAILURE_TRIP_THRESHOLD],
  );
  return rows[0]?.tripped ?? false;
};

export const recordRoleSuccess = async (role: string): Promise<void> => {
  await getPool().query(
    `INSERT INTO role_health (role, consecutive_failures, tripped)
       VALUES ($1, 0, false)
     ON CONFLICT (role) DO UPDATE
       SET consecutive_failures = 0, tripped = false, updated_at = now()`,
    [role],
  );
};

export const isRoleTripped = async (role: string): Promise<boolean> => {
  const { rows } = await getPool().query<{ tripped: boolean }>(
    "SELECT tripped FROM role_health WHERE role = $1",
    [role],
  );
  return rows[0]?.tripped ?? false;
};
