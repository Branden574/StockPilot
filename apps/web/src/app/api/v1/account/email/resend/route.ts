import { NextResponse, type NextRequest } from 'next/server';

import { apiContextGate } from '@/server/lib/api-context-gate';
import { emailChangeErrorResponse, mfaPostureFromContext } from '@/server/lib/email-change-api';
import { resendEmailChange } from '@/server/services/email-change';

export const runtime = 'nodejs';

/**
 * POST /api/v1/account/email/resend — re-sends both links for the pending
 * address. The same authenticator answers as a request (aal2_required,
 * mfa_required), before anything is spent.
 */
export async function POST(req: NextRequest) {
  // First, before the body or anything else: a context that could not be
  // built because the caller's access could not be read answers the 503 the
  // phone may send again (server/lib/api-context-gate.ts).
  const gate = await apiContextGate(req);
  if ('response' in gate) return gate.response;
  const ctx = gate.ctx;
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const result = await resendEmailChange({
      userId: ctx.userId,
      mfa: mfaPostureFromContext(ctx),
      source: 'mobile',
    });
    return NextResponse.json(result);
  } catch (e) {
    return emailChangeErrorResponse(e);
  }
}
