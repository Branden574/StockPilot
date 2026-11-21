/**
 * The reserved name of a passkey's bridge factor at Supabase Auth.
 *
 * A passkey takes the session to aal2 through a hidden authenticator-app
 * (TOTP) factor of the account whose secret only the server holds: the
 * bridge. The server names it with this prefix, and the database records a
 * bridge only when its factor carries it (0475, _passkey_bridge_factor_ok).
 *
 * The name is only a TRIGGER to ask the server about the account's recorded
 * bridge (lib/auth/passkey-bridge.ts, by id). It is never proof that a factor
 * is the bridge: anyone can enrol a factor under any name at Auth directly.
 * Client-safe: the step-up modal reads it in the browser.
 */
export const PASSKEY_BRIDGE_NAME_PREFIX = 'sp-passkey-bridge-';

/** Whether a factor's name starts with the reserved prefix (exactly, case and all). */
export function carriesBridgeName(factor: { friendly_name?: unknown }): boolean {
  return (
    typeof factor.friendly_name === 'string' &&
    factor.friendly_name.startsWith(PASSKEY_BRIDGE_NAME_PREFIX)
  );
}

/**
 * How long an unverified reserved-name factor is a passkey registration in
 * flight (plan review 12): enrolled, not yet stored or answered. Only the
 * request that enrolled it holds its secret, so one older than this and still
 * unverified can never become verified.
 */
export const RESERVED_FACTOR_IN_FLIGHT_MS = 2 * 60_000;

/** Whether a factor made at `createdAt` is younger than two minutes (a time that cannot be read: yes). */
export function reservedFactorInFlight(createdAt: unknown): boolean {
  const made = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(made)) return true;
  return Date.now() - made < RESERVED_FACTOR_IN_FLIGHT_MS;
}
