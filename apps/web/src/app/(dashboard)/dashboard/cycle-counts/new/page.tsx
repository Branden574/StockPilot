import Link from 'next/link';
import { redirect } from 'next/navigation';

import { NewCycleCount } from '@/components/cycle-counts/new-cycle-count';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';
import { getModulesForRequest } from '@/lib/dashboard/request-cache';
import { createClient } from '@/lib/supabase/server';
import { fetchCountAssignees, type CountAssignee } from '@/server/lib/count-assignees';
import { WarehousesService } from '@/server/services/warehouses';

import { can } from '@stockpilot/core';

export default async function NewCycleCountPage() {
  // Submit asserts stock:adjust. Without this gate viewers/staff
  // would land on the form and only learn they can't submit when
  // they click Start. Matches the sibling /cycle-counts list page.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'stock:adjust')) {
    redirect('/dashboard');
  }

  const warehousesSvc = await WarehousesService.forCurrentUser();
  const [warehouses, supabase, enabledModules] = await Promise.all([
    warehousesSvc.listNames(),
    createClient(),
    // Gates the "Product groups" scope. An org without the sports module sees
    // the picker exactly as it was.
    getModulesForRequest(ctx.organizationId),
  ]);
  const sportsEnabled = enabledModules.has('sports');

  // Manager+ can assign a count to a teammate at creation time. Only
  // fetch the member list when they actually can (mirrors the detail page).
  const canAssign = can(ctx, 'cycle_counts:assign');
  let members: CountAssignee[] = [];
  if (canAssign) {
    // One member source for every count assignee picker (count-assignees.ts).
    // A failed read shows no members here, as it always did.
    members = await fetchCountAssignees(supabase, ctx.organizationId).catch(() => []);
  }

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
          Pick the exact items to count below, or snapshot a whole warehouse.
          Starting the count records each item&apos;s current quantity-on-hand
          so we can compute variance later.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scope</CardTitle>
        </CardHeader>
        <CardContent>
          <NewCycleCount
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            members={members}
            canAssign={canAssign}
            sportsEnabled={sportsEnabled}
          />
        </CardContent>
      </Card>
    </div>
  );
}
