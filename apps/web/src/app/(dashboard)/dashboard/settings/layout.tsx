import { Suspense } from 'react';

import {
  SettingsFrame,
  SettingsSubNav,
  SettingsSubNavPlaceholder,
  type SettingsNavAccess,
} from '@/components/settings/settings-nav';
import { requireOrgContextForLayout } from '@/lib/auth/session';
import { checkModuleAccessFor } from '@/lib/modules/module-gate';

import { can, PERMISSIONS } from '@stockpilot/core';

/**
 * The settings area's frame: the grouped sub-nav beside or above every
 * settings page except the hub (the hub IS the grouped index).
 *
 * NO READS OF ITS OWN. The sub-nav's gates come from the React-cached
 * `requireOrgContextForLayout()` (the membership bundle the dashboard layout
 * and every settings page resolve anyway) and `checkModuleAccessFor`, which reads
 * the module set that bundle already carries. layout.test.tsx pins that no
 * Supabase client is created here.
 *
 * NOTHING WAITS FOR IT. The layout itself is synchronous and the sub-nav sits
 * in its own Suspense boundary, so `settings/loading.tsx` (the boundary around
 * the page) shows at once on a navigation into settings, below the sub-nav's
 * placeholder, and the page never waits for the nav. A redirect stub such as
 * `settings/audit` redirects exactly as before.
 *
 * Nothing here redirects. A member who must set up an authenticator first is
 * sent to the security page by the page they asked for (requireOrgContext()).
 * The navigation takes the layout's context (requireOrgContextForLayout, no
 * set-up redirect): this layout is shared by the security page, and a layout
 * that redirects to a page under itself is kept by the browser and replayed on
 * the way there. The security and profile pages are open to them
 * (lib/auth/authenticator-set-up).
 *
 * A MODULE SET THAT COULD NOT BE READ is not "off": Maintenance requests is
 * still not offered as a link (an unknown answer never shows it), but someone
 * its permission shows it to sees that it could not be checked, with Try
 * again, as the hub does, instead of the link silently missing.
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
  const ctx = await requireOrgContextForLayout();
  const maintenance = await checkModuleAccessFor('maintenance_requests', ctx);
  const access: SettingsNavAccess = {
    permissions: PERMISSIONS.filter((permission) => can(ctx, permission)),
    modules: maintenance.enabled ? ['maintenance_requests'] : [],
    uncheckedModules: maintenance.checkFailed ? ['maintenance_requests'] : [],
  };
  return <SettingsSubNav access={access} />;
}
