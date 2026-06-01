import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { NavCustomizer } from '@/components/settings/nav-customizer';
import { requireOrgContext } from '@/lib/auth/session';
import { getModulesForRequest, getOrgRowForRequest } from '@/lib/dashboard/request-cache';

import {
  hasPermission,
  resolveSurface,
  type NavOverrides,
  type NavSectionKey,
} from '@stockpilot/core';

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
  if (!hasPermission(ctx.role, 'organization:update')) {
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
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Navigation</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Hide, rename, and reorder sidebar items, or add custom links, for your whole
          organization. Items follow each member&apos;s role and your enabled modules — hiding an
          item never enables a feature you&apos;ve turned off.
        </p>
      </div>

      <NavCustomizer baseSections={baseSections} initialOverrides={initialOverrides} />
    </div>
  );
}
