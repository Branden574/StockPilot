import 'server-only';

import { env } from '@/lib/env';

/**
 * The site a passkey belongs to (the WebAuthn relying party): its RP ID and
 * the origins a passkey answer may come from (plan 2.2).
 *
 *   - Production (VERCEL_ENV is "production"): the two constants below. No
 *     setting can change them; the browser binds a passkey to the RP ID, and
 *     the server never takes the request's own Origin header.
 *   - Any other deployed environment (a preview, `vercel dev`): none.
 *     Passkeys are not offered or accepted there, whatever database it uses.
 *   - Not on Vercel at all: `localhost`, and only when the Supabase URL is a
 *     loopback address (review 9.4). A developer machine that holds another
 *     project's settings gets none, so it can never make a localhost passkey
 *     and a real bridge on a real account.
 *
 * Rows store their `rp_id`, and every read filters on the configured one, so
 * a lab row is never accepted in production even if it were copied there.
 */
export interface RelyingParty {
  rpId: string;
  origins: readonly string[];
}

export const PRODUCTION_RP_ID = 'stockpilotusa.com';
export const PRODUCTION_ORIGIN = 'https://stockpilotusa.com';
const LOCAL_RP_ID = 'localhost';
const LOCAL_DEFAULT_ORIGIN = 'http://localhost:3000';
const LOCAL_ORIGIN_RE = /^http:\/\/localhost:\d{1,5}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface RelyingPartyInput {
  /** process.env.VERCEL: set on every Vercel build and function. */
  vercel: string | undefined;
  /** process.env.VERCEL_ENV: production, preview or development. */
  vercelEnv: string | undefined;
  /** The Supabase URL this server talks to. */
  supabaseUrl: string;
  /** PASSKEY_LOCAL_ORIGINS: more local origins, comma separated. */
  localOrigins: string;
}

function isLoopback(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The local origins: the default, plus every extra one, only when every
 * extra one is a plain http://localhost:<port>. One that is not makes the
 * whole setting refused (the default alone stays).
 */
function localOriginsOf(raw: string): string[] {
  const extra = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.length === 0 || !extra.every((o) => LOCAL_ORIGIN_RE.test(o))) {
    return [LOCAL_DEFAULT_ORIGIN];
  }
  return [...new Set([LOCAL_DEFAULT_ORIGIN, ...extra])];
}

/** The relying party for these settings, or null when passkeys are not available here. */
export function relyingPartyFor(input: RelyingPartyInput): RelyingParty | null {
  if (input.vercelEnv === 'production' && input.vercel) {
    return { rpId: PRODUCTION_RP_ID, origins: [PRODUCTION_ORIGIN] };
  }
  if (input.vercel || input.vercelEnv) return null;
  if (!isLoopback(input.supabaseUrl)) return null;
  return { rpId: LOCAL_RP_ID, origins: localOriginsOf(input.localOrigins) };
}

/** This server's relying party, read fresh on every call. */
export function passkeyRelyingParty(): RelyingParty | null {
  return relyingPartyFor({
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    localOrigins: env.PASSKEY_LOCAL_ORIGINS,
  });
}
