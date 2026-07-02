import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * QA-only: mint a password-recovery /auth/confirm URL for the DEMO
 * account so the emailed-link flow can be end-to-end tested without a
 * mailbox (Sensitive env vars make this impossible to do locally — same
 * rationale as /api/admin/backfill-item-thumbs).
 *
 * Guardrails:
 *  - Bearer BACKFILL_ADMIN_SECRET (timingSafeEqual, fail-closed when unset).
 *  - HARDCODED allowlist: only the demo QA account. A recovery link is an
 *    account-takeover primitive, so this must never work for a real user's
 *    email, no matter who holds the secret.
 */
const QA_EMAILS = new Set(['demo@stockpilotusa.com']);

function isAuthorized(req: NextRequest): boolean {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const secret = env.BACKFILL_ADMIN_SECRET;
  if (!secret || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.toLowerCase() ?? '';
  if (!QA_EMAILS.has(email)) {
    return NextResponse.json({ error: 'email not in QA allowlist' }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/reset/complete` },
  });
  const hashedToken = data?.properties?.hashed_token;
  if (error || !hashedToken) {
    return NextResponse.json({ error: error?.message ?? 'no token' }, { status: 500 });
  }
  return NextResponse.json({
    confirmUrl: `${env.NEXT_PUBLIC_APP_URL}/auth/confirm?token_hash=${encodeURIComponent(hashedToken)}&type=recovery&next=${encodeURIComponent('/reset/complete')}`,
  });
}
