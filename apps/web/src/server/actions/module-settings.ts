'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';

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
    const ctx = await requireOrgContext();
    if (ctx.role !== 'owner' && ctx.role !== 'admin')
      return err('forbidden', 'Only owners and admins can change modules.');

    const supabase = await createClient();
    const { data: rows } = await supabase
      .from('organization_modules')
      .select('module_id, enabled')
      .eq('organization_id', ctx.organizationId);
    const current = new Set<ModuleId>(
      ((rows ?? []) as Array<{ module_id: string; enabled: boolean }>)
        .filter((r) => r.enabled)
        .map((r) => r.module_id as ModuleId),
    );

    const changes = computeModuleChangeSet(current, moduleId, enabled);
    if (changes.length === 0) return ok({ enabled: [...current] });

    const upserts = changes.map((c) => ({
      organization_id: ctx.organizationId,
      module_id: c.moduleId,
      enabled: c.enabled,
      tier: MODULE_REGISTRY[c.moduleId].tier,
      enabled_at: new Date().toISOString(),
      enabled_by: ctx.userId,
    }));
    const { error } = await supabase
      .from('organization_modules')
      .upsert(upserts, { onConflict: 'organization_id,module_id' });
    if (error) throw new ServiceError('internal_error', error.message);

    await audit({
      event: enabled ? 'module.enabled' : 'module.disabled',
      entityType: 'organization_module',
      entityId: moduleId,
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
