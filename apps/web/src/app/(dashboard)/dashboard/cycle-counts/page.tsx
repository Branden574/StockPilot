import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { WarehousesService } from '@/server/services/warehouses';
import { formatRelative } from '@/lib/utils';

import { can } from '@stockpilot/core';

export default async function CycleCountsPage() {
  const moduleAccess = await checkModuleAccess('cycle_counts');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="cycle_counts" canManage={moduleAccess.canManage} />;
  }
  // Cycle counts emit stock_movements rows when posted — gated on
  // stock:adjust (staff+). Viewers get bounced.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'stock:adjust')) {
    redirect('/dashboard');
  }
  const [ccSvc, warehousesSvc] = await Promise.all([
    CycleCountsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);
  const [counts, warehouses] = await Promise.all([
    ccSvc.list(),
    warehousesSvc.listNames(),
  ]);
  const warehouseMap = new Map(warehouses.map((w) => [w.id, w.name]));

  // Resolve assignee names for the "Assigned to" column. Mirrors the
  // member lookup on the detail/new pages (embed through organization_members
  // so it works under RLS).
  const supabase = await createClient();
  const { data: rawMembers } = await supabase
    .from('organization_members')
    .select('user_id, user:user_profiles!user_id (id, full_name, email)')
    .eq('organization_id', ctx.organizationId)
    .not('accepted_at', 'is', null);
  const assigneeMap = new Map<string, string>();
  for (const row of (rawMembers ?? []) as Array<{
    user_id: string;
    user:
      | { id: string; full_name: string | null; email: string }
      | { id: string; full_name: string | null; email: string }[]
      | null;
  }>) {
    const u = Array.isArray(row.user) ? row.user[0] : row.user;
    if (u) assigneeMap.set(u.id, u.full_name ?? u.email);
  }

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cycle counts</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Recount stock against the system. Approving a count posts adjustments
            for every variance and brings inventory in line with what was counted.
          </p>
        </div>
        <Button asChild variant="gradient">
          <Link href="/dashboard/cycle-counts/new">+ Start a count</Link>
        </Button>
      </div>

      <div className="mt-8">
        {counts.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No cycle counts yet"
            description="Start a count to snapshot expected quantities, then enter actuals as you walk the warehouse. We post the variance adjustments for you."
            cta={{ label: 'Start your first count', href: '/dashboard/cycle-counts/new' }}
          />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assigned to</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {counts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/cycle-counts/${c.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {formatRelative(c.started_at)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {c.warehouse_id
                        ? (warehouseMap.get(c.warehouse_id) ?? '—')
                        : 'All warehouses'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {c.assigned_to ? (assigneeMap.get(c.assigned_to) ?? '—') : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[260px] truncate text-xs">
                      {c.notes ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {c.completed_at ? formatRelative(c.completed_at) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'in_progress')
    return <Badge variant="warning">In progress</Badge>;
  if (status === 'completed')
    return <Badge variant="success">Completed</Badge>;
  if (status === 'canceled')
    return <Badge variant="destructive">Canceled</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}
