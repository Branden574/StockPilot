import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  ACCOUNT_NOTE_LIMIT,
  ACCOUNT_NOTE_WINDOW_MS,
  accountNoteKey,
  SESSION_NOTE_WINDOW_MS,
  sessionNoteKey,
  sessionRef,
  verifiedBearerClaims,
} from '@/lib/auth/session-note';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import { emitAuthAudit } from '@/server/services/auth-audit';
import { broadcastEndedSessions, listMySessionIds } from '@/server/services/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The phone's sign-out: the account's other devices are signed out at once,
 * and the sign-out is in the Audit log (S5, plans/S5.md 3.4 step 11).
 *
 * The phone's Sign out was the Auth server's global logout alone. It wrote no
 * user.signed_out row, and the account's other devices kept working on their
 * access tokens for up to an hour, because nothing told their listeners. The
 * phone now sends this note while its session still exists, just before that
 * logout:
 *
 *   1. the account's sessions are listed;
 *   2. every session but this one is revoked (revoke_my_other_sessions), so
 *      when the web listener asks the Auth server about a tab's session, the
 *      answer is that it is gone;
 *   3. only if the revoke answered without error, the sessions it ended are
 *      named on the account's channel ({ sessionIds }), never this one: the
 *      channel is public and this session is still live
 *      (server/services/sessions.ts);
 *   4. one user.signed_out row per session, with a hashed session reference.
 *
 * This session ends with the phone's own logout right after. An AAL1 token is
 * accepted: the Auth server's own global logout, and revoke_my_other_sessions
 * over the Data API, already accept one, so the route adds no power. So
 * withApiContext is asked with allowStepUpPending (S43a; AAL1_ROUTES in
 * src/test/api-step-up.guard.test.ts): a phone can press Sign out with an
 * aal1 session of an account with an authenticator (one added on another
 * device while the app stayed open; the app asks for the code again only at
 * its next launch), and refused there, its other devices would stay signed in
 * for up to an hour and the row would be lost. The context it gets is
 * labelled unsatisfied, so no permission check passes it; the route needs
 * none. A token
 * with no session id revokes nothing (revoke_my_other_sessions(null) would end
 * EVERY session) and its row says so.
 */

const unauthenticated = () => NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

export async function POST(req: Request) {
  try {
    const ctx = await withApiContext(req, { allowStepUpPending: true });
    if (!ctx) return unauthenticated();
    const claims = await verifiedBearerClaims(req, ctx);
    if (!claims) return unauthenticated();
    const sessionId = claims.sessionId;

    let othersRevoked: number | null = null;
    let revokeError: string | null = null;
    if (sessionId) {
      const listed = await listMySessionIds(ctx.supabase);
      const { data, error } = await ctx.supabase.rpc('revoke_my_other_sessions', {
        p_keep_session_id: sessionId,
      });
      if (error) {
        revokeError = error.code || 'unknown';
        void reportError(new Error(`revoke_my_other_sessions refused (${revokeError})`), {
          tag: 'auth.signed_out',
          level: 'warning',
          organizationId: ctx.organizationId,
        });
      } else {
        othersRevoked = typeof data === 'number' ? data : null;
        await broadcastEndedSessions(ctx.userId, listed, sessionId);
      }
    }

    // Once per session; a token with no session id is held to the account's
    // hourly budget instead.
    const write = sessionId
      ? await checkRateLimit(sessionNoteKey('out', sessionId), 1, SESSION_NOTE_WINDOW_MS, 'open')
      : await checkRateLimit(
          accountNoteKey(ctx.userId),
          ACCOUNT_NOTE_LIMIT,
          ACCOUNT_NOTE_WINDOW_MS,
          'open',
        );
    if (write.allowed) {
      await emitAuthAudit({
        event: 'user.signed_out',
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        extra: {
          client: 'mobile',
          scope: 'global',
          email: claims.email,
          session_ref: sessionId ? sessionRef(sessionId) : null,
          others_revoked: othersRevoked,
          revoke_error: revokeError,
          revoke_skipped: !sessionId,
        },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return internalErrorResponse(e, 'auth.signed_out');
  }
}
