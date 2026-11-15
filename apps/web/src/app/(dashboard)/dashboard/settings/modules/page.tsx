import { Info } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { TryAgainButton } from '@/components/dashboard/try-again-button';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { ModuleToggles } from '@/components/settings/module-toggles';
import { SettingsPage } from '@/components/settings/settings-nav';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { createClient } from '@/lib/supabase/server';
import { can, MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

// The Liquid Glass settings and administration composition (stage 4:
// pages/admin.css): every rule is scoped to this area's [data-glass-page] root
// and to glass, so Classic never matches it (glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/admin.css';

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
  const [{ data: rows, error: rowsError }, comped] = await Promise.all([
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

  // The switches show what the rows say, and a switch that reads "off" is one
  // press from being written. supabase-js resolves a failed read as `{ data:
  // null, error }`, the shape of an organization with no rows, so the read's
  // outcome is checked: rows that could not be read (an error, or an answer
  // that is not a list) draw no switches. The page says so and offers Try
  // again.
  if (rowsError || !Array.isArray(rows)) {
    console.error(
      '[settings/modules] module rows unreadable:',
      (rowsError as { code?: string } | null)?.code || 'not a list of rows',
    );
    return (
      <SettingsPage>
        <PageHeader
          title="Modules"
          subline="Turn features on or off for your whole organization. Core modules are always on."
          back={
            <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
          }
        />
        <StatePanel
          kind="failed"
          headingLevel={2}
          title="We couldn't load your modules"
          description="Nothing was changed. This is usually temporary. Try again in a moment."
          action={<TryAgainButton />}
        />
      </SettingsPage>
    );
  }

  const enabledIds: ModuleId[] = (rows as Array<{ module_id: string; enabled: boolean }>)
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
    <SettingsPage>
      <PageHeader
        title="Modules"
        subline="Turn features on or off for your whole organization. Core modules are always on."
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
      />

      {comped ? (
        <div
          role="note"
          className="bg-sunk flex items-start gap-3 rounded-lg border px-4 py-3 text-[13px] leading-relaxed"
        >
          <Info aria-hidden className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Every module is included for your organization.</p>
            <p className="text-ink-2 mt-1">
              Each one is available to your team in the app whether or not it is switched on here. A
              switch still controls what that module does on its own or shows to people outside your
              team: scheduled jobs, exports to accounting, emails to customers, public links and the
              customer portal. To hide a module from the sidebar, use{' '}
              <Link
                href="/dashboard/settings/navigation"
                className="text-foreground underline underline-offset-4"
              >
                Navigation
              </Link>
              .
            </p>
          </div>
        </div>
      ) : null}

      <ModuleToggles modules={modules} enabledIds={enabledIds} comped={comped} />
    </SettingsPage>
  );
}
