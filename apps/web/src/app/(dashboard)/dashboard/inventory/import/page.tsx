import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CsvImport } from '@/components/inventory/csv-import';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';

import { can } from '@stockpilot/core';

export default async function ImportPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'items:import')) {
    redirect('/dashboard/inventory');
  }
  // The template's sports columns are gated like every other sports surface —
  // an org without the module never sees jerseys, colorways or size systems in
  // a CSV header it is told to fill in. Resolved AFTER the permission gate so a
  // redirect costs no extra read.
  const { enabled: sportsEnabled } = await checkModuleAccess('sports');
  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/inventory" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to inventory
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Import items</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a CSV. We'll validate every row and show errors before anything goes into your inventory.
        </p>
      </div>
      <CsvImport sportsEnabled={sportsEnabled} />
    </div>
  );
}
