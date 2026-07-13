import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createSupportTicket } from '@/server/services/support-tickets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile "Support & feedback" submission — the Bearer-authed twin of the web
 * submitDashboardTicketAction. Identity (org + user + email) comes from the
 * session, never the client. Optional screenshot is uploaded by the app to the
 * private support-attachments bucket under `${userId}/…` first (mig 0260
 * storage policy), then its path is passed here; we re-assert the prefix so a
 * forged path can't attach someone else's upload.
 */
const schema = z.object({
  category: z.enum(['bug', 'feature', 'billing', 'other']),
  subject: z.string().trim().min(3, 'Add a short subject').max(140),
  message: z.string().trim().min(10, 'Tell us a little more').max(4000),
  attachmentPath: z.string().trim().min(1).max(300).optional(),
});

export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Please check the form.' },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // Attachment must live under the caller's own uid folder (mirror the web
  // action + the mig 0260 storage INSERT policy).
  if (data.attachmentPath && !data.attachmentPath.startsWith(`${ctx.userId}/`)) {
    return NextResponse.json(
      { error: 'invalid_attachment', message: 'Invalid attachment. Please re-attach your screenshot.' },
      { status: 400 },
    );
  }

  // Authenticated surface; generous per-user cap, fail-closed (a limiter
  // outage must not open the floodgates) — same bucket as the web action.
  const limit = await checkRateLimit(`support:user:${ctx.userId}`, 10, 60 * 60 * 1000, 'closed');
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many tickets in the last hour. Please try again later.' },
      { status: 429 },
    );
  }

  // Identity from the session (never the client body).
  const {
    data: { user },
  } = await ctx.supabase.auth.getUser();
  const email = user?.email ?? null;
  if (!email) {
    return NextResponse.json(
      { error: 'no_email', message: 'Your account has no email on file to reply to.' },
      { status: 400 },
    );
  }
  const { data: prof } = await ctx.supabase
    .from('user_profiles')
    .select('full_name')
    .eq('id', ctx.userId)
    .maybeSingle();

  try {
    const res = await createSupportTicket({
      name: (prof?.full_name as string | null) ?? null,
      email,
      category: data.category,
      subject: data.subject,
      message: data.message,
      pageUrl: 'mobile',
      userAgent: req.headers.get('user-agent') ?? null,
      organizationId: ctx.organizationId,
      submittedBy: ctx.userId,
      attachmentPath: data.attachmentPath ?? null,
    });
    return NextResponse.json({ ok: true, id: res.id });
  } catch (e) {
    void reportError(e, {
      tag: 'support-tickets.api-create',
      organizationId: ctx.organizationId,
      userIdHash: ctx.userId,
    });
    return NextResponse.json(
      { error: 'internal_error', message: 'Could not submit your request. Please try again.' },
      { status: 500 },
    );
  }
}
