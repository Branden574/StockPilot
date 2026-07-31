import 'server-only';

import type { SessionRevokedReason } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { broadcastToChannel } from '@/lib/realtime/broadcast';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Revoke EVERY auth session belonging to one user, by user id, and evict their
 * live devices immediately.
 *
 * This is the only supported by-user-id revocation in the codebase:
 *
 *   - migration 0213's revoke_my_session / revoke_my_other_sessions are
 *     auth.uid()-scoped, so an admin cannot use them against someone else;
 *   - the installed auth-js 2.105.1 has NO signOut-by-user-id — its
 *     `signOut(jwt, scope)` takes a JWT, which is why the previous
 *     `admin.auth.admin.signOut(userId, 'global')` in TeamService could never
 *     have worked;
 *   - the service-role client cannot run raw SQL against the auth schema.
 *
 * So it goes through the SECURITY DEFINER function added in 0308, which deletes
 * the user's auth.sessions rows. auth.refresh_tokens cascades on that delete,
 * so the next refresh attempt fails and the device is out for good once its
 * current access token expires. `createAdminClient()` is mandatory here: 0308
 * grants EXECUTE to service_role ONLY, so a user-authed client (ctx.supabase)
 * cannot reach the function at all.
 *
 * TWO LAYERS, TWO FAILURE POSTURES:
 *
 *   1. The RPC is authoritative. Its outcome is returned as `ok` so the caller
 *      always KNOWS — the bug this replaces survived for so long precisely
 *      because a failed revocation looked like a success. It is deliberately
 *      NOT thrown: both callers (member removal, account disable) have already
 *      committed the authoritative change before they get here, so a throw
 *      would abandon their audit trail mid-flight. Callers that must not
 *      proceed on failure branch on `ok`; every caller must record it.
 *   2. The broadcast is best-effort UX and is never allowed to fail the call.
 *      It only closes the ~1h gap in which a device coasts on an access token
 *      that was minted before the revoke. If Realtime is down, the security
 *      outcome is unchanged — just slower — so a dead socket must not turn a
 *      landed revocation into a reported failure. It is skipped entirely when
 *      the RPC failed: telling devices to sign out when nothing was actually
 *      revoked would bounce them to /signin and straight back in on a session
 *      that is still live.
 */
export async function revokeAllSessionsForUser(
  userId: string,
  options: {
    /**
     * WHAT kind of revocation this is, carried to the live devices in the
     * broadcast below. Supply it ONLY when the device needs to behave
     * differently — today that means a platform account disable, which the
     * device cannot otherwise detect once its session is gone. Omit it for an
     * ordinary revocation (member removal) and the payload keeps its
     * pre-existing shape exactly.
     */
    reason?: SessionRevokedReason;
  } = {},
): Promise<{ ok: boolean; sessionIds: string[] }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('admin_revoke_user_sessions', {
    p_target_user_id: userId,
  });

  if (error) {
    await reportError(new Error(error.message), {
      tag: 'platform.revoke-sessions',
      extra: { userId },
    });
    return { ok: false, sessionIds: [] };
  }

  // `returns setof uuid` arrives as a bare string array over PostgREST, but
  // tolerate the row-shaped form too so a later `returns table(id uuid)` does
  // not silently start reporting zero revoked sessions.
  const rows = (data ?? []) as unknown;
  const sessionIds = Array.isArray(rows)
    ? rows
        .map((r) => (typeof r === 'string' ? r : ((r as { id?: unknown })?.id as string | undefined)))
        .filter((id): id is string => typeof id === 'string')
    : [];

  // Live force-logout on the device-management channel. `keepId: null` is the
  // established "sign out EVERYWHERE" payload (server/actions/auth.ts uses it
  // for global sign-out and password reset): the web and mobile listeners
  // target themselves whenever a payload carries a `keepId` that is not their
  // own session id, so null reaches all of them, and they answer with
  // signOut({ scope: 'local' }) because the server-side revoke above is what
  // is authoritative. The `sessionIds` payload variant would be weaker here —
  // a device whose JWT names a session row that had already gone would not
  // match and would coast to token expiry.
  //
  // `reason` rides along ONLY when the caller named one, so an ordinary
  // revocation still puts the identical `{ keepId: null }` bytes on the wire it
  // always has. It is the one thing a device cannot work out for itself after
  // the revoke above: its own getUser() can only answer `session_not_found`
  // from here on, so without this a platform disable and a plain
  // sign-out-everywhere are indistinguishable on the device and the disabled
  // screen can never appear. It names the KIND of event and nothing else — the
  // channel is public (`private: false`), so the operator's reason text, the
  // category and the actor stay strictly server-side.
  //
  // broadcastToChannel swallows its own errors, but it is awaited inside a
  // try/catch anyway so this function's contract does not depend on that.
  try {
    const payload: { keepId: null; reason?: SessionRevokedReason } = { keepId: null };
    if (options.reason) payload.reason = options.reason;
    await broadcastToChannel(`user:${userId}:sessions`, 'revoked', payload);
  } catch (e) {
    console.error('[platform.revoke-sessions] eviction broadcast failed (non-fatal):', e);
  }

  return { ok: true, sessionIds };
}
