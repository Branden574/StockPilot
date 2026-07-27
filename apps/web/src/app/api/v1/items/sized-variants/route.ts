import { NextResponse, type NextRequest } from 'next/server';

import { bulkCreateSizedVariantsSchema } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Create one inventory item per size — the sized-variant fan-out.
 *
 * The web form reaches `InventoryService.bulkCreateSizedVariants` through a
 * server action; the mobile app has no server actions, so before this route
 * existed `apps/mobile/app/item/new.tsx` ran its OWN fan-out against raw
 * PostgREST. That copy carried its own nine-letter apparel list (a shoe run was
 * unexpressible), no cap on how many rows one tap could insert, no size-scale
 * validation, no plan-limit check, no custom-field validation, no permission
 * check, no audit events and no variant columns.
 *
 * There is now ONE implementation of the fan-out. This route parses the SHARED
 * `bulkCreateSizedVariantsSchema` (the exact object the server action parses),
 * rate-limits, delegates, and maps errors. It owns no rule of its own: the
 * per-variant name and SKU, the size-scale check, the derived `variant_size` /
 * `variant_size_system` / `variant_key`, the tracking-type stamp, the warehouse
 * and charter resolution, the initial stock movements and the audit events all
 * live in the service.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle mirroring POST /api/v1/items. One request here can create
  // up to 60 rows (the schema's cap), so the same 60/min budget is deliberately
  // stricter in row terms than the single-create route.
  const rl = await checkRateLimit(`items-sized-create:${ctx.userId}`, 60, 60_000);
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

  const json = await req.json().catch(() => null);
  const parsed = bulkCreateSizedVariantsSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'validation_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid input',
        // The field path lets the native form highlight the offending input
        // instead of showing a bare alert.
        path: parsed.error.issues[0]?.path ?? [],
      },
      { status: 400 },
    );
  }

  try {
    const svc = new InventoryService(ctx);
    const rows = await svc.bulkCreateSizedVariants(parsed.data);

    // New items change the org's cached Items/Books list — invalidate so the
    // next dashboard view sees them (mirrors POST /api/v1/items).
    revalidateInventoryList(ctx.organizationId);

    return NextResponse.json(
      { created: rows.length, ids: rows.map((r) => r.id) },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        // `details` carries the SHOE_SIZE_REQUIRED / VARIANT_ALREADY_EXISTS code
        // when the service set one, so the native client can render the mapped
        // title/action rather than raw text.
        { error: e.code, message: e.message, details: e.details ?? null },
        { status: serviceErrorStatus(e.code) },
      );
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    void reportError(e, { tag: 'api.v1.items.sized-variants.create' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
