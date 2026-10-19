import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SettingsPage } from '@/components/settings/settings-nav';
import { NavCustomizer } from '@/components/settings/nav-customizer';
import { requireOrgContext } from '@/lib/auth/session';
import { getModulesForRequest, getOrgRowForRequest } from '@/lib/dashboard/request-cache';

import { can, resolveSurface, type NavOverrides, type NavSectionKey } from '@stockpilot/core';
import { PageTour } from '@/components/onboarding/page-tour';
import { NAV_SETTINGS_TOUR } from '@/lib/onboarding/tours';

export const metadata: Metadata = { title: 'Navigation — Settings' };

/**
 * Admin-only editor for the per-org sidebar nav. We resolve the BASE nav here
 * (admin role + the org's enabled modules) — i.e. the full set of items an org
 * admin could possibly hide/rename/reorder — and hand it to the client editor
 * together with the current saved overrides. The editor only ever produces a
 * `NavOverrides` payload; the server action re-validates it authoritatively.
 *
 * Note we resolve with `role: 'admin'` deliberately: the editor configures the
 * org-wide nav, so it must show admin-section items (every editor of this page
 * IS an admin/owner). The override layer can still only hide/rename/reorder
 * what `resolveSurface` returns per viewing role at render time.
 */
export default async function NavigationSettingsPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'organization:update')) {
    redirect('/dashboard');
  }

  const [enabledModules, orgRow] = await Promise.all([
    getModulesForRequest(ctx.organizationId),
    getOrgRowForRequest(ctx.organizationId),
  ]);

  const resolved = resolveSurface('web_sidebar', { role: 'admin', enabledModules });
  const baseSections = resolved.map((sec) => ({
    section: sec.section as NavSectionKey,
    items: sec.items.map((it) => ({
      href: it.href,
      label: it.label,
      iconName: it.iconName,
      // The editor orders by core's rule, which reads an order saved before
      // the 2026-10-19 regroup by each link's module.
      moduleId: it.moduleId,
    })),
  }));

  // Untrusted jsonb — the client editor + the server action both validate; we
  // only pass v:1 shapes through to seed the form. Anything else → no overrides.
  const raw = orgRow?.nav_overrides;
  const initialOverrides: NavOverrides | null =
    raw && typeof raw === 'object' && (raw as { v?: unknown }).v === 1
      ? (raw as NavOverrides)
      : null;

  return (
    <SettingsPage>
      <PageHeader
        title="Navigation"
        subline={
          <>
            Hide, rename, and reorder sidebar items, or add custom links, for your whole
            organization. Items follow each member&apos;s role and your enabled modules — hiding an
            item never enables a feature you&apos;ve turned off.
          </>
        }
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
        tour={<PageTour tour={NAV_SETTINGS_TOUR} />}
      />

      <NavCustomizer baseSections={baseSections} initialOverrides={initialOverrides} />
    </SettingsPage>
  );
}
