import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { emailChangeErrorResponse } from '@/server/lib/email-change-api';
import { cancelEmailChange } from '@/server/services/email-change';

export const runtime = 'nodejs';

/** POST /api/v1/account/email/cancel — abandons the pending change. */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const result = await cancelEmailChange({ userId: ctx.userId, source: 'mobile' });
    return NextResponse.json(result);
  } catch (e) {
    return emailChangeErrorResponse(e);
  }
}
