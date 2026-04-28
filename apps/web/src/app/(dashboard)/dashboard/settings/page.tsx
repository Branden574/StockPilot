import Link from 'next/link';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';

const SECTIONS = [
  { href: '/dashboard/settings/organization', title: 'Organization', description: 'Name, logo, timezone, currency.' },
  { href: '/dashboard/settings/billing', title: 'Billing', description: 'Plan, invoices, payment method.' },
  { href: '/dashboard/settings/profile', title: 'Profile', description: 'Your name and avatar.' },
  { href: '/dashboard/settings/security', title: 'Security', description: 'Password, sessions, audit log.' },
];

export default async function SettingsPage() {
  await requireOrgContext();
  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">Manage your workspace and account.</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((s) => (
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
