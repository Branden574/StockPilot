import type { Metadata } from 'next';

import { CreateOrgForForm } from '@/components/admin/create-org-for-form';
import { PageHeader } from '@/components/patterns/page-header';
import { PlatformPage } from '@/components/platform/platform-page';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';

export const metadata: Metadata = { title: 'Provision organization · Platform' };

/**
 * Provision a new tenant org for a customer. Gated in-page (the layout renders
 * in parallel so its gate can't be relied on alone); the underlying
 * createOrgForCustomerAction also re-checks the platform-admin allowlist +
 * step-up server-side. No server-side reads here, but the in-page gate keeps
 * the whole (platform) tree uniform.
 */
export default async function PlatformProvisionPage() {
  await requirePlatformAdmin();
  return (
    <PlatformPage width="narrow">
      <PageHeader
        title="Provision a new organization"
        subline={
          <>
            Creates the customer&apos;s account, emails a magic-link invite, spins up their org,
            makes them the owner, and seeds a default warehouse. Audit-logged against the new org.
          </>
        }
      />
      <div className="border-border bg-card rounded-lg border p-[18px] sm:p-6">
        <CreateOrgForForm />
      </div>
    </PlatformPage>
  );
}
