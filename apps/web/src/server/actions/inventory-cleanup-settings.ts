'use server';

import { revalidatePath } from 'next/cache';

import { audit } from '@/server/services/audit';
import {
  autoDeleteArchivedSchema,
  type AutoDeleteArchivedSettings,
} from '@/server/services/archive-cleanup';
import { ServiceError, withContext } from '@/server/services/context';

import { err, hasPermission, ok, type ActionResult } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Per-org "auto-delete archived items" settings, stored in the `inventory`
// module's organization_modules.settings jsonb under `autoDeleteArchived`
// (no migration — mirrors auto-reorder-settings): validate → withContext
// (honor org MFA policy) → MFA gate (fail CLOSED) → items:delete gate (this is
// a destructive data-retention policy, same gate as Recovery) → module gate →
// MERGE into settings (never clobber) → audit → revalidate.
// ---------------------------------------------------------------------------

export type AutoDeleteArchivedSettingsInput = AutoDeleteArchivedSettings;

export async function setAutoDeleteArchivedSettingsAction(
  input: AutoDeleteArchivedSettingsInput,
): Promise<ActionResult<{ settings: AutoDeleteArchivedSettings }>> {
  const parsed = autoDeleteArchivedSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid settings.');
  }
  const settings = parsed.data;

  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    // items:delete = owner/admin (matches the Recovery section's gate). This
    // configures AUTOMATIC deletion of inventory, so it must be at least as
    // privileged as deleting an item by hand.
    if (!hasPermission(ctx.role, 'items:delete')) {
      return err('forbidden', 'You do not have permission to configure item deletion.');
    }
    if (!ctx.enabledModules.has('inventory')) {
      return err('forbidden', 'Inventory is not enabled for this organization.');
    }

    const supabase = ctx.supabase;

    // Merge into the inventory module settings (never clobber other keys).
    const { data: existing, error: readError } = await supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'inventory')
      .maybeSingle();
    if (readError) throw new ServiceError('internal_error', readError.message);

    const prev = (existing as { settings?: unknown } | null)?.settings;
    const prevSettings = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {};
    const nextSettings = { ...prevSettings, autoDeleteArchived: settings };

    const { data: updated, error } = await supabase
      .from('organization_modules')
      .update({ settings: nextSettings })
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'inventory')
      .select('organization_id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update means the module row is missing.
    if (!updated) {
      throw new ServiceError('internal_error', 'Inventory module is not initialized.');
    }

    await audit({
      event: 'archive_cleanup_settings.updated',
      entityType: 'organization_module',
      entityId: 'inventory',
      after: { autoDeleteArchived: settings },
    });

    revalidatePath('/dashboard/settings/inventory-cleanup');
    return ok({ settings });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
