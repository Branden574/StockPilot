import Link from 'next/link';
import { redirect } from 'next/navigation';

import { StartCycleCountForm } from '@/components/cycle-counts/start-cycle-count-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';
import { WarehousesService } from '@/server/services/warehouses';

import { hasPermission } from '@stockpilot/core';

export default async function NewCycleCountPage() {
  // Submit asserts stock:adjust. Without this gate viewers/staff
  // would land on the form and only learn they can't submit when
  // they click Start. Matches the sibling /cycle-counts list page.
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'stock:adjust')) {
    redirect('/dashboard');
  }

  const warehousesSvc = await WarehousesService.forCurrentUser();
  const warehouses = await warehousesSvc.list();

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/cycle-counts"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to cycle counts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Start a count</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Pick a scope. Starting the count snapshots every active item's
          current quantity-on-hand so we can compute variance later.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scope</CardTitle>
        </CardHeader>
        <CardContent>
          <StartCycleCountForm
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
