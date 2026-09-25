import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ExceptionOccurrencesService } from '@/server/services/exception-occurrences';

import { exceptionsErrorResponse } from './error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/exceptions?status=open|resolved — the stored Exception Center
 * list (F1-1), for the phone and any REST consumer. Cookie or Bearer
 * (withApiContext); `items:read` (403 without it).
 *
 * ONE READ, NO SYNC. Owner decision (F1 Q9): freshness must not slow a page
 * or the system down, so this route only reads the stored occurrences under
 * the caller's RLS and returns `syncState` ("Checked at" = lastSyncedAt; null
 * before the org's first check, which the client must show as "not checked
 * yet", never as all clear). The cron, a posted or cancelled count and
 * "Check now" are what refresh the store.
 *
 * `status` defaults to open; anything but `resolved` reads as open. A failed
 * read is a 500, never an empty list.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const status =
    new URL(req.url).searchParams.get('status') === 'resolved' ? 'resolved' : 'open';
  try {
    const result = await new ExceptionOccurrencesService(ctx).list({ status });
    return NextResponse.json(
      { organizationId: ctx.organizationId, ...result },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.exceptions.list', ctx);
  }
}
