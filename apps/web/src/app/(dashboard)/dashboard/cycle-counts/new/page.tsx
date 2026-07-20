import Link from 'next/link';
import { redirect } from 'next/navigation';

import { NewCycleCount } from '@/components/cycle-counts/new-cycle-count';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
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
  const [warehouses, supabase] = await Promise.all([
    warehousesSvc.listNames(),
    createClient(),
  ]);

  // Manager+ can assign a count to a teammate at creation time. Only
  // fetch the member list when they actually can (mirrors the detail page).
  const canAssign = can(ctx, 'cycle_counts:assign');
  let members: Array<{ id: string; name: string; email: string }> = [];
  if (canAssign) {
    const { data: rawMembers } = await supabase
      .from('organization_members')
      .select('user_id, user:user_profiles!user_id (id, full_name, email)')
      .eq('organization_id', ctx.organizationId)
      .not('accepted_at', 'is', null);
    type MemberRow = {
      user_id: string;
      user:
        | { id: string; full_name: string | null; email: string }
        | { id: string; full_name: string | null; email: string }[]
        | null;
    };
    members = ((rawMembers ?? []) as MemberRow[])
      .map((row) => {
        const u = Array.isArray(row.user) ? row.user[0] : row.user;
        if (!u) return null;
        return { id: u.id, name: u.full_name ?? u.email, email: u.email };
      })
      .filter((m): m is { id: string; name: string; email: string } => Boolean(m))
      .sort((a, b) => a.name.localeCompare(b.name));
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
          />
        </CardContent>
      </Card>
    </div>
  );
}
