import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleToggles } from '@/components/settings/module-toggles';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { createClient } from '@/lib/supabase/server';
import { can, MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Modules — Settings' };

export default async function ModulesSettingsPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'organization:update')) {
    redirect('/dashboard');
  }

  const supabase = await createClient();
  // The comp flag decides only what this page SAYS, so an unreadable flag must
  // not take the page down: getOrgRowForRequest throws on a read error, and this
  // page rendered fine through one before it read the flag at all. Unreadable
  // means "not comped", which is also the safe reading. Both reads in parallel:
  // the row is request-cached on a hard load, but not on a soft navigation.
  const [{ data: rows }, comped] = await Promise.all([
    supabase
      .from('organization_modules')
      .select('module_id, enabled')
      .eq('organization_id', ctx.organizationId),
    getOrgRowForRequest(ctx.organizationId)
      .then((org) => org?.all_modules_comp === true)
      .catch((e: unknown) => {
        console.error('[settings/modules] comp flag unreadable; rendering as not comped', e);
        return false;
      }),
  ]);

  const enabledIds: ModuleId[] = ((rows ?? []) as Array<{ module_id: string; enabled: boolean }>)
    .filter((r) => r.enabled)
    .map((r) => r.module_id as ModuleId);

  // A comped organization can USE every module whatever these switches say, so
  // the page has to say so, or it shows "off" for a module that opens fine from
  // the sidebar.

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

      {comped ? (
        <div
          role="note"
          className="bg-muted/50 mb-6 rounded-md border px-4 py-3 text-sm leading-relaxed"
        >
          <p className="font-medium">Every module is included for your organization.</p>
          <p className="text-muted-foreground mt-1">
            Each one is available to your team in the app whether or not it is switched on here. A
            switch still controls what that module does on its own or shows to people outside your
            team: scheduled jobs, exports to accounting, emails to customers, public links and the
            customer portal. To hide a module from the sidebar, use{' '}
            <Link href="/dashboard/settings/navigation" className="text-foreground underline">
              Navigation
            </Link>
            .
          </p>
        </div>
      ) : null}

      <ModuleToggles modules={modules} enabledIds={enabledIds} comped={comped} />
    </div>
  );
}
