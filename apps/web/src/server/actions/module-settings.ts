'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { ServiceError, withContext } from '@/server/services/context';

import {
  MODULE_REGISTRY,
  computeModuleChangeSet,
  err,
  ok,
  type ActionResult,
  type ModuleId,
} from '@stockpilot/core';

const schema = z.object({
  moduleId: z.string().refine((id): id is ModuleId => id in MODULE_REGISTRY, 'Unknown module'),
  enabled: z.boolean(),
});

export async function setModuleEnabledAction(
  input: { moduleId: ModuleId; enabled: boolean },
): Promise<ActionResult<{ enabled: ModuleId[] }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid module');
  const { moduleId, enabled } = parsed.data;
  if (MODULE_REGISTRY[moduleId].tier === 'core')
    return err('validation_error', 'Core modules are always enabled.');

  try {
    // Resolve through `withContext()` (not `requireOrgContext()`) so the
    // org's MFA policy is honored. Toggling modules — especially DISABLING
    // an integration mid-drain — is a privileged org mutation, so it must
    // ride the SAME org-MFA gate that `assertPermission` enforces inside
    // services. An admin on an AAL1 session in an mfa-required org would
    // otherwise bypass the documented MFA gate. Fail CLOSED.
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      return err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      );
    }
    if (ctx.role !== 'owner' && ctx.role !== 'admin')
      return err('forbidden', 'Only owners and admins can change modules.');

    const supabase = ctx.supabase;
    const { data: rows, error: selectError } = await supabase
      .from('organization_modules')
      .select('module_id, enabled')
      .eq('organization_id', ctx.organizationId);
    // Fail CLOSED: if the read fails, `current` would look empty and a disable
    // could cascade off modules that are actually enabled. Bail rather than act
    // on a phantom empty set (mirrors the dashboard layout's module-read guard).
    if (selectError) throw new ServiceError('internal_error', selectError.message);
    const current = new Set<ModuleId>(
      ((rows ?? []) as Array<{ module_id: string; enabled: boolean }>)
        .filter((r) => r.enabled)
        .map((r) => r.module_id as ModuleId),
    );

    const changes = computeModuleChangeSet(current, moduleId, enabled);
    if (changes.length === 0) return ok({ enabled: [...current] });

    // A single action's change set is uniformly all-enable or all-disable
    // (computeModuleChangeSet sets every change to `enabled`), so the column set
    // is uniform across the batch. Only stamp enabled_at/enabled_by when
    // ENABLING — those columns mean "when/who enabled", so on disable we leave
    // the prior enable provenance intact rather than recording the disabler.
    const stamp = enabled
      ? { enabled_at: new Date().toISOString(), enabled_by: ctx.userId }
      : {};
    const upserts = changes.map((c) => ({
      organization_id: ctx.organizationId,
      module_id: c.moduleId,
      enabled: c.enabled,
      tier: MODULE_REGISTRY[c.moduleId].tier,
      ...stamp,
    }));
    const { error } = await supabase
      .from('organization_modules')
      .upsert(upserts, { onConflict: 'organization_id,module_id' });
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: enabled ? 'module.enabled' : 'module.disabled',
      entityType: 'organization_module',
      entityId: moduleId,
      before: { enabled: [...current] },
      after: { changes },
    });

    revalidatePath('/dashboard', 'layout');
    revalidatePath('/dashboard/settings/modules');

    const nextEnabled = new Set(current);
    for (const c of changes) c.enabled ? nextEnabled.add(c.moduleId) : nextEnabled.delete(c.moduleId);
    return ok({ enabled: [...nextEnabled] });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
