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
 * Mobile "Cancel import" — Bearer parity for web's cancelPoImportAction.
 * Reuses PoImportsService.cancel verbatim (module gate,
 * purchase_orders:manage assert, org-scoped guarded update, best-effort
 * archive of items the import auto-created). No body.
 *
 * The org-scoped svc.get() runs FIRST because cancel() alone reports a
 * 0-row update as 'conflict' — it cannot distinguish "unknown/foreign id"
 * from "already approved/canceled". The pinned mobile contract wants a
 * clean 404 for ids outside the caller's org, and 409 stays reserved for
 * genuinely-finalized imports.
 *
 * → 200 { ok: true }
 */
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

  try {
    const svc = new PoImportsService(ctx);
    // Foreign-org / unknown id → not_found (404) via the org-scoped read.
    await svc.get(id);
    // State transition + permission gate + cleanup live in the service.
    await svc.cancel(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.po-imports.cancel' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
