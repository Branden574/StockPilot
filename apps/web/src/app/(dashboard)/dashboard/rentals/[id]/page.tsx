import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { RentalActionsPanel } from '@/components/rentals/rental-actions-panel';
import { RentalDetailHeader } from '@/components/rentals/rental-detail-header';
import { RentalEmailsCard } from '@/components/rentals/rental-emails-card';
import { ReportProblemButton } from '@/components/maintenance/report-problem-button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import { InventoryService } from '@/server/services/inventory';
import { RentalsService } from '@/server/services/rentals';
import { WarehousesService } from '@/server/services/warehouses';
import { can, resolveOrgTimezone } from '@stockpilot/core';
import { formatNumber } from '@/lib/utils';

export default async function RentalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A malformed id (a mistyped or cut-off link) is Page not found before
  // anything is read with it, ahead of the gates below (B63).
  notFoundUnlessUuid(id);
  const ctx = await requireOrgContext();
  // Same visibility gate as the rentals list page (rentals RLS additionally
  // warehouse-scopes rows; this keeps list/detail consistent for ungranted
  // viewers reaching a rental by direct URL).
  if (!can(ctx, 'rentals:read') && !can(ctx, 'rentals:create') && !can(ctx, 'rentals:manage')) {
    redirect('/dashboard');
  }
  // With the Rentals module off, the rentals service refuses the read below,
  // and this page (rental emails, maintenance request emails and bookmarks
  // still link here) fell to the error screen ("Something broke loading this
  // page") instead of saying the module is off. It now shows the checkouts
  // list's module-off panel. The module set came with the request's
  // membership, so this costs no extra round trip. When that set could not
  // be read, the page says it could not check and offers Try again, and
  // still reads nothing.
  const rentalsModule = await checkModuleAccess('rentals');
  if (!rentalsModule.enabled) {
    return <ModuleUnavailable moduleId="rentals" access={rentalsModule} />;
  }

  const [rentalsSvc, inventorySvc, warehousesSvc] = await Promise.all([
    RentalsService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);

  // The rental, whether the daily sweep sends overdue reminders for this
  // organization (its explicit Rentals row, read the way the sweep reads it;
  // null when unreadable), and the organization's zone for the times. The
  // zone falls back to the documented default rather than failing the page
  // (getOrgRowForRequest throws on a read error), like the PO imports list.
  const [rental, remindersOn, timeZone] = await Promise.all([
    rentalsSvc.get(id),
    rentalsSvc.overdueRemindersOn(),
    getOrgRowForRequest(ctx.organizationId)
      .then((org) => resolveOrgTimezone(org?.timezone))
      .catch((e: unknown) => {
        void reportError(e, { tag: 'rentals.detail.org_timezone_failed', level: 'warning' });
        return resolveOrgTimezone(null);
      }),
  ]);
  if (!rental) notFound();
  // One moment for the whole page, so the emails card and the header agree.
  const nowMs = Date.now();

  // Resolve item names for each line
  const itemIds = rental.lines.map((l) => l.item_id);
  const [itemRows, warehouses] = await Promise.all([
    itemIds.length > 0 ? inventorySvc.byIds(itemIds) : Promise.resolve([]),
    warehousesSvc.listNames(),
  ]);
  const itemMap = new Map(itemRows.map((i) => [i.id, i]));
  const warehouse = warehouses.find((w) => w.id === rental.warehouse_id);

  const canManage = can(ctx, 'rentals:manage');
  const canCreate = can(ctx, 'rentals:create');

  // "Report a problem" launch point (Task 17, master brief §8 / audit Q11 —
  // rentals stand in for the brief's "assigned asset view"; no assets table
  // exists). Sync gate first: the module RPC is only paid for a viewer who
  // actually holds the submit permission.
  const canReportProblem = can(ctx, 'maintenance_requests:submit');
  const { enabled: maintenanceModuleEnabled } = canReportProblem
    ? await checkModuleAccess('maintenance_requests')
    : { enabled: false };

  return (
    // The page box every redesigned dashboard page shares. On a wide screen
    // the record's own cards (borrower, items) take the left column and the
    // work on it (actions, emails) the right, as the item and bundle pages lay
    // out; on a narrow one everything stacks in today's order: borrower,
    // emails, actions, items.
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/rentals">← Back to rentals</PageHeaderBackLink>}
        title="Rental detail"
        actions={
          <ReportProblemButton
            moduleEnabled={maintenanceModuleEnabled}
            canSubmit={canReportProblem}
            prefill={{ rentalId: id }}
          />
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)] lg:grid-rows-[auto_1fr]">
        {/* Header card */}
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <RentalDetailHeader
            rental={rental}
            warehouseName={warehouse?.name ?? rental.warehouse_id}
            timeZone={timeZone}
            nowMs={nowMs}
          />
        </div>

        <aside className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {/* Which emails the borrower gets, and the overdue reminder's real state */}
          <RentalEmailsCard
            rental={rental}
            remindersOn={remindersOn}
            nowMs={nowMs}
            timeZone={timeZone}
          />

          {/* Actions panel — only shown when rental is out and user has permission */}
          {canCreate && (
            <RentalActionsPanel rentalId={rental.id} status={rental.status} canManage={canManage} />
          )}
        </aside>

        {/* Lines table. Notes hides below sm, as before; there it rides as a
            quiet line under the item's name instead. */}
        <DetailSection
          headingId="rental-items-heading"
          title={`Items (${rental.lines.length})`}
          flush
          className="lg:col-start-1 lg:row-start-2"
        >
          {rental.lines.length === 0 ? (
            <p className="text-muted-foreground px-[18px] py-6 text-[13.5px]">
              No items on this rental.
            </p>
          ) : (
            <Table scrollLabelledBy="rental-items-heading">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Item</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="hidden sm:table-cell">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rental.lines.map((line) => {
                  const item = itemMap.get(line.item_id);
                  return (
                    <TableRow key={line.id}>
                      <TableCell className="min-w-0">
                        {item ? (
                          <Link
                            href={`/dashboard/rentals/items/${line.item_id}`}
                            className="text-foreground font-medium [overflow-wrap:anywhere] hover:underline"
                          >
                            {item.name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground [overflow-wrap:anywhere]">
                            {line.item_id}
                          </span>
                        )}
                        {line.notes ? (
                          <span className="text-muted-foreground mt-0.5 block text-[12px] leading-[18px] [overflow-wrap:anywhere] sm:hidden">
                            Notes: {line.notes}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-[12px]">
                        {item?.sku ?? '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatNumber(line.quantity)}
                      </TableCell>
                      {/* Wraps anywhere, like the phone line under the item:
                          a long unbroken link in the notes would otherwise
                          widen the table and squeeze the Item column. */}
                      <TableCell className="text-muted-foreground hidden [overflow-wrap:anywhere] sm:table-cell">
                        {line.notes ?? '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </DetailSection>
      </div>
    </div>
  );
}
