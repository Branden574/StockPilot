import { NextResponse, type NextRequest } from 'next/server';

import { apiContextGate } from '@/server/lib/api-context-gate';
import { emailChangeErrorResponse } from '@/server/lib/email-change-api';
import { cancelEmailChange } from '@/server/services/email-change';

export const runtime = 'nodejs';

/** POST /api/v1/account/email/cancel — abandons the pending change. */
export async function POST(req: NextRequest) {
  // First, before the body or anything else: a context that could not be
  // built because the caller's access could not be read answers the 503 the
  // phone may send again (server/lib/api-context-gate.ts).
  const gate = await apiContextGate(req);
  if ('response' in gate) return gate.response;
  const ctx = gate.ctx;
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const result = await cancelEmailChange({ userId: ctx.userId, source: 'mobile' });
    return NextResponse.json(result);
  } catch (e) {
    return emailChangeErrorResponse(e);
  }
}
