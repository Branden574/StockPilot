import type { Metadata } from 'next';
import Link from 'next/link';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Settings' };
import { requireOrgContext } from '@/lib/auth/session';

import { hasPermission } from '@stockpilot/core';

const BASE_SECTIONS = [
  { href: '/dashboard/settings/organization', title: 'Organization', description: 'Name, labels for charters and warehouses.' },
  { href: '/dashboard/settings/security', title: 'Security', description: 'Two-factor authentication and org MFA policy.' },
  { href: '/dashboard/settings/profile', title: 'Profile', description: 'Your name and avatar.' },
  { href: '/dashboard/settings/notifications', title: 'Notifications', description: 'Weekly digest email and preferences.' },
  { href: '/dashboard/settings/roles', title: 'Roles & permissions', description: 'Reference for what each role can see and do across StockPilot.' },
];

// Billing is gated on the `billing:read` permission — staff/viewer
// roles can't visit /dashboard/settings/billing (the underlying page
// redirects them), so the tile was previously visible-but-broken.
// Show it only when the role actually has access.
const BILLING_SECTIONS = [
  { href: '/dashboard/settings/billing', title: 'Billing', description: 'Plan, invoices, payment method.' },
];

// Manager-and-above sections. Gated by hasPermission('orders:approve')
// so warehouse-scoped members don't see tiles they can't actually use —
// the underlying page redirects them anyway, but the tile is the
// discoverable surface.
const MANAGER_SECTIONS = [
  {
    href: '/dashboard/settings/public-requests',
    title: 'Public requests',
    description:
      'Shareable link external partners use to submit order requests — no account required.',
  },
];

const ADMIN_SECTIONS = [
  { href: '/dashboard/settings/audit', title: 'Audit log', description: 'Every privileged action across the org.' },
];

// AI settings (embeddings backfill, etc.) — gated on the explicit
// `ai:manage` permission (admin+ in the matrix). Embedding backfill
// burns Gemini API quota and shouldn't be a manager-level toggle.
const AI_SECTIONS = [
  { href: '/dashboard/settings/ai', title: 'AI', description: 'Semantic-search embeddings and AI assistant configuration.' },
];

// Recovery (restoring soft-deleted rows) is a destructive admin action;
// gate on `items:delete` so manager can't restore items they couldn't
// delete in the first place. Owners and admins only.
const RECOVERY_SECTIONS = [
  { href: '/dashboard/settings/recovery', title: 'Recovery', description: 'Restore soft-deleted items, categories, suppliers, and locations.' },
];

// Module control plane — turn features on or off for the whole org.
// Gated on `organization:update` so only admins and owners see the tile
// (the underlying page redirects anyone without that permission anyway).
const MODULES_SECTIONS = [
  { href: '/dashboard/settings/modules', title: 'Modules', description: 'Turn features on or off for your whole organization.' },
];

// Navigation customization — hide/rename/reorder sidebar items + add custom
// links for the whole org. Same `organization:update` gate as Modules; the
// underlying page redirects anyone without that permission.
const NAVIGATION_SECTIONS = [
  { href: '/dashboard/settings/navigation', title: 'Navigation', description: 'Customize the sidebar — hide, rename, and reorder items or add custom links.' },
];

// Dashboard customization — choose which landing-page cards show and in what
// order for the whole org. Same `organization:update` gate as Modules /
// Navigation; the underlying page redirects anyone without that permission.
const DASHBOARD_SECTIONS = [
  { href: '/dashboard/settings/dashboard', title: 'Dashboard', description: 'Choose which cards appear on the dashboard and in what order.' },
];

// Integrations control plane — connect external tools (QuickBooks Online).
// Gated on `integrations:manage` (owner+admin); the underlying page also
// redirects anyone without that permission.
const INTEGRATIONS_SECTIONS = [
  { href: '/dashboard/settings/integrations', title: 'Integrations', description: 'Connect QuickBooks Online and other tools to export your data.' },
];

export default async function SettingsPage() {
  const ctx = await requireOrgContext();
  const sections = [
    ...BASE_SECTIONS,
    ...(hasPermission(ctx.role, 'billing:read') ? BILLING_SECTIONS : []),
    ...(hasPermission(ctx.role, 'orders:approve') ? MANAGER_SECTIONS : []),
    ...(hasPermission(ctx.role, 'activity_logs:read') ? ADMIN_SECTIONS : []),
    ...(hasPermission(ctx.role, 'ai:manage') ? AI_SECTIONS : []),
    ...(hasPermission(ctx.role, 'items:delete') ? RECOVERY_SECTIONS : []),
    ...(hasPermission(ctx.role, 'organization:update') ? MODULES_SECTIONS : []),
    ...(hasPermission(ctx.role, 'organization:update') ? NAVIGATION_SECTIONS : []),
    ...(hasPermission(ctx.role, 'organization:update') ? DASHBOARD_SECTIONS : []),
    ...(hasPermission(ctx.role, 'integrations:manage') ? INTEGRATIONS_SECTIONS : []),
  ];
  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">Manage your workspace and account.</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href}>
            <Card className="h-full transition-shadow hover:shadow-md">
              <CardHeader>
                <CardTitle className="text-base">{s.title}</CardTitle>
                <CardDescription>{s.description}</CardDescription>
              </CardHeader>
              <CardContent />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
