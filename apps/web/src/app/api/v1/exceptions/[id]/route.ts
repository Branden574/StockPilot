import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ExceptionOccurrencesService } from '@/server/services/exception-occurrences';

import { exceptionsErrorResponse } from '../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/exceptions/[id] — one stored occurrence with its timeline
 * (oldest first) and its recurrence history (every occurrence of the same
 * identity, newest first), plus the org's sync state. Cookie or Bearer;
 * `items:read`.
 *
 * 404 when the occurrence does not exist OR the caller cannot see it (RLS
 * follows item and holding visibility), so existence is never leaked. No
 * sync (see ../route.ts).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'That exception id is not valid.' },
      { status: 400 },
    );
  }

  try {
    const detail = await new ExceptionOccurrencesService(ctx).get(id);
    return NextResponse.json(
      { organizationId: ctx.organizationId, ...detail },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.exceptions.get', ctx);
  }
}
