'use server';

import { revalidatePath } from 'next/cache';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';
import {
  RecurringPoTemplatesService,
  recurringTemplateSchema,
  type RecurringTemplateInput,
} from '@/server/services/recurring-pos';

import {
  err,
  hasPermission,
  ok,
  planAllowsRecurringPos,
  type ActionResult,
  type OrgBillingState,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Recurring PO template CRUD actions.
// Gate sequence (mirrors auto-reorder-settings.ts verbatim):
//   validate → withContext → MFA fail-closed → purchase_orders:manage →
//   module-enabled → Pro+ effective-plan via planAllowsRecurringPos →
//   service call → audit → revalidatePath('/dashboard/purchase-orders/recurring')
// The plan gate is enforced here because the service itself does not gate plan.
// ---------------------------------------------------------------------------

const REVALIDATE_PATH = '/dashboard/purchase-orders/recurring';

async function runGate(opts?: { skipPlanGate?: boolean }) {
  const ctx = await withContext();

  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    return {
      ctx: null as never,
      error: err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      ),
    } as const;
  }

  if (!hasPermission(ctx.role, 'purchase_orders:manage')) {
    return {
      ctx: null as never,
      error: err('forbidden', 'You do not have permission to manage purchase orders.'),
    } as const;
  }

  if (!ctx.enabledModules.has('purchase_orders')) {
    return {
      ctx: null as never,
      error: err('forbidden', 'Purchase Orders is not enabled for this organization.'),
    } as const;
  }

  if (!opts?.skipPlanGate) {
    const { data: orgRow, error: orgErr } = await ctx.supabase
      .from('organizations')
      .select(
        'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
      )
      .eq('id', ctx.organizationId)
      .single();
    if (orgErr) throw new ServiceError('internal_error', orgErr.message);
    if (!planAllowsRecurringPos((orgRow as OrgBillingState | null) ?? { plan: null })) {
      return {
        ctx: null as never,
        error: err(
          'plan_limit_exceeded',
          'Recurring purchase orders is a Pro feature. Upgrade to Pro or above to use it.',
        ),
      } as const;
    }
  }

  return { ctx, error: null } as const;
}

// ── createRecurringTemplateAction ────────────────────────────────────────────

export async function createRecurringTemplateAction(
  input: RecurringTemplateInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = recurringTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input.');
  }

  try {
    const { ctx, error } = await runGate();
    if (error) return error;

    const result = await new RecurringPoTemplatesService(ctx).create(parsed.data);

    await audit({
      event: 'recurring_po_template.created',
      entityType: 'recurring_po_template',
      entityId: result.id,
      extra: { name: parsed.data.name },
    });

    revalidatePath(REVALIDATE_PATH);
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

// ── updateRecurringTemplateAction ────────────────────────────────────────────

export async function updateRecurringTemplateAction(
  id: string,
  input: RecurringTemplateInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = recurringTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input.');
  }
  if (!id) return err('validation_error', 'Template ID is required.');

  try {
    const { ctx, error } = await runGate();
    if (error) return error;

    const result = await new RecurringPoTemplatesService(ctx).update(id, parsed.data);

    await audit({
      event: 'recurring_po_template.updated',
      entityType: 'recurring_po_template',
      entityId: id,
      extra: { name: parsed.data.name },
    });

    revalidatePath(REVALIDATE_PATH);
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

// ── setRecurringTemplateEnabledAction ────────────────────────────────────────

export async function setRecurringTemplateEnabledAction(
  id: string,
  enabled: boolean,
): Promise<ActionResult<{ id: string }>> {
  if (!id) return err('validation_error', 'Template ID is required.');

  try {
    // Plan gate only when ENABLING (you can always turn it off — mirrors auto-reorder).
    const { ctx, error } = await runGate({ skipPlanGate: !enabled });
    if (error) return error;

    const result = await new RecurringPoTemplatesService(ctx).setEnabled(id, enabled);

    await audit({
      event: 'recurring_po_template.toggled',
      entityType: 'recurring_po_template',
      entityId: id,
      extra: { enabled },
    });

    revalidatePath(REVALIDATE_PATH);
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

// ── deleteRecurringTemplateAction ────────────────────────────────────────────

export async function deleteRecurringTemplateAction(
  id: string,
): Promise<ActionResult<void>> {
  if (!id) return err('validation_error', 'Template ID is required.');

  try {
    // Deletion does not require a plan gate (can always delete).
    const { ctx, error } = await runGate({ skipPlanGate: true });
    if (error) return error;

    await new RecurringPoTemplatesService(ctx).remove(id);

    await audit({
      event: 'recurring_po_template.deleted',
      entityType: 'recurring_po_template',
      entityId: id,
      extra: {},
    });

    revalidatePath(REVALIDATE_PATH);
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

// ── seedRecurringTemplateFromPoAction ────────────────────────────────────────

export async function seedRecurringTemplateFromPoAction(poId: string): Promise<
  ActionResult<{
    supplierId: string | null;
    destinationLocationId: string | null;
    lineItems: Array<{ itemId: string; quantityOrdered: number; unitCost: number }>;
  }>
> {
  if (!poId) return err('validation_error', 'Purchase order ID is required.');

  try {
    // Read-only — skip plan gate (the create action will enforce it).
    const { ctx, error } = await runGate({ skipPlanGate: true });
    if (error) return error;

    const seed = await new RecurringPoTemplatesService(ctx).seedFromPo(poId);
    // No audit (read-only), no revalidate.
    return ok(seed);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
