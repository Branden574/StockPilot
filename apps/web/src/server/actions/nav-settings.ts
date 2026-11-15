'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { mergeNavOverrides } from '@/lib/nav-overrides-merge';
import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';
import { actionErrorResult } from '@/server/lib/action-error-result';

import {
  err,
  isSafeNavHref,
  ok,
  resolveSurface,
  SECTION_ORDER,
  type ActionResult,
  type NavOverrides,
  type NavSectionKey,
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
const MAX_LISTED = 500;

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

const listedSchema = z.array(z.string().min(1).max(HREF_MAX)).max(MAX_LISTED).optional();

/**
 * Persist (or clear) the org's sidebar nav overrides. Mirrors the
 * module-settings action EXACTLY: `withContext()` (so the org MFA policy is
 * honored) → MFA gate (fail CLOSED) → owner/admin gate → validate → write →
 * audit → revalidate.
 *
 * `overrides === null` resets the org to the default derived nav.
 *
 * A save (`overrides` not null) answers only for the links the editor
 * listed: `listed`, the hrefs it showed, narrowed to the links of the modules
 * that are on now (all of those when `listed` is absent). The stored entries
 * of every other link are kept (mergeNavOverrides), so saving while a module
 * is off, or from a page opened before a module was turned on, never drops
 * the admin's hides, renames and order places for that module's links. A
 * module state that could not be read refuses the save (ModulesUnavailable,
 * nothing written), as the page shows no editor then.
 */
export async function setNavOverridesAction(
  overrides: NavOverrides | null,
  listed?: readonly string[],
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
  const listedParsed = listedSchema.safeParse(listed);
  if (!listedParsed.success) {
    return err('validation_error', 'Invalid navigation settings.');
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

    if (value !== null) {
      // The links the editor lists, as the page resolves them (role 'admin',
      // the org's modules). An unread module state throws
      // ModulesUnavailableError here: no save, nothing written.
      const resolved = resolveSurface('web_sidebar', {
        role: 'admin',
        enabledModules: ctx.enabledModules,
      });
      const listedNow = listedParsed.data ? new Set(listedParsed.data) : null;
      const decided = new Set<string>();
      const defaultOrder = new Map<NavSectionKey, string[]>();
      for (const sec of resolved) {
        const hrefs = sec.items.map((it) => it.href);
        defaultOrder.set(sec.section as NavSectionKey, hrefs);
        for (const href of hrefs) if (!listedNow || listedNow.has(href)) decided.add(href);
      }

      const { data: storedRow, error: readError } = await supabase
        .from('organizations')
        .select('nav_overrides')
        .eq('id', ctx.organizationId)
        .maybeSingle();
      if (readError) throw new ServiceError('internal_error', readError.message);

      const merged = mergeNavOverrides(
        value,
        (storedRow as { nav_overrides?: unknown } | null)?.nav_overrides ?? null,
        decided,
        defaultOrder,
      );
      if (merged !== null) {
        const reparsed = overridesSchema.safeParse(merged);
        if (!reparsed.success) {
          return err(
            'validation_error',
            reparsed.error.issues[0]?.message ?? 'Invalid navigation settings.',
          );
        }
      }
      value = merged;
    }

    const { data: updatedRow, error } = await supabase
      .from('organizations')
      .update({ nav_overrides: value })
      .eq('id', ctx.organizationId)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail CLOSED on a 0-row UPDATE (RLS no-match): no error + no row means
    // nothing persisted. Without this, the action returns ok and the UI shows
    // the saved nav while the row never changed.
    if (!updatedRow) {
      throw new ServiceError(
        'internal_error',
        'setNavOverridesAction did not persist: organization row was not updated (0 rows).',
      );
    }

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
    return actionErrorResult(e, 'actions.nav_settings.set_nav_overrides');
  }
}
