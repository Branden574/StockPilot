import type { Metadata } from 'next';

import { CreateOrgForForm } from '@/components/admin/create-org-for-form';

export const metadata: Metadata = { title: 'Provision organization · Platform' };

/**
 * Provision a new tenant org for a customer. The gate lives in the
 * (platform) layout (requirePlatformAdmin); the underlying
 * createOrgForCustomerAction re-checks isPlatformAdmin server-side.
 */
export default function PlatformProvisionPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 pb-20 pt-7">
      <div className="mb-6 border-b border-border pb-4">
        <h1 className="font-display text-[26px] font-medium tracking-[-0.025em]">
          Provision a new organization
        </h1>
        <p className="mt-1 text-[13px] text-[var(--ed-ink-3)]">
          Creates the customer&apos;s account, emails a magic-link invite, spins up their org, makes
          them the owner, and seeds a default warehouse. Audit-logged against the new org.
        </p>
      </div>
      <div className="rounded-[10px] border border-border bg-card p-6">
        <CreateOrgForForm />
      </div>
    </div>
  );
}
