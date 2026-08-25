import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { emailChangeErrorResponse, mfaPostureFromContext } from '@/server/lib/email-change-api';
import { resendEmailChange } from '@/server/services/email-change';

export const runtime = 'nodejs';

/** POST /api/v1/account/email/resend — re-sends both links for the pending address. */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
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
