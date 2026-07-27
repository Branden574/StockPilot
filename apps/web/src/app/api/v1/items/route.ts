import { NextResponse, type NextRequest } from 'next/server';

import { createItemSchema } from '@stockpilot/core';

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
 * Create one inventory item.
 *
 * The mobile app has no server actions, so item creation goes through here
 * with the standard Bearer-token auth. Mirrors createItemAction on the web and
 * shares its EXACT zod schema, so a payload valid on one surface is valid on
 * the other. Everything the raw-PostgREST mobile path used to skip —
 * permission, plan limit, custom-field validation, warehouse resolution and
 * access, charter/warehouse pairing, the sports tracking profile, the audit
 * event and the search embedding — is enforced here by InventoryService.
 * This route does NOT duplicate any of those rules itself; it only parses,
 * rate-limits, delegates to InventoryService.create(), and maps errors.
 *
 * `variant_key`/`group_key` are never accepted from a client: createItemSchema
 * has no such fields (Task 7), and InventoryService computes both
 * server-side from the caller's variant attributes (Task 8) — a forged value
 * in the body is silently ignored, never trusted.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle — defense-in-depth on top of the service's items:create
  // permission gate and plan-limit check. 60/min mirrors the other
  // item-mutation routes (remove-stock, transfer, restore).
  const rl = await checkRateLimit(`items-create:${ctx.userId}`, 60, 60_000);
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
  const parsed = createItemSchema.safeParse(json);
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
    const item = await svc.create(parsed.data);

    // A new item changes the org's cached Items/Books list — invalidate so
    // the next dashboard view sees it (mirrors remove-stock/transfer/restore).
    revalidateInventoryList(ctx.organizationId);

    return NextResponse.json({ id: item.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        // `details` carries the SPORTS_* code when the service set one, so the
        // native client can render the mapped title/action rather than raw text.
        { error: e.code, message: e.message, details: e.details ?? null },
        { status: serviceErrorStatus(e.code) },
      );
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    void reportError(e, { tag: 'api.v1.items.create' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
