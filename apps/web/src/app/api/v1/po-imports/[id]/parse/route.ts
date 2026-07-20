import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Parsing downloads the stored file and runs the PDF/CSV parser — large
// multi-page POs need headroom beyond the default function timeout.
export const maxDuration = 60;

/**
 * Mobile "Re-parse import" — Bearer parity for web's parsePoImportAction.
 * Reuses PoImportsService.parseImport verbatim (module gate,
 * purchase_orders:manage assert, org-scoped header read → not_found for
 * foreign or unknown ids, wipe-and-reinsert lines, status transition). Same
 * states web allows: parseImport itself records a parse failure as
 * status='failed' and RESOLVES, so a 200 here means "parse ran", not
 * "parse succeeded" — the client re-reads the import's status, exactly like
 * the web review page does. No body.
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
    await svc.parseImport(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.po-imports.parse' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
