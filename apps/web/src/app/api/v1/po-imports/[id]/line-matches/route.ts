import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile "duplicate candidates" lookup — Bearer parity for web's
 * findDuplicatesForPoLinesAction. Reuses
 * PoImportsService.findDuplicatesForLines, which wraps the SAME shared
 * implementation the web action uses (barcode = high confidence, cleaned-name
 * = low confidence; result keyed by line id, verbatim). The shared function
 * org-scopes the import id → not_found for foreign or unknown ids.
 *
 * Body { lineIds?: string[] } — omitted means "all lines of this import"
 * (capped at 200, the same ceiling the explicit-ids form enforces).
 *
 * → 200 { ok: true, matches: Record<lineId, DuplicateCandidate[]> }
 */
const bodySchema = z.object({
  lineIds: z.array(z.string().uuid()).min(1).max(200).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = await checkRateLimit(`po-imports:write:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests — slow down.' },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Invalid import id.' },
      { status: 400 },
    );
  }

  // The whole body is optional — a bare POST means "match all lines". Only a
  // PRESENT-but-malformed body is a 400 (handled by the schema below).
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  try {
    const svc = new PoImportsService(ctx);
    const { matches } = await svc.findDuplicatesForLines({
      poImportId: id,
      lineIds: parsed.data.lineIds,
    });
    return NextResponse.json({ ok: true, matches });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.po-imports.line-matches' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
