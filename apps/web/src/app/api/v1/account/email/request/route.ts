import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { emailChangeErrorResponse, mfaPostureFromContext } from '@/server/lib/email-change-api';
import { requestEmailChange } from '@/server/services/email-change';

import { changeEmailSchema } from '@stockpilot/core';

export const runtime = 'nodejs';

/**
 * POST /api/v1/account/email/request — mobile twin of requestEmailChangeAction.
 *   body: { newEmail, currentPassword }
 *   200: { pendingEmail, sentAt, expiresAt }
 *   400 validation_error · 403 forbidden | aal2_required · 409 conflict · 429 rate_limited
 * withApiContext already refused disabled accounts with a 401; the service
 * repeats that check (plus deleted_at) before anything is spent.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // falls through to validation
  }
  const parsed = changeEmailSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  try {
    const result = await requestEmailChange({
      userId: ctx.userId,
      newEmail: parsed.data.newEmail,
      currentPassword: parsed.data.currentPassword,
      mfa: mfaPostureFromContext(ctx),
      source: 'mobile',
    });
    return NextResponse.json(result);
  } catch (e) {
    return emailChangeErrorResponse(e);
  }
}
