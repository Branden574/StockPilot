import { Suspense } from 'react';

import {
  SettingsFrame,
  SettingsSubNav,
  SettingsSubNavPlaceholder,
  type SettingsNavAccess,
} from '@/components/settings/settings-nav';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';

import { can, PERMISSIONS } from '@stockpilot/core';

/**
 * The settings area's frame: the grouped sub-nav beside or above every
 * settings page except the hub (the hub IS the grouped index).
 *
 * NO READS OF ITS OWN. The sub-nav's gates come from the React-cached
 * `requireOrgContext()` (the membership bundle the dashboard layout and every
 * settings page resolve anyway) and `checkModuleAccess`, which reads the
 * module set that bundle already carries. layout.test.tsx pins that no
 * Supabase client is created here.
 *
 * NOTHING WAITS FOR IT. The layout itself is synchronous and the sub-nav sits
 * in its own Suspense boundary, so `settings/loading.tsx` (the boundary around
 * the page) shows at once on a navigation into settings, below the sub-nav's
 * placeholder, and the page never waits for the nav. A redirect stub such as
 * `settings/audit` redirects exactly as before.
 *
 * The `?mfa=required` hard gate and its exemption for the security page live in
 * the dashboard layout; nothing here redirects.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SettingsFrame
      nav={
        <Suspense fallback={<SettingsSubNavPlaceholder />}>
          <SettingsNavSlot />
        </Suspense>
      }
    >
      {children}
    </SettingsFrame>
  );
}

async function SettingsNavSlot() {
  const ctx = await requireOrgContext();
  const maintenance = await checkModuleAccess('maintenance_requests');
  const access: SettingsNavAccess = {
    permissions: PERMISSIONS.filter((permission) => can(ctx, permission)),
    modules: maintenance.enabled ? ['maintenance_requests'] : [],
  };
  return <SettingsSubNav access={access} />;
}
