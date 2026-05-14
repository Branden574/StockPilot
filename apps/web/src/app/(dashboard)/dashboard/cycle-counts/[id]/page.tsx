import { Download } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CycleCountDetail } from '@/components/cycle-counts/cycle-count-detail';
import { Button } from '@/components/ui/button';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { WarehousesService } from '@/server/services/warehouses';
import { formatRelative } from '@/lib/utils';

import { hasPermission } from '@stockpilot/core';

export default async function CycleCountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [ccSvc, warehousesSvc, ctx, supabase] = await Promise.all([
    CycleCountsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    requireOrgContext(),
    createClient(),
  ]);

  let header, lines;
  try {
    ({ header, lines } = await ccSvc.get(id));
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  // Items-in-scope check is only meaningful while the count is open;
  // closed counts compare against a fixed snapshot. Best-effort: if
  // the head query fails we render without the warning rather than
  // breaking the page.
  let itemsInScopeCount: number | undefined = undefined;
  if (header.status === 'in_progress') {
    try {
      itemsInScopeCount = await ccSvc.itemsInScopeCount(id);
    } catch {
      itemsInScopeCount = undefined;
    }
  }

  const warehouses = await warehousesSvc.list();
  const warehouseName = header.warehouse_id
    ? (warehouses.find((w) => w.id === header.warehouse_id)?.name ?? null)
    : null;

  // Manager+ can change the assignee — staff / viewers see it read-only.
  const canAssign = hasPermission(ctx.role, 'cycle_counts:assign');

  // Member list for the assignee picker. Only fetched when the current
  // user can actually assign (saves a round trip for staff/viewers).
  let members: Array<{ id: string; name: string; email: string }> = [];
  if (canAssign) {
    const { data: rawMembers } = await supabase
      .from('organization_members')
      .select(
        'user_id, user:user_profiles!user_id (id, full_name, email)',
      )
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
        return {
          id: u.id,
          name: u.full_name ?? u.email,
          email: u.email,
        };
      })
      .filter((m): m is { id: string; name: string; email: string } => Boolean(m))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Resolve the current assignee's display name for the read-only badge
  // shown to non-managers, since they don't get the member list.
  let assigneeName: string | null = null;
  if (header.assigned_to) {
    if (canAssign) {
      assigneeName = members.find((m) => m.id === header.assigned_to)?.name ?? null;
    } else {
      const { data: assignee } = await supabase
        .from('user_profiles')
        .select('full_name, email')
        .eq('id', header.assigned_to)
        .maybeSingle();
      const a = assignee as { full_name: string | null; email: string } | null;
      assigneeName = a?.full_name ?? a?.email ?? null;
    }
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/cycle-counts"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to cycle counts
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Cycle count · {formatRelative(header.started_at)}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {warehouseName ?? 'All warehouses'}
              {header.notes ? ` · ${header.notes}` : ''}
            </p>
          </div>
          <Button asChild variant="outline">
            <a
              href={`/api/cycle-counts/${id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download className="h-4 w-4" />{' '}
              {header.status === 'in_progress'
                ? 'Print count sheet'
                : 'Variance report PDF'}
            </a>
          </Button>
        </div>
      </div>

      <CycleCountDetail
        header={header}
        lines={lines}
        canAssign={canAssign}
        members={members}
        assigneeName={assigneeName}
        itemsInScopeCount={itemsInScopeCount}
      />
    </div>
  );
}
