import { notFound } from 'next/navigation';
import Link from 'next/link';

import { CreateOrgForForm } from '@/components/admin/create-org-for-form';
import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { requireSession } from '@/lib/auth/session';

export const metadata = {
  title: 'Provision new organization',
};

export default async function PlatformAdminCreateOrgPage() {
  const session = await requireSession();

  // Hard 404 (not 403) so the existence of the route isn't observable
  // to users who aren't on the platform-admin allowlist.
  if (!isPlatformAdmin(session.email)) {
    notFound();
  }

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/admin"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to admin
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Provision a new organization
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Creates a Supabase auth account for the customer, emails them a magic-link invite,
          spins up their organization, makes them the owner, and seeds a default warehouse.
          They land on the dashboard on first sign-in.
        </p>
      </div>

      <div className="bg-card rounded-xl border p-6">
        <CreateOrgForForm />
      </div>

      <p className="text-muted-foreground mt-4 text-xs">
        Platform-admin action. Audit-logged against the new organization.
      </p>
    </div>
  );
}
