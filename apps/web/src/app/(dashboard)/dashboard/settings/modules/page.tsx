import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleToggles } from '@/components/settings/module-toggles';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { can, MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Modules — Settings' };

export default async function ModulesSettingsPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'organization:update')) {
    redirect('/dashboard');
  }

  const supabase = await createClient();
  const { data: rows } = await supabase
    .from('organization_modules')
    .select('module_id, enabled')
    .eq('organization_id', ctx.organizationId);

  const enabledIds: ModuleId[] = ((rows ?? []) as Array<{ module_id: string; enabled: boolean }>)
    .filter((r) => r.enabled)
    .map((r) => r.module_id as ModuleId);

  const modules = Object.values(MODULE_REGISTRY).map((m) => ({
    id: m.id,
    title: m.title,
    tier: m.tier,
  }));

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Modules</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Turn features on or off for your whole organization. Core modules are always on.
        </p>
      </div>

      <ModuleToggles modules={modules} enabledIds={enabledIds} />
    </div>
  );
}
