import { Download } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';

import { CopyReferenceButton } from '@/components/cycle-counts/copy-reference-button';
import { CycleCountDetail } from '@/components/cycle-counts/cycle-count-detail';
import { BackToCycleCounts } from '@/components/cycle-counts/cycle-count-list-memory';
import { LinkedExceptionsBlock } from '@/components/exceptions/linked-exceptions-block';
import { Button } from '@/components/ui/button';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { createClient } from '@/lib/supabase/server';
import { fetchCountAssignees, type CountAssignee } from '@/server/lib/count-assignees';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { WarehousesService } from '@/server/services/warehouses';
import { formatRelative } from '@/lib/utils';

import {
  can,
  CYCLE_COUNT_REFERENCE_UNAVAILABLE,
  cycleCountScopeLabel,
  formatCycleCountNumber,
  formatOrgDateTime,
  resolveOrgTimezone,
} from '@stockpilot/core';

const LINE_PAGE_SIZE = 50;

type DetailSearchParams = {
  page?: string;
  q?: string;
  filter?: string;
};

export default async function CycleCountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<DetailSearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const requestedPage = Math.max(1, Number(sp.page) || 1);
  const search = (sp.q ?? '').trim();
  const filter: 'all' | 'uncounted' | 'variance' =
    sp.filter === 'uncounted' || sp.filter === 'variance' ? sp.filter : 'all';

  const [ccSvc, warehousesSvc, ctx, supabase] = await Promise.all([
    CycleCountsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    requireOrgContext(),
    createClient(),
  ]);

  // Same visibility gate as the list page: cycle_counts:read (or the write
  // perm as a fallback for override edge cases). Without this the detail page
  // was reachable by ANY member via direct URL.
  if (!can(ctx, 'cycle_counts:read') && !can(ctx, 'stock:adjust')) {
    redirect('/dashboard');
  }
  // Entering counts, clearing lines, cancelling, and posting adjustments all
  // require stock:adjust — read-only visitors get a genuinely read-only view.
  const canAdjust = can(ctx, 'stock:adjust');

  let header, lines, summary, total, pageSize, page;
  try {
    ({ header, lines, summary, total, pageSize, page } = await ccSvc.getDetailPage(id, {
      page: requestedPage,
      pageSize: LINE_PAGE_SIZE,
      search,
      filter,
    }));
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

  const [warehouses, orgRow] = await Promise.all([
    warehousesSvc.listNames(),
    getOrgRowForRequest(ctx.organizationId),
  ]);
  const warehouseName = header.warehouse_id
    ? (warehouses.find((w) => w.id === header.warehouse_id)?.name ?? null)
    : null;
  const tz = resolveOrgTimezone(orgRow?.timezone);
  const reference = formatCycleCountNumber(header.count_number);
  const scopeLabel = cycleCountScopeLabel({
    warehouseId: header.warehouse_id,
    warehouseName,
    scope: header.scope ?? null,
  });

  // Manager+ can change the assignee — staff / viewers see it read-only.
  const canAssign = can(ctx, 'cycle_counts:assign');

  // Member list for the assignee picker. Only fetched when the current
  // user can actually assign (saves a round trip for staff/viewers).
  let members: CountAssignee[] = [];
  if (canAssign) {
    // One member source for every count assignee picker (count-assignees.ts).
    // A failed read shows no members here, as it always did.
    members = await fetchCountAssignees(supabase, ctx.organizationId).catch(() => []);
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
        <nav aria-label="Breadcrumb" className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <BackToCycleCounts className="hover:text-foreground" />
          <span aria-hidden>/</span>
          <span aria-current="page" className="font-mono tabular-nums">
            {reference ?? 'Cycle count'}
          </span>
        </nav>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-2xl font-semibold tracking-tight">
                {reference ? (
                  <>
                    <span className="sr-only">Cycle count </span>
                    <span className="font-mono tabular-nums">{reference}</span>
                  </>
                ) : (
                  'Cycle count'
                )}
              </h1>
              {reference ? <CopyReferenceButton reference={reference} /> : null}
            </div>
            {reference ? null : (
              <p className="text-muted-foreground mt-0.5 text-xs">{CYCLE_COUNT_REFERENCE_UNAVAILABLE}</p>
            )}
            <p className="text-muted-foreground mt-1 text-sm">
              {scopeLabel}
              {header.notes ? ` · ${header.notes}` : ''}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Started {formatRelative(header.started_at)} ·{' '}
              <time dateTime={header.started_at}>
                {formatOrgDateTime(header.started_at, { dateStyle: 'medium', timeStyle: 'short' }, tz)}
              </time>
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

      {/* The exceptions a recount linked to this count (F1-2): streamed, so
          the count never waits for it; a failed read says unavailable. */}
      <Suspense fallback={null}>
        <div className="mb-6 empty:hidden">
          <LinkedExceptionsBlock cycleCountId={id} />
        </div>
      </Suspense>

      <CycleCountDetail
        header={header}
        lines={lines}
        summary={summary}
        page={page}
        pageSize={pageSize}
        total={total}
        search={search}
        filter={filter}
        canAssign={canAssign}
        canAdjust={canAdjust}
        members={members}
        assigneeName={assigneeName}
        itemsInScopeCount={itemsInScopeCount}
        timeZone={tz}
        role={ctx.role}
      />
    </div>
  );
}
