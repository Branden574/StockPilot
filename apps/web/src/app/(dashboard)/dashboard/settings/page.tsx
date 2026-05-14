import Link from 'next/link';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';

import { hasPermission } from '@stockpilot/core';

const BASE_SECTIONS = [
  { href: '/dashboard/settings/organization', title: 'Organization', description: 'Name, labels for charters and warehouses.' },
  { href: '/dashboard/settings/security', title: 'Security', description: 'Two-factor authentication and org MFA policy.' },
  { href: '/dashboard/settings/profile', title: 'Profile', description: 'Your name and avatar.' },
  { href: '/dashboard/settings/notifications', title: 'Notifications', description: 'Weekly digest email and preferences.' },
  { href: '/dashboard/settings/billing', title: 'Billing', description: 'Plan, invoices, payment method.' },
  { href: '/dashboard/settings/roles', title: 'Roles & permissions', description: 'Reference for what each role can see and do across StockPilot.' },
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

// Recovery (restoring soft-deleted rows) is a destructive admin action;
// gate on `items:delete` so manager can't restore items they couldn't
// delete in the first place. Owners and admins only.
const RECOVERY_SECTIONS = [
  { href: '/dashboard/settings/recovery', title: 'Recovery', description: 'Restore soft-deleted items, categories, suppliers, and locations.' },
];

export default async function SettingsPage() {
  const ctx = await requireOrgContext();
  const sections = [
    ...BASE_SECTIONS,
    ...(hasPermission(ctx.role, 'orders:approve') ? MANAGER_SECTIONS : []),
    ...(hasPermission(ctx.role, 'activity_logs:read') ? ADMIN_SECTIONS : []),
    ...(hasPermission(ctx.role, 'items:delete') ? RECOVERY_SECTIONS : []),
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
