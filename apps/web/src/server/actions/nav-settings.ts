'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import {
  err,
  isSafeNavHref,
  ok,
  SECTION_ORDER,
  type ActionResult,
  type NavOverrides,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Server-side validation — AUTHORITATIVE.
//
// The client editor runs the same href safety check, but the server re-runs it
// here on every custom href and re-enforces the caps. The shape mirrors the
// `NavOverrides` v1 contract in @stockpilot/core. `null` clears the override
// (Reset to default). Anything that fails validation is rejected outright
// (validation_error) rather than silently coerced, so an admin always sees why
// a save was refused.
// ---------------------------------------------------------------------------

const LABEL_MAX = 60;
const HREF_MAX = 512;
const ID_MAX = 64;
const MAX_CUSTOM_LINKS = 50;
const MAX_HIDDEN = 200;
const MAX_LABEL_OVERRIDES = 200;

const sectionSchema = z.enum(
  SECTION_ORDER as unknown as [string, ...string[]],
);

const customLinkSchema = z.object({
  id: z.string().min(1).max(ID_MAX),
  label: z.string().min(1).max(LABEL_MAX),
  href: z
    .string()
    .max(HREF_MAX)
    .refine((h) => isSafeNavHref(h), 'Unsafe or invalid link URL.'),
  section: sectionSchema,
  iconName: z.string().min(1).max(64),
  sortOrder: z.number().int().optional(),
});

const overridesSchema = z.object({
  v: z.literal(1),
  hidden: z.array(z.string().min(1).max(HREF_MAX)).max(MAX_HIDDEN).optional(),
  labels: z
    .record(z.string().min(1).max(HREF_MAX), z.string().min(1).max(LABEL_MAX))
    .refine((rec) => Object.keys(rec).length <= MAX_LABEL_OVERRIDES, 'Too many label overrides.')
    .optional(),
  order: z
    .record(sectionSchema, z.array(z.string().min(1).max(HREF_MAX)).max(MAX_HIDDEN))
    .optional(),
  custom: z.array(customLinkSchema).max(MAX_CUSTOM_LINKS).optional(),
});

/**
 * Persist (or clear) the org's sidebar nav overrides. Mirrors the
 * module-settings action EXACTLY: `withContext()` (so the org MFA policy is
 * honored) → MFA gate (fail CLOSED) → owner/admin gate → validate → write →
 * audit → revalidate.
 *
 * `overrides === null` resets the org to the default derived nav.
 */
export async function setNavOverridesAction(
  overrides: NavOverrides | null,
): Promise<ActionResult<{ navOverrides: NavOverrides | null }>> {
  // Validate BEFORE touching context so an obviously-bad payload is cheap to
  // reject. `null` is the explicit reset signal and is always allowed (subject
  // to the auth gates below).
  let value: NavOverrides | null = null;
  if (overrides !== null && overrides !== undefined) {
    const parsed = overridesSchema.safeParse(overrides);
    if (!parsed.success) {
      return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid navigation settings.');
    }
    value = parsed.data as NavOverrides;
  }

  try {
    // `withContext()` (not `requireOrgContext()`) so the org's MFA policy is
    // honored — editing the org-wide nav is a privileged org mutation that must
    // ride the same MFA gate `assertPermission` enforces inside services. Fail
    // CLOSED for an AAL1 session in an mfa-required org.
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can customize navigation.');
    }

    const supabase = ctx.supabase;
    const { error } = await supabase
      .from('organizations')
      .update({ nav_overrides: value })
      .eq('id', ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: 'nav_overrides.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      after: { navOverrides: value },
    });

    revalidatePath('/dashboard', 'layout');
    revalidatePath('/dashboard/settings/navigation');

    return ok({ navOverrides: value });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
