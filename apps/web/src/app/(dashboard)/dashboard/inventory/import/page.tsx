import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CsvImport } from '@/components/inventory/csv-import';
import { requireOrgContext } from '@/lib/auth/session';

import { can } from '@stockpilot/core';

export default async function ImportPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'items:import')) {
    redirect('/dashboard/inventory');
  }
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
      <CsvImport />
    </div>
  );
}
