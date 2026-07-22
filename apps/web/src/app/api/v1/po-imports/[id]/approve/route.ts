import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';

import { approvePoImportSchema } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Approve fans out into per-line queries (charter re-resolution can create
// sibling items) plus the PO + charges inserts — give large imports headroom
// beyond the default function timeout.
export const maxDuration = 60;

/**
 * Mobile "Approve import" — Bearer parity for web's approvePoImportAction.
 * Reuses PoImportsService.approve verbatim (module gate,
 * purchase_orders:manage assert, org-scoped get() → not_found for foreign or
 * unknown ids, item-ownership re-resolution ONLY when itemCharterId is
 * supplied, required destination location). charterId here is BILL-TO
 * metadata and never affects placement. Body is the SAME zod contract as the web action minus
 * poImportId, which comes from the path.
 *
 * → 200 { ok: true, poId }
 */
const bodySchema = approvePoImportSchema.omit({ poImportId: true });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle shared across the po-imports write family —
  // defense-in-depth on top of the service's purchase_orders:manage gate,
  // matching items/restore's posture (60/min is far above human tapping).
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
    const { poId } = await svc.approve({ ...parsed.data, poImportId: id });
    return NextResponse.json({ ok: true, poId });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.po-imports.approve' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
