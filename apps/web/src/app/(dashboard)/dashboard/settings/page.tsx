import type { Metadata } from 'next';

import { PageTour } from '@/components/onboarding/page-tour';
import { PageHeader } from '@/components/patterns/page-header';
import { SettingsIndex, type SettingsNavAccess } from '@/components/settings/settings-nav';
import { requireOrgContext } from '@/lib/auth/session';
import { SETTINGS_TOUR } from '@/lib/onboarding/tours';
import { checkModuleAccess } from '@/lib/modules/module-gate';

import { can, PERMISSIONS } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Settings' };

/**
 * The settings hub: every settings destination the caller may use, grouped
 * (Account, Workspace, Access, Requests and email, Data safety, Connections,
 * Plan). Which tiles show is decided by the one gate table in
 * components/settings/settings-nav.tsx, which the sub-nav on every settings
 * page shares, from the caller's effective permissions (`can(ctx, ...)`,
 * overrides applied) and, for Maintenance requests, whether that
 * off-by-default module is on (`checkModuleAccess`). Both reads are the
 * request-cached ones the dashboard layout has already made.
 */
export default async function SettingsPage() {
  const ctx = await requireOrgContext();
  const maintenanceAccess = await checkModuleAccess('maintenance_requests');
  const access: SettingsNavAccess = {
    permissions: PERMISSIONS.filter((permission) => can(ctx, permission)),
    modules: maintenanceAccess.enabled ? ['maintenance_requests'] : [],
  };
  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title="Settings"
        subline="Manage your workspace and account."
        tour={<PageTour tour={SETTINGS_TOUR} />}
      />
      <SettingsIndex access={access} />
    </div>
  );
}
