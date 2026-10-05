import 'server-only';

/**
 * The exchange kill switch (returns plan 10.2, RX-2).
 *
 * `RETURNS_EXCHANGE_CREATE=off` (a Vercel environment variable) hides
 * "Exchange" on every create surface and makes the create routes refuse an
 * `exchange` field with `exchange_not_available` ("Exchanges are turned off
 * right now. Request a return only."). Adding a replacement to a return-only
 * line at approval is a new exchange too, so it is refused the same way. The
 * lifecycle of existing exchange RMAs is untouched: approving a requested
 * exchange, changing, cancelling, releasing and preparing a replacement keep
 * working. A redeploy takes minutes, faster than an OTA.
 *
 * Any other value (unset included) leaves exchanges on.
 */
export function exchangeCreateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.RETURNS_EXCHANGE_CREATE ?? '').trim().toLowerCase() !== 'off';
}
