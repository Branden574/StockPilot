import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import { RentalsService } from '@/server/services/rentals';

import { createRentalSchema } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile rental checkout — the Bearer twin of createRentalAction (SP-012).
 *
 * WHY THIS ROUTE EXISTS. apps/mobile/app/rentals/new.tsx used to write a
 * `rentals` header row STRAIGHT TO THE TABLE. RLS 0131 accepts it — its only
 * gate is `user_can_access_warehouse(auth.uid(), warehouse_id, 'write')` — so
 * the insert always "succeeded", while every guarantee a rental depends on was
 * silently skipped:
 *   • no `rental_lines`, so the rental carried no inventory linkage at all and
 *     there is no add-line path anywhere to attach items to it afterwards;
 *   • no `stock_reservations`. That table is service-role-only (migs
 *     0119/0263), so a direct-Supabase client CANNOT reserve, no matter what
 *     it tries — the checked-out asset stayed fully available-to-promise and
 *     could be rented again from the web to a second borrower;
 *   • no `rentals:create` assertion (RLS never checks the configurable
 *     permission), no is_rental / warehouse validation, no over-lend refusal
 *     (SP-052), no audit row, no checkout email.
 * RentalsService.create does all eight. The parity rule in this repo is that
 * mobile WRITES go through /api/v1 rather than the table, precisely so a
 * screen cannot re-implement half a service by accident.
 *
 * The service is the only authority here: this handler validates the envelope
 * and translates errors. Note in particular that a checkout can now legitimately
 * FAIL (insufficient availability, non-rental item, wrong warehouse) where the
 * direct insert always succeeded — those come back as 400 with the service's
 * own operator-readable sentence, which the app shows verbatim.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  try {
    // `.catch(() => null)` because a truncated/garbage body from a flaky mobile
    // connection must be a 400, not an unhandled throw that reports as a 500 and
    // makes the offline outbox retry a permanently-bad payload forever.
    const json = await req.json().catch(() => null);
    const parsed = createRentalSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400 },
      );
    }

    const svc = new RentalsService(ctx);
    const result = await svc.create(parsed.data);
    // No revalidatePath here, unlike createRentalAction. The dashboard rentals
    // pages are per-user dynamic RSCs (requireOrgContext reads cookies), so
    // there is no shared full-route cache for a Bearer caller to invalidate —
    // and every other /api/v1 twin in this app follows the same rule. The
    // phone refreshes its own list on return.
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ServiceError) {
      // Map EVERY code the service can raise. A refusal that falls through to
      // 500 reads to the caller as "the server is broken, retry" — and the
      // mobile client does exactly that (SP-124, api/v1/po/[id]/receive-line).
      const status =
        e.code === 'conflict'
          ? 409
          : e.code === 'forbidden' ||
              e.code === 'module_disabled' ||
              e.code === 'plan_limit_exceeded'
            ? 403
            : e.code === 'not_found'
              ? 404
              : e.code === 'validation_error'
                ? 400
                : e.code === 'unauthenticated'
                  ? 401
                  : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    // assertWarehouseAccess throws this, not a ServiceError — without the arm
    // a warehouse-scoped refusal would surface as an opaque 500.
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    // Deliberately body-less: a raw PostgREST/RLS string names tables, columns
    // and policies (S13). The detail goes to the reporter, not the phone.
    void reportError(e, { tag: 'api.v1.rentals.create', organizationId: ctx.organizationId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
