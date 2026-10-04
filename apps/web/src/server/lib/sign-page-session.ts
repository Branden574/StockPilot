import 'server-only';

import { combineChunks, stringFromBase64URL } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { env } from '@/lib/env';

/**
 * Who is signed in on the PUBLIC sign page (`/orders/sign/<token>`), verified
 * locally, WITHOUT refreshing the session (plan 13.2 R1, adopted for 0389).
 *
 * The sign page is outside the proxy matcher (src/proxy.ts), and a server
 * component cannot write cookies (lib/supabase/server.ts ignores setAll
 * outside Server Actions and Route Handlers). The usual `getClaims()` /
 * `getUser()` with no argument first LOADS the session, and loading an
 * expired one refreshes it over the network: the rotated refresh token would
 * be dropped on the floor and the browser left holding a spent one. So this
 * reads the access token straight out of the auth cookie and verifies only
 * that token (`getClaims(jwt)`: signature against the project's keys, and an
 * expired token is an error). An expired token is "no session" here; the page
 * then answers its one not-found, and the person reloads after any other page
 * has refreshed their session. The hand-over itself is authorized by the POST
 * route handler, which can persist a refresh.
 *
 * Never throws: anything unreadable is "nobody".
 */

const BASE64_PREFIX = 'base64-';

/** supabase-js's default storage key, which the SSR cookie storage uses as the cookie name. */
export function authCookieKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
}

/**
 * The access token in the (possibly chunked, possibly base64url-encoded) auth
 * cookie, read the way @supabase/ssr's cookie storage reads it, or null.
 */
export async function accessTokenFromAuthCookie(
  getCookie: (name: string) => string | undefined,
  key: string,
): Promise<string | null> {
  try {
    const combined = await combineChunks(key, (name) => getCookie(name) ?? null);
    if (!combined) return null;
    const json = combined.startsWith(BASE64_PREFIX)
      ? stringFromBase64URL(combined.slice(BASE64_PREFIX.length))
      : combined;
    const stored = JSON.parse(json) as {
      access_token?: unknown;
      currentSession?: { access_token?: unknown } | null;
    } | null;
    const token = stored?.access_token ?? stored?.currentSession?.access_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** The verified, unexpired session user of this request's cookies, or null. */
export async function verifiedSessionUserIdWithoutRefresh(): Promise<string | null> {
  try {
    const store = await cookies();
    const token = await accessTokenFromAuthCookie(
      (name) => store.get(name)?.value,
      authCookieKey(env.NEXT_PUBLIC_SUPABASE_URL),
    );
    if (!token) return null;
    const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    // With an explicit token getClaims never loads or refreshes a session; it
    // refuses an expired token (allowExpired is not set) and a bad signature.
    const { data, error } = await client.auth.getClaims(token);
    if (error || !data?.claims) return null;
    const { sub, role } = data.claims as { sub?: unknown; role?: unknown };
    if (role !== 'authenticated') return null;
    return typeof sub === 'string' && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

/** The slice of the admin client the membership read uses. */
interface MembershipClient {
  from(table: string): unknown;
}

interface Chain {
  select(columns: string): Chain;
  eq(column: string, value: string): Chain;
  not(column: string, op: string, value: null): Chain;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Is `userId` an accepted member of `organizationId` whose account is not
 * disabled, and whose membership, if it is a platform impersonation grant,
 * has not expired (is_org_member's rule, all three conditions)? Read with the
 * admin client; a failed read, or an expiry that cannot be read as a time, is
 * "no".
 */
export async function isActiveOrgMember(
  admin: MembershipClient,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  try {
    const [member, profile] = await Promise.all([
      (admin.from('organization_members') as Chain)
        .select('user_id, impersonation_expires_at')
        .eq('organization_id', organizationId)
        .eq('user_id', userId)
        .not('accepted_at', 'is', null)
        .maybeSingle(),
      (admin.from('user_profiles') as Chain)
        .select('disabled_at')
        .eq('id', userId)
        .maybeSingle(),
    ]);
    if (member.error || !member.data) return false;
    // An "Act as" membership (0176) counts only until it expires (review 5).
    const expires = (member.data as { impersonation_expires_at?: unknown }).impersonation_expires_at;
    if (expires != null && !(typeof expires === 'string' && Date.parse(expires) > Date.now())) return false;
    if (profile.error || !profile.data) return false;
    return (profile.data as { disabled_at?: unknown }).disabled_at == null;
  } catch {
    return false;
  }
}
