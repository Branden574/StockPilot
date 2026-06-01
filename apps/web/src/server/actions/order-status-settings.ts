'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import {
  err,
  ok,
  ORDER_STATUS_COLORS,
  ORDER_STATUS_KEYS,
  ORDER_STATUS_LABEL_MAX,
  type ActionResult,
  type OrderStatusConfig,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Server-side validation — AUTHORITATIVE. Mirrors nav/module/dashboard settings
// actions: validate the payload BEFORE touching context, then withContext() →
// MFA gate (fail CLOSED) → owner/admin gate → mutate organizations.
// order_status_config → audit → revalidate. The pure resolver in
// @stockpilot/core re-sanitizes on read (fail-closed), but this is the trust
// boundary that decides what is ever persisted.
//
// This is a SOFT presentation override only — it never touches the
// order_requests.status CHECK or the transition state machine.
//
// `config === null` clears the override (Reset to default).
// ---------------------------------------------------------------------------

const SORT_MAX = 100000;

const statusKeySchema = z.enum(ORDER_STATUS_KEYS as unknown as [string, ...string[]]);
const colorSchema = z.enum(ORDER_STATUS_COLORS as unknown as [string, ...string[]]);

const statusEntrySchema = z
  .object({
    label: z.string().trim().min(1).max(ORDER_STATUS_LABEL_MAX).optional(),
    color: colorSchema.optional(),
    sortOrder: z.number().int().min(0).max(SORT_MAX).optional(),
  })
  // Reject an entry that overrides nothing — keeps the stored config minimal.
  .refine(
    (v) => v.label !== undefined || v.color !== undefined || v.sortOrder !== undefined,
    'Each status override must set at least one of label, color, or sort order.',
  );

// A record keyed by KNOWN status keys only. Unknown keys are rejected (not
// silently dropped) so an admin sees why a save was refused.
const configSchema = z
  .record(statusKeySchema, statusEntrySchema)
  .refine(
    (rec) => Object.keys(rec).length <= ORDER_STATUS_KEYS.length,
    'Too many status overrides.',
  );

/**
 * Persist (or clear) the org's order status presentation config. Mirrors the
 * nav-settings action EXACTLY: validate → withContext() (so the org MFA policy
 * is honored) → MFA gate (fail CLOSED) → owner/admin gate → write → audit →
 * revalidate.
 *
 * `config === null` resets the org to the canonical order status labels/colors.
 */
export async function setOrderStatusConfigAction(
  config: OrderStatusConfig | null,
): Promise<ActionResult<{ orderStatusConfig: OrderStatusConfig | null }>> {
  // Validate BEFORE touching context so an obviously-bad payload is cheap to
  // reject. `null` is the explicit reset signal and is always allowed (subject
  // to the auth gates below).
  let value: OrderStatusConfig | null = null;
  if (config !== null && config !== undefined) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      return err(
        'validation_error',
        parsed.error.issues[0]?.message ?? 'Invalid order status settings.',
      );
    }
    value = parsed.data as OrderStatusConfig;
  }

  try {
    // `withContext()` (not `requireOrgContext()`) so the org's MFA policy is
    // honored — editing org-wide status presentation is a privileged org
    // mutation. Fail CLOSED for an AAL1 session in an mfa-required org.
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can customize order statuses.');
    }

    const supabase = ctx.supabase;
    const { error } = await supabase
      .from('organizations')
      .update({ order_status_config: value })
      .eq('id', ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: 'order_status_config.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      after: { orderStatusConfig: value },
    });

    revalidatePath('/dashboard', 'layout');
    revalidatePath('/dashboard/settings/order-statuses');

    return ok({ orderStatusConfig: value });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
