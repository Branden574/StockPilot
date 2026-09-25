import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { exceptionsErrorResponse } from '@/app/api/v1/exceptions/error-response';
import { withApiContext } from '@/lib/auth/api-context';
import { ExceptionOccurrencesService } from '@/server/services/exception-occurrences';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/cycle-counts/[id]/exceptions — the exceptions linked to this
 * count as its recount (F1-2), for the count screen's "Linked exceptions"
 * block and each linked line's "where the difference lands". Cookie or
 * Bearer; `items:read`.
 *
 * Every exception a recount_linked event names for this count, as the caller
 * may see it (occurrence RLS), each with its item's line in the count
 * (counted, the book at count time, the counted location), what the count
 * came to for it (`outcome`, core recountOutcome), and where the line's
 * difference lands when posted (`destination` / `reviewLine`, core
 * varianceDestination). `active` is true while this count is the exception's
 * current recount.
 *
 * 404 when the count does not exist or is not visible. A failed read is a
 * 500, never an empty list: the screen must say "unavailable", not "none".
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'That cycle count id is not valid.' },
      { status: 400 },
    );
  }

  try {
    const result = await new ExceptionOccurrencesService(ctx).listForCount(id);
    return NextResponse.json(
      { organizationId: ctx.organizationId, ...result },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.cycle_counts.exceptions', ctx);
  }
}
