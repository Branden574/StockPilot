import { Edit } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ArchiveBundleButton } from '@/components/bundles/archive-bundle-button';
import { AssembleBundleModal } from '@/components/bundles/assemble-bundle-modal';
import { DistributeBundleModal } from '@/components/bundles/distribute-bundle-modal';
import { DetailSection } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can, canDistributeBundles } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { BundlesService } from '@/server/services/bundles';
import { WarehousesService } from '@/server/services/warehouses';
import { formatNumber, formatRelative } from '@/lib/utils';

/** The page area (DESIGN-SPEC 4 and 5.3), as on the bundle list. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function BundleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  const canManage = can(ctx, 'bundles:manage');
  // Same visibility gate as the bundles list page — without it, an UNgranted
  // viewer could still open any bundle's recipe + distribution history by
  // direct URL (bundles RLS is org-member-wide). Holding bundles:distribute
  // still OPENS the page, as it does the list.
  if (!can(ctx, 'bundles:read') && !can(ctx, 'bundles:distribute') && !canManage) {
    redirect('/dashboard');
  }
  // The Distribute BUTTON is offered only where the database will accept it:
  // bundles:distribute AND manager or above (0101). Staff hold the permission
  // by default and were shown a button that answered "Permission denied".
  const canDistribute = canDistributeBundles(ctx);

  const svc = await BundlesService.forCurrentUser();
  let detail;
  try {
    detail = await svc.get(id);
  } catch {
    notFound();
  }

  const [whs, recent, upcomingEvents] = await Promise.all([
    (await WarehousesService.forCurrentUser()).listNames(),
    svc.recentDistributions({ bundleId: id, limit: 20 }),
    fetchUpcomingEvents(),
  ]);

  const warehouseMap = new Map(whs.map((w) => [w.id, w.name]));

  return (
    <div className={PAGE}>
      {/* The record's header (DESIGN-SPEC 6.1): the name never truncates and
          wraps instead; when the actions do not fit beside it they move under
          it, so the title is never squeezed by its actions. */}
      <PageHeader
        variant="item"
        back={<PageHeaderBackLink href="/dashboard/bundles">← Back to bundles</PageHeaderBackLink>}
        title={detail.bundle.name}
        titleAside={
          <div className="flex flex-wrap items-center gap-2">
            {detail.bundle.archived_at ? (
              <Badge variant="outline">Archived</Badge>
            ) : detail.bundle.is_active ? (
              <Badge variant="success">Active</Badge>
            ) : (
              <Badge variant="warning">Inactive</Badge>
            )}
            {detail.bundle.preassembly_enabled && <Badge variant="outline">Pre-assembly</Badge>}
          </div>
        }
        meta={
          detail.bundle.sku ? (
            <span className="font-mono text-[12.5px]">{detail.bundle.sku}</span>
          ) : undefined
        }
        actions={
          canManage ? (
            <>
              <Button asChild variant="outline">
                <Link href={`/dashboard/bundles/${id}/edit`}>
                  <Edit className="h-3.5 w-3.5" />
                  Edit
                </Link>
              </Button>
              {!detail.bundle.archived_at && (
                <ArchiveBundleButton bundleId={id} bundleName={detail.bundle.name} />
              )}
            </>
          ) : null
        }
        commitAction={
          canDistribute && detail.bundle.is_active && !detail.bundle.archived_at ? (
            <DistributeBundleModal
              bundleId={id}
              bundleName={detail.bundle.name}
              warehouses={whs}
              upcomingEvents={upcomingEvents}
            />
          ) : null
        }
      >
        {detail.bundle.description && (
          <p className="text-muted-foreground mt-2 max-w-2xl text-[13.5px] [overflow-wrap:anywhere]">
            {detail.bundle.description}
          </p>
        )}
      </PageHeader>

      {/* Two columns from lg (the record page's 1.7 : 1 split with a 280 px
          rail), one column below. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <DetailSection title={`Components (${detail.components.length})`} flush>
            {detail.components.length === 0 ? (
              <StatePanel
                kind="empty"
                surface="plain"
                icon={null}
                headingLevel={null}
                title="No components — edit this bundle to add some."
              />
            ) : (
              <Table className="min-w-[480px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Qty / kit</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="text-center">Optional</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.components.map((c) => (
                    <TableRow key={c.itemId}>
                      <TableCell>
                        {c.itemId ? (
                          <Link
                            href={`/dashboard/inventory/${c.itemId}`}
                            className="group block min-w-0"
                          >
                            <div className="text-foreground font-medium [overflow-wrap:anywhere] group-hover:underline">
                              {c.itemName}
                            </div>
                            <div className="text-muted-foreground font-mono text-[11.5px]">
                              {c.itemSku}
                            </div>
                          </Link>
                        ) : (
                          <span className="text-muted-foreground italic">Deleted item</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatNumber(c.quantity)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right font-mono tabular-nums">
                        {formatNumber(c.itemQuantityOnHand)}
                      </TableCell>
                      <TableCell className="text-center">
                        {c.isOptional ? (
                          <Badge variant="outline">Optional</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </DetailSection>

          <DetailSection title="Recent distributions" flush>
            {recent.length === 0 ? (
              <StatePanel
                kind="empty"
                surface="plain"
                icon={null}
                headingLevel={null}
                title="No distributions yet."
              />
            ) : (
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>When</TableHead>
                    <TableHead>Warehouse</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                        {formatRelative(d.distributed_at)}
                      </TableCell>
                      <TableCell className="text-[12.5px] text-[var(--ed-ink-2)]">
                        {warehouseMap.get(d.warehouse_id) ?? '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatNumber(Number(d.quantity))}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground max-w-[280px] truncate text-[12.5px]"
                        title={d.notes ?? undefined}
                      >
                        {d.notes ?? '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {d.shortage_recorded && <Badge variant="destructive">Shortage</Badge>}
                          {d.schedule_event_id && <Badge variant="outline">Event</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </DetailSection>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          {detail.bundle.preassembly_enabled && (
            <DetailSection title="Pre-assembled stock">
              <div className="text-foreground text-[24px] font-medium tabular-nums leading-8 tracking-[-0.02em] [font-family:var(--font-display)]">
                {formatNumber(detail.phantom?.quantityOnHand ?? 0)}
              </div>
              <div className="text-muted-foreground mt-0.5 text-[12px]">
                kits ready{' '}
                {detail.phantom?.warehouseId
                  ? `at ${warehouseMap.get(detail.phantom.warehouseId) ?? 'a warehouse'}`
                  : ''}
              </div>
              {canManage && (
                <div className="mt-3.5">
                  <AssembleBundleModal
                    bundleId={id}
                    bundleName={detail.bundle.name}
                    warehouses={whs}
                    lockedWarehouseId={detail.phantom?.warehouseId ?? null}
                  />
                </div>
              )}
            </DetailSection>
          )}

          <DetailSection title="Audit" flush>
            <KeyValueList>
              <KeyValueRow label="Created">{formatRelative(detail.bundle.created_at)}</KeyValueRow>
              <KeyValueRow label="Updated">{formatRelative(detail.bundle.updated_at)}</KeyValueRow>
            </KeyValueList>
          </DetailSection>
        </aside>
      </div>
    </div>
  );
}

async function fetchUpcomingEvents(): Promise<
  Array<{ id: string; title: string; startsAt: string }>
> {
  try {
    const supabase = await createClient();
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const untilIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('schedule_events')
      .select('id, title, starts_at')
      .gte('starts_at', sinceIso)
      .lte('starts_at', untilIso)
      .in('status', ['scheduled', 'in_progress'])
      .order('starts_at', { ascending: true })
      .limit(20);
    return (data ?? []).map((e) => ({
      id: e.id as string,
      title: e.title as string,
      startsAt: e.starts_at as string,
    }));
  } catch {
    return [];
  }
}
