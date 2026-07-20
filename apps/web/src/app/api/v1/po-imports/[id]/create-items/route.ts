import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';
import { createItemsFromPoLinesSchema } from '@/server/services/po-imports-lines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Sequential per-line lookups + inventory creates + mapping upserts — a
// 200-line import needs headroom beyond the default function timeout.
export const maxDuration = 60;

/**
 * Mobile "create items from lines" — Bearer parity for web's
 * createItemsFromPoLinesAction. Reuses PoImportsService.createItemsFromLines,
 * which wraps the SAME shared implementation the web action uses
 * (selected-charter-wins, advisory-only barcode/ISBN matching, item_created
 * bookkeeping, vendor-mapping upserts; foreign/unknown import id →
 * not_found). Body mirrors the web action's input minus poImportId, which
 * comes from the path.
 *
 * → 200 { ok: true, created, mapped, linked, skipped } (counts, verbatim
 *   from the shared implementation)
 */
const bodySchema = createItemsFromPoLinesSchema.omit({ poImportId: true });

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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'validation_error', message: 'Request body must be JSON.' },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  try {
    const svc = new PoImportsService(ctx);
    const result = await svc.createItemsFromLines({ ...parsed.data, poImportId: id });

    // New items change the Items/Books list — refresh the org's cached
    // inventory list, mirroring the web action's
    // revalidateInventoryListForCurrentOrg (and transfer/restore's posture).
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.po-imports.create-items' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
