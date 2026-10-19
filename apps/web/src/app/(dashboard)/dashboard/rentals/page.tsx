import Link from 'next/link';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PageHeader } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { RentalsListTable } from '@/components/rentals/rentals-list-table';
import { RentalsTabs } from '@/components/rentals/rentals-tabs';
import { Button } from '@/components/ui/button';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';
import { InventoryService } from '@/server/services/inventory';
import { RentalsService, type RentalRow } from '@/server/services/rentals';
import {
  can,
  isRentalOverdue,
  overdueReminderListMark,
  overdueReminderState,
  resolveOrgTimezone,
} from '@stockpilot/core';

type StatusParam = 'out' | 'overdue' | 'returned' | 'cancelled' | 'all';

const VALID_STATUSES: Set<StatusParam> = new Set([
  'out',
  'overdue',
  'returned',
  'cancelled',
  'all',
]);

const SUB_TABS: Array<{ id: StatusParam; label: string }> = [
  { id: 'out', label: 'Out' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'returned', label: 'Returned' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];

/**
 * The small reminder mark on each OVERDUE row ("Reminder sent Sep 26", "No
 * email on file", ...), keyed by rental id. Decided here, on the server, with
 * the rule the daily sweep uses (@stockpilot/core rentals/emails.ts) and in the
 * organization's zone, and handed to the table as text: the table is a client
 * component, and a date formatted there would follow the browser's zone.
 */
function reminderMarksFor(
  rentals: RentalRow[],
  remindersOn: boolean | null,
  nowMs: number,
  timeZone: string,
): Record<string, string> {
  const marks: Record<string, string> = {};
  for (const rental of rentals) {
    if (!isRentalOverdue(rental, nowMs)) continue;
    const mark = overdueReminderListMark(
      overdueReminderState(rental, remindersOn, nowMs),
      timeZone,
    );
    if (mark) marks[rental.id] = mark;
  }
  return marks;
}

function parseStatus(value: string | undefined): StatusParam {
  return value && VALID_STATUSES.has(value as StatusParam) ? (value as StatusParam) : 'out';
}

export default async function RentalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('rentals');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="rentals" canManage={moduleAccess.canManage} />;
  }
  const ctx = await requireOrgContext();
  // Visibility gates on rentals:read (staff+ by default, grantable to
  // viewers) — consistent with the sidebar placement, which requires the
  // same permission. rentals:create holders keep access even if an org
  // revokes the read perm from a role that can still rent out. Create /
  // return / cancel actions stay gated on rentals:create / rentals:manage.
  if (!can(ctx, 'rentals:read') && !can(ctx, 'rentals:create')) {
    redirect('/dashboard');
  }
  const params = await searchParams;
  const status = parseStatus(params.status);
  const canCreate = can(ctx, 'rentals:create');

  const [rentalsSvc, inventorySvc] = await Promise.all([
    RentalsService.forCurrentUser(),
    InventoryService.forCurrentUser(),
  ]);

  // The rows, the organization's Rentals row as the overdue sweep reads it
  // (null when unreadable: overdue rows then show only the marks that do not
  // depend on it), and the zone for the marks' dates.
  const [{ rentals }, remindersOn, timeZone] = await Promise.all([
    rentalsSvc.list({ status }),
    rentalsSvc.overdueRemindersOn(),
    getOrgRowForRequest(ctx.organizationId)
      .then((org) => resolveOrgTimezone(org?.timezone))
      .catch((e: unknown) => {
        void reportError(e, { tag: 'rentals.list.org_timezone_failed', level: 'warning' });
        return resolveOrgTimezone(null);
      }),
  ]);
  const reminderMarks = reminderMarksFor(rentals, remindersOn, Date.now(), timeZone);

  // Build a name map for the first-line item summary in each row.
  const allItemIds = [...new Set(rentals.flatMap((r) => r.lines.map((l) => l.item_id)))];
  const itemRows = allItemIds.length > 0 ? await inventorySvc.byIds(allItemIds) : [];
  const itemNames = new Map(itemRows.map((i) => [i.id, i.name]));

  return (
    // The page box every redesigned dashboard page shares (max 1320, 16 px
    // gutters on a phone).
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title="Rentals"
        subline="Track items checked out to staff, vendors, and event coordinators."
        primaryAction={
          canCreate ? (
            <Button asChild variant="gradient">
              <Link href="/dashboard/rentals/new">+ New rental</Link>
            </Button>
          ) : undefined
        }
      />

      {/* Section tabs: Activity | Items */}
      <RentalsTabs activeTab="activity" />

      {/* Status views: Out | Overdue | Returned | Cancelled | All, the same
          links and default (Out). Overdue stays derived (out and past due).
          No counts: none is read for these views (CONFLICTS K6, O2). */}
      <SegmentedTabs
        semantics="nav"
        aria-label="Filter by status"
        activeId={status}
        items={SUB_TABS.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: `/dashboard/rentals?status=${tab.id}`,
        }))}
      />

      {/* Table */}
      <RentalsListTable
        rentals={rentals}
        viewerRole={ctx.role}
        itemNames={itemNames}
        reminderMarks={reminderMarks}
        timeZone={timeZone}
      />
    </div>
  );
}
