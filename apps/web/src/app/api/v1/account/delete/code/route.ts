import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { createAdminClient } from '@/lib/supabase/admin';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import {
  ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY,
  ACCOUNT_DELETE_CODE_SEND_FAILED_COPY,
  ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY,
  ACCOUNT_DELETE_CODE_SENT_COPY,
  sendDeletionCode,
} from '@/server/lib/account-deletion-credential';

export const runtime = 'nodejs';

/**
 * POST /api/v1/account/delete/code: the phone's twin of the web's
 * requestAccountDeletionCodeAction. Emails a six-digit code that confirms
 * deleting the caller's own account, to the account's current sign-in
 * address, for an account with no authenticator
 * (server/lib/account-deletion-credential).
 *
 *   body: none
 *   200: { ok: true, challenge, expiresAt, message } // send challenge + code to /api/v1/account/delete
 *   401: { error: "unauthenticated" }
 *   409: { error: "not_offered", message }   // the account has an authenticator: its code confirms
 *   429: { error: "rate_limited", message }  // 5 codes per 15 minutes per account
 *   503: { error: "send_failed", message }   // nothing was sent: try again, or use the password
 *
 * `expiresAt` is whole UTC seconds. The challenge holds no code; the code is
 * only in the email.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  try {
    const sent = await sendDeletionCode({ admin: createAdminClient(), userId: ctx.userId });
    if (sent.ok) {
      return NextResponse.json({
        ok: true,
        challenge: sent.challenge,
        expiresAt: sent.expiresAt,
        message: ACCOUNT_DELETE_CODE_SENT_COPY,
      });
    }
    switch (sent.kind) {
      case 'not_offered':
        return NextResponse.json(
          { error: 'not_offered', message: ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY },
          { status: 409 },
        );
      case 'rate_limited':
        return NextResponse.json(
          { error: 'rate_limited', message: ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY },
          { status: 429 },
        );
      case 'gone':
        return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
      default:
        return NextResponse.json(
          { error: 'send_failed', message: ACCOUNT_DELETE_CODE_SEND_FAILED_COPY },
          { status: 503 },
        );
    }
  } catch (e) {
    return internalErrorResponse(e, 'api.v1.account.delete.code', {
      organizationId: ctx.organizationId,
    });
  }
}
