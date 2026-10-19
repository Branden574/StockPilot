import { notFound } from 'next/navigation';

import { CreateOrgForForm } from '@/components/admin/create-org-for-form';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { currentUserIsPlatformAdmin } from '@/lib/auth/platform-admin';

export const metadata = {
  title: 'Provision new organization',
};

export default async function PlatformAdminCreateOrgPage() {
  // Hard 404 (not 403) so the existence of the route isn't observable
  // to users who aren't on the platform-admin allowlist. Gated on the
  // VERIFIED auth email, never the user-writable profile column.
  if (!(await currentUserIsPlatformAdmin())) {
    notFound();
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/admin">← Back to admin</PageHeaderBackLink>}
        title="Provision a new organization"
        subline="Creates a Supabase auth account for the customer, emails them a magic-link invite, spins up their organization, makes them the owner, and seeds a default warehouse. They land on the dashboard on first sign-in."
      />

      <div className="border-border bg-card rounded-lg border p-[18px] sm:p-6">
        <CreateOrgForForm />
      </div>

      <p className="text-muted-foreground text-[12px]">
        Platform-admin action. Audit-logged against the new organization.
      </p>
    </div>
  );
}
