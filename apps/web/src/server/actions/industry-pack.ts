'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import {
  DEFAULT_TERMINOLOGY,
  MODULE_REGISTRY,
  err,
  modulesForPack,
  ok,
  presetForPack,
  type ActionResult,
  type DomainPack,
  type ModuleId,
  type OrgTerminology,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// One-click INDUSTRY TEMPLATE apply (Phase 3 T3).
//
// Mirrors the canonical org-config write action EXACTLY (nav-settings,
// module-settings, order-status-settings): validate input cheaply BEFORE
// touching context, then withContext() (so the org MFA policy is honored) →
// MFA gate (fail CLOSED) → owner/admin gate → mutate via ctx.supabase →
// audit(before/after) → revalidatePath. NO migration: this writes existing
// columns (organization_modules rows, organizations.domain_pack, and
// organizations.terminology) only.
//
// NON-DESTRUCTIVE by design: applying a pack ENABLES the pack's module set and
// SETS organizations.domain_pack, but it NEVER disables modules the org turned
// on outside the pack — modules not in the pack are left exactly as-is. This is
// a "set up as" template, not a "reset to". Terminology is MERGED: only the
// terminology keys the org has NOT already customized get the preset's
// defaults, so an org's existing labels are never clobbered.
//
// Idempotent: re-applying the same pack writes no new module rows (every pack
// module is already enabled), re-sets domain_pack to the same value, and the
// terminology merge is a fixed point once applied.
// ---------------------------------------------------------------------------

const VALID_PACKS: readonly DomainPack[] = [
  'charter_school',
  'distribution',
  'agriculture_food',
  'retail_backroom',
  'light_3pl',
];

const schema = z.object({
  pack: z.enum(VALID_PACKS as unknown as [string, ...string[]]),
});

const TERMINOLOGY_KEYS: ReadonlyArray<keyof OrgTerminology> = [
  'charter_singular',
  'charter_plural',
  'warehouse_singular',
  'warehouse_plural',
];

/**
 * Merge a preset's terminology defaults over the org's EXISTING terminology
 * WITHOUT clobbering any value the org already customized. A key is considered
 * "already customized" when the org's stored value is a non-empty string that
 * differs from the platform default. Returns the merged map plus whether any
 * key actually changed (so we skip the write when nothing changes).
 */
function mergeTerminology(
  existing: Partial<OrgTerminology> | null | undefined,
  presetTerms: Partial<OrgTerminology> | undefined,
): { merged: Partial<OrgTerminology>; changed: boolean } {
  const current: Partial<OrgTerminology> =
    existing && typeof existing === 'object' ? { ...existing } : {};
  const merged: Partial<OrgTerminology> = { ...current };
  let changed = false;
  if (presetTerms) {
    for (const key of TERMINOLOGY_KEYS) {
      const presetValue = presetTerms[key];
      if (typeof presetValue !== 'string' || presetValue.length === 0) continue;
      const orgValue = current[key];
      const orgCustomized =
        typeof orgValue === 'string' &&
        orgValue.length > 0 &&
        orgValue !== DEFAULT_TERMINOLOGY[key];
      // Only fill keys the org has NOT customized. If the org already set a
      // distinct, non-empty label, keep it.
      if (!orgCustomized && merged[key] !== presetValue) {
        merged[key] = presetValue;
        changed = true;
      }
    }
  }
  return { merged, changed };
}

/**
 * Owner/admin only. Apply an industry template:
 *   1. ENABLE every (non-core) module the pack turns on by default — additive,
 *      stamping enabled_at/enabled_by like module-settings. Core modules are
 *      always-on via the registry, so they are not written.
 *   2. SET organizations.domain_pack = pack.
 *   3. MERGE the preset's terminology defaults over the org's existing
 *      terminology (only keys the org hasn't customized).
 */
export async function applyIndustryPackAction(
  input: { pack: DomainPack },
): Promise<ActionResult<{ pack: DomainPack; enabled: ModuleId[] }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Unknown industry pack.');
  }
  const pack = parsed.data.pack as DomainPack;

  try {
    // `withContext()` (not `requireOrgContext()`) so the org's MFA policy is
    // honored — re-shaping the whole org's modules + identity is a privileged
    // mutation. Fail CLOSED for an AAL1 session in an mfa-required org.
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return err('forbidden', 'Only owners and admins can apply an industry template.');
    }

    const supabase = ctx.supabase;

    // --- Read current state (org row + enabled modules) for merge + audit. ---
    const { data: orgRow, error: orgError } = await supabase
      .from('organizations')
      .select('domain_pack, terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    if (orgError) throw new ServiceError('internal_error', orgError.message);

    const { data: moduleRows, error: selectError } = await supabase
      .from('organization_modules')
      .select('module_id, enabled')
      .eq('organization_id', ctx.organizationId);
    // Fail CLOSED: if the read fails we can't know what's already enabled. Bail
    // rather than re-stamp provenance on rows we'd otherwise think are off
    // (mirrors module-settings.ts read guard).
    if (selectError) throw new ServiceError('internal_error', selectError.message);

    const currentEnabled = new Set<ModuleId>(
      ((moduleRows ?? []) as Array<{ module_id: string; enabled: boolean }>)
        .filter((r) => r.enabled)
        .map((r) => r.module_id as ModuleId),
    );
    const beforeDomainPack = (orgRow as { domain_pack?: string } | null)?.domain_pack ?? null;
    const beforeTerminology =
      (orgRow as { terminology?: Partial<OrgTerminology> } | null)?.terminology ?? null;

    // --- 1) Module set: enable every non-core pack module not already on. ---
    // Core modules are always-on via the registry; we deliberately do NOT write
    // rows for them (avoids noise + matches module-settings, which forbids
    // toggling core). NON-DESTRUCTIVE: modules outside the pack are untouched.
    const packModules = modulesForPack(pack).filter(
      (id) => MODULE_REGISTRY[id].tier !== 'core',
    );
    const toEnable = packModules.filter((id) => !currentEnabled.has(id));

    if (toEnable.length > 0) {
      const stamp = { enabled_at: new Date().toISOString(), enabled_by: ctx.userId };
      const upserts = toEnable.map((id) => ({
        organization_id: ctx.organizationId,
        module_id: id,
        enabled: true,
        tier: MODULE_REGISTRY[id].tier,
        ...stamp,
      }));
      const { error: upsertError } = await supabase
        .from('organization_modules')
        .upsert(upserts, { onConflict: 'organization_id,module_id' });
      if (upsertError) throw new ServiceError('internal_error', upsertError.message);
    }

    // --- 2 & 3) Org row: domain_pack + merged terminology. -------------------
    const preset = presetForPack(pack);
    const { merged: mergedTerminology, changed: terminologyChanged } = mergeTerminology(
      beforeTerminology,
      preset.terminology,
    );

    const orgUpdate: { domain_pack: DomainPack; terminology?: Partial<OrgTerminology> } = {
      domain_pack: pack,
    };
    if (terminologyChanged) orgUpdate.terminology = mergedTerminology;

    const { error: updateError } = await supabase
      .from('organizations')
      .update(orgUpdate)
      .eq('id', ctx.organizationId);
    if (updateError) throw new ServiceError('internal_error', updateError.message);

    // --- Audit (before/after) ------------------------------------------------
    const afterEnabled = new Set(currentEnabled);
    for (const id of toEnable) afterEnabled.add(id);

    await audit({
      event: 'industry_pack.applied',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before: {
        domainPack: beforeDomainPack,
        terminology: beforeTerminology,
        enabled: [...currentEnabled],
      },
      after: {
        domainPack: pack,
        terminology: terminologyChanged ? mergedTerminology : beforeTerminology,
        enabled: [...afterEnabled],
        modulesEnabled: toEnable,
      },
    });

    revalidatePath('/dashboard', 'layout');
    revalidatePath('/dashboard/settings/industry');

    return ok({ pack, enabled: [...afterEnabled] });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
