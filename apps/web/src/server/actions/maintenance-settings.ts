'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import { can, err, ok, uuidSchema, type ActionResult } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Per-org maintenance-request module settings, stored in
// `organization_modules.settings` (module_id = 'maintenance_requests') as
// TOP-LEVEL keys — the same unconstrained-jsonb convention as every other
// module-settings reader in this codebase (b2b pricingMode, inventory's
// autoArchiveOnZeroStock/autoDeleteArchived). Two readers already exist and
// are forward-compatible with this writer:
//   - categories: dashboard/maintenance/new/page.tsx
//   - includeShareLinksInEmail: api/v1/maintenance-requests/[id]/route.ts
//     (shareLinksEnabled()) — absent/missing means "never configured",
//     default ON (`!== false`).
// notifyAudience is new here; Task 21's notification dispatch is the future
// reader (not shipped as of this task) — the shape below is that contract.
//
// Gate → merge → audit → revalidate, matching setAutoArchiveSettingsAction /
// setAutoDeleteArchivedSettingsAction (apps/web/src/server/actions/
// auto-archive-settings.ts, inventory-cleanup-settings.ts) exactly: validate
// → withContext (honor org MFA policy) → MFA gate (fail CLOSED) →
// maintenance_requests:configure gate → MERGE into settings (never clobber
// a sibling key) → audit → revalidate.
//
// RECIPIENTS ARE NOT HERE. L4L_MAINTENANCE_EMAIL / L4L_MAINTENANCE_EMAIL_NAMES
// (packages/core/src/maintenance/constants.ts) are compile-time literals the
// email builder reads directly and takes NO recipient argument for. This
// type has no field a recipient value could land in, and the patch schema
// below is `.strict()` — an unrecognized key (e.g. a client attempting to
// smuggle `recipientTo`/`cc`) is a hard validation rejection, never a
// silent strip. Mirrors maintenanceRequestFormSchema's own documented
// rationale (packages/core/src/schemas/maintenance.ts).
// ---------------------------------------------------------------------------

export interface MaintenanceModuleSettings {
  /** Fallback: MAINTENANCE_CATEGORIES when absent/empty/malformed. */
  categories?: string[];
  /** Whether the generated email includes a secure photo-share link. Default true. */
  includeShareLinksInEmail?: boolean;
  /** userId -> notification mode (C9 adjudication — the narrowed 3-state set). */
  notifyAudience?: Record<string, 'all' | 'urgent_only' | 'none'>;
}

const categorySchema = z
  .string()
  .trim()
  .min(1, 'Category names cannot be blank.')
  .max(80, 'Keep category names under 80 characters.');

const patchSchema = z
  .object({
    categories: z
      .array(categorySchema)
      .min(1, 'Keep at least one category.')
      .max(30, 'Keep the category list to 30 or fewer.')
      .optional(),
    includeShareLinksInEmail: z.boolean().optional(),
    notifyAudience: z.record(uuidSchema, z.enum(['all', 'urgent_only', 'none'])).optional(),
  })
  .strict();

export type MaintenanceSettingsPatch = z.infer<typeof patchSchema>;

/** Case-insensitive de-dupe, preserving the first-seen casing and order. */
function dedupeCategories(categories: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of categories) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

export async function updateMaintenanceSettingsAction(
  patch: MaintenanceSettingsPatch,
): Promise<ActionResult<{ settings: MaintenanceModuleSettings }>> {
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid settings.');
  }

  // Only keys ACTUALLY present in the input survive into the patch we
  // merge with — zod's `.optional()` omits an absent key from the parsed
  // object, but a caller that explicitly passes `key: undefined` would
  // otherwise leave an own-enumerable `undefined` entry that clobbers the
  // sibling on merge (the exact landmine class this action's merge test
  // guards against). Filtering defensively here means the merge below is
  // safe regardless of how a caller constructs its input.
  const patchToApply: Partial<MaintenanceModuleSettings> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    (patchToApply as Record<string, unknown>)[key] = value;
  }
  if (patchToApply.categories) {
    patchToApply.categories = dedupeCategories(patchToApply.categories);
  }

  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    // Owner-only by design (adjudication C2) — filtered out of admin's
    // derived permission set and absent from FULLY_GRANTABLE_PERMISSIONS
    // (packages/core/src/constants/permissions.ts). An admin WITHOUT an
    // explicit per-user override (granted through the existing
    // role-permission-matrix.tsx / setUserPermissionOverrideAction — never
    // a parallel mechanism) is refused here exactly like the page's own
    // load-time gate.
    if (!can(ctx, 'maintenance_requests:configure')) {
      return err('forbidden', 'You do not have permission to configure maintenance requests.');
    }

    const supabase = ctx.supabase;

    const { data: existing, error: readError } = await supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'maintenance_requests')
      .maybeSingle();
    if (readError) throw new ServiceError('internal_error', readError.message);

    const prev = (existing as { settings?: unknown } | null)?.settings;
    const prevSettings = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {};
    // Merge: only the keys present in this patch are overwritten. Any
    // sibling top-level key already in the settings jsonb — the other two
    // maintenance keys, or any future key this blob grows — is carried
    // through untouched.
    const nextSettings = { ...prevSettings, ...patchToApply };

    const { data: updated, error } = await supabase
      .from('organization_modules')
      .update({ settings: nextSettings })
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'maintenance_requests')
      .select('organization_id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update means the module row is missing.
    if (!updated) {
      throw new ServiceError('internal_error', 'Maintenance requests module is not initialized.');
    }

    await audit({
      event: 'maintenance_request.settings_updated',
      entityType: 'organization_module',
      entityId: 'maintenance_requests',
      after: patchToApply,
    });

    revalidatePath('/dashboard/settings/maintenance');
    return ok({ settings: nextSettings as MaintenanceModuleSettings });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
