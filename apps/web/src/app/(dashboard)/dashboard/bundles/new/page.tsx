import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BundleForm } from '@/components/bundles/bundle-form';
import { hasPermission } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';

export default async function NewBundlePage() {
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'bundles:manage')) {
    redirect('/dashboard/bundles');
  }

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/bundles"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to bundles
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New bundle</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Define a reusable kit. Choose components and per-kit quantities.
          Optionally enable pre-assembly to box kits ahead of distribution.
        </p>
      </div>
      <BundleForm />
    </div>
  );
}
