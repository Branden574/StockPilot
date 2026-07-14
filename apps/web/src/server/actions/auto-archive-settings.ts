'use server';

import { revalidatePath } from 'next/cache';

import { audit } from '@/server/services/audit';
import { autoArchiveSettingsSchema, type AutoArchiveSettings } from '@/server/services/auto-archive';
import { ServiceError, withContext } from '@/server/services/context';

import { can, err, ok, type ActionResult } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Per-org "auto-archive out-of-stock items" settings, stored in the
// `inventory` module's organization_modules.settings jsonb under
// `autoArchiveOnZeroStock` (no migration — mirrors auto-delete-archived /
// auto-reorder-settings): validate → withContext (honor org MFA policy) →
// MFA gate (fail CLOSED) → items:update gate (archive is REVERSIBLE —
// restocking un-archives, so this is a lighter gate than items:delete) →
// module gate → MERGE into settings (never clobber) → audit → revalidate.
// ---------------------------------------------------------------------------

export type AutoArchiveSettingsInput = AutoArchiveSettings;

export async function setAutoArchiveSettingsAction(
  input: AutoArchiveSettingsInput,
): Promise<ActionResult<{ settings: AutoArchiveSettings }>> {
  const parsed = autoArchiveSettingsSchema.safeParse(input);
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
    // items:update = archive is reversible (restocking auto-restores), unlike
    // auto-delete-archived which gates on items:delete.
    if (!can(ctx, 'items:update')) {
      return err('forbidden', 'You do not have permission to configure this setting.');
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
    const nextSettings = { ...prevSettings, autoArchiveOnZeroStock: settings };

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
      event: 'auto_archive_settings.updated',
      entityType: 'organization_module',
      entityId: 'inventory',
      after: { autoArchiveOnZeroStock: settings },
    });

    revalidatePath('/dashboard/settings/inventory-cleanup');
    return ok({ settings });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
