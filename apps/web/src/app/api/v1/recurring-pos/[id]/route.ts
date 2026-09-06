import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { planAllowsRecurringPos, type OrgBillingState } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import {
  assertModuleEnabled,
  assertPermission,
  serviceErrorStatus,
  ServiceError,
  type ServiceContext,
} from '@/server/services/context';
import { RecurringPoTemplatesService } from '@/server/services/recurring-pos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Recurring PO template pause/resume + delete — the Bearer twin of
 * `setRecurringTemplateEnabledAction` / `deleteRecurringTemplateAction`.
 *
 * WHY THIS ROUTE EXISTS (SP-122). The mobile screen used to toggle and delete
 * these rows with a direct PostgREST write. RLS accepted it (manager+ /
 * purchase_orders:manage — the same floor the service asserts) and the daily
 * cron re-checks the plan tier, so nothing was over-permitted. What the direct
 * write skipped was the AUDIT ROW: `audit_logs` is written app-side only
 * (server/services/audit.ts, via the service-role client — there is no DB
 * trigger, and the table's only policy is SELECT), so a template disabled or
 * deleted from a phone left no trace at all. The org reads that same table on
 * the phone (app/(drawer)/admin/audit.tsx), so "why did the monthly PO stop?"
 * had an answer on web and a blank on mobile. Routing the write through the
 * service closes it: RecurringPoTemplatesService.setEnabled/remove audit with
 * the ctx passed in (Bearer callers MUST pass ctx or audit()'s withContext()
 * fallback throws NEXT_REDIRECT and the event is dropped — see audit.ts and
 * recurring bug pattern #23), and they also stamp `updated_by`, which the
 * direct write never did.
 *
 * Gate order mirrors the web action's runGate() exactly:
 *   MFA (inside assertPermission) -> purchase_orders:manage -> module enabled
 *   -> Pro+ plan (ENABLE only) -> service call (which re-asserts + audits).
 * Permission is checked BEFORE the plan read on purpose: gating on plan first
 * would answer `plan_limit_exceeded` to a caller whose real problem is that
 * they may not touch purchase orders at all.
 */

const patchSchema = z.object({ enabled: z.boolean() });

function badId() {
  return NextResponse.json(
    { error: 'validation_error', message: 'That template id is not valid.' },
    { status: 400 },
  );
}

function fail(e: unknown, tag: string) {
  if (e instanceof ServiceError) {
    return NextResponse.json(
      { error: e.code, message: e.message },
      { status: serviceErrorStatus(e.code) },
    );
  }
  void reportError(e, { tag });
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}

/**
 * Pro+ entitlement, mirroring `runGate()` in server/actions/recurring-pos.ts.
 * A missing org row falls into the `{ plan: null }` default so the gate fails
 * CLOSED with a clean plan_limit_exceeded rather than an opaque 500.
 */
async function assertPlanAllowsRecurringPos(ctx: ServiceContext) {
  const { data: orgRow, error } = await ctx.supabase
    .from('organizations')
    .select('plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier')
    .eq('id', ctx.organizationId)
    .maybeSingle();
  if (error) throw new ServiceError('internal_error', error.message);
  if (!planAllowsRecurringPos((orgRow as OrgBillingState | null) ?? { plan: null })) {
    throw new ServiceError(
      'plan_limit_exceeded',
      'Recurring purchase orders is a Pro feature. Upgrade to Pro or above to use it.',
    );
  }
}

/** Pause / resume a template. Body: `{ enabled: boolean }`. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  // Validate the id at the untrusted edge: a malformed value reaching
  // `.eq('id', id)` surfaces as an opaque Postgres 22P02 internal_error
  // instead of a 400 (the convention every sibling v1 [id] route follows).
  if (!z.string().uuid().safeParse(id).success) return badId();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Send { "enabled": true | false }.' },
      { status: 400 },
    );
  }

  try {
    assertPermission(ctx, 'purchase_orders:manage');
    assertModuleEnabled(ctx, 'purchase_orders');
    // Plan gate on ENABLE only — turning a template OFF must always be
    // possible, including for an org that has dropped off Pro (same carve-out
    // as the web action and auto-reorder).
    if (parsed.data.enabled) await assertPlanAllowsRecurringPos(ctx);

    await new RecurringPoTemplatesService(ctx).setEnabled(id, parsed.data.enabled);
    return NextResponse.json({ ok: true, id, enabled: parsed.data.enabled });
  } catch (e) {
    return fail(e, 'api.v1.recurring-pos.set-enabled');
  }
}

/** Delete a template. No plan gate — deleting is always allowed. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return badId();

  try {
    assertPermission(ctx, 'purchase_orders:manage');
    assertModuleEnabled(ctx, 'purchase_orders');

    await new RecurringPoTemplatesService(ctx).remove(id);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return fail(e, 'api.v1.recurring-pos.remove');
  }
}
